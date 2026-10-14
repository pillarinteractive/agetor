# No owner holds

Cards run unattended, overnight. The owner asked that no card is ever left parked "held for you": every stop must
resolve by itself. In the 24 hours before this change 138 blocks parked cards (Finish 42, Review 33, Build 27,
handoff-missing 9, step-failed 6, step-cap 8, follow-up steps); none of the owner-classified reasons needed the
owner — a refused shell command, a diverged branch, a decision already recorded on an issue, work larger than one
visit, waiting on its own command or subagent, Finish waiting for develop's CI for hours, a second step-cap hit,
handoff-missing after one reminder.

The standing policy the steps already carry: an owner decision does not stop a card — take the recommended option
as provisional, record it as provisional (never as approval), file one deduplicated follow-up issue and proceed; an
unmet criterion makes the closing verdict Refs. The only real stops: credentials or access the agent lacks,
destructive or irreversible actions, anything touching main, releases or production. An unapproved head is never
merged.

## The ladder

`resolveOwnerHold(input) → {action: "park" | "answer" | "reroute" | "fresh" | "wait" | "restart-from-base" |
"close-publish" | "close-depend", why, …}` in `src/shared/owner-holds.ts`, pure and unit-tested. The runner
(`src/bun/pipeline-runner.ts`, `resolveOwnerHolds`) finds the stop that would wait for the owner (`ownerHoldOf`:
blocked, nothing live, no retry pending, not the wait queue's), persists the rung counters on the run, and carries
the decision out.

1. **Answer it in place** (once per step execution). The same step, its own session
   (`composeOwnerHoldAnswer`): nobody will answer; for each open question take the recommended option as
   provisional, record it, file or reuse one follow-up issue, continue; a refused command → the edit tool; a command
   or subagent it started is its own to wait for (agetor-await); work larger than one visit → commit in parts and
   continue; a diverged remote branch → merge it, never force-push. The only acceptable stops are the hard stops,
   declared as `hardStop`. A pending question in an unattended run (AskUserQuestion, an fx permission request) gets
   the same message: the question is dismissed or declined, never approved.
2. **Route it to the step that can act.** A Review or Finish that still cannot proceed sends its reason to Build,
   as Build's arrival (the mechanism Finish's own "verification failed" and the merge-queue rework use). At most one
   reroute per execution and two per run, never over a corrective edge whose `maxTraversals` is spent. A step with
   no handoff, a failure, or a failed check gate gets one fresh session of the same step (Retry; checks first for a
   gate). Waits on what clears by itself — another issue or PR, the base branch's CI, a lease, a usage limit, the
   environment — stay in the wait queue with no deadline; once their retries are spent they are re-checked every
   `longBackoffMin` (120 min) for as long as it takes, and they read blue.
3. **Close it out.** One follow-up issue per unresolved item (each open question, else the stated reason): the
   question, the options the step gave, the provisional choice, the evidence, what was tried, the card, its issue
   and PR, label `agetor-owner-decision` and marker `<!-- agetor-owner-hold:KEY -->`. Then:
   - committed work (commits of its own, or a PR already) → the step-cap wrap-up through the terminal step, once
     (`run.capWrapUp.closeout`): it publishes, says the head is not approved when it is not, references the issues,
     merges nothing, and the card finishes;
   - nothing to publish → a dependency wait on the first issue (`run.wait`, `closeout`, ref `#N`): blue, re-checked
     at the long interval, never resumed on a timer, resumed with a fresh allowance when the issue is closed.

   Before this rung, the step cap hit again after the run's wrap-up restarts the card once (below).

   A hard stop takes this rung directly once rung 1 confirmed it. If GitHub refuses the issue, the close-out is
   tried again in 15 minutes (a blue wait on GitHub); it never falls back to the owner.

Bounds: each rung at most once per step execution (`run.ladder.steps["<taskId>#<seq>"]`, or `"<kind>@<stepId>"` for
a run-level stop), reroutes at most two a run, the close-out once a run (`ladder.closed`); every new execution is
counted by the step cap. Counters are written before the action, so a restart resumes at the same rung.

## Restart once from the base

Owner decision 2026-10-14 ("Restart once from develop"): a card that hits its step cap again after its one
wrap-up is going round in circles, and an issue with no options does not help the owner. It restarts once from
scratch on the current base branch; only a second cap hit after that restart files the issue and waits.

`resolveOwnerHold` returns `restart-from-base` for kind `step-cap` when the wrap-up has been used (`wrapUpUsed`) and
the restart has not (`capRestartAvailable`: no `run.capRestart`, the card has its own branch — not one it was pinned
to — in a worktree). The runner (`ladderRestartFromBase`) waits for a slot for the start step, writes
`run.capRestart = {state: "pending"}`, then `restartFromBase` in `src/bun/owner-hold-io.ts` runs, in order:

1. refusals, nothing changed: the worktree is not on the card's branch; `git status --porcelain` is not empty; no
   base can be determined, or `git fetch origin +refs/heads/<base>:refs/remotes/origin/<base>` fails;
2. `git ls-remote --heads origin` for the card's branch and for `archive/<slug>-attempt-*` (`<slug>` is
   `issue-<N>`, else the branch; `<n>` is one past the highest on origin);
   `git push --quiet --no-verify origin <HEAD>:refs/heads/archive/<slug>-attempt-<n>`; when the remote branch
   exists and differs, fetch it and push it to `…-attempt-<n>-pr`. Never forced. A failed push stops here: nothing
   is closed, deleted or reset;
3. the open PR is closed with a comment: the card looped to its step cap, it restarts from the current base on the
   same branch name, and where the archived attempt is (a failed close is noted; deleting the branch closes it);
4. `git push --quiet --no-verify origin --delete <branch>`, only now;
5. `git reset --hard refs/remotes/origin/<base>`, `git branch --unset-upstream`.

The base is the open PR's base, else the card's recorded base branch (`card_base_branches`), else the project's
(`pr_base_branch`, `develop`, origin's default). Then the card's `baseRef` becomes the new base commit, its `prUrl`
is cleared, `run.capRestart` becomes `reset`, and the run restarts from scratch (`startPipelineRun({restart: true,
fromScratch: true})` — the decision policy and check gates are captured as for any new run) with the record carried
over as `started`. One activity line names the base, the archive refs and the closed PR. If the start itself fails
(no slot, a Stop meanwhile), the record stays `reset` and the next pass only starts the run.

A refusal or failure records `state: "failed"` with the reason and closes out on an issue (`close-depend`). A core
restart while `pending` does the same: it is never tried twice. On the restarted run `capRestart` is set, so its own
wrap-up runs again and a further cap hit closes out on an issue, as before this change. `park`, a person-run card
and a user Stop are unchanged.

## The hard-stop field

```json
"hardStop": { "kind": "credentials" | "destructive" | "protected", "detail": "the exact thing needed" }
```

On a blocked handoff. Read leniently like `waitingOn` (`parseHardStop`): `hard_stop` / `hardstop`, a bare string,
`type` / `on` for the kind, `reason` / `what` / `needs` for the detail, aliases (`secret`, `token`, `access` →
credentials; `irreversible`, `delete`, `force-push` → destructive; `main`, `release`, `production`, `tag` →
protected). A handoff with one is `blocked`.

## The preference

`owner_holds`: `"resolve"` (default) or `"park"`, read at every decision; `park` restores today's behaviour exactly
(no stamp, no ladder, the queue escalates at its deadline as before). Runs without a decision policy (a person runs
them) are unaffected either way. A Stop the user pressed marks the run (`ladder.userStop`) and the ladder leaves it
alone until a step runs again by a person's hand.

## What the owner sees

GitHub issues labelled `agetor-owner-decision`, each naming its card, its question and the provisional choice taken
— collected by the decision milestone — and pull requests that say when their head was published unapproved. Not
parked cards: the board shows "Resolving" (blue) while the ladder acts and "Dependency · waiting on #N (filed for the
owner)" for a card closed out on an issue. Every automatic action writes an activity line starting "Resolving
without you: "; the block log keeps every original block and records which rung resolved it (`resolution`), so the
block rate stays measurable. Velocity counts none of it as "Held for you"; that phase is for real owner time.

## Choices made

- **One sweeper instead of thirty call sites.** The sites that record a stop are unchanged (the block log still sees
  every block); one pass finds stops that nothing automatic owns and runs the ladder. It also catches stops nobody
  enumerated.
- **Unattended means a decision policy** (`snapshot.decisionPolicy`), the fork's existing test for an unattended
  board. Manual runs keep every old outcome.
- **Reroute uses the arrival mechanism**, not `pipeline/feedback`: Stage 3 feedback is for gated runs only and is
  rendered as the owner's words. The arrival is a runner-written handoff naming the stopped step and quoting its
  reason; the stopped step's report is attached as for any arrival.
- **"Fresh session" is a Retry** of the same step task (its original prompt and arrivals); a check gate's retry runs
  the checks first, with a new allowance of feedback turns.
- **Questions:** AskUserQuestion is dismissed and the answer sent as a message (the path a person's free-text answer
  takes); an fx permission request is declined. A scraped REPL prompt (login, trust or model dialog) is left alone:
  what Escape does to it is not known.
- **Close-out waits on the first filed issue**; the others are listed in it and in the activity line.
- **Merge-queue rework** keeps its rounds and its fresh rule; an unattended hold also files an issue, and closing it
  lifts the hold as a sign-off by hand does.
- **Stop on a "Resolving" card** takes it out of the ladder (it was a 409 before, since nothing ran).

## Not changed

The step cap extends once then wraps up through Finish and files issues (and then restarts once from the base, above); Agetor merges a moved base when clean with
unchanged patch-id and carries approval over; edited instructions reach unfinished runs; publication is verified in
GitHub CI only; usage-limit handling; the merge queue's fresh rule. Nothing here merges or approves anything.

## Awaits end

A step parked on its own `agetor-await` waits for nobody but the command; a command that never ends held the card
"active" for 25 hours (2026-10-14). Every await now has a deadline: `--max` on the command (at most 12 h), else
`await_max_minutes` (default 120); a `ci-wait` at least its own `--timeout` + 15 min. Past it Agetor stops the
process group (SIGTERM, SIGKILL 30 s later, on the watcher's tick), records exit 124 and wakes the same step with the
log's tail, once. A record whose process is gone with no exit code is closed and woken at once. The deadline is
stored in the record, so a core restart keeps it. See FORK.md, "An await has a deadline".
