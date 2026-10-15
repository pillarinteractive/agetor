import { describe, expect, test } from "bun:test";
import type { PipelinePublishState, PipelineRunSnapshot, PipelineStep, PublishStateName } from "./types.ts";
import type { CheckRunLike } from "./check-runs.ts";
import {
  PUBLISH_MAX_TRIES, PUBLISH_NO_CHECKS_MS, PUBLISH_PR_LAG_MS, PUBLISH_RERUN_SETTLE_MS,
  applyPublish, approvedHeadFor, baseHealth, baseVerdicts, decidePublish, failingCauses, initialPublishState, parsePublishGate,
  parsePipelineGate, publishBuildHandoff, publishEvidenceComment, publishGateOn, publishStepOf, publishVisitOver, publishWriterBrief, verdictsSettled,
  gateUnmatchedLine, unmatchedGateRefs,
  type PublishAction, type PublishObservation, type PullSeen,
} from "./publish.ts";

const NOW = 1_800_000_000_000;
const HEAD = "a".repeat(40);
const APPROVED = HEAD;
const MERGED = "c".repeat(40);
const TIP = "b".repeat(40);
const TIP2 = "d".repeat(40);

const at = (minute: number) => `2026-10-13T10:${String(minute).padStart(2, "0")}:00Z`;
const check = (name: string, conclusion: string | null, minute = 1, id = 1): CheckRunLike => ({
  name, status: conclusion === null ? "in_progress" : "completed", conclusion,
  htmlUrl: `https://github.com/o/r/actions/runs/${1000 + id}/job/${id}`, startedAt: at(minute), id,
});
const state = (name: PublishStateName, o: Partial<PipelinePublishState> = {}): PipelinePublishState => ({
  ...initialPublishState("finish", NOW - 60_000), base: "develop", approvedHead: APPROVED, head: HEAD, tree: "e".repeat(40), baseTip: TIP,
  pr: { number: 7, url: "https://github.com/o/r/pull/7" }, ...o, state: name, stateSince: o.stateSince ?? NOW - 30_000,
});
const pull = (o: Partial<PullSeen> = {}): PullSeen => ({ number: 7, url: "https://github.com/o/r/pull/7", state: "open", draft: true, headSha: HEAD, ...o });
const kind = (a: PublishAction) => (a.kind === "advance" ? `advance:${a.to}` : a.kind === "to-build" ? `to-build:${a.cause.kind}` : a.kind === "rerun" ? `rerun:${a.why}` : a.kind);

describe("the switch (pipeline_gates)", () => {
  test("off unless a pipeline is named; cards narrows it to a trial list", () => {
    const card = { id: "t1", pipelineId: "p1", pipelineName: "Change" };
    const on = (raw: string | null) => publishGateOn(parsePublishGate(raw), card);
    expect(on(null)).toBe(false);
    expect(on("not json")).toBe(false);
    expect(on("{}")).toBe(false);
    expect(on('{"publish":{}}')).toBe(false);
    expect(on('{"publish":{"cards":["t1"]}}')).toBe(false); // a card list alone is not the switch
    expect(on('{"publish":{"pipelines":["Change"]}}')).toBe(true);
    expect(on('{"publish":{"pipelines":["change"]}}')).toBe(true); // by name, any case
    expect(on('{"publish":{"pipelines":["p1"]}}')).toBe(true); // or by id
    expect(on('{"publish":{"pipelines":["Other"]}}')).toBe(false);
    expect(on('{"publish":{"pipelines":["Change"],"cards":["t1","t2"]}}')).toBe(true);
    expect(on('{"publish":{"pipelines":["Change"],"cards":["t2"]}}')).toBe(false);
    expect(on('{"publish":{"pipelines":["Change"],"cards":[]}}')).toBe(false);
    // A trial list that cannot be read allows nobody — it never widens to the whole pipeline.
    expect(on('{"publish":{"pipelines":["Change"],"cards":"t1"}}')).toBe(false);
  });

  test("the step Agetor runs: Finish of Build → Review → Finish, only for a run that adopted the gate", () => {
    const step = (name: string): PipelineStep => ({
      id: name.toLowerCase(), name, instructions: "", agentProfileId: "a", position: { x: 0, y: 0 }, subagents: { profileIds: [], cap: null }, transition: "choose", join: "any",
    });
    const graph = {
      steps: [step("Build"), step("Review"), step("Finish")], startStepId: "build",
      edges: [{ id: "1", from: "build", to: "review", label: "" }, { id: "2", from: "review", to: "finish", label: "approved" }],
    };
    const snap = (o: Partial<PipelineRunSnapshot>): PipelineRunSnapshot => ({ graph, maxSteps: 14, profiles: {}, capturedAt: 0, ...o });
    expect(publishStepOf(snap({ gates: { publish: true } }))?.name).toBe("Finish");
    expect(publishStepOf(snap({}))).toBeNull();
    expect(publishStepOf(null)).toBeNull();
    expect(publishStepOf(snap({ gates: { publish: true }, graph: { ...graph, steps: [step("Build"), step("Finish")] } }))).toBeNull();
  });

  test("…and it is Finish whichever step Understand hands a trivial change to", () => {
    const step = (name: string, canFinish = false): PipelineStep => ({
      id: name.toLowerCase(), name, instructions: "", agentProfileId: "a", position: { x: 0, y: 0 }, subagents: { profileIds: [], cap: null }, transition: "choose", join: "any",
      ...(canFinish ? { canFinish: true } : {}),
    });
    for (const trivialTo of ["finish", "review"]) {
      const graph = {
        steps: [step("Understand", true), step("Build"), step("Review"), step("Finish", true)], startStepId: "understand",
        edges: [
          { id: "1", from: "understand", to: "build", label: "build" }, { id: "2", from: "understand", to: trivialTo, label: "trivial change made" },
          { id: "3", from: "build", to: "review", label: "" }, { id: "4", from: "review", to: "build", label: "changes requested" },
          { id: "5", from: "review", to: "finish", label: "approved" }, { id: "6", from: "finish", to: "build", label: "verification failed" },
        ],
      };
      const snapshot: PipelineRunSnapshot = { graph, maxSteps: 14, profiles: {}, capturedAt: 0, gates: { publish: true } };
      expect(publishStepOf(snapshot)?.id).toBe("finish");
      expect(publishStepOf({ ...snapshot, gates: { steps: true } })).toBeNull();
    }
  });
});

describe("whose failure: the control arm reads the base by job name", () => {
  const cases: { name: string; commits: CheckRunLike[][]; verdict: string }[] = [
    { name: "failed on the base tip → inherited", commits: [[check("web", "failure")]], verdict: "failed" },
    { name: "passed on the base tip → the change's own", commits: [[check("web", "success")]], verdict: "passed" },
    { name: "still running on the base tip → undecided", commits: [[check("web", null)]], verdict: "running" },
    { name: "never run on the base → the change's own", commits: [[check("lint", "success")], [check("lint", "success")]], verdict: "never" },
    { name: "the tip did not run the suite: the newest base commit that did decides", commits: [[check("lint", "success")], [check("web", "failure")], [check("web", "success")]], verdict: "failed" },
    { name: "skipped on the tip says nothing; an older pass does", commits: [[check("web", "skipped")], [check("web", "success")]], verdict: "passed" },
    { name: "cancelled on the tip says nothing; an older failure does", commits: [[check("web", "cancelled")], [check("web", "failure")]], verdict: "failed" },
    { name: "a cancelled duplicate beside a newer failure on the tip: the newest run counts", commits: [[check("web", "cancelled", 1, 1), check("web", "failure", 2, 2)]], verdict: "failed" },
    { name: "a re-run that passed on the tip clears the older failure", commits: [[check("web", "failure", 1, 1), check("web", "success", 9, 2)]], verdict: "passed" },
    { name: "no base commits read", commits: [], verdict: "never" },
  ];
  for (const c of cases) {
    test(c.name, () => expect(baseVerdicts(["web"], c.commits).web).toBe(c.verdict as never));
  }
  test("older commits are read only while a name has no verdict", () => {
    expect(verdictsSettled(baseVerdicts(["web", "lab"], [[check("web", "failure")]]))).toBe(false);
    expect(verdictsSettled(baseVerdicts(["web", "lab"], [[check("web", "failure")], [check("lab", null)]]))).toBe(true);
    expect(verdictsSettled({})).toBe(true);
  });
  test("the roll-up check is never a cause", () => {
    expect(failingCauses([check("required", "failure", 1, 1), check("web", "failure", 1, 2), check("lint", "success", 1, 3)]).map((f) => f.name)).toEqual(["web"]);
    expect(failingCauses([check("web", "failure", 1, 1), check("web", "success", 5, 2)])).toEqual([]);
  });
});

describe("the base's health before a push", () => {
  const cases: { name: string; checks: CheckRunLike[]; state: string; failing?: string[] }[] = [
    { name: "no runs", checks: [], state: "none" },
    { name: "all passed", checks: [check("web", "success"), check("required", "success", 1, 2)], state: "green" },
    { name: "the roll-up failed", checks: [check("web", "failure"), check("required", "failure", 1, 2)], state: "red", failing: ["web"] },
    { name: "an optional check failed but the roll-up passed: not red", checks: [check("preview", "failure"), check("required", "success", 1, 2)], state: "green" },
    { name: "no roll-up: any failure is red", checks: [check("web", "failure"), check("lint", "success", 1, 2)], state: "red", failing: ["web"] },
    { name: "the roll-up is still running", checks: [check("web", "success"), check("required", null, 1, 2)], state: "pending" },
    { name: "a failed roll-up re-run and passing", checks: [check("required", "failure", 1, 1), check("required", "success", 9, 2)], state: "green" },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const got = baseHealth(c.checks);
      expect(got.state).toBe(c.state as never);
      expect(got.failing).toEqual(c.failing ?? []);
    });
  }
});

describe("decidePublish: one action from the state and what Agetor observed", () => {
  const green = [check("web", "success", 1, 1), check("required", "success", 1, 2)];
  const redOwn = [check("web", "failure", 1, 1), check("required", "failure", 1, 2)];
  const clean = { conflicts: null, samePatch: true, commit: MERGED };
  const cases: { name: string; p: PipelinePublishState; obs: PublishObservation; want: string }[] = [
    // verify-head
    { name: "verify-head: clean tree at the approved head", p: state("verify-head", { approvedHead: null, head: null }),
      obs: { state: "verify-head", dirty: [], head: HEAD, tree: "t", approval: { kind: "approved", headSha: APPROVED }, unreviewed: [] }, want: "advance:check-merge" },
    { name: "verify-head: tracked changes → Build, no agent turn", p: state("verify-head"),
      obs: { state: "verify-head", dirty: ["src/a.ts"], head: HEAD, tree: "t", approval: { kind: "approved", headSha: APPROVED }, unreviewed: [] }, want: "to-build:dirty" },
    { name: "verify-head: a commit after the approval → Build", p: state("verify-head"),
      obs: { state: "verify-head", dirty: [], head: MERGED, tree: "t", approval: { kind: "approved", headSha: APPROVED }, unreviewed: ["c0ffee1 fix: late"] }, want: "to-build:unapproved-head" },
    { name: "verify-head: the base Agetor merged in earlier is the approved head carried over", p: state("verify-head", { head: MERGED, carried: 1 }),
      obs: { state: "verify-head", dirty: [], head: MERGED, tree: "t", approval: { kind: "approved", headSha: APPROVED }, unreviewed: ["m merge"] }, want: "advance:check-merge" },
    { name: "verify-head: Review did not approve → Build", p: state("verify-head"),
      obs: { state: "verify-head", dirty: [], head: HEAD, tree: "t", approval: { kind: "not-approved", why: "its verdict is \"changes-requested\"" }, unreviewed: [] }, want: "to-build:not-approved" },
    { name: "verify-head: no reviewApproval at all → the agent runs Finish as before", p: state("verify-head"),
      obs: { state: "verify-head", dirty: [], head: HEAD, tree: "t", approval: { kind: "none" }, unreviewed: [] }, want: "agent" },
    // check-merge
    { name: "check-merge: the head already contains the base tip → push", p: state("check-merge"), obs: { state: "check-merge", baseTip: TIP, contains: true, merge: null }, want: "advance:push" },
    { name: "check-merge: the base moved, clean merge, same diff → Agetor merges it in", p: state("check-merge"), obs: { state: "check-merge", baseTip: TIP2, contains: false, merge: clean }, want: "merge-base" },
    { name: "check-merge: conflicts → Build", p: state("check-merge"), obs: { state: "check-merge", baseTip: TIP2, contains: false, merge: { conflicts: ["a.ts"], samePatch: false, commit: null } }, want: "to-build:conflict" },
    { name: "check-merge: clean but the change's diff would differ → publish the approved head as it is", p: state("check-merge"),
      obs: { state: "check-merge", baseTip: TIP2, contains: false, merge: { conflicts: null, samePatch: false, commit: MERGED } }, want: "advance:push" },
    { name: "check-merge: git could not try the merge → wait", p: state("check-merge"), obs: { state: "check-merge", baseTip: TIP2, contains: false, merge: null }, want: "wait" },
    // hold-base: no longer entered; a visit saved in it pushes, whatever the base does
    { name: "hold-base (saved by an older build): base green → push", p: state("hold-base"), obs: { state: "hold-base", baseTip: TIP, checks: green }, want: "advance:push" },
    { name: "hold-base (saved by an older build): base red → push anyway; classify parks it only if it fails the same checks", p: state("hold-base"), obs: { state: "hold-base", baseTip: TIP, checks: redOwn }, want: "advance:push" },
    { name: "hold-base (saved by an older build): the base moved → push; it doesn't chase the base", p: state("hold-base"), obs: { state: "hold-base", baseTip: TIP2, checks: green }, want: "advance:push" },
    // push
    { name: "push: nothing on the remote yet", p: state("push"), obs: { state: "push", branch: "claude/x", localHead: HEAD, remoteHead: null, remoteIsAncestor: false }, want: "push" },
    { name: "push: the remote already has this head → skip", p: state("push"), obs: { state: "push", branch: "claude/x", localHead: HEAD, remoteHead: HEAD, remoteIsAncestor: true }, want: "advance:pr" },
    { name: "push: the remote is behind → fast-forward push", p: state("push"), obs: { state: "push", branch: "claude/x", localHead: HEAD, remoteHead: TIP, remoteIsAncestor: true }, want: "push" },
    { name: "push: the remote diverged → the owner; never a force-push", p: state("push"), obs: { state: "push", branch: "claude/x", localHead: HEAD, remoteHead: TIP, remoteIsAncestor: false }, want: "owner" },
    { name: "push: the remote holds the same change (GitHub's Update branch) → take that commit", p: state("push"), obs: { state: "push", branch: "claude/x", localHead: HEAD, remoteHead: TIP, remoteIsAncestor: false, remoteSameChange: true }, want: "adopt-remote" },
    { name: "push: HEAD is no longer the verified head → verify again", p: state("push"), obs: { state: "push", branch: "claude/x", localHead: MERGED, remoteHead: null, remoteIsAncestor: false }, want: "advance:verify-head" },
    { name: "push: the card's branch is the base → never", p: state("push"), obs: { state: "push", branch: "develop", localHead: HEAD, remoteHead: null, remoteIsAncestor: false }, want: "owner" },
    { name: "push: the card's branch is main → never", p: state("push", { base: "develop" }), obs: { state: "push", branch: "main", localHead: HEAD, remoteHead: null, remoteIsAncestor: false }, want: "owner" },
    // pr
    { name: "pr: none → open a draft", p: state("pr", { pr: null }), obs: { state: "pr", pull: null }, want: "open-pr" },
    { name: "pr: only a closed one → open a new draft", p: state("pr", { pr: null }), obs: { state: "pr", pull: pull({ state: "closed" }) }, want: "open-pr" },
    { name: "pr: open at the pushed head", p: state("pr", { pr: null }), obs: { state: "pr", pull: pull() }, want: "advance:wait-ci" },
    { name: "pr: GitHub has not shown the push yet", p: state("pr"), obs: { state: "pr", pull: pull({ headSha: TIP }) }, want: "wait" },
    { name: "pr: still not shown after ten minutes → the owner", p: state("pr", { stateSince: NOW - PUBLISH_PR_LAG_MS - 1 }), obs: { state: "pr", pull: pull({ headSha: TIP }) }, want: "owner" },
    { name: "pr: already merged → the owner", p: state("pr"), obs: { state: "pr", pull: pull({ state: "merged" }) }, want: "owner" },
    // wait-ci
    { name: "wait-ci: all green", p: state("wait-ci"), obs: { state: "wait-ci", pull: pull(), checks: green }, want: "advance:finalize" },
    { name: "wait-ci: still running", p: state("wait-ci"), obs: { state: "wait-ci", pull: pull(), checks: [check("web", "success", 1, 1), check("lab", null, 1, 2)] }, want: "wait" },
    { name: "wait-ci: a failure while others still run → wait for the whole picture", p: state("wait-ci"), obs: { state: "wait-ci", pull: pull(), checks: [check("web", "failure", 1, 1), check("lab", null, 1, 2)] }, want: "wait" },
    { name: "wait-ci: failed and finished → classify", p: state("wait-ci"), obs: { state: "wait-ci", pull: pull(), checks: redOwn }, want: "advance:classify" },
    { name: "wait-ci: the 2026-10-13 stall — a cancelled duplicate beside a newer success is green",
      p: state("wait-ci"), obs: { state: "wait-ci", pull: pull(), checks: [check("required", "cancelled", 1, 1), check("required", "success", 2, 2), check("web", "success", 2, 3)] }, want: "advance:finalize" },
    { name: "wait-ci: the newest run is cancelled and nothing is running → re-run once", p: state("wait-ci"), obs: { state: "wait-ci", pull: pull(), checks: [check("web", "success", 1, 1), check("required", "cancelled", 2, 2)] }, want: "rerun:cancelled" },
    { name: "wait-ci: cancelled again after the one re-run → the owner",
      p: state("wait-ci", { reran: [{ head: HEAD, why: "cancelled", at: NOW - PUBLISH_RERUN_SETTLE_MS - 1 }] }),
      obs: { state: "wait-ci", pull: pull(), checks: [check("required", "cancelled", 2, 2)] }, want: "owner" },
    { name: "wait-ci: a re-run was just requested and GitHub still shows the old result → wait",
      p: state("wait-ci", { reran: [{ head: HEAD, why: "infra", at: NOW - 60_000 }] }), obs: { state: "wait-ci", pull: pull(), checks: redOwn }, want: "wait" },
    { name: "wait-ci: a re-run of another head does not excuse this one",
      p: state("wait-ci", { reran: [{ head: TIP, why: "infra", at: NOW - 60_000 }] }), obs: { state: "wait-ci", pull: pull(), checks: redOwn }, want: "advance:classify" },
    { name: "wait-ci: no check yet", p: state("wait-ci"), obs: { state: "wait-ci", pull: pull(), checks: [] }, want: "wait" },
    { name: "wait-ci: no check after twenty minutes → the owner", p: state("wait-ci", { stateSince: NOW - PUBLISH_NO_CHECKS_MS - 1 }), obs: { state: "wait-ci", pull: pull(), checks: [] }, want: "owner" },
    { name: "wait-ci: someone else pushed to the branch → the owner", p: state("wait-ci"), obs: { state: "wait-ci", pull: pull({ headSha: TIP }), checks: green }, want: "owner" },
    { name: "wait-ci: the PR was closed → the owner", p: state("wait-ci"), obs: { state: "wait-ci", pull: pull({ state: "closed" }), checks: green }, want: "owner" },
    // classify
    { name: "classify: the job passes on the base → the change's own → Build", p: state("classify"), obs: { state: "classify", checks: redOwn, baseCommits: [[check("web", "success")]], infra: null }, want: "to-build:ci" },
    { name: "classify: the base never ran the job → the change's own → Build", p: state("classify"), obs: { state: "classify", checks: redOwn, baseCommits: [[check("lint", "success")]], infra: null }, want: "to-build:ci" },
    { name: "classify: the base fails the same job → base-red, no agent", p: state("classify"), obs: { state: "classify", checks: redOwn, baseCommits: [[check("web", "failure")]], infra: null }, want: "advance:base-red" },
    { name: "classify: the base is still running that job → undecided, wait", p: state("classify"), obs: { state: "classify", checks: redOwn, baseCommits: [[check("web", null)]], infra: null }, want: "wait" },
    { name: "classify: one inherited, one its own → Build",
      p: state("classify"), obs: { state: "classify", checks: [check("web", "failure", 1, 1), check("lab", "failure", 1, 2)], baseCommits: [[check("web", "failure"), check("lab", "success", 1, 2)]], infra: null }, want: "to-build:ci" },
    { name: "classify: a runner fault → re-run the failed jobs", p: state("classify"), obs: { state: "classify", checks: redOwn, baseCommits: [[check("web", "success")]], infra: "web: \"ECONNRESET\"" }, want: "rerun:infra" },
    { name: "classify: a second runner fault on the same head → re-run again",
      p: state("classify", { reran: [{ head: HEAD, why: "infra", at: NOW - 3_600_000 }] }), obs: { state: "classify", checks: redOwn, baseCommits: [[check("web", "success")]], infra: "web: \"ECONNRESET\"" }, want: "rerun:infra" },
    { name: "classify: a third runner fault on the same head → judged like any failure",
      p: state("classify", { reran: [{ head: HEAD, why: "infra", at: NOW - 7_200_000 }, { head: HEAD, why: "infra", at: NOW - 3_600_000 }] }), obs: { state: "classify", checks: redOwn, baseCommits: [[check("web", "success")]], infra: "web: \"ECONNRESET\"" }, want: "to-build:ci" },
    { name: "classify: only the roll-up failed → re-run once", p: state("classify"), obs: { state: "classify", checks: [check("required", "failure", 1, 2), check("web", "skipped", 1, 1)], baseCommits: [], infra: null }, want: "rerun:cancelled" },
    { name: "classify: the checks are no longer failing (a re-run landed) → back to waiting", p: state("classify"), obs: { state: "classify", checks: green, baseCommits: [], infra: null }, want: "advance:wait-ci" },
    // base-red
    { name: "base-red: the base still fails the job → stay", p: state("base-red", { inherited: ["web"] }), obs: { state: "base-red", baseTip: TIP, baseCommits: [[check("web", "failure")]] }, want: "wait" },
    { name: "base-red: a new base commit still fails it → stay", p: state("base-red", { inherited: ["web"] }), obs: { state: "base-red", baseTip: TIP2, baseCommits: [[check("web", "failure")]] }, want: "wait" },
    { name: "base-red: the base is re-running it → stay", p: state("base-red", { inherited: ["web"] }), obs: { state: "base-red", baseTip: TIP, baseCommits: [[check("web", null)]] }, want: "wait" },
    { name: "base-red: the base passes it now → refresh, by itself", p: state("base-red", { inherited: ["web"] }), obs: { state: "base-red", baseTip: TIP2, baseCommits: [[check("web", "success")]] }, want: "advance:refresh" },
    { name: "base-red: one of two inherited jobs still fails → stay", p: state("base-red", { inherited: ["web", "lab"] }), obs: { state: "base-red", baseTip: TIP2, baseCommits: [[check("web", "success"), check("lab", "failure", 1, 2)]] }, want: "wait" },
    // refresh (owner decision 1)
    { name: "refresh: the base moved, clean merge, same diff → Agetor merges it in", p: state("refresh"), obs: { state: "refresh", baseTip: TIP2, contains: false, merge: clean }, want: "merge-base" },
    { name: "refresh: the merge conflicts → Build, as today", p: state("refresh"), obs: { state: "refresh", baseTip: TIP2, contains: false, merge: { conflicts: ["a.ts"], samePatch: false, commit: null } }, want: "to-build:conflict" },
    { name: "refresh: the merge changes the change's own diff → Build, as today", p: state("refresh"), obs: { state: "refresh", baseTip: TIP2, contains: false, merge: { conflicts: null, samePatch: false, commit: MERGED } }, want: "to-build:changed-diff" },
    { name: "refresh: the base recovered with no new commit → re-run the failed jobs", p: state("refresh"), obs: { state: "refresh", baseTip: TIP, contains: true, merge: null }, want: "rerun:base-recovered" },
    { name: "refresh: already re-run for this head → judge the result again",
      p: state("refresh", { reran: [{ head: HEAD, why: "base-recovered", at: NOW - 3_600_000 }] }), obs: { state: "refresh", baseTip: TIP, contains: true, merge: null }, want: "advance:wait-ci" },
    // finalize
    { name: "finalize: green for the published head → the agent writes", p: state("finalize"), obs: { state: "finalize", pull: pull(), checks: green }, want: "write" },
    { name: "finalize: no longer green → back to waiting", p: state("finalize"), obs: { state: "finalize", pull: pull(), checks: redOwn }, want: "advance:wait-ci" },
    { name: "finalize: the PR moved to another head → the owner", p: state("finalize"), obs: { state: "finalize", pull: pull({ headSha: TIP }), checks: green }, want: "owner" },
    // any state
    { name: "git or GitHub unreadable → wait, never guess", p: state("wait-ci"), obs: { state: "unreadable", what: "the pull request's checks" }, want: "wait" },
    { name: "an action that keeps failing → the owner", p: state("push", { tries: PUBLISH_MAX_TRIES }), obs: { state: "push", branch: "claude/x", localHead: HEAD, remoteHead: null, remoteIsAncestor: false }, want: "owner" },
    { name: "an observation of another state changes nothing", p: state("push"), obs: { state: "pr", pull: pull() }, want: "wait" },
  ];
  for (const c of cases) {
    test(c.name, () => expect(kind(decidePublish(c.p, c.obs, NOW))).toBe(c.want));
  }

  test("classify tells Build which checks are its own and which are the base's", () => {
    const a = decidePublish(state("classify"), {
      state: "classify", checks: [check("web", "failure", 1, 1), check("lab", "failure", 1, 2), check("required", "failure", 1, 3)],
      baseCommits: [[check("web", "failure"), check("lab", "success", 1, 2)]], infra: null,
    }, NOW);
    expect(a.kind === "to-build" && a.cause.kind === "ci" ? { own: a.cause.checks.map((c) => c.name), inherited: a.cause.inherited } : null)
      .toEqual({ own: ["lab"], inherited: ["web"] });
  });

  test("the base-red wait says what is failing and that nothing is spent; no text of the step is involved", () => {
    const a = decidePublish(state("base-red", { inherited: ["web / vitest"] }), { state: "base-red", baseTip: TIP, baseCommits: [[check("web / vitest", "failure")]] }, NOW);
    expect(a).toEqual({
      kind: "wait", set: { baseTip: TIP },
      note: "develop is failing web / vitest — parked: no agent, no step slot, no attempt spent. Agetor re-tests this change when develop is green",
    });
  });
});

describe("applyPublish: an action's result folded into the state", () => {
  test("advance enters the state with a fresh clock and no failed attempts", () => {
    const next = applyPublish(state("verify-head", { tries: 3 }), { kind: "advance", to: "check-merge", set: { head: HEAD } }, { ok: true }, NOW);
    expect(next).toMatchObject({ state: "check-merge", stateSince: NOW, tries: 0, head: HEAD, note: "checking that it merges with the base" });
  });
  test("a wait changes the note and nothing else — no attempt is counted, however long it lasts", () => {
    const p = state("base-red", { inherited: ["web"], tries: 0 });
    let next = p;
    for (let i = 0; i < 500; i++) next = applyPublish(next, { kind: "wait", note: "develop is failing web" }, { ok: true }, NOW + i * 60_000);
    expect(next).toEqual({ ...p, note: "develop is failing web" });
  });
  test("a push that worked moves to the PR; one that failed is counted and tried again", () => {
    expect(applyPublish(state("push"), { kind: "push" }, { ok: true }, NOW).state).toBe("pr");
    const failed = applyPublish(state("push", { tries: 1 }), { kind: "push" }, { ok: false, error: "remote: rejected\n  (hook declined)" }, NOW);
    expect(failed).toMatchObject({ state: "push", tries: 2, note: `the push failed (attempt 2 of ${PUBLISH_MAX_TRIES}): remote: rejected (hook declined)` });
  });
  test("merging the base in: the published head becomes the merge and the approval is carried", () => {
    const next = applyPublish(state("refresh"), { kind: "merge-base", commit: MERGED, baseTip: TIP2, then: "push" }, { ok: true, head: MERGED, tree: "f".repeat(40) }, NOW);
    expect(next).toMatchObject({ state: "push", head: MERGED, approvedHead: APPROVED, carried: 1, baseTip: TIP2, tree: "f".repeat(40) });
    expect(approvedHeadFor(next, MERGED)).toBe(APPROVED);
    expect(approvedHeadFor(next, HEAD)).toBe(HEAD); // some other head is only itself
    expect(approvedHeadFor(state("wait-ci"), HEAD)).toBe(HEAD);
    expect(approvedHeadFor(undefined, HEAD)).toBe(HEAD);
  });
  test("a re-run is remembered per head and reason, and the visit waits for CI again", () => {
    expect(applyPublish(state("push"), { kind: "adopt-remote", commit: TIP }, { ok: true, tree: "t2" }, NOW)).toMatchObject({ state: "pr", head: TIP, tree: "t2" });
    expect(applyPublish(state("push"), { kind: "adopt-remote", commit: TIP }, { ok: false, error: "x" }, NOW)).toMatchObject({ state: "push", tries: 1 });
    const next = applyPublish(state("classify"), { kind: "rerun", why: "infra", reason: "x" }, { ok: true }, NOW);
    expect(next).toMatchObject({ state: "wait-ci", reran: [{ head: HEAD, why: "infra", at: NOW }] });
    expect(applyPublish(state("classify"), { kind: "rerun", why: "infra", reason: "x" }, { ok: false, error: "403" }, NOW)).toMatchObject({ state: "classify", tries: 1 });
  });
  test("opening the PR records it", () => {
    const next = applyPublish(state("pr", { pr: null }), { kind: "open-pr" }, { ok: true, pr: { number: 9, url: "u" } }, NOW);
    expect(next).toMatchObject({ state: "wait-ci", pr: { number: 9, url: "u" } });
  });
  test("leaving for Build, the writer, the agent or the owner is the runner's to record", () => {
    const p = state("classify");
    for (const a of [{ kind: "write" }, { kind: "owner", why: "x" }, { kind: "agent", why: "x" }, { kind: "to-build", cause: { kind: "changed-diff" } }] as PublishAction[]) {
      expect(applyPublish(p, a, { ok: true }, NOW)).toBe(p);
    }
  });
});

describe("a visit and the agent execution it ends in", () => {
  test("over once that execution has left the run; a new launch of the step starts a new visit", () => {
    expect(publishVisitOver(undefined, "finish", [])).toBe(true);
    expect(publishVisitOver(state("wait-ci"), "finish", [])).toBe(false); // held: no execution yet
    expect(publishVisitOver(state("write"), "finish", [])).toBe(false); // the writer is queued for a slot
    expect(publishVisitOver(state("write", { seq: 9 }), "finish", [9])).toBe(false);
    expect(publishVisitOver(state("write", { seq: 9 }), "finish", [])).toBe(true);
    expect(publishVisitOver(state("agent", { seq: 9 }), "finish", [12])).toBe(true);
    expect(publishVisitOver(state("wait-ci"), "other-step", [])).toBe(true);
  });
});

describe("what Build, the writer and the pull request are told", () => {
  const facts = {
    branch: "claude/x", base: "develop", pr: { number: 7, url: "https://github.com/o/r/pull/7" }, head: MERGED, tree: "e".repeat(40),
    approvedHead: APPROVED, carried: 1, baseTip: TIP2, checks: [{ name: "web", conclusion: "success", url: "https://ci/1" }], reran: [],
  };
  test("a head Review has not seen is listed for Build, with the rule", () => {
    const h = publishBuildHandoff({ kind: "unapproved-head", head: MERGED, approvedHead: APPROVED, commits: ["c0ffee1 fix: late"] }, { base: "develop", next: "verification failed" });
    expect(h.next).toBe("verification failed");
    expect(h.status).toBe("done");
    expect(h.summary).toContain("- c0ffee1 fix: late");
    expect(h.summary).toContain("do not push");
    expect(h.purpose).toBe("Verification failed: HEAD is not the head Review approved");
  });
  test("the fallback when the base's merge changes the diff asks Build to merge origin/<base>", () => {
    const h = publishBuildHandoff({ kind: "changed-diff" }, { base: "develop", next: "Build" });
    expect(h.summary).toContain("merge origin/develop into this branch");
  });
  test("the evidence comment is Agetor's facts, and says when the approval was carried over", () => {
    const body = publishEvidenceComment(facts);
    expect(body).toContain(`Head: \`${MERGED}\``);
    expect(body).toContain(`Approved by Review: \`${APPROVED}\`. Agetor merged \`origin/develop\` into it once`);
    expect(body).toContain("- web: success — https://ci/1");
    expect(publishEvidenceComment({ ...facts, head: APPROVED, carried: 0 })).toContain("the head published");
  });
  test("the writer is told what is done and that it only writes", () => {
    const brief = publishWriterBrief({ ...facts, issueUrl: "https://github.com/o/r/issues/3", factsPosted: true, markedReady: true });
    expect(brief).toContain("gh pr edit 7 --body-file");
    expect(brief).toContain("Do not push, commit, merge, rebase or amend");
    expect(brief).toContain('"next": null');
    expect(brief).toContain("https://github.com/o/r/pull/7");
    expect(brief).toContain("with origin/develop merged in by Agetor");
  });
});

// The trial's preference named the pipeline "Change"; the pipeline is called
// "Change: Understand, Build, Review, Finish". Nothing matched, and nothing said so.
describe("pipeline_gates entries that match nothing", () => {
  const known = {
    pipelines: [{ id: "deec4252", name: "Change: Understand, Build, Review, Finish" }, { id: "5e82ae3d", name: "Branch Review" }],
    hasCard: (id: string) => id === "card-1",
  };
  const pref = (v: unknown) => JSON.stringify(v);
  const cases: [string, unknown, { pipelines: string[]; cards: string[] }][] = [
    ["a prefix of a name is not the name", { publish: { pipelines: ["Change"] } }, { pipelines: ["publish: Change"], cards: [] }],
    ["the whole name, in any case", { publish: { pipelines: ["change: understand, build, review, finish"] } }, { pipelines: [], cards: [] }],
    ["the id", { steps: { pipelines: ["deec4252"] } }, { pipelines: [], cards: [] }],
    ["a prefix of an id is not the id", { steps: { pipelines: ["deec"] } }, { pipelines: ["steps: deec"], cards: [] }],
    ["each gate is reported by name", { publish: { pipelines: ["Change"] }, steps: { pipelines: ["Change", "Branch review"] } }, { pipelines: ["publish: Change", "steps: Change"], cards: [] }],
    ["a card id no task has", { publish: { pipelines: ["deec4252"], cards: ["card-1", "card-9"] } }, { pipelines: [], cards: ["publish: card-9"] }],
    ["`preload` is switched and checked the same way", { preload: { pipelines: ["Change", "deec4252"], cards: ["card-1", "card-9"] } }, { pipelines: ["preload: Change"], cards: ["preload: card-9"] }],
    ["nothing set", null, { pipelines: [], cards: [] }],
  ];
  for (const [name, value, want] of cases) {
    test(name, () => expect(unmatchedGateRefs(value === null ? null : pref(value), known)).toEqual(want));
  }

  test("`preload` has its own entry: off unless named, a trial list when `cards` is there, and independent of the gates", () => {
    const card = { id: "card-1", pipelineId: "deec4252", pipelineName: "Change: Understand, Build, Review, Finish" };
    const on = (v: unknown) => publishGateOn(parsePipelineGate(pref(v), "preload"), card);
    const cases: [unknown, boolean][] = [
      [{}, false],
      [{ publish: { pipelines: ["deec4252"] }, steps: { pipelines: ["deec4252"] } }, false],
      [{ preload: { pipelines: ["deec4252"] } }, true],
      [{ preload: { pipelines: ["change: understand, build, review, finish"] } }, true],
      [{ preload: { pipelines: ["Change"] } }, false],
      [{ preload: { pipelines: ["deec4252"], cards: ["card-1", "card-2"] } }, true],
      [{ preload: { pipelines: ["deec4252"], cards: ["card-2"] } }, false],
      [{ preload: { pipelines: ["deec4252"], cards: "card-1" } }, false],
      [{ preload: { cards: ["card-1"] } }, false],
      [{ preload: true }, false],
    ];
    for (const [value, want] of cases) expect(`${JSON.stringify(value)} → ${on(value)}`).toBe(`${JSON.stringify(value)} → ${want}`);
  });

  test("the switch itself takes an id or the exact name, never a prefix", () => {
    const card = { id: "card-1", pipelineId: "deec4252", pipelineName: "Change: Understand, Build, Review, Finish" };
    const on = (pipelines: string[]) => publishGateOn(parsePublishGate(pref({ publish: { pipelines } })), card);
    expect(on(["Change"])).toBe(false);
    expect(on(["deec"])).toBe(false);
    expect(on(["CHANGE: understand, build, review, finish"])).toBe(true);
    expect(on(["deec4252"])).toBe(true);
  });

  test("one line names what did not match, and nothing is said when all did", () => {
    expect(gateUnmatchedLine({ pipelines: [], cards: [] })).toBeNull();
    const line = gateUnmatchedLine({ pipelines: ["publish: Change"], cards: ["publish: card-9"] })!;
    expect(line).toContain('no pipeline has the id or the exact name "Change"');
    expect(line).toContain('no card has the id "card-9"');
  });
});

test("parked cards re-test against a recovered base a few at a time", async () => {
  const { refreshAllowed, REFRESH_BURST, REFRESH_WINDOW_MS } = await import("./publish.ts");
  expect(REFRESH_BURST).toBe(3);
  const now = 1_000_000_000;
  expect(refreshAllowed([], now)).toBe(true);
  expect(refreshAllowed([now - 1, now - 2], now)).toBe(true);
  expect(refreshAllowed([now - 1, now - 2, now - 3], now)).toBe(false);
  // Grants older than the window no longer count.
  expect(refreshAllowed([now - REFRESH_WINDOW_MS, now - REFRESH_WINDOW_MS - 1, now - 3], now)).toBe(true);
});
