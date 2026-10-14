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

`resolveOwnerHold(input) → {action: "park" | "answer" | "reroute" | "fresh" | "wait" | "close-publish" |
"close-depend", why, …}` in `src/shared/owner-holds.ts`, pure and unit-tested. The runner
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

   A hard stop takes this rung directly once rung 1 confirmed it. If GitHub refuses the issue, the close-out is
   tried again in 15 minutes (a blue wait on GitHub); it never falls back to the owner.

Bounds: each rung at most once per step execution (`run.ladder.steps["<taskId>#<seq>"]`, or `"<kind>@<stepId>"` for
a run-level stop), reroutes at most two a run, the close-out once a run (`ladder.closed`); every new execution is
counted by the step cap. Counters are written before the action, so a restart resumes at the same rung.

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

The step cap extends once then wraps up through Finish and files issues; Agetor merges a moved base when clean with
unchanged patch-id and carries approval over; edited instructions reach unfinished runs; publication is verified in
GitHub CI only; usage-limit handling; the merge queue's fresh rule. Nothing here merges or approves anything.
