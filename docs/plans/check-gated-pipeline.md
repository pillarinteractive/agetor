# Design — Check-gated pipeline loop

| Field | Value |
| --- | --- |
| Date | 2026-10-13 |
| Status | Proposal for the owner. No production code changes with this document. |
| Base | `release` at `56e9adb` |
| Location | `docs/plans/`, where this repository already keeps designs (`pipelines.md`, `global-owner-and-test-caps.md`); no `docs/design/` was created. |
| Evidence | Source on `release`; the live board's database, block log and await records, read-only, on 2026-10-13. |

## 1. Summary

1. Today a step advances on what its agent says in a handoff block. The proposal: a step advances when checks that Agetor runs itself pass, and a failed check goes back to the same step.
2. Stage 0 (new, small): fix the two merge-queue faults that need no new model, the cancelled-duplicate roll-up and merging on stale green.
3. Stage 1: Finish becomes Agetor code. It verifies the approved head, pushes once, waits for CI, decides whose failure it is and parks without an agent while the base is red.
4. Stage 2: cheap checks on Build and Review. Stage 3: resume, restart and rewind find the card's position from those checks.
5. Decision asked for: approve this order and answer the six questions in section 10. Question 1 decides whether Stage 1 removes the Finish → Build loop or only the owner escalations.

## 2. How the loop works today

A pipeline is a graph stored in `pipelines.graph`. `startPipelineRun` (`src/bun/pipeline-runner.ts`) freezes a copy on the card (`PipelineRunSnapshot`). `launchStep` starts every step visit as a new hidden task with a new agent session and a prompt from `composeStepPrompt` (`src/shared/pipeline.ts`): the card's prompt as "Overall goal", the sender's handoff and report, the step's instructions and the handoff contract.

When the turn ends, `settleStepRun` reads the agent's text and `classifyStepResponse` sorts it:

- A valid handoff: `resolveNextSteps` follows the edge its `next` field names.
- A handoff with `status: "blocked"`: the run stays on the step. `scheduleBlockWait` calls `classifyBlock` (`src/shared/block-wait.ts`), which reads `waitingOn`, `waitingRef`, `openQuestions` and the prose, and sends the card to the owner or to the wait queue (`releaseBlockWaits`, every 30 s).
- No handoff: if the step started a command with `agetor-await`, it is parked and woken by `awaitTick` (`src/bun/awaits.ts`). Otherwise `attemptHandoffReminderOrBlock` sends one reminder, then blocks.

The only bound on loops is the launch count: `run.stepCount` against `effectiveStepCap`. Change has `maxSteps` 14, doubled once automatically to 28, then `capWrapUp`.

Agetor does not look at the worktree at a step boundary. The exceptions are hardcoded for Pillar by step name: `launchStep` appends an approval note when `step.name` is `Review` or `Finish` under `managedPillarRoot`; `settleStepRun` reroutes a Review with `reviewRequiresRepair`; Autopilot's `reviewedPillarPipeline` (`src/bun/autopilot.ts`) calls `reviewApprovalMatches` to compare Review's `reviewApproval.headSha` with the PR head before sign-off. These are gates already. This design makes them declared and general.

After the run is done, the PR watcher (`src/bun/pr-watch.ts`), the merge queue (`src/bun/merge-queue.ts`), merge trains and `src/bun/merge-rework.ts` take over. `merge-rework.ts` already decides whose CI failure it is (the base's, the runner's or the change's), but only for a run whose status is `done`. While Finish is running, its agent makes the same decision from prose instructions.

### Why each incident happened

| # | What happened | Cause in the code |
| --- | --- | --- |
| 1 | Review blocked, asking the owner for permission to push to get CI for its head. Block log, 10-12 13:46: "Await clarification of contradictory verification instructions: no push/PR versus mandatory pushed-head CI". | Nothing in the core owns "obtain CI for this head". Only an agent could push, and the prompts forbade Review. `openPrDirectly` (`pr-watch.ts`) can push and open a PR without an agent, but is called only after the run is done. |
| 2 | Finish blocked "waiting for CI on develop"; four timed retries, then the owner. Live card #1351: `wait = {category: "dependency", source: "declared", ref: "CI on develop", attempt 1 of 4}`. | The Finish prompt tells the agent to write `waitingRef` "CI on develop". `classifyBlock` returns at the declared `dependency` branch with that text as `ref`. The branch that sets `ref: "base-ci"` is below it and is reached only when the step declared nothing. `waitHasTrigger` and `waitTriggerState` match only `base-ci` or `#123`, so the wait has no watcher and runs on `DEFAULT_BLOCK_WAIT.backoffMin.dependency` = 30, 60, 120, 240 min. 23 Finish blocks in two days name develop's CI. |
| 3 | "Build finished but never emitted a handoff block". | `attemptHandoffReminderOrBlock` allows one reminder per execution, then records `handoff-missing` for the owner. Agetor never checks whether the work is there. Three days: 17 on Build, 7 on Finish. |
| 4 | Runs reached the 28- and 34-step caps. | Every correction is a new launch counted by `stepCount`. A CI failure costs three (Build, Review, Finish). A red base costs the same: the prompt forbids Finish to change the head, so once develop is green it must send the card to Build only to merge develop. Live card #1293: Understand, then eleven Build → Review → Finish rounds, 36 launches. Of 231 `ci-wait` runs, 63 ended in a CI failure and 40 in "conflicts with base". |
| 5 | Restart re-ran Understand and Build. | `startPipelineRun` with `restart` archives every step task, sets `history: []` and launches `resolveStartStep`. The worktree and its commits remain, and nothing reads them. `refreshPipelineInstructions` (added 10-13) copies step text only. |
| 6 | PRs merged on checks older than a new rule on develop. | Deliberate in `nextMergeStep`: "A green PR that's merely behind merges as it is". `trainEligible` needs only `pr.checks === "success"`. A merge train tests the combined result, but a lone PR does not ride one, and `disband` (`src/bun/merge-train.ts`) marks a failed train's members with `trainSkip` so each merges alone on its old result. |
| 7 | A cancelled duplicate run kept green PRs "pending" for four hours. | `rollUpChecks` returns `pending` when any check run has `conclusion === "cancelled"`. `getGitHubPullChecks` returns every check run of the head commit, and nothing groups them by name. Pillar's CI uses `cancel-in-progress` for pull requests, so a second run on the same commit leaves a cancelled twin. |
| 8 | Two cards stayed blocked after their CI wait finished. | `readyToWake` wakes a step only under an `await`, `handoff-missing` or `handoff-invalid` block. A step that ends its turn with a blocked handoff while `ci-wait` is still running gets `step-blocked`, which is woken only through `resourceBlockedAwaits`, and that requires a declared `resource` wait. Finish declares `dependency`. Five finished `ci` awaits from 10-12 and 10-13 have no `notified` marker. |

## 3. The proposed model

A **check** is a test of the work that Agetor runs and whose result Agetor records. A **gate** is a step's set of required checks: the step is finished when they pass.

```ts
interface StepCheck {
  id: string;            // unique within the step: "head-approved"
  description: string;   // one line: shown on the card and in the feedback
  run:
    | { kind: "builtin"; name: BuiltinCheck }
    | { kind: "command"; command: string };  // in the card's worktree; exit 0 passes
  dependsOn?: string[];  // runs only after these passed; cheap checks first
  skipWhen?: "unchanged-since-pass";  // reuse a recorded pass for the same key
  required: boolean;     // false: reported, never gates
  timeoutSec: number;    // commands: default 120, at most 600
}
type BuiltinCheck =
  | "tree-clean" | "diff-nonempty" | "review-verdict" | "head-approved"
  | "merges-with-base" | "head-published" | "pr-required-check";

interface PipelineStep {
  // existing fields, plus:
  goal?: string;         // the outcome this step must reach, one or two sentences
  checks?: StepCheck[];
  maxTurns?: number;     // check-feedback turns in one visit; default 2
  runner?: "agent" | "publish";   // Stage 1: "publish" is run by Agetor
}
```

**Goal and prompt.** The card-level goal exists (`composeStepPrompt` renders the card's prompt as "Overall goal"). The step `goal` is new: what must be true when the step ends. `instructions` stay as the how. The goal is repeated in every feedback turn.

**Where results are stored.** One append-only file per run generation, `<data dir>/pipeline-runs/<card>/checks-<generation>.jsonl`, written only by the core. A line holds the step, the visit (`seq`), the turn, the check id, the outcome (`pass`, `fail`, `skip`, `waived`, `halt`, `void`), the key it was computed for (HEAD commit, HEAD tree hash, base tip, a hash of the check's definition), the exit code and the output's tail and path. It is a file because `parsePipelineRunState` (`src/bun/db.ts`) rebuilds the run field by field and drops fields it does not know, so an older build after a rollback would erase results kept in the run. `decisions-<runStartedAt>.json` and `merge_queue_rework_state` are stored outside the run for the same reason. The run itself gains one small field, `publish` (section 4).

**Trust order.** A gate recomputes from the tree when it can (`tree-clean`, `head-approved`, `merges-with-base`). The ledger is used only to skip a command whose key is unchanged. A file the agent names is a place to look and proves nothing. The ledger cannot be made unwritable for agents on macOS without a sandbox, so it is never the strongest evidence.

**How a result reaches the next turn.** Failed required checks are sent to the step's own session with `sendInput`, as the handoff reminder and `awaitResultMessage` are today: the step goal, each failed check's id, description, exit code and last 60 lines, and the log path. After `maxTurns` the run blocks with a new kind `check-failed`.

The default is 2 because a same-session turn is not cheap here. FORK.md's cost section measures a Build session at 364k tokens on average, against about 50k for a fresh one, and each visit is a fresh session on purpose.

**Handoffs during migration.**

| Handoff field | Under gates |
| --- | --- |
| `summary`, `purpose`, `reason`, `artifacts` | Unchanged: context for the next step and the PR text. |
| `reviewApproval.verdict`, `findings`, `acceptanceComplete` | Authoritative. A reviewer's judgment is the one thing Agetor cannot recompute. |
| `reviewApproval.headSha` | Checked against `git rev-parse HEAD` at settle. Agetor records the tree hash itself. |
| `next` | Used only where no gate decides the edge (Understand's "trivial change made"). Review's edge follows its verdict. |
| `status: "blocked"`, `waitingOn`, `waitingRef` | Not authoritative for anything Agetor can observe: CI, the base, the head. Still honoured for `owner`, leases and unknown causes through the existing wait queue. |
| `openQuestions` | Unchanged: the owner's. |

## 4. Stage 1 — Finish run by Agetor

The Finish prompt already lists this procedure as six numbered steps ("One push, then CI"). Stage 1 moves that list into code. It needs no `checks` schema: Finish becomes a step with `runner: "publish"`, and the graph, its edges and the card's strip are unchanged. Its state is `run.publish = { state, head, tree, baseTip, pr, since, reran }`, read on every pass of the PR watcher's loop, so a core restart loses nothing.

| State | Evidence Agetor computes | Next |
| --- | --- | --- |
| `verify-head` | `git status --porcelain` shows no tracked change; HEAD equals the last Review's `reviewApproval.headSha` (`reviewApprovalMatches`). | Pass → `check-merge`. Fail → Build on the "verification failed" edge, with the unreviewed commits listed. No agent turn. |
| `check-merge` | `git merge-tree --write-tree HEAD origin/<base>`. | Clean → `hold-base`. Conflicts → Build, with `conflictHandoff` (`merge-rework.ts`). |
| `hold-base` | The base tip's newest completed CI run. | Green or none → `push`. Red → stay: a push now would spend a run that must fail. |
| `push` | `git ls-remote` already shows HEAD → skip. Otherwise one push, as `openPrDirectly` does. | → `pr` |
| `pr` | `findGitHubPullForBranch`. None → create a draft. The body is written by one short agent turn, with `directPrBody` as the fallback. | → `wait-ci` |
| `wait-ci` | The head's check runs, newest per name. | `required` succeeded → `finalize`. Failed → `classify`. Newest is cancelled and nothing is running → re-run once. |
| `classify` | The control arm, below. | Runner fault → re-run the failed jobs once per head (`infraReason`). All inherited → `base-red`. Any of its own → Build, with `ciFailureHandoff`. |
| `base-red` | The base tip's runs for the inherited jobs. | Still failing → stay. No agent, no step slot, no retry count. Passing → `refresh`. |
| `refresh` | Question 1. | → `wait-ci` |
| `finalize` | `required` succeeded for `run.publish.head`. | Mark the PR ready, post the evidence comment (agent text, Agetor's facts), end the run. |

**The control arm** asks whether the unmodified base fails the same way. For each failing job on the head (a check run's name, leaving out the `required` roll-up as `ROLLUP_CHECKS` does), Agetor reads the newest completed run of the same job on the base tip. If the base tip did not run that job because the suite was not selected, it reads the most recent base commit that did, up to ten back.

- Failed there → **inherited**.
- Passed there → the change's own.
- Base run still in progress → undecided; wait.
- Never run on the base → the change's own.

Log text is never compared. A job name failing on both sides does not prove the same test failed. The cost of being wrong is a wait that ends when the base recovers, after which the job is judged again. This is `markInherited` and `ownFailures` from `pr-watch.ts`, applied during Finish and no longer only after the run is done. Log text is used only for the runner-fault decision, which exists (`INFRA_LOG_RE`) and costs one re-run when wrong.

**The `base-ci` mismatch cannot occur.** The wait is a state Agetor entered from its own observation. No handoff, no `waitingRef` and no `classifyBlock` is involved. The board can show one line, "develop red since 14:10 — 5 cards parked", in place of five escalations.

**Outcomes** are recorded as four kinds: pass; waiver (the owner advanced past a failed check; never counts as a pass for automatic merging); block (the change's own failure); halt (the base or a runner, no blame, no attempt spent).

**Stale green (Stage 0).** A green result is *fresh* when the base commit CI tested against is the base's current tip. The merge queue merges a PR only when its result is fresh or when it rides a merge train, whose CI tests the merged result. In code: `nextMergeStep` returns a train step for a green, stale PR; `buildTrain` accepts one member (today it and `shouldDepart` need two); `disband` after a CI failure sends members back as single trains, no longer to a direct merge.

The cost in CI runs: nothing when the base has not moved; one run per train as today when two or more PRs are ready; one extra run for a lone stale PR; and up to one per member after a failed train. A train of six that fails costs seven runs where today it costs one, and today's one is what lets a breaking PR through.

**Cancelled duplicates (Stage 0).** `rollUpChecks` groups runs by name and keeps the newest by `startedAt`, which `normalizeCheckRun` already provides and `ci-wait` already uses. A cancelled run counts only when it is the newest of its name.

**What the agent still does.** It writes the PR description and the wording of the evidence comment. It does not push, wait, classify or choose an edge.

| # | Prevented by |
| --- | --- |
| 1 | `push` and `wait-ci` belong to Agetor. Review's "pending CI" criterion has an owner that is not an agent. |
| 2 | `classify` → `base-red`: observed state, no ref, no timer attempts, resumes when the base's jobs pass. |
| 6 | The fresh-or-train rule in `nextMergeStep`, and `disband` no longer merging members directly. |
| 7 | Newest-per-name in `rollUpChecks`; `wait-ci` re-runs once when the newest `required` is cancelled. |
| 8 | `wait-ci` has no agent session to wake: the result is read from GitHub by the core's loop. |

## 5. Stage 2 — Checks on Build and Review

Verification stays in CI. Only checks that take seconds run on the Mac.

| Step | Check | How | Required |
| --- | --- | --- | --- |
| Build | `tree-clean` | no tracked changes | yes |
| Build | `diff-nonempty` | commits ahead of the merge base with the base branch | yes |
| Build | `static` | the project's own selector in a static-only mode (format, vet, typecheck of changed components) | no, until question 6 |
| Review | `tree-clean` | as above | yes |
| Review | `review-verdict` | the handoff has `reviewApproval`; its `headSha` is HEAD; "approved" has no findings (`reviewApprovalMatches`, without the Pillar-only conditions) | yes |

I could not confirm that Pillar's `verify_changed.py` has a static-only mode; its prompts forbid running it locally because it runs suites. Until it has one, Stage 2 ships with the built-in checks only.

**A missing handoff (incident 3).** The one reminder stays. If the handoff is still missing, Agetor runs the step's required checks. When they pass on Build, it composes a handoff from the step's final message, marked as composed (the path manual Advance already uses for a turn with no valid handoff), and advances to Review. Review cannot be composed, because the verdict is the evidence: a missing verdict fails `review-verdict` and costs a same-step turn.

**Same-step turns (incident 4).** These corrections stop being launches:

- A dirty tree or an approval for another head. Today Finish finds them and blocks or loops; the log shows "Review approved 9c65604f…, but publication requires approval of the exact HEAD".
- A static failure, once question 6 allows the check.
- A red base (Stage 1).

**What still routes back.** Review findings go to Build with the full report as today. A CI failure of the change's own and a real conflict go from Finish to Build. Review → Build gets `maxTraversals` (suggested 4), so the bound counts review rounds and not launches. A commit after an approval invalidates it by construction: `head-approved` is keyed on HEAD.

## 6. Stage 3 — Finding the position

`resolvePosition` walks the steps from the start along forward edges and stops at the first step whose gate is not satisfied.

| Step | Still satisfied when |
| --- | --- |
| Understand | A succeeded record with a handoff exists for this card. Handoff and report files survive a restart, which archives and does not delete. |
| Build | `tree-clean` and `diff-nonempty` pass now. |
| Review | A `review-verdict` pass exists whose key is the current HEAD. |
| Finish | `run.publish.head` is HEAD and `required` succeeded for it. |

What invalidates a result:

- A new commit voids Review and everything after it.
- A moved base voids only `merges-with-base` and CI freshness, subject to question 1.
- A changed check definition voids that check.
- Changed instruction text voids nothing. Text is not evidence. The owner uses Rewind when a new prompt should redo a step.

Restart resolves the position and offers it ("Restart from Review"), with "from the beginning" as an explicit choice. Incident 5 then needs neither: the prompt refresh already updates the text, and a restart no longer repeats satisfied steps.

## 7. Operator operations

| Operation | Effect on the run | Today |
| --- | --- | --- |
| Retry / Resume, drag to Running | Re-runs the current step's checks, then gives it a turn only if one still fails. | Same request (`retryPipelineStep`); always a turn. |
| **Steer** (feedback to step X) | X active: the text goes to its session and does not count against `maxTurns`. X earlier: the text is kept for X's next launch. With "invalidate": X's results are voided in the ledger and the run re-enters X with the feedback as its arrival, as `reworkPipelineRun` does for a CI failure. | Message from the step panel, active step only. |
| **Rewind** to step X | Voids the results of X and later steps, stops the live step and launches X with the earlier handoffs. History is kept. | Restart, which empties the history. |
| Restart pipeline… | "Start over (discard history)", behind its confirmation. | Unchanged. |
| Advance | Records `waived` on each failed required check, then routes. | `advancePipeline`; no record of what was waived. |
| Refresh instructions | Unchanged: text and `goal` only. | `refreshPipelineInstructions`. |

## 8. Compatibility and rollout

**Switch.** A `pipeline_gates` preference: per project, per pipeline and, for the trial, per card (`{"publish": {"cards": ["…"]}}`). It is captured in the run's snapshot as `pipeline_decisions` is.

**Running cards.** They adopt gates at their next step launch, and only when the owner asks through the refresh-runs route with an explicit flag. They do not adopt on save, because gates change behaviour and `refreshPipelineInstructions` promises to change text only. They are not held back until a restart either, because that is incident 5. A step in mid-turn is never switched.

**Editor.** `validatePipelineGraph` rebuilds each step field by field, so `goal`, `checks`, `maxTurns` and `runner` must be added there or a save drops them. `StepPanel.tsx` gets a goal field, a checks list and, for Stage 1, one "Published by Agetor" switch.

**Card states** (`src/mainview/lib/card-state.ts`):

| State | Change |
| --- | --- |
| `awaiting` ("Waiting on CI") | Also set from `run.publish.state`, without an `await` block. |
| new `base-red` (blue) | "Base red — develop failing `<job>`". No action. Today the same card reads `auto-retry`, then `needs-you`. |
| `auto-retry` | No longer shown for CI or base waits. |
| `needs-you` | Loses missing handoffs and base-CI escalations. Gains `check-failed`. |
| `working` | Reason line "running checks 2 of 4" while Agetor checks. |
| strip (`stepStrip`) | A segment is green when the step's gate is satisfied, not when an earlier execution succeeded. |

**Tests.** The publish machine is a pure function from state and observations to one action, as `nextMergeStep` is, tested from literal fixtures of the incidents: a cancelled twin, a red base, a job the base never ran. Loops are driven by calling the tick with a `now` argument, as `releaseBlockWaits(now)` and `mergeQueueTick(now)` are. Git checks run against temporary repositories. No sleeps, no elapsed-time assertions.

**Trial.** In the sandbox first; FORK.md notes that it still acts on the real repository. Then three cards by id on the board. Compare `agetor blocks` before and after: Finish `step-blocked` (53 in three days), `handoff-missing` (24), and launches per merged card.

## 9. Left out

| Left out | Why |
| --- | --- |
| Landlock sandboxing | The board runs on macOS. The trust order covers the gap. |
| Boards by workflow shape, groups, bulk migrations | No incident needs them. |
| The full reasoning ledger | The checks file records outcomes, not reasoning. |
| Replacing the wait queue | Leases, owner questions and unknown blocks still need it. |
| Gates on Understand | Its output is a plan; nothing in the tree shows it. |
| Fan-out and join graphs (Branch Review) | Position resolution is defined for one path with loops. |
| Removing the Pillar-specific code (`managedPillarRoot`, `reviewedPillarPipeline`) | Checks make it removable. Removing it is a separate change, after the trial. |

## 10. Risks and open questions

### Decided by the owner, 2026-10-13

These answers replace the "Recommend" lines below wherever the two differ.

| # | Question | Decision |
| --- | --- | --- |
| 1 | The base moved or recovered after Review approved | **A.** Agetor merges the base into the branch when the merge is clean and the change's own diff is unchanged (`git patch-id` of `git diff base...HEAD`, before and after), pushes, and the Review approval carries over. No agent step. A conflict or a changed diff falls back to today's route: Build, with "merge origin/<base>". |
| 2 | What must be true of a green PR before the merge queue merges it | **A.** Its checks are fresh against the current base, or it was tested in a train. A lone stale PR rides a train of one. |
| 3 | Running cards | **A.** They adopt the new loop at their next step launch, on an explicit refresh. Never automatically. |
| 4 | Build still fails its checks after `maxTurns` (Stage 2) | **B.** One fresh session, then the owner. Not built yet. |
| 5 | A handoff is missing and the checks pass (Stage 2) | **A.** Advance. Not built yet; Stage 1 must not stand in its way. |
| 6 | Checks on the Mac | **A.** Built-in checks only for now. |
| — | Order | Stages 0 and 1 are built now. Stage 1 ships behind a per-pipeline switch that is off by default, with a trial list of card ids, so it can be turned on for a few cards first. |

The questions as they were asked:

**1. After the base recovers or moves, how does a card get CI against the new base?**
A re-run of the old CI run tests the old merge commit, so it cannot answer this. The same fact makes `merge-rework.ts`'s "base recovered → re-run the failed jobs" ineffective when the base was fixed by a commit.
- A. Agetor merges the base into the branch when the merge is clean and the change's own diff is unchanged (`git patch-id` of `git diff base...HEAD`), pushes, and the approval carries over. No agent step, one CI run.
- B. Agetor closes and reopens the PR, which makes GitHub test the same head against the new base. The head is untouched. It does not help a PR that conflicts.
- C. As today: Build merges, Review re-reviews, Finish publishes. Three launches.
- **Recommend A.** Counter-argument: the rule becomes "Review approves the change", not "the exact head", and a harness push is a second push. Merge trains already publish squashed commits no Review saw, relying on CI.

**2. What must be true of a green PR before the merge queue merges it?**
- A. Fresh, or in a train; a lone stale PR rides a train of one.
- B. Turn on "require branches to be up to date" on GitHub and let `update-branch` run. Every merge restarts CI on every other queued PR.
- C. Keep today's rule.
- **Recommend A.** Counter-argument: up to one extra CI run per lone PR on two or three runners.

**3. Do running cards adopt gates?**
- A. At their next step launch, on an explicit refresh.
- B. Only cards started afterwards.
- C. Automatically when the pipeline is saved.
- **Recommend A.** Counter-argument: two loops are live on one board during the trial, and a card's behaviour depends on when it was refreshed.

**4. Build's required checks still fail after `maxTurns`. What then?**
- A. The owner, at once.
- B. One fresh Build session with the failures as its arrival, then the owner.
- **Recommend B.** Counter-argument: one more launch against the cap for a failure that may need a person.

**5. A handoff is still missing after the reminder and Build's checks pass. Advance?**
- A. Yes, with a composed handoff.
- B. No, block as today.
- **Recommend A.** Counter-argument: the cheap checks cannot tell half-finished work from finished work. Review will catch it, at the price of a round.

**6. May format, vet and typecheck run on the Mac as checks?**
- A. Built-in checks only for now.
- B. Add a static-only mode to the project's selector, one at a time, 120 s at most.
- C. Never.
- **Recommend A now, B once the selector has that mode.** Counter-argument: until then every mechanical failure costs a CI run and a round.

Risks without a decision attached:

- A job name is a coarse key for "the same failure".
- `checks-*.jsonl` is protected by convention only.
- Stage 1 moves pushes into the core, so a bug there pushes without an agent's judgment between. The trial allowlist is the mitigation.

## 11. Size and order

| Stage | Files | Source lines | Test lines | Contents |
| --- | --- | --- | --- | --- |
| 0 | 3–4 | ~200 | ~300 | `rollUpChecks` newest per name (`pr-watch.ts`); the fresh rule (`merge-queue.ts`); one-member trains and `disband` (`merge-train.ts`). |
| 1 | 9–11 | ~1,300 | ~1,200 | New `src/shared/publish.ts` (pure machine) and `src/bun/publish-step.ts` (git and GitHub actions); `launchStep` dispatch and `run.publish` (`pipeline-runner.ts`, `types.ts`, `db.ts`); classification exported from `merge-rework.ts`; `card-state.ts` and fixtures; "Finish" taken off the heavy list in `step-slots.ts`. |
| 2 | 10–12 | ~1,400 | ~1,200 | New `src/shared/checks.ts` and `src/bun/check-runner.ts` with the ledger; settle and feedback turns in `pipeline-runner.ts`; `composeStepPrompt` goal and feedback text; validator; `StepPanel.tsx`. |
| 3 | 7–9 | ~800 | ~600 | New `src/shared/position.ts`; rewind and steer in `pipeline-runner.ts`, `server.ts` and the CLI; `CardInspector.tsx`. |

Order: 0, 1, 2, 3. This differs from the staging discussed earlier in three ways:

- Stage 0 goes first. Incidents 6 and 7 are merge-queue faults that need no gate.
- Stage 1 does not depend on the generic checks model.
- Stage 3 needs only the built-in checks, so it can follow Stage 1 directly if restarts hurt more than missing handoffs.
