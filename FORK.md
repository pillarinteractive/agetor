# Working on the pillarinteractive fork

This checkout is `pillarinteractive/agetor`, a fork of `alamops/agetor`. The same person uses a build of it as their daily
Agetor, so a change here can reach a board that is running real agents. Follow this workflow; it keeps development and
the live board apart.

## Layout

| Where | Data | What it's for |
| --- | --- | --- |
| `~/Dev/agetor` (branch `main`) | — | The main checkout. `main` = `upstream/main` + the fork's local tooling and early FORK.md commits. |
| `~/Dev/agetor-<name>` (git worktrees) | — | One per branch being worked on, so several can be open at once. |
| `bun run dev:hmr` | `~/.agetor-dev`, port 4318, tmux socket `agetor-dev` | Sandbox for trying changes. Runs whatever branch is checked out. |
| `~/Dev/agetor-release` (git worktree, branch `release`) | — | What is installed. `release` = `main` + every fork feature described below. |
| `/Applications/Agetor.app` | `~/.agetor`, port 4317, tmux socket `agetor` | The daily board, built from `release`. |

Remotes: `origin` = the fork, `upstream` = `alamops/agetor`. Only `main` is on `origin`; `release` and the `feat/`,
`fix/`, `chore/` and `perf/` branches are local.

**Never point a dev run at `~/.agetor`.** `dev:hmr` reloads on save and loads its UI from Vite on :5173, so half-written
code would drive live agents. The real board only ever runs a packaged build from `release`.

## Making a change

1. Pick the base by where the change is going:
   - **Fork features and fixes to them** (nearly everything below: Autopilot, the merge queue, pipelines' fork behaviour,
     the board's columns) build on code that exists only on `release` and are not upstreamed. Branch off `release`, in
     its own worktree: `git worktree add ../agetor-<name> -b feat/<name> release`.
   - **A fix meant for upstream** touches only code upstream has. Branch off upstream, not the fork's `main`, so it
     carries no fork commits: `git fetch upstream && git switch -c fix/<name> upstream/main`.
2. Verify: `bun run typecheck` and the relevant tests (`bun test src/bun/<file>.test.ts`). The full `bun test` takes about
   5 minutes. On this machine 7 tests fail on unmodified upstream too (`github-network.test.ts`, `tmux-socket.test.ts`:
   they assume no `gh` login / no socket override), so compare against a baseline rather than expecting zero.
3. Try it in the sandbox: `bun run sync:dev` (copies projects, agents, pipelines and harness aliases from `~/.agetor`
   into `~/.agetor-dev` through both APIs; safe to re-run; preferences such as `autopilot` are not copied), then
   `bun run dev:hmr`. The sandbox separates data, port and tmux — not GitHub: a card in a real project still opens a
   real issue (`auto_issues`), and the PR watcher, merge queue and Autopilot act on the real repository.

## Shipping to the board

```bash
cd ~/Dev/agetor-release
git merge feat/<name>          # whatever should be live; a branch based on release fast-forwards
bun run build:local            # packages the app: no Developer ID signing/notarization, update feed = the fork's releases
bun run install:local          # backs up ~/.agetor/agetor.sqlite, moves the old app into ~/.agetor/backups/, relaunches
```

Besides swapping the app, `install:local` compiles the CLI to `~/.agetor/bin/agetor` (same commit as the app, so
their routes match), installs the keepalive check to `~/.agetor/bin/agetor-keepalive` and installs `ci-wait`
(`scripts/ci-wait/ci-wait`, what a Finish step waits for CI with) to `~/.agetor/bin/ci-wait`, replacing the copy that
used to be kept there by hand.

`install:local` quits Agetor; the user has to confirm the Quit dialog. Agents keep running in tmux and the new app
reattaches to them. Roll back by quitting, moving the previous app from `~/.agetor/backups/` back into `/Applications`,
and restoring the database backup only if the new build ran a migration. A build that adds a migration makes the database
unreadable by older builds, so call that out before installing.

`install:local` installs the archive `build:local` last produced; it does not build. Run both, or the board keeps the
old code. After the swap it prunes `~/.agetor/backups/` to the newest three app bundles and five database copies (a
bundle a process still has as its working directory is kept), so a rollback reaches at most five installs back.

## Going upstream

Ask the user before pushing a branch or opening a PR: both are public. Upstream PRs target `alamops/agetor` `main`, come
from a `fix/` or `feat/` branch based on `upstream/main`, and stay small (the maintainer asks for focused PRs). After a
merge: `git fetch upstream` and bring it into the fork's `main` and `release`. Never recreate `release` from `main`:
it carries about a hundred fork commits that exist nowhere else.

## First-time setup in a fresh checkout or worktree

`bun install`, then `bun run vendor:tmux && bun run vendor:notifier && bun run vendor:disclaim && bunx vite build`.
Without the vendored helpers and `dist/`, `electrobun dev --watch` crashes its watcher on the missing paths.

## Known issues found while running this fork

- Bun.spawn's default env is the launch-time environ, not the live `process.env`, and tmux gives a session the creating
  client's PATH. Before `fix/tmux-server-env-cwd`, a Finder-launched Agetor ran every agent with the bare macOS PATH.
  The board's harnesses were pointed at wrappers in `~/.agetor/bin/` (which source `agent-path.sh`) as a workaround.
- The tmux server keeps the cwd of the client that started it. If that is inside an app bundle that gets replaced, every
  new session fails with `getcwd: cannot access parent directories` until the server restarts
  (`tmux -L agetor kill-server`, which also ends running agent turns).
- A finished pipeline lands in Review, and the server refuses column changes on pipeline tasks, so the board's Done
  button fails and Archive (Done-only) never appears. Fixed on `fix/pipeline-review-to-done`.
- **Port trap:** `agetor daemon start --data-dir ~/.agetor-dev` binds the default port 4317, not 4318, and Bun lets it
  share 4317 with the running app, so CLI and UI requests can reach either core. Always set `AGETOR_API_PORT=4318` for
  a sandbox core and check `~/.agetor-dev/agetor-core.json` shows 4318 before sending it anything.
  (`bun run sync:dev` already passes 4318.)

## Lease badges (`feat/lease-watch`)

The `lease_watchers` preference lists commands Agetor polls to show who holds a shared resource. For Pillar's lab:

```bash
agetor config lease_watchers '[{"project":"/Users/markedmiston/Dev/pillar","label":"lab","command":"lab/vm/plab lease --json","intervalSec":30}]'
```

The command runs in `project` and must print `{"held": false}` or `{"held": true, "checkout": "<holder's repo root>"}`
(`plab lease --json` does, from Pillar's `feature/plab-worktrees-lease-json`). The holder's card gets a lock badge,
Blocked cards in that project show who holds it or that it's free, and dropping a blocked pipeline on Running retries it.

## Updating instructions on a stopped run

### Planner recommendations without routine owner waits

The `pipeline_decisions` preference is an explicit project opt-in:
`{"mode":"planner-recommendation","projects":["/absolute/project/path"]}`.
The exact project path and policy are captured at a fresh run's start; existing
snapshots and other projects keep their current instructions and permissions.
A second mode, `agent-followups`, differs only in who files the follow-up
issue; see "Pillar's instruction policy" below.

With that policy, every step chooses the planner's supported recommendation
for ordinary implementation, design and product choices within the issue's
authorized scope and continues the same card. If the planner has not made a
recommendation, the step reasons from the issue, acceptance criteria and
approved repository decisions first. Issue fidelity comes first, then
correctness/privacy/security, then throughput, then token cost. Native
AskUserQuestion is left out of these Claude step sessions; genuine authority
requirements are reported in a blocked handoff. This does not remove native
permission prompts or override reviewer denials. The exact optional Claude
environment-teaching reminder is dismissed with “Don't show again”; no other
generic modal is automatically answered.

Before acting on a routine choice, the step calls
`agetor pipeline decision <parent> <record.json>`. The JSON contains the run's
`capturedAt`, `category` (`routine` or `required-authority`), `question`, an
explicit `recommendation`, `rationale`, nonempty `evidence`, and
`affectedArtifacts`. The authenticated route saves a redacted private ledger
under `pipeline-runs/<parent>/decisions-<runStartedAt>.json`, deduplicates the
question, and attempts one GitHub follow-up issue per run in the verified
owning repository. Later decisions update that same issue. Inspect the full
records with `agetor pipeline decisions <parent>`; the remote issue contains
runner-generated record references rather than arbitrary agent prose, panes,
private files or credentials. Confirmation is retrospective for routine
choices and does not block continued work. Uncertain remote creates are
recorded and never automatically replayed into issue spam. Instruction refresh
keeps the same run ledger and issue; changed recommendations retain up to eight
previous revisions per question instead of silently overwriting the audit.
Repository lookup failures before a write can retry the same record without
duplicating it. Follow-up creates and updates carry the verified repository
identity through the mutation, even if a worktree's remote changes meanwhile.
The ledger freezes the source issue at its first record and the verified
repository before its first remote write. Every later update uses that stored
ownership and validates the existing follow-up URL and number. A changed source
issue, incomplete legacy ownership, or inconsistent remote response requires
explicit reconciliation; it never rebinds the old issue number to new task
metadata. A temporary remote mismatch can retry only after the original source,
repository and authentication host match again. Pending or uncertain writes
remain protected from replay.

Confirmed-dead tmux sessions cancel only the questions captured for that
session as undelivered and emit a removal event for the open UI. Changed runs,
replaced sessions, later questions and inconclusive liveness checks retain
their questions. History is preserved; cancellation is never an answer or
permission grant. A full app restart clears the in-memory interaction registry;
boot reattachment restores running sessions only. Inventory legitimate pending
questions before rollout instead of assuming all idle-session prompts survive.

Recording is passive: it never starts/retries an execution, answers a
permission, grants approval or clears a blocked sibling. Missing action-time
permission, credentials, protected/destructive actions, contradictory
requirements and essential decisions outside the delegated scope remain
accurate per-card owner holds; their unfinished dependents remain blocked and
unrelated ready cards retain capacity. Failing tests and review defects go
through repair and independent review; unmet dependencies stay dependencies.
No caps, approvals, merge protections or commercial/planning source policy
are changed. A real session teardown cancels its obsolete interaction cards,
while a defensive reattach preserves the live session's interactions.

Edited step instructions always reach the runs already started from that
template. Saving a pipeline whose step text changed (`PATCH /pipelines/:id`)
makes every unarchived running, blocked or cancelled run of it adopt the new
text in the background, each under its own run lock; the save does not wait for
them. `POST /pipelines/:id/refresh-runs` does the same on demand and returns
`{ results: [{ taskId, stepIds, unmatched, skippedPrompts, error? }] }`, and
`agetor pipeline refresh-instructions <parent-id>` (`POST
/tasks/:id/pipeline/refresh-instructions`) does it for one run. Never-started
cards need nothing: they snapshot the template when they start.

Only the text is copied, step by step, matched by step id. The run keeps its
own topology, agent assignments, delegation, frozen profiles and caps, so a
template whose agents or edges were changed since is no reason to refuse. A step
the template no longer has keeps its text and is listed in `unmatched`;
follow-up steps are never touched. No agent is started or interrupted and no
verdict, hold, wait, scheduled retry or step count changes. A step that is
executing keeps the prompt it was given and gets the new text at its next launch
or Retry; a step that is stopped or waiting has the `## Your step` section of
its prompt rewritten now. A step prompt someone edited by hand is left as it is
and listed in `skippedPrompts` (the run's snapshot is still updated). Each
update writes the instruction diff under the run's data directory and one
activity line on the card. `expectedCapturedAt` / `expectedTemplateUpdatedAt`
are optional on the per-run route: when sent they must still match. Otherwise
a refresh is refused only when it cannot be done: not a pipeline task, archived,
never started, or the template is deleted or invalid.

Manual Advance now retains the sender's handoff and full report by default.
Choosing Build does not make a blocked review an approval: Build receives the
original findings and reproduction/test evidence, including raw output from a
turn with no valid handoff. Raw output grants no approval. Completed reports
retain their event boundary so a later explanation cannot replace the reviewed
execution. Explicit handoff fields still replace those fields.

Automatic routing accepts blocked findings only on a corrective edge, such as
"changes requested" or "verification failed"; blocked never means approved.
Malformed status/schema and contradictory questions/waits fail closed, retaining
owner holds. A security finding about unauthorized callers is distinct from the
executing agent being denied permission. Instruction refresh also refuses an
automatic recovery while its unlocked send or relaunch is in flight.

## Follow-ups on finished pipelines (`feat/pipeline-followups`)

A finished run's view has a **Next** box: run a preset or a custom request (any agent) as one more step of the same run,
in the same worktree, with every earlier handoff as context. The card goes Running → Review and the follow-up's handoff
becomes the Result. Presets live in the `pipeline_followups` preference:

```json
[{"id": "vm", "label": "Run VM tests", "agent": "Codex Builder",
  "suggestWhen": ["apps/agent/**", "apps/observer/**", "lab/vm/**", "deploy/**"],
  "prompt": "Run the VM suite with lab/vm/plab cycle …"},
 {"id": "explain", "label": "Explain", "agent": "Architect", "requiresRequest": true, "prompt": "Answer … Do not modify files."}]
```

`agent` is a profile name; `suggestWhen` globs (`**` crosses directories; a slash-less pattern matches a file name
anywhere) mark the preset **Suggested** when the branch changed a matching file. Nothing runs until the user clicks.
Edit with `agetor config pipeline_followups '<json>'`; the board's current presets are Open PR, Run VM tests, Run E2E, Explain.

## Keep awake (`feat/keep-awake`)

While any task is running, Agetor holds `caffeinate -i -s -w <pid>` so long agent turns aren't cut off by the Mac
sleeping ("Your computer went to sleep mid-response"); it's released when nothing is running. On by default; toggle in
Settings → General (`keepAwakeWhileRunning` preference). Closing the lid still sleeps the Mac unless a display is attached.
The top bar's sun button (`keepScreenOn` preference, off by default) also keeps the display on (`caffeinate -d`).

## PR babysitter and issue queue (`feat/pr-watch-issues`)

- **PR watcher** (`src/bun/pr-watch.ts`): every 60s, finds each live card's PR by branch (agents open PRs with `gh`, which
  Agetor never sees), rolls up check runs and counts unresolved review threads. The card shows a PR badge; a merged PR
  moves the card to Done. A finished pipeline's Next box offers suggested **Fix CI** / **Address review** follow-ups
  (agent: `pr_followup_agent` preference, default `Builder`). The Builder profiles may push their own task branch so
  these can update the PR; never `main`/`develop`, never force-push.
  - A failing check that also fails on the PR's base branch is marked inherited: the badge reads
    `✗ CI (also on develop)` and Fix CI isn't offered for it (the aggregate `required` check never counts).
  - Follow-ups also run on a **blocked** run once nothing in it is live.
  - Auto Fix CI starts Fix CI by itself for the PR's own failures, at most twice per PR and never twice for the same
    commit (ledger in the `pr_autofix_attempts` preference). On for pipeline cards and off for plain tasks unless
    `agetor config pr_autofix true|false` says otherwise.
- **Issue queue** (top-bar Issues button, `src/bun/issue-queue.ts`): a project's open issues with label chips, search
  and grouping by milestone; pick a pipeline and **Fix** to create and start a pipeline task from the issue (built like
  `agetor add --issue`). Issues that already have a live task show it instead. This is where work starts on the board:
  the New Task panel and the Worktrees dialog were removed (the onboarding "new task" action opens this page).
  `createTaskFromIssue` is also what Autopilot calls.
- **`Fixes` / `Refs` rule** (`fixesLine`): every card made from an issue is told to write `Fixes #n` in the PR
  description only if the PR fully resolves the issue, and `Refs #n` plus what's left otherwise. Merging a `Refs` PR
  leaves the issue open (see "Closing issues when their PR merges").

## Knowing what each card is doing (`feat/board-clarity`, `feat/pipeline-cards`)

The board is still the main view: backlog and finished work stay on it, and nothing but a selected card opens beside
it. Since `feat/pipeline-cards` every card keeps three things apart:

| What | Where on the card | Comes from |
| --- | --- | --- |
| **Status**: where the card is in the workflow | the column | `task.column` |
| **Step**: where its pipeline is | "Step **Build**", "· round 2" after a loop back, and a strip of segments | the run's active or stopped step, over the snapshot's graph |
| **State**: what is happening now | the coloured band at the top: an icon and a label | the run, the PR, the leases, the wait queue |

The state is never read from the column alone. A card in Running whose step is parked on CI says "Waiting on CI", not
"Working"; a card in Blocked that the wait queue retries says "Auto retry", not "Needs you".

- **`src/mainview/lib/card-state.ts`** (`cardState(task, { pr, lease, now, progressActive, roadmap })`) decides all of
  it and is pure. Its precedence follows `cardStatus` (`card-status.ts`), whose sentences it reuses; the blocked
  branches use the wait queue's helpers (`src/shared/block-wait.ts`) and `causeOf` (`board-health.ts`). It returns the
  state, a label, an icon, one line of reason, the step, the strip, an elapsed time and the card's one action.
- **Six colours, each with a label and an icon** so none depends on colour: green *Working*; blue for a wait that ends
  by itself (*Waiting on CI*, *Waiting on command*, *Auto retry*, and Ready to Merge's *Opening PR*, *Updating
  branch*, *Fixing CI*, *Merging*, *In merge train*); amber for the owner's move (*Needs input*, *Needs you*, *Step
  cap*, *Quiet*, *Review PR*, *Review comments*, *Update branch*, *No PR yet*, *PR closed*, *Draft PR*); red *Failed*
  and *CI failed*; purple *Merged*; grey *Queued*, *Stopped*, *Done*. *Dependency* is blue for a run that has started
  and is parked on another card or issue (it moves on by itself), grey for a card nothing has run yet (it is queued). Amber and red cards carry the
  colour on their border too. The values are the `--state-*` variables in `src/mainview/index.css`, for both themes.
  Nothing on a card pulses or glows.
- **The strip** has one segment per step of the run's snapshot, ordered by how far each step is from the start step
  (`stepOrder`: the longest way there, leaving out the edges that lead back, so Finish stays last when Understand can
  also go straight to it); follow-up steps have none. A segment is green only if it comes before the current step and has a succeeded execution, so after
  a loop back the steps ahead read as to do again. No snapshot (a single-agent task, a run not started): no strip.
- **Elapsed time** is shown only where the data has it: since the active step's latest start, or since a step was
  parked in the wait queue. There is no "blocked for" time, no PR approval and no sign-off state: the board is not
  told any of those, so the card does not show them.
- **A task without a pipeline** is *Working* only while the server reports activity for it (`lastActivityAt`); in
  Running without that it reads "No activity yet".
- **The footer is one button or a name.** The button is the owner's next move: *Answer*, *Run*, *Retry <step>*,
  *Resume <step>*, *Fix CI*, *Review PR*, *Inspect PR / CI / retry*, *Open dependency*, *Open*. With no move to make
  the footer names the agent on the current step and the pipeline. *Retry* and *Resume* continue the step that
  stopped (`POST /tasks/:id/pipeline/retry`, the same request as dropping a blocked card on Running); they never
  restart the run. *Fix CI* starts the PR watcher's `pr:fix-ci` follow-up at once, without a confirmation, and is
  offered only on a finished pipeline whose own checks fail (not ones the base branch fails too).
- **A click selects a card** and opens the inspector under the board (`CardInspector.tsx`): Status, Step and State
  as three chips, the step's own words in full, the retry schedule (`run.wait`, `run.autoRetry`, a held input), what
  the PR watcher last saw and when, and the actions: the card's button, Retry or Resume step, **Restart pipeline…**
  (asks first, in the run view's words), Stop, Inspect PR, Open run. Escape or its × closes it. A **double click**, or
  Open run, opens the full view as a click used to. Keyboard: Tab to a card, Enter or Space selects it, Tab reaches
  its button.
- **Columns** are lanes with a count and a summary of their cards' states ("3 need you · 1 failed · 3 waiting"). The
  board shows "In review" and "Merge queue" for the columns the rest of this file, the CLI and the server call In
  Review and Ready to Merge (`src/mainview/lib/column-labels.ts`); the ids (`review`, `merge`) are unchanged. Columns
  narrow to 11.5rem, then the board scrolls sideways.
- **Search and View** are in the top bar: the search box (Cmd/Ctrl+F; title, prompt, workdir, branch, PR number) and
  a View menu (Active / All / Archived). The status strip (`SystemStrip`) and the filter row (`KanbanFilters`), with
  the repo, harness, type and status filters, are deleted; `board-health.ts` stays for `causeOf` and `whyStopped`.
- **Two PR sentences changed** (`card-status.ts`): a PR with no check runs no longer reads "checks pass", and a card
  whose PR was closed without merging says so instead of "no PR yet".
- **Needs you** (`src/mainview/components/kanban/NeedsYouBar.tsx`) is untouched and still not mounted on the board:
  a card that waits on the owner says so in its own state band.
- **Activity** timeline in the run view (`src/bun/activity.ts`): steps derived from the run's history, plus PR, CI,
  review, merge, lease and auto-fix events appended to `<dataDir>/activity/<taskId>.jsonl` as they happen.
- A step's panel strip names the card it belongs to. The run panel is unchanged; the run view is described under
  "The run view" below.

**Trying the cards without a core.** `bun run hmr`, then open `http://localhost:5173/fixtures/board.html`
(`?theme=dark`, `?case=long`, `?case=backlog`, `?select=t845`): every state through the real components from made-up
data (`src/mainview/fixtures/`). The page imports no API client and its buttons only report what they stood for. It
is not an entry of `vite build`, so it is not in the packaged app. `e2e/board-fixtures.spec.ts` runs against it with
no backend; set `BOARD_SHOTS_DIR` to keep its screenshots.

## The run view (`feat/velocity-and-run-view`)

A double click on a pipeline card (or Open run in the inspector) replaces the board with that card's run. The board
stays the main view: Back, or Escape, returns to it as it was left — search text, the View menu, where
`.kanban-scroll` was scrolled to, Done unfolded, the selected card with the focus on it (`boardMemoryRef` and
`restoreBoard` in `App.tsx`; the board is unmounted meanwhile). `PipelineRunView.tsx` owns the data and the canvas;
`components/pipelines/run/RunPage.tsx` lays the page out from props and fetches nothing.

- **One state band, the card's own.** `RunPage` is given `cardState(task)` — the same call the board card makes, from
  the same PR, lease, progress and roadmap contexts, which now wrap every view — so the band's icon, label, colour and
  reason are the card's. The tile of the step the card is on wears that state too.
- **Recovery is in the band and nowhere else** (`recoveryControls` in `src/mainview/lib/run-view.ts`). There is one
  Retry, named for what it does: *Retry <step>*, *Resume <step>* (a stopped run), *Recheck now* (a held input; its
  tooltip says it is the retry request and also retries other blocked executions), *Extend cap*, or *Retry <step> now*
  beside the card's own button when the step is retried by itself. All are `POST /tasks/:id/pipeline/retry`. Stop is
  there while a step is live, without a confirmation (the run can be resumed). *Answer*, *Fix CI*, *Review PR*, *Open
  dependency* and *Run* go through `App.tsx`'s `onCardAction`, as on the board. A missing or invalid handoff gets no
  Retry: the band points at Advance.
- **Restart and Advance are under "Advanced run controls"**, closed by default: *Restart pipeline…* keeps its
  confirmation, *Advance <step>…* opens the form, whose button is disabled until a next step is picked or "Finish
  here" is switched on. Nothing on the page skips a blocker, advances a step or merges by default.
- **Executions, not a fraction.** `executionSummary`: "N executions recorded" (`run.history.length`), per-step
  counts, the round of a record, loops (a record that hands to a step with an earlier record), several executions at
  once, and the cap as "step cap 28 of 28". Follow-up steps are listed apart from the graph's.
- **Pipeline steps** switch between the tiles and "Graph & routing": the React Flow canvas as before, the routes as a
  list with how often each was taken, and who each step may delegate to — *available* (configured) apart from
  *running* (observed).
- **The selected step** has four tabs. *Summary*: its state, the step's own words, its latest handoff. *Transcript*:
  the final report of its latest execution (`GET /tasks/:id/pipeline/reports?seq=N`) and "Open full transcript",
  which opens the step's run panel. *Checks* (`checksEvidence`): the current head only from the PR watcher
  (`TaskPrStatus`, "as of <time> on <sha>"); a live CI wait and the timeline's `ci` entries are listed as what they
  are, with no head, on a neutral chip — a recorded pass never stands for the current head. No check record exists
  per step; each row is `{source, status, observedAt, head}` so one can be added. *Files*: what the handoff named;
  a per-step file list is unavailable, and the task's own diff is one button away.
- **Current hold**: the retry schedule (only the wait queue has a maximum number of attempts), whether any agent is
  executing, the PR, the step cap, each block in the step's words.

## Orchestrator suggestions, layer 1 (`feat/suggestions`)

`src/bun/suggestions.ts` recognises situations that used to need a person and proposes the fix. The board no longer
shows them (see Needs you above); they are read with `agetor suggestions` / `GET /suggestions` and `agetor board`, and
applied with `agetor suggestions apply <taskId> <suggestionId>` / `POST /suggestions/apply`. Nothing runs without that,
and each suggestion is recomputed at apply time.
Rules: step blocked on a lease that's free → Retry; PR behind its base whose failing checks pass on the base → Update
branch (only when `pr_autoupdate` is off); finished run with commits and no PR → Open PR preset; blocked step with
open questions → show the first one (not appliable: open the card). A card waiting on another card gets none, and
neither does one parked in the blocked-step wait queue for a lease.
The PR watcher also records `behindBy` and `passesOnBase`, so a failure the base has since fixed isn't treated as the
PR's own (no Fix CI / auto-fix).
- **Worktree setup** (`worktree_setup` preference, `src/bun/worktree.ts`): a per-project command run once in each newly
  created worktree. Pillar: `pnpm install --frozen-lockfile --prefer-offline`. Failures never block the worktree.

## Live run progress (`feat/live-progress`)

`src/bun/progress-watch.ts` runs each `progress_watchers` command (preference: JSON array of
`{project, label, command, intervalSec?}`) in the checkout of every **running** card of that project, every few
seconds. The command prints one `progress/v1` object (`active`, `phase`, `phases`, `targets`, `counts`, `current`,
`failures`, `artifacts`, `last`). The card shows a live line with a bar ("lab: test 120/180 · 2 failed"). The run view
gets a **Live** panel with a phase stepper, counts, the test running now, failures and evidence paths. Phase starts
and the final result go on the activity timeline. A checkout whose command fails (for example a branch older than
the tool) is backed off for 2 minutes. Pillar: `lab/vm/plab progress --json` (Pillar PR #194), label `lab`.

## The board from a terminal; the Conductor is gone (`feat/conductor`, `chore/github-driven-board`)

The Conductor — a chat agent for the whole board — was removed: `src/bun/conductor.ts`, the `/conductor` API, its
30s watcher loop and its top-bar button no longer exist, and nothing reads the `conductor` / `conductor_rules`
preferences. What it was built on stays:
- `GET /board/digest` (`src/bun/board-digest.ts`; `?format=text` for a readable form): every live card with its status
  line, PR, leases and live progress, plus the pending suggestions.
- CLI commands in `src/cli/commands/board.ts`: `agetor board`, `suggestions [apply <taskId> <suggestionId>]`,
  `activity <id>`, `followups <id>`, `followup <id> <actionId> [--request <text>]`, `blocks [--days N]`, `waiting`,
  `depends <id> [<dep>…|--clear]`. `install:local` compiles the CLI to `~/.agetor/bin/agetor`.
- `src/bun/auto-issue.ts` still skips the card named by a `conductor_task_id` preference; nothing sets it any more.
- Testing without touching the board: a throwaway daemon with its own data dir, port and tmux socket —
  `AGETOR_DATA_DIR=<tmp> AGETOR_API_PORT=4319 AGETOR_TMUX_SOCKET=agetor-ct bun src/bun/headless.ts`.

## Real block reasons, quiet cards, lab queue (`feat/stuck-reasons`)

- **Block reasons** (`src/shared/block-reason.ts`): a blocked card says "Waiting for lab" only when its step's block
  text mentions the lease (its label, "lease", "plab", "held by"); anything else shows the step's own reason. The
  suggestions engine uses the same check.
- **Lab queue** (`src/bun/lease-watch.ts`): each `LeaseStatus` carries `queue` — the cards blocked on that lease,
  longest waiting first. Cards show "2nd of 3 in line". When the lease is free the first in line is retried
  automatically (one every 5 min per lease, once per block; activity entry). Off: `agetor config lease_autoretry false`.
  A card the blocked-step wait queue has parked for the lease is resumed by that queue instead (see below).
- **Quiet cards** (`src/bun/activity-clock.ts`): running cards carry `lastActivityAt` (newest run event; for a pipeline
  the quietest active step — any harness). After 20 min quiet the card's status line warns "quiet 25m" and marks it as
  needing you — unless a lab/E2E run on it is reporting live progress.
- **Done cards' PRs**: each Done card's PR is looked up once after startup, so a PR merged before a restart shows
  "merged" instead of the final handoff's old CI headline. PR timeline entries re-derived after a restart aren't
  logged twice (`recordActivityOnce`).
- **Follow-ups take over from a block** (`supersedeBlocksBefore` in `src/bun/pipeline-runner.ts`): starting (or
  resuming) a follow-up on a blocked run sets aside the earlier blocks, so the card runs, then lands in Review or on
  the follow-up's own block. Boot repairs runs left blocked behind a live or finished follow-up.
- E2E live progress: Pillar PR #197 — watcher `{"label":"e2e","command":"node apps/web/scripts/e2e-progress.mjs --json"}`.

## Pipeline robustness (`feat/pipeline-robustness`)

Goal: pipelines finish on their own; a block means something new. Known causes are fixed at the source (worktree
setup command, CI's placeholder DATABASE_URL in Pillar), not patched with canned unblock messages — those
suggestion rules are gone.
- **Base sync before shipping** (`src/bun/sync-base.ts`, pref `pipeline_sync_base` =
  `[{"project","branch":"develop","steps":["Finish","Open PR"]}]`): when one of those steps launches, the runner
  fetches `origin/<branch>`; if it's ahead of the task branch the step's prompt starts with "merge it first" (merge
  commit, never rebase; conflicts it can't resolve → hand back to Fix/Build). Not behind → prompt unchanged.
- **Crashed / lost steps retry themselves** (`scheduleAutoRetry` in `src/bun/pipeline-runner.ts`, rules in
  `src/bun/usage-limit.ts`): a step that crashed, lost its session or hit an API overload/5xx is retried up to 4×
  (1 → 5 → 15 → 30 min apart), then left for a person. A step stopped by a usage limit waits for the reset and is
  retried then, without giving up (see "Usage limits, retries and keepalive"). A "blocked" handoff for a real reason
  or a user Stop never is (a blocked handoff that clears by itself is resumed by the wait queue instead — see
  "The blocked-step wait queue"). The schedule is stored on the run (`autoRetry`) and re-armed when the core restarts.
  A step the limit stopped part-way is continued in its own session rather than restarted (see "Unfinished steps
  stay put").
- **Pipelines own their PRs**: auto Fix CI is on by default for pipeline cards (`pr_autofix` true/false overrides;
  max 2 per PR, never twice on one head). A PR behind its base whose failing checks pass on the base gets its branch
  updated automatically (`pr_autoupdate=false` to stop) — so the Update-branch suggestion only exists when that's off.
- **Block log** (`src/bun/block-log.ts`): every new pipeline block is appended to `blocks.jsonl`; `agetor blocks
  [--days N]` / `GET /blocks` group them by pipeline › step › kind, most frequent first.
- **Steps that can finish** (`PipelineStep.canFinish`, editor: "Can also finish the pipeline"): a choose step with
  outgoing edges that may also end the run by handing off `next: null`. Pillar's Finish uses it with a
  "verification failed" edge back to Fix (Bugfix) / Build (Feature), so a failing final check loops back instead of
  blocking (bounded by maxSteps).

### An unattended run that reaches its step cap finishes once (`fix/step-cap-wrap-up`)

A run with a decision policy (`planner-recommendation` or `agent-followups`) that reaches its step cap after the
automatic extension is used no longer waits for a person. It launches the step the run ends through (`capWrapUpStep` in `src/shared/pipeline.ts`: the step with no
outgoing edge, or `canFinish`; when several can end the run — Change's Understand may, for a card that needs no
change — the last of them, the one no other end is reachable from) in place of the requested step, with the same arrivals and an added prompt section
(`capWrapUpSection`): publish as usual, do not hand back, file one GitHub issue per unresolved finding and list them
in the PR, and say so when the head is published unapproved. `run.capWrapUp` records it; it happens once per run, and
a second cap hit blocks with `step-cap` as before. Attended runs are unchanged. If the cap arrives on a launch of
Build or Review, the head Finish publishes has not been approved; auto-merge still needs an approving Review for
that head.

## Card dependencies (`feat/card-dependencies`)

"Blocked by…" in a card's right-click menu, `agetor depends <id> <dep…>` (or `--clear`), or
`PUT /tasks/:id/blocked-by` with `{ids}`. Stored in the `card_dependencies` preference; `Task.blockedBy` is decorated
onto API responses (`src/bun/dependencies.ts`). A set that would make cards wait on each other is refused.
A dependency is satisfied when its card is Done/archived/deleted or its PR merged.
While waiting, the card says `Waiting on "<card>" · PR #201 · checks running` and carries a "waits on #201" chip.
When the last one lands, a 15s watcher moves the card on and clears the entry: never-started → started; blocked
pipeline → its blocked step is told to merge the base and carry on; idle single task → told the same.
Resuming a step waits for a free step slot (`unblockGate`): a heavy step needs the verification slot, so three
cards unblocked by one merge carry on one after another, not all at once. A priority card doesn't wait.
These are dependencies between cards. Autopilot doesn't use them: its order comes from the milestone thread or from
the roadmap's predecessor steps.

## Closing issues when their PR merges (`feat/close-issues-on-merge`)

GitHub only auto-closes "Fixes #N" when a PR merges into the default branch; Pillar's PRs merge into `develop`, so
fixed issues stayed open. When a card's PR merges (seen by the PR watcher, including Done cards' one lookup after a
restart), the issue it fixes — its `issueUrl`, else a `Fixes/Closes/Resolves #N` line in its prompt — is closed with
a "Fixed by #PR, merged into develop" comment — but only when the merged PR's description itself uses a closing
keyword for that issue (`prClosesIssue` in `src/bun/pr-watch.ts`: `Fixes/Closes/Resolves #N`). A PR that says
`Refs #N` leaves the issue open and the card's timeline says so. Merge trains close issues through the same check
(`closeIssueForTask`). `closed_issues` preference remembers what was closed; an issue already closed is left alone.

## Columns: In Review and Ready to Merge (`feat/review-merge-columns`)

Board: Backlog · Running · Blocked · In Review · Ready to Merge · Done. "ready" is still a task state (queued, or a
stopped pipeline) but shows in Backlog (`boardColumnOf`).
- **In Review** = the user's review of the PR. A finished run without a PR says "No PR yet" (needs you); a green PR
  says "checks pass — review and sign off". Finish / Open PR write a reviewer-ready PR description (Summary, Why,
  Impact, How it was verified, Review focus).
- **Ready to Merge** (column id `merge`) = sign-off (`src/bun/merge-queue.ts`, intent in `merge_queue` pref via
  `merge-intent.ts`). The user drags a card there, or Autopilot signs it off. Every minute, one next step per card:
  open PR → resolve conflicts → update from base → Fix CI → address review → wait for checks → squash-merge
  (`merge_method` pref) when its checks are fresh against the base, else a merge train first (the fresh rule, under
  Merge trains). Agetor opens the PR itself (`openPrDirectly`: push, then the API) and starts the Open PR
  follow-up only when that fails; the branch is updated from its base only when GitHub requires it or CI is failing.
  Each automatic step once per PR head, ≤4 fix-ups per card.
  A card whose pipeline has steps named Build, Review and Finish (Build → Review → Finish) gets no Fix CI or Resolve
  conflicts follow-up, which would push a fix nobody reviewed: its sign-off is withdrawn and its run re-enters at Build
  with the failure as Finish's "verification failed" handoff (failing jobs, run URLs, log tail, or the conflicting
  files); Review re-reviews, Finish pushes once, and the finished run is signed off again the ordinary way
  (`src/bun/merge-rework.ts`, `reworkPipelineRun`). A job a runner or the network broke is re-run once instead; the
  base failing the same checks waits. `merge_queue_rework` preference, default `{"enabled":true,"maxRounds":3}`:
  after `maxRounds` rounds (or a round that left the head unchanged) the card is held in In Review with a "Held for
  you" timeline entry, and Autopilot leaves it there until the owner drags it to Ready to Merge again. The PR
  watcher's automatic Fix CI follows the same rule for these cards.
  **A conflict with the base is counted apart, per base commit** (`reworkConflict`, `entry.conflict`): merging the
  base in is Build's work, never the owner's. A card that conflicts with a base tip it has not been sent to Build for
  gets a round whatever its other rounds came to, and also when it is already held ("No longer held for you: develop
  moved to …"); for one base tip it gets at most `maxRounds`, each for a head the last round changed, then waits for
  the base to move (one `git ls-remote` a pass, nothing fetched). The one conflict that is held for the owner for good
  is a round that left the head as it was — Build could not resolve it (`heldFor: "conflict-unresolved"`) — or a
  Build that hands off `blocked` inside the round, which blocks the run as any step does.
  **A hold does not outlive its run.** A sign-off the owner took back (`autopilot_hands_off`) and the merge queue's
  hold are each about one run of the card at one PR head (`autopilot_hands_off_marks`; `heldRun` on the rework
  entry). When another run of the card — a restart, or that run reopened by the owner — finishes at a different head,
  the marks are forgotten and Autopilot judges the card like any other (`signOffMarkLapsed`). The same run, the same
  head, or a head an automatic fix round pushed keep them.
  A pipeline edge may carry `maxTraversals` (set through `PATCH /pipelines/:id`; the editor keeps it but has no
  control for it): a step that chooses the edge once more is held for a person (`exhaustedEdge`), e.g. `2` on
  Finish → Build. A pipeline's fix-up run returns the card to Ready to
  Merge (runner honours the intent), not In Review. Dragging back to In Review/Backlog withdraws the sign-off (for
  one of Autopilot's cards, for good: `noteSignOffWithdrawn`).
  Merged → Done + issue closed (if the PR says `Fixes`). The column's refresh button is `POST /merge-queue/refresh`.
  Pipeline cards still in In Review get conflicts with their base resolved by the same loop.

## Step slots (`feat/step-slots`)

Too many agents at once starve the Mac (five builds + their test suites → timeouts). `step_slots` preference
(`src/bun/step-slots.ts`, default `{"max":3,"heavy":{"max":1,"steps":["Finish","Open PR","Fix CI","Resolve merge
conflicts","Run VM tests","Run E2E"]}}`): a pipeline step over the limit queues as a `slot-wait` block — the run reads
as running, the card says "Finish queued — starts when a slot frees up", the run view shows it in blue with no
Retry — and `releaseSlotWaits` (every 10s) launches the longest-waiting first. A step counts from launch until it
settles. Heavy steps match by name prefix. Plain tasks count toward `max` but are never held. A live step that only
waits — on a question or permission card, or on Claude's usage-limit pause — doesn't count. These slots limit running
steps on the machine; Autopilot's `maxInFlight` separately limits how many cards it keeps building.
Don't set `build.bunVersion`: Electrobun 1.18's native channel (window drag, etc.) breaks on Bun 1.4.2. The bundled
Bun 1.3.13 has segfaulted under heavy load (3× on 2026-10-04); the real fix is an Electrobun 2.x upgrade.

## Every card has a GitHub issue (`feat/auto-issues`)

`src/bun/auto-issue.ts`: a card created without an issue, in a project with a GitHub remote, gets one opened in
the background (title = card title, body = its prompt), then is linked — `issueUrl`, title `Issue #N: …`, `Fixes #N`
in its prompt — so tags/dependencies show a number and the issue closes when its PR merges. At startup, live cards
without one are caught up (Done cards are left). Skips pipeline steps, cards from an issue, non-GitHub projects.
`agetor config auto_issues false` turns it off; never runs under tests unless set to `true`.

## PR lookups that can't silently fail (`fix/pr-lookup-robustness`)

- `githubToken` runs `gh auth token` with the live env: an app opened from the Dock has a bare launch PATH, `gh`
  wasn't found, every call went out unauthenticated, and a private repo's PRs read as "none".
- The PR watcher separates "GitHub says no PR" (`hasConfirmedNoPr`) from "couldn't look" (probe throws, last status
  kept). The merge queue only opens a PR on a confirmed none, once per card.
- A pipeline that finishes in In Review with commits beyond its base and no PR gets one opened by Agetor itself
  (`maybeOpenMissingPr` → `openPrDirectly`, once per run; base = `pr_base_branch` preference, else `develop` when the
  remote has it, else the remote's default branch). The "Open PR" follow-up is started only when that fails
  (uncommitted changes, a failed push or API call) — In Review always has a PR.

## Models, effort and subagents (`feat/subagent-models`)

Step subagents (`step.subagents`) now run on their persona's model: a Claude step's Delegation section tells it to
pass the Agent tool's `model` (`claudeModelAlias`: sonnet/opus/haiku) — before, a Scout spawned from an Opus step ran
on Opus. Codex steps get no personas (no subagent tool). Board config (2026-10-04): Scout sonnet/low (subagent on Plan
×4, Survey ×4, Reproduce ×3, Fix ×2, Feature Review ×2, Security ×2); Architect opus/high (Plan, Survey, Explain);
Investigator sonnet/high (Reproduce); Builder opus/high (Fix); Codex Builder gpt-6-sol/high (Build, VM); Claude
Reviewer opus/medium; Codex Reviewer gpt-6-sol/medium; Security Reviewer opus/high; Editor sonnet/medium (Synthesize,
File issues); Finisher gpt-6-luna/medium. Verification is path-scoped (Pillar
`.github/scripts/verify_changed.py --if-needed`, PR #229), CI runs the full suite.

## One pipeline: Change (`feat/default-pipeline`)

Board config (2026-10-04): pipelines are **Change** (default for every card) and **Branch Review**; Feature, Bugfix
and Simplify were retired. Change = Understand (Investigator, Claude sonnet-5.5 high + 3 Sonnet Scouts; can end the
run, or skip to Finish for a trivial change it made) → Build (Codex gpt-6.1-sol high) → Review (Claude opus-5.5
medium + 2 Scouts — the other model family; changes requested → Build) → Finish (Codex gpt-6-luna; verification
failed → Build). Codex does the long work on the plan with quota headroom; Claude does short thinking steps.
`default_pipeline` preference = Change's id: the Issues page starts on it, and Autopilot uses it unless its own
`pipelineId` is set. Fix CI / Address review /
E2E follow-ups run on Codex Builder.

## Merge trains (`feat/merge-train`)

`src/bun/merge-train.ts`, driven by the merge queue: when ≥2 Ready to Merge PRs in one project/base are green,
mergeable and thread-free (behind is fine) and the oldest has waited `windowMin` (or `max` are ready), Agetor builds
`agetor/merge-train-<id>` from `origin/<base>` with ONE squashed commit per PR (`<title> (#n)`; conflicting or empty
PRs drop out and merge alone), pushes it, opens "Merge train: #a, #b" — CI runs once — and when green merges it with
**rebase** (develop keeps one commit per PR, one push → one develop CI run). Originals are closed "Merged in merge train
#T", cards → Done, issues closed (`closeIssueForTask`). CI failure / conflict / a member changed or withdrawn →
disband, members are handled individually. A lone ready PR waits the window for company, then merges alone if its
checks are fresh (below). One train at a time. Config `merge_train` = {"enabled":true,"windowMin":10,"max":6}. Cards show "In merge train #T" / "Merged in
merge train #T" (`Task.mergeTrain`). Ready to Merge's **Merge together** button (`POST /merge-train/depart`) sends a
train now with every PR that can go, without waiting for the window or for each PR's own checks; it replaces a train
whose CI hasn't started and is refused once one is running CI.

**The fresh rule** (`merge_queue_fresh` preference; on unless it is `false`). Before it, a green PR that was behind
its base merged on its old result, and a failed train's members merged one at a time on theirs, so a PR could land on
checks older than a rule added to `develop`. Now a green PR merges by itself only when its checks are *fresh*: its
head contains the base's tip (`freshAgainstBase`: `behindBy === 0`; unknown counts as stale), so the commit CI tested
is what lands. Run times are not used: a re-run tests the old merge commit. Otherwise:
- `nextMergeStep` returns `train` for a green PR that is behind. With company it joins the usual train; alone, it
  waits the window, then leaves as a **train of one** (`shouldDepart`/`buildTrain`/`assembleTrain` take a minimum).
- Members of a train that disbanded (and PRs left out of one) are re-tested as trains of one, one at a time, instead
  of merging directly. A train of one whose CI fails means "green alone, red on the latest base": the PR's branch is
  updated from the base so the failure shows on the PR, where Fix CI or a fix round can reach it.
- With trains off, or when a train of one cannot be built, the branch is updated from the base instead.
- Just before any direct merge the queue asks GitHub how far behind the head is (`mergeQueueDeps.behindBy`): the
  watcher's cached answer can be ten minutes old, and another PR merging in between is the case the rule is for.
  Behind → no merge, the PR is re-read and sent by train; unknown → no merge this pass.

What it costs in CI runs, also written on the card's timeline each time: nothing for a PR whose head contains the
base tip; one run per train as before when two or more are ready; **one extra run for a lone PR that is behind**;
and after a failed train of N, up to N more (one train of one each). `merge_queue_fresh` = `false` restores the old
behaviour without a rebuild: stale green PRs merge as they are and disbanded members merge one at a time.
`rollUpChecks` (`src/bun/pr-watch.ts`) judges each check name by its **newest** run (`newestPerName`: start time,
then id), so a duplicate run cancelled by `cancel-in-progress` beside one that passed no longer reads as pending; a
name whose newest run is cancelled is still not a pass.

## Finish run by Agetor (`feat/check-gates-stage-0-1`)

Stage 1 of `docs/plans/check-gated-pipeline.md`. **Off unless switched on.** For a card it covers, a reviewed
pipeline's Finish step (the `Finish` of Build → Review → Finish, `reviewedPipelineShape`) is carried out by the core,
not by an agent: `src/shared/publish.ts` is the pure state machine (`decidePublish`, `applyPublish`),
`src/bun/publish-step.ts` observes git and GitHub and acts, once a minute per held card and at once when a card is
put on hold. The visit's state is `run.publish`, so a core restart loses nothing.

| State | Agetor checks | Then |
| --- | --- | --- |
| `verify-head` | no tracked changes; HEAD is the last Review's `reviewApproval.headSha` (`reviewApprovalMatches`) | `check-merge`. Dirty, another head, or not approved → Build. No `reviewApproval` at all → the agent runs Finish as before (`agent`). |
| `check-merge` | `git merge-tree` of HEAD and `origin/<base>` | contains the base tip → `hold-base`. Clean and the change's own diff unchanged → Agetor merges the base in, then `hold-base`. Conflicts → Build. Clean but the diff would change → `hold-base` with the approved head as it is. |
| `hold-base` | the base tip's checks (`required` when it has one, else any failure) | red → stay (a push would spend a run that must fail). Otherwise `push`. |
| `push` | `git ls-remote` | already there → `pr`. Otherwise one push of that sha. Remote diverged, or the branch is a base branch → the owner. |
| `pr` | the branch's pull request | none → a draft is opened (`Refs #n`). → `wait-ci` |
| `wait-ci` | the head's check runs, newest per name | green → `finalize`. Failed and finished → `classify`. Newest cancelled, nothing running → one re-run. |
| `classify` | each failing job on the base: tip first, then up to ten commits back for one that ran it (`baseVerdicts`) | a runner fault (`infraReason`) → one re-run per head. Passes on the base or never ran there → Build, with `ciFailureHandoff`. Fails there too → `base-red`. |
| `base-red` | the base's runs of the inherited jobs, every 3 min | failing → stay. Passing → `refresh`. |
| `refresh` | as `check-merge` | base unmoved → re-run the failed jobs once. Clean merge, same diff → Agetor merges the base in → `push`. Conflict or a changed diff → Build ("merge origin/<base>"). |
| `finalize` | still green for the published head | PR marked ready, a facts comment posted, then `write`. |
| `write` | — | one turn of Finish's own agent rewrites the PR description; its handoff ends the run whatever `next` it names. |

- **No agent, no slot, no attempt while it waits.** A held Finish has no step task: the run carries a run-level
  `await` block for the step (it reads as running), `slotUse` and the card-owner count see nothing, `stepCount` does
  not move. The wait on a red base is a state Agetor entered from what it read on GitHub; no handoff, no `waitingRef`
  and no `classifyBlock` take part, and it leaves the state by itself when the base's jobs pass. A visit costs one
  step in total, as before: the writer's turn, or the record written when it is sent back to Build (that record also
  counts against `maxTraversals` on Finish → Build).
- **Whose failure** is decided by check name and job against the base, never by log text. Log text is read only for
  the runner-fault decision (one re-run when wrong) and quoted to Build.
- **What it pushes.** One commit, by sha, to the card's own branch: the approved head, or that head with the base
  merged in by Agetor when the merge is clean and `git patch-id` of `git diff <base>...HEAD` (plus the list of changed
  files) is the same before and after (`mergeProbe`: `merge-tree` + `commit-tree`, the worktree is untouched until the
  fast-forward). `run.publish.approvedHead` stays the head Review saw and `carried` counts the merges; Autopilot's
  sign-off check accepts the carried head (`approvedHeadFor`). It never force-pushes, never pushes to `main`,
  `master`, `develop`, `release` or the card's base, never rebases or amends, never merges the PR.
- **What the agent still does.** It writes the PR description (and at most one comment mapping acceptance criteria
  to evidence) and decides `Fixes #n` or `Refs #n`. It does not push, wait, classify or choose an edge.
- **Stops for the owner** (a `step-blocked` block on the card; Retry resumes the visit where it stopped): the remote
  branch diverged, the PR was closed or merged or moved to another head, no check started in 20 minutes, CI cancelled
  again after its one re-run, an action failed five times, or Finish → Build reached its `maxTraversals`. Manual
  Advance and Stop do not act on a held Finish (there is no step task to act on): take the card out of the
  preference and it is its agent's again.

**The switch** is the `pipeline_gates` preference:

```json
{"publish": {"pipelines": ["<pipeline id>"], "cards": ["<task id>", "<task id>"]}}
```

`pipelines` turns it on: each entry is a pipeline's **id** (`agetor pipeline ls --json`) or its **exact name**,
compared without regard to case — `"Change: Understand, Build, Review, Finish"`, never a prefix such as `"Change"`.
`cards` is the trial list (full task ids), and while it is present only those cards are covered. Remove `cards` to
cover every card of those pipelines. An entry that matches nothing gates nothing, and is no longer silent: the
`{"gates": true}` refreshes below answer with what did not match (`gatesUnmatched` on `refresh-runs`, `unmatched` in
each `gates` result: `{"pipelines": ["publish: Change"], "cards": ["steps: <id>"]}`), the card that was refreshed gets
a timeline line "pipeline_gates names what is not there …" naming its own pipeline's name and id, and the core log
has the same line when the preference is saved (`unmatchedGateRefs`, `src/shared/publish.ts`). A card is covered when its run *adopted* the gate
(`run.snapshot.gates.publish`) **and** the preference still names it:
- A run adopts when it starts. A run that has started adopts only on an explicit refresh:
  `POST /pipelines/:id/refresh-runs` with `{"gates": true}`, or `POST /tasks/:id/pipeline/refresh-instructions` with
  `{"gates": true}` (`adoptPipelineGates`). It takes effect at Finish's next launch; a step in mid-turn is not
  switched. Saving the preference or the pipeline alone changes no running card.
- Taking a card or the pipeline out of the preference works at once, with no refresh: the next launch of Finish is
  the agent's, and a Finish Agetor is holding is handed to its agent on the next pass.

**To trial it:** set the preference with two or three card ids, call `refresh-runs` with `{"gates": true}`, and watch
the cards' timelines ("Finish (run by Agetor): …"). Compare `agetor blocks` for Finish `step-blocked` and launches per
merged card. To back out: `{}` in the preference. After a rollback to a build without this, a card that was being
held shows an `await` block nothing wakes — press Retry on it and its agent runs Finish.

Not done here: the board's card states (`src/mainview` is unchanged, so a held Finish reads "Queued — No step is
running yet" with the real line on the run view); the `ci` cap in `step_slots` does not count cards waiting in
`wait-ci`; the writer's turn still takes a verification slot because slots are keyed by step name.

Also in this change: a step that started a CI wait and then ended the same turn with a `blocked` handoff was never
woken when the wait finished (the run recorded `step-blocked`, and only `await` blocks were woken). Such a step is
now woken like any other when its own CI waits finish, while the wait queue — not the owner — holds it
(`ciBlockedAwaits`, `src/bun/awaits.ts`). This one applies with the switch off.

## Checks on working steps (`feat/check-gates-stage-2`)

Stage 2 of `docs/plans/check-gated-pipeline.md`. **Off unless switched on.** For a card it covers, a step with a
gate is finished when checks Agetor runs itself pass — not when its agent's handoff says so. When the step's turn
ends its checks are run on the card's worktree; a required check that fails goes back to the **same step, in its own
session**, as another turn that carries the failure. `src/shared/checks.ts` is the pure half (the model, the order,
the verdict, the words), `src/bun/check-runner.ts` runs the checks and keeps the ledger, and `settleStepRun`
(`src/bun/pipeline-runner.ts`) decides what a result does to the run.

**What a gated step's turn end does**

| The turn ended with | Required checks | Then |
| --- | --- | --- |
| a handoff | all pass | the run advances by the graph, as before |
| a handoff | one fails | the handoff is void; the step gets a check-feedback turn (`sendInput` into its session): the step's goal, each failed check's id, description, exit code and the last 60 lines of its output, the log's path, and the handoff contract again |
| no handoff, before its one reminder | not run yet | the reminder, as before |
| no handoff, after the reminder | all pass | **the run advances** with a handoff Agetor composes (below). The card is never blocked for a missing handoff when its checks pass |
| no handoff, after the reminder | one fails | a check-feedback turn, as above |
| a `blocked` handoff, a question, an `agetor-await` | not run | as before: the wait queue, the owner, the await |

- **A feedback turn is not a launch.** Same step task, same session, same history record: `run.stepCount` does not
  move, so it costs nothing against the step cap, and the execution keeps the slot it had (it stays `active` with no
  block, which is what `slotUse` counts). The record's `gate` says where the visit stands
  (`working → checking → feedback → passed`, `turns`, `max`, `failed`), and the card reads "Fixing checks — back in Build to fix
  failed checks: tree-clean · check-feedback turn 1 of 2".
- **`maxTurns`** feedback turns per visit (step field, 0..5, default 2). Still failing after them: the visit ends
  (`outcome: "failed"`, `gate.state: "exhausted"`) and the step is launched **once more in a fresh session**, with the
  failures as its arrival — that is one real launch and counts as a step. If the fresh session's turns run out too,
  the run blocks with kind `check-failed` for the owner. Retry gives the step a turn and a new allowance of
  `maxTurns`; Advance moves on and writes one `waived` line per failing check in the ledger.
- **A check that could not be evaluated** (git did not answer, GitHub unreadable, a required check still running, a
  command that could not be started) is `halt`: no turn is spent on the step, the run blocks `check-failed` at once.
- **The composed handoff** is marked in `purpose`, `summary` and `reason` with
  `[Composed by Agetor — not written by the step's agent]`; the summary names the checks that passed and quotes the
  step's last two messages (the end of them, 4,000 characters at most); `next` is the step's one way forward. It is
  only composed where there is one way forward (Build). A Review is never advanced this way: with no handoff there is
  no verdict, `review-verdict` fails, and it costs a same-step turn. `gate.composed` is set on the record.
- **Not gated:** a follow-up step, the writer's turn of an Agetor-run Finish, and the wrap-up at the step cap.
- **Review findings still route to Build.** `review-verdict` passes for "changes-requested" as long as the verdict
  names HEAD: that is a judgement, and the run follows it. What stopped is going round Build → Review → Finish for a
  dirty tree, a missing commit or an approval of another head.

**The checks.** A step's `checks` is a list of

```json
{"id": "unit", "description": "The unit tests pass.", "run": {"kind": "command", "command": "make unit"},
 "dependsOn": ["tree-clean"], "skipWhen": "unchanged-since-pass", "required": true, "timeoutSec": 120}
```

`run` is `{"kind":"builtin","name":…}` or `{"kind":"command","command":…}` (`sh -c` in the card's worktree, exit 0
passes, killed at `timeoutSec`, 600 at most; its whole output is saved beside the ledger). `dependsOn`: runs only
after those passed. `skipWhen: "unchanged-since-pass"`: a recorded pass for the same HEAD, tree, base tip and
definition is not run again. `required: false`: reported, never gates. The built-ins:

| Built-in | Passes when | Reads |
| --- | --- | --- |
| `tree-clean` | no uncommitted change to a tracked file | `git status --porcelain --untracked-files=no` |
| `diff-nonempty` | HEAD has a commit the base does not | `git rev-list --count origin/<base>..HEAD` (the base as last fetched; nothing is fetched) |
| `review-verdict` | the turn's handoff has `reviewApproval`, its `headSha` is HEAD, and "approved" has no findings and complete acceptance | the handoff and `git rev-parse HEAD`; the ledger records HEAD's tree |
| `head-approved` | HEAD is the head the run's last finished Review approved | the run's history |
| `merges-with-base` | `git merge-tree` of HEAD and the base has no conflict | local refs only |
| `head-published` | `origin/<branch>` is at HEAD | `git ls-remote` |
| `pr-required-check` | the PR's `required` check (the whole set without one) passed for HEAD; not applicable with no PR; still running → `halt` | GitHub, read-only |

**Defaults.** A step that declares no `checks` gets, in a reviewed pipeline (Build → Review → Finish,
`reviewedPipelineShape`): **Build** `tree-clean` + `diff-nonempty`; **Review** `tree-clean` + `review-verdict`. Review's
`tree-clean` stands on Build's gate: on a visit that another step handed the work to (Understand's trivial change,
where the graph routes it through Review) it is reported and not required (`defaultChecksOf`). Every
other step has no gate; `"checks": []` on a step says "no gate" on purpose. No test suite, linter, type checker or
build is a default, and none runs on this Mac unless a pipeline declares a command check.

**The prompt.** A gated step's prompt gets `## Step goal` (the step's `goal`, when it has one) before `## Your step`,
and `## Checks this step must pass` after it: one line per check with its description. Writing `{{checks}}` in the
step's instructions puts the list there instead. With the gate off the prompt is byte for byte what it was.

**The ledger** is `<data dir>/pipeline-runs/<card>/checks-<generation>.jsonl`: one line per check per evaluation
(step, visit `seq`, evaluation `turn`, outcome `pass`/`fail`/`skip`/`halt`/`waived`, the key — HEAD, tree, base tip,
definition hash — exit code, detail, output tail, log path). Append-only and written only by the core. It is a file
so a build that does not know checks cannot erase it; it is only ever *trusted* to skip a `skipWhen` check — every
built-in is recomputed. `GET /tasks/:id/pipeline/checks` returns it, and the run view's Checks tab lists the
selected step's rows under "Recorded while … was executing".

**The switch** is the same `pipeline_gates` preference as Finish, under its own key:

```json
{"steps": {"pipelines": ["<pipeline id>"], "cards": ["<task id>", "<task id>"]}}
```

Both gates at once: `{"publish": {"pipelines": ["<pipeline id>"], "cards": […]}, "steps": {"pipelines": ["<pipeline id>"], "cards": […]}}`.
The semantics are those of `publish`: `pipelines` (ids, or exact names — not `"Change"` for a pipeline called
`"Change: Understand, Build, Review, Finish"`) turns it on, `cards` is the trial list (remove it
to cover every card of those pipelines), and a card is covered when its run *adopted* the gate
(`run.snapshot.gates.steps`) **and** the preference still names it.
- A run adopts when it starts. A started run adopts only on an explicit refresh — `POST /pipelines/:id/refresh-runs`
  or `POST /tasks/:id/pipeline/refresh-instructions` with `{"gates": true}` (`adoptPipelineGates`, which now answers
  `{publish, steps, changed}`). That refresh also copies each step's `goal`, `checks` and `maxTurns` from the template
  onto the run (never its text). It takes effect at each step's next launch: a visit already launched — running,
  or stopped on a block — keeps the loop it was launched with, also when it is retried (its record has no `gate`).
- Taking a card or the pipeline out of the preference works at once, with no refresh.

**Editing a step's gate.** The step panel of the pipeline editor shows a step's goal, checks and turns read-only
(`pipeline-step-gate`). They are edited through the pipeline's JSON for now: `PATCH /pipelines/:id` with the whole
`graph`, each step carrying `goal`, `checks`, `maxTurns` as wanted. `validatePipelineGraph` keeps them (and rejects a
duplicate id, an unknown built-in, an empty command, a dependency cycle, a timeout over 600); the editor's own saves
preserve them because it sends back the step objects it loaded.

**To trial it:** set the preference with two or three card ids, call `refresh-runs` with `{"gates": true}`, and watch
for "did not pass its checks … sent back to Build in its own session" and "moving on with a handoff composed by
Agetor" on the cards' timelines. Compare `agetor blocks` for `handoff-missing` and launches per merged card. To back
out: remove `steps` from the preference. After a rollback to a build without this, a `check-failed` block is
dropped by that build's reader (the step then reads as running with nothing live until the unsettled-step sweep
settles it the old way), a record's `gate` is dropped, and the ledger file is left alone.

Not done here: the card's strip still colours a segment by a succeeded execution; `Review → Build` has no default
`maxTraversals`; a `blocked` handoff is honoured as before without its checks being run. (Retry running the checks
first, position resolution, rewind and feedback came with Stage 3, below.)

## Position, rewind and feedback (`feat/check-gates-stage-3`)

Stage 3 of `docs/plans/check-gated-pipeline.md`. **Only for a run with check gates** — one that adopted `publish` or
`steps` and that `pipeline_gates` still names. Every other card restarts, retries and advances exactly as before, and
the routes below answer 409 for it. `src/shared/position.ts` is the pure half (the walk, the void lines, the notes),
`src/bun/position.ts` reads the worktree and the files, `src/bun/pipeline-runner.ts` acts.

**The position** is the first step whose gate is not satisfied *now*. `resolvePosition` walks the run's forward path
(`forwardPath`: from the start step, the edge that leads to a step not yet on the path — Review → Finish, not Review →
Build; where a step has several, or may end the run itself, the one its last finished visit took; a trivial change's
shortcut past Build ends once a later step has sent the work to Build and Build has finished, after which the path is
Understand, Build, Review, Finish again) and a step is satisfied when all of these hold:

| | Still satisfied when | Voided by |
| --- | --- | --- |
| every step | it has a finished visit (succeeded, or advanced by the owner) with a handoff, later than the visit that satisfied the step before it | an earlier step running again; a rewind |
| a step with checks | each required check holds now: a **built-in is recomputed** from the worktree (`tree-clean`, `diff-nonempty`, …); `review-verdict` and `head-approved` are recomputed from the run's own records against HEAD; a **command check** needs a ledger pass for HEAD's commit, its tree and the check's definition that no later fail, waiver or void takes back. No command is ever run to find a position | a new commit (Review and everything after it: the verdict names another head); a dirty tree (Build); a changed check definition (that check); a rewind |
| Understand (the start step, no gate) | **its earlier handoff is reused** when its prompt carries the card's goal as it is now, word for word, and no change of the card's issue contract was recorded after it finished (`autopilot_card_inputs_v1`, the digests `reconcileCardInputs` keeps for a dispatched card; a card with no such record is judged by the goal alone) | an edited goal; a changed issue body; a rewind to it |
| a Finish Agetor ran | `run.publish.head` is HEAD and the pull request's `required` check passes for it when read now | a new commit; a failed or still-running check |

A satisfied step whose visit sent the work **back** (Review, "changes requested" for this head; Finish, "verification
failed") makes the step it named the position, with that visit as the arrival. A moved base voids only what is
recomputed against it. **Changed instruction text voids nothing**: text is not evidence — use Rewind. A run whose
`steps` gate is off but whose `publish` gate is on is judged by the default checks for Build and Review. A graph that
fans out or joins has no position (`unsupported`), and restarts from the beginning.

**Restart resumes.** `POST /tasks/:id/pipeline/restart` on a gated run re-snapshots the template (as a restart does)
and launches the position's step with the handoff of the step before it. The run is the same run: history, step
numbers, the ledger and the handoff files are kept, only what was still under way is stopped, and the step cap is
raised just enough for the steps from there to the end. The answer carries
`resumed: {stepId, stepName, why, kept: […]}`; the timeline says "Restarted. Resumes at Review — …; Understand, Build
are still satisfied and are not run again". When everything is satisfied it refuses (409, "there is nothing to
resume — rewind to a step to redo it, or restart from the beginning"). **From the beginning** is
`{"fromScratch": true}` in the body (`agetor pipeline restart <task> --from-scratch`): history emptied, a new
generation, the start step — what every restart was, and what an ungated run, a position on the start step or an
`unsupported` graph still gets. `GET /tasks/:id/pipeline/position` reads the position without starting anything
(`{gated, position, line, steps: [{id, name, reached}]}`), and a `{"gates": true}` refresh includes the same line as
`position`.

**Rewind.** `POST /tasks/:id/pipeline/rewind` with `{"stepId": "<step id>"}`
(`agetor pipeline rewind <task> --to <step>`): the gate evidence of that step and of every step after it on the path
is voided **by appending** `void` lines to the ledger — one per step with check id `(step)`, which voids its visits
up to that step number, and one per check that had a result, with that result's key so a `skipWhen` pass is not reused
either. Nothing in the ledger is rewritten. A Finish Agetor is holding is dropped (it verifies the head again from the
start), whatever is running is stopped (its visit ends `cancelled` and stays in the history; its step row is
archived), and the step is launched with the handoff of the step before it. **Git is never touched**: no reset, no
branch change, nothing on the remote. The answer says what was voided and stopped and
`unpushed: {count, head, remoteHead}` — the commits the remote does not have, as last fetched. A step the run has not
reached (the step before it has no finished visit) is refused.

**Feedback (steer).** `POST /tasks/:id/pipeline/feedback` with
`{"fromStepId": "<step id>", "note": "…", "invalidate": false}`
(`agetor pipeline feedback <task> --from <step> --note "…" | --note-file <file|-> [--invalidate]`): the note is
appended to `<data dir>/pipeline-runs/<card>/feedback-<generation>.jsonl`, the run is reopened from that step as a
rewind reopens it, and the step's next prompt gets `## Feedback from the owner` with the note — as does each later
step's, until that step has finished a visit launched after the note (Build reads it once, then Review, then Finish;
a later Build ↔ Review round does not repeat it). Without `invalidate` nothing is voided: it is a refinement, the
prompt says so, and earlier results stand. With `invalidate` the evidence is voided exactly as a rewind voids it.
The writer of an Agetor-run Finish and the wrap-up at the step cap never carry a note. At most 8,000 characters;
the newest five notes that still apply are shown.

**Retry runs the checks first.** The owner's Retry (`POST /tasks/:id/pipeline/retry`, the Retry buttons, the CLI) on
a step that stopped with `check-failed` judges the turn it ended on again by checks run now — the settle that judged
it the first time. They pass (the owner fixed the worktree, GitHub answers again): the run moves on with what the
step handed off, and **no turn is spent**. One still fails: the step gets a check-feedback turn with the output,
under a new allowance of `maxTurns`. A stop for any other reason, a visit launched without the gate, and every
internal retry (the wait queue, automatic retries, the feedback fallback) are the ordinary retry, unchanged.

**The run view** has, under Advanced run controls for a gated run: the position line; "Restart from <step>…" (asks,
not destructive) beside "Restart from the beginning…" (the existing destructive confirmation); "Rewind to a step…"
and "Send feedback from a step…", each a closed form that picks no step for you and sends nothing until its own
button is pressed. The inspector's "Restart pipeline…" is unchanged and always means from the beginning.

Sign-off marks: a restart that resumed, a rewind and feedback each mark a taken-back sign-off and a merge-queue hold
as "reopened by the owner", so they lapse when the redone run finishes at a new head (see "A hold does not outlive
its run" above).

Not done here: a drag to Running / a plain Run on a stopped gated run is still the ordinary retry (only the Retry
route runs the checks first); feedback to a step that is live is not sent into its session — it reopens the run from
that step like any other (the step panel's message box still talks to a live step); a refinement visit gets the
step's ordinary turn allowance, not a single turn; the card's strip still colours a segment by a succeeded execution,
not by the position; fan-out and join graphs; and position resolution reads GitHub only for a Finish Agetor ran — an
agent-run Finish is judged by its finished visit alone.

## Pillar's instruction policy (`feat/instruction-policy-compatible`)

Pillar versions its profile and step instructions in `docs/engineering/agetor/` and applies them with
`sync_policy.py`, which talks to Agetor only through the CLI. This branch adds what that script needs and nothing
that changes how a run is published, capped or verified: `docs/plans/instruction-policy.md` records what was taken
from the other session's commit (`004f16e`) and the four behaviours of `release` that were kept.

- **`agetor pipeline edit <ref> --file <pipeline.json|->`** replaces an existing pipeline's name, description, graph
  and step cap (`PATCH /pipelines/:id`), keeping its id. `<ref>` is the id or the unique name; `-` reads stdin; the
  file is the `PipelineInput` JSON that `pipeline export` writes and is validated like an import (`profileName`
  hints are not remapped). With `--json` it prints the updated pipeline. `agetor pipeline --help` names the verb,
  which the script checks before it changes anything. Saving does what saving a template always does: unfinished
  runs take edited step text by themselves and keep their own routing, agents and cap.
- **`agent-followups`** is a second `pipeline_decisions` mode:
  `{"mode":"agent-followups","projects":["/absolute/project/path"]}`. The decision command still writes the private
  ledger and deduplicates by question, but never creates or updates a GitHub issue; it answers with a stable
  `followupMarker` (`<!-- agetor-decision:<source issue>:<decision id> -->`) and `publication: "agent-managed"`, and
  the step's prompt tells the agent to search for the marker and file or reuse one issue per decision. Everything
  else a decision policy switches on is the same in both modes: routine choices continue the same card, the step cap
  extends once and then wraps up through Finish, a missing handoff and an interrupted launch are retried. The mode is
  one value for the whole preference, so a project list cannot mix the two.
- **The trivial change through Review.** The script moves Change's "trivial change made" edge from Understand →
  Finish to Understand → Review. Runs started before the edit keep the old edge, so both graphs run side by side:

  | | trivial → Finish (today) | trivial → Review |
  | --- | --- | --- |
  | `reviewedPipelineShape`, `publishStepOf`, `capWrapUpStep` | Build, Review, Finish; Finish is published and is the wrap-up | the same |
  | Finish run by Agetor | no Review visit, so no approved head: the visit is the agent's | publishes the head Review approved; a dirty tree goes to Build |
  | Review's default checks | handed the work only by Build: `tree-clean` + `review-verdict` | from Understand: `review-verdict`, with `tree-clean` reported; from Build: both |
  | position | Understand, Finish | Understand, Review, Finish; a new commit resumes at Review with Understand's handoff |
  | after Review or Finish sent it to Build, and Build finished | Understand, Build, Review, Finish | the same |
  | lifecycle sign-off (`reviewedPillarPipeline`) | not while no Review has seen the change; after a round through Build and Review, as on any card | when Review approved the published head |

Not done here: nothing checks that Understand committed anything before it chose the trivial route (Build's
`diff-nonempty` has no counterpart there); `profile edit --instructions-file` trims the text it stores, so the
script's comparison, which keeps a trailing newline, reports every profile as changed on each preview.

## Priority cards (`feat/priority-cards`)

`src/bun/priority.ts`: "Make priority (run now)" in a card's right-click menu, or `PUT /tasks/:id/priority` with
`{"on": true|false}`. Stored in the `priority_cards` preference (task ids). A priority card's pipeline steps launch
over the step-slot limits, its queued steps start at once, an unblocked dependency resumes without waiting for a slot,
and it goes to the front of a lease's queue. It stops being a priority once Done or archived.

## The core runs in its own process (`feat/core-process`)

The Electrobun app (`src/bun/index.ts`) no longer runs the API server, orchestrator and background loops itself: it
spawns a child with its bundled bun (`src/bun/core-child.ts`, supervised by `src/bun/core-host.ts`) so the core has
its own event loop. The boot parameters (API token, native-bridge URL and token) go to the child on stdin, not in the
environment.
- `src/bun/core-main.ts` `startCore` is the one place the core boots and every loop is started, for both hosts: the
  app's child (`kind: "app"`) and the headless CLI daemon (`src/bun/headless.ts`, `kind: "cli-daemon"`). A new
  background loop goes there, as an entry in `coreDeps`.
- A child that dies is restarted with a 1s → 30s backoff and keeps the same API token, so the open window carries on.
  The child exits by itself when the app is gone (`src/bun/core-watchdog.ts`). Agents live in tmux and survive both.
- Native calls from the core (file dialogs, notifications, open in Finder/browser, updater, quit) go back to the app
  over `src/bun/native-bridge.ts`; the daemon has no native side, so those routes answer 501.
- Packaging: `scripts/build-core-child.ts` (Electrobun `preBuild`) bundles the entry to
  `Resources/app/bun/core-child.js`; the app refuses to start without it.
- `src/bun/stall-monitor.ts` logs event-loop stalls of the core to `<dataDir>/stalls.log` (busy vs idle).

## Usage limits, retries and keepalive (`feat/overnight`)

So an unattended board keeps going:
- **Steps** (`scheduleAutoRetry` in `src/bun/pipeline-runner.ts`; messages and schedule in `src/bun/usage-limit.ts`):
  a step stopped by a Claude or Codex usage limit blocks with `autoRetry.kind = "quota"` and is retried 5 min after
  the parsed reset time, or after 15 → 30 → 60 min (then hourly) when no time was given; it never gives up. Transient
  failures get 4 retries (see Pipeline robustness).
- **Claude paused mid-turn** ("continuing automatically at …"): the scraper in `src/bun/claude-tmux.ts` marks the
  session `isQuotaPaused` — it holds no step slot and no Autopilot slot — and presses Enter when Claude shows that the
  limit has reset but is waiting for a key.
- **Autopilot** holds new starts while any card waits on a limit, and stops asking its thread until the thread's own
  limit resets (`limitedUntil`).
- **Keepalive** (`src/bun/keepalive.ts`, `agetor keepalive on|off|status`): a launchd LaunchAgent
  (`com.pillarinteractive.agetor.keepalive`) runs `~/.agetor/bin/agetor-keepalive` every 3 minutes and reopens
  `/Applications/Agetor.app` when `~/.agetor/keepalive-enabled` exists, no app process is running and the last exit
  wasn't a quit the user approved (`~/.agetor/keepalive-quit`, written on an approved quit and cleared on launch). At
  most 5 reopens an hour. Off until `agetor keepalive on`.

### Switching harness before the limit, and a notice that asks nothing

`quota_fallback` preference, e.g. `{"enabled":true,"from":["claude-code"],"harness":"claude-deepseek","atPercent":92}`:
new steps whose harness is in `from` launch on `harness` once a usage meter reaches `atPercent` (`usageAtThreshold`),
instead of only after the limit is hit. Running steps are not moved.

Claude Code shows a notice when its requests go through a gateway that has not adopted the auto-mode classifier
billing change. It offers no choices and only waits for Enter. `gatewayBillingNoticeKey`
(`src/bun/optional-claude-prompt.ts`) matches its exact sentences and sends Enter, with a timeline entry; anything
else on screen is left for a person.

## Unfinished steps stay put; the next step gets the whole report (`feat/roadmap-autopilot`)

Two things a run got wrong, both in `settleStepRun` / `launchStep` (`src/bun/pipeline-runner.ts`) and
`src/shared/pipeline.ts`:

- **A `blocked` handoff no longer moves the run along its only edge.** Build has one way forward, so its handoff
  contract says `set "next" to "Review"`; a Build stopped by Claude's usage-limit grace window wrote exactly that with
  `status: "blocked"`, and the "a blocked handoff that names a next step follows it" rule (meant for Review/Finish
  sending work back) started Review on half-done work. Now (`blockedHandoffChoosesNext`): a blocked handoff routes only
  when the step had a real choice and made one — several outgoing edges, or `canFinish` — and never when the turn hit
  a usage limit. Otherwise the run stays on the step:
  - **Usage limit** (Claude's own status notices in that turn, `quotaNoticeFrom`): the run waits for the reset with
    `autoRetry.kind = "quota"` and `autoRetry.resume`, then **continues the same session** with a note
    (`composeLimitResumeNote`, sent through `sendInput` like the await wake-up) telling it to finish and write a new
    handoff. A limit that fails a turn mid-work (any tool call already made) resumes the same way; one hit before any
    work relaunches the step as before. If the note can't be delivered the step is relaunched.
  - **Blocked for another reason**: the run stays on that step. Whether it then waits for a person or is retried
    by itself is decided by the wait queue (next section).
  - The timeline says which: "Build stopped at its usage limit before finishing — resuming it at 7:25 PM instead of
    handing unfinished work to Review" / "Build handed off "blocked" with its work unfinished — holding the run on
    Build instead of starting Review".
  - The contract now tells every step what `blocked` does. Not done: holding back a handoff that says `done` because
    a limit notice appeared in the turn (in the board's history those were finished, committed steps), and a
    "nothing changed since the last Review" check (a Build that answers a finding without changing code is a
    legitimate hand-back).
- **A step receives the sending step's full final report**, not just its handoff. The handoff's `summary` is a line
  per finding; the findings themselves (file:line, the failing case, the fix) are the body of the same message. The
  step(s) a step is entered from now contribute that body inside the same untrusted span as their handoff
  (`stepFinalReport` reads it from the step's recorded turns; nothing new is stored in the run state or the
  database). Budget: `PIPELINE_LIMITS.reportInlineMaxBytes` = 24 KB per prompt, shared by the senders, cut from the
  middle (first third + last two thirds kept) with a marker; the whole report is always written to
  `<data dir>/pipeline-runs/<card>/report-<generation>-<step number>.md` and the prompt names the file. A
  follow-up still gets every earlier handoff, with the report of the newest step only.
- **Reading them yourself**: `agetor pipeline status <card> --handoffs` prints each step's whole handoff;
  `agetor pipeline handoff <card> [<step number> | <step name> | --all]` prints a step's full final message
  (`GET /tasks/:id/pipeline/reports`).
- **A step sent back into its session is judged on what it writes from then on.** Two Builds resumed after a usage
  limit finished their work, started verification with `agetor-await` and ended the turn to wait; the settle found no
  handoff in that turn's run, fell back to "every run of the step since it started" (the sibling-run lookup for a
  reply that lands in a twin run) and read the pre-limit `blocked` handoff again. The cards were held as "handed off
  blocked", never parked as `await`, and never woken when the commands passed. Now each step record carries
  `turnStartedAt`: the start of the run that last took the step from idle to running (`handleColumnChange`,
  `running`). `executionAssistantText` reads only runs from there on, and the record's old handoff is cleared. This
  covers every way back in, which all had the same fault: the usage-limit resume, the handoff reminder, the wait
  queue's resume, a Retry (the lease watcher's too — a new session in the same step task), an await wake-up and a
  message from the step's panel. A resumed turn with awaits out parks and is woken; one with no handoff and no awaits
  gets the one reminder. No migration (a field in the run-state JSON).
  - Safety net (`readyToWake`, `src/bun/awaits.ts`): an idle step blocked as `handoff-missing` / `handoff-invalid`
    whose own awaits have all finished untold is woken with the results, once per record. Not woken: `step-blocked`
    (the step says it is blocked or asks the owner; a usage-limit stop is continued by its own resume, and waking it
    earlier would only hit the limit) and `step-failed` (the retries have it).
  - Not done: a message folded into a turn that is still running stays in the same run, so a handoff written earlier
    in that run still counts if the reply has none.

## The blocked-step wait queue (`feat/roadmap-autopilot`)

A step that hands off `blocked` and stays put (previous section) used to wait for a person whatever it was blocked
on. Now the block is classified, and one that clears by itself parks the card in a queue: the **same step** is
resumed in its own session when what it waits on changes, or on a backoff, a bounded number of times; then it goes to
the owner with what was tried. Nothing in the queue ever starts a different step.

- **Classifying** (`classifyBlock`, `src/shared/block-wait.ts` — every regular expression that reads a step's prose
  is in that file). Strongest evidence first:
  1. a usage limit the harness itself reported in that turn → resumed at the reset (as before; not the queue);
  2. the step declared `waitingOn: "owner"` → the owner;
  3. a watched lease is held by another checkout and the block names it → resource (what the card always showed
     as "Waiting for lab");
  4. the handoff has open questions, or its reason asks for a decision, a credential, a permission or a manual
     action → the owner, at once;
  5. the step's declared `waitingOn` → that category;
  6. patterns in its reason: "waiting for #41 to merge", base-branch CI red (the PR watcher's `alsoOnBase`), a busy
     slot or lease, a queued CI run, a network / registry / crashed-tool failure;
  7. nothing recognised → unknown.
- **The handoff says what it waits on.** The contract asks a blocked step for `"waitingOn"`: `owner`, `resource`,
  `dependency`, `environment`, `usage_limit` or `other`, and `"waitingRef"` (a lease's label, `#123`). It is read
  leniently (`parseWaitingOn`: other spellings, an object with `kind`/`ref`/`issue`, or absent) and kept only on a
  blocked handoff. It cannot move the run on, and it cannot talk past the owner: a declared `owner`, an open
  question or a request in the reason wins over any other declaration. The contract tells steps to keep
  `openQuestions` for questions the user must answer.
- **Schedules** (`planWait`; minutes before each automatic resume — the list's length is the number allowed):

  | Category | Resumed when | Timed retries | Then |
  | --- | --- | --- | --- |
  | resource | the watched lease frees (one card per lease every 5 min, as the lab queue did) | 10, 20, 30, 60, 60, 60 | owner |
  | dependency | the issue/PR it names is closed (`gh api`, cached 2 min), or the base's checks stop failing | 30, 60, 120, 240 | owner |
  | environment | — | 1, 5, 15, 30 (the transient backoff) | owner |
  | limit (the step says so; the harness didn't) | — | 15, 30, 60 | owner |
  | unknown | — | 15, 45, 120 | owner |

  When the timer comes due and a watcher says what it waits on has **not** changed (lease still held, issue still
  open), the card is looked at again later and no resume is spent. Bounds on top: 8 resumes per blocked execution
  whatever it waits on, 24 h in the queue, each wait stretched by up to 10% so cards don't come back together.
  Attempts carry over when a resumed step comes back blocked on something else; a manual retry starts the count
  again.
- **The resume** (`resumeBlockedStep`, `composeBlockedResumeNote`): a follow-up turn in the step's own session —
  "you handed off blocked because: …; check whether that still holds; if it has cleared, finish; if not, say what
  you are waiting for; do not work around it or decide for the user" — with the handoff contract. If the note
  can't be delivered the step is started again (still the same step).
- **The queue** is the persisted `run.wait` on each blocked run (no timers, no migration: it lives in the run's
  JSON; an older build ignores it and shows a plain block). `releaseBlockWaits` runs every 30 s: at most
  `maxPerPass` (2) resumes a pass, oldest first, priority cards ahead; none while any card waits on a usage limit;
  none over the step-slot limits. A restart loses nothing; a resume that was recorded but never sent goes back in
  line after 10 min.
- **While it waits** the run is `blocked`: it holds no Autopilot slot and no step slot, its issue stays busy (no
  second card), and the Mac is kept awake. For the roadmap it is in flight, not the owner's; for the
  next-milestone "blocked" trigger it occupies no slot.
- **A person always wins**: Retry, a message to the step, an answer, Advance or a follow-up clear the entry; Stop on
  a parked card takes it out of the queue and leaves the block for the owner.
- **Seeing it**: the card says `Build waiting for the lab — retrying when it frees or at 3:40 PM · attempt 2 of 6`
  (muted, no ⓘ); given up, `Build still blocked after 3 automatic retries: <its reason>` with what was tried under
  ⓘ. The timeline records each park, resume and escalation. `agetor waiting` (`GET /waiting`) lists the queue and
  what it gave up on. `agetor roadmap status` says `3 in flight (1 blocked — needs you, 1 waiting in the queue)` and
  lists both. Velocity has a `waiting` state beside `blocked`: time in the queue counts as "other", not the owner's.
- **Settings**: `agetor config blocked_wait '{"unknownBackoffMin":[15,45,120],"maxPerPass":2,"maxResumes":8,"maxWaitHours":24}'`
  (also `resourceBackoffMin`, `dependencyBackoffMin`, `environmentBackoffMin`, `limitBackoffMin`, `jitter`;
  `[]` for a category sends it straight to the owner; `{"enabled":false}` turns the queue off).
  `"declaredOutranksQuestions": true` lets a step that declares a non-owner `waitingOn` be queued although its
  handoff has open questions, as long as none reads as a request to a person. Off by default: in a week of this
  board's history 25 of 29 blocked handoffs had open questions, most of them notes rather than questions — so until
  steps follow the new contract, most blocks still go to the owner.
- **Codex limits**: a codex usage limit ends the turn as `turn.failed`, whose message lands on stderr and fails the
  run — already retried at the reset. New: such a row beside a turn that still handed off `blocked` counts as the
  limit notice too (`harnessQuotaNotice`: only when the row *is* the message, since codex's stderr also quotes the
  agent's commands). No codex limit has occurred on this board yet (1,407 codex runs); the strings are from the
  codex-cli binary.
- **Not changed**: cards already blocked when this build is installed are not queued (they have no entry) — Retry
  them. The lease watcher's own retry still handles blocks the queue left to the owner that name a free lease, but
  no longer a step that declares `owner`. An escalation does not send a notification.

## What a Claude step costs, and the launch flags that trim it (`feat/roadmap-autopilot`)

Measured from Claude Code's own transcripts for one day of this board (2026-10-10: 20 cards, 69 Opus step sessions,
2,783 model calls; weighted tokens = output×5 + cache-write×1.25 + input + cache-read×0.1):

- **Every step visit is already its own session.** `launchStep` inserts a new step task per visit, so a Build
  sent back by Review starts fresh at ~50k tokens (49 Build sessions for 20 cards; none resumed). Only a
  usage-limit resume, a wait-queue resume, an await wake-up and a handoff reminder continue a session — the same
  visit's. Resuming the earlier Build instead would start each fix round at ~360k.
- **Where the tokens go**: re-reading the session on every call is 54% (cache-read), output 28% (40% of it
  thinking), writing new context 18%. A Build visit makes 61 calls (39 when revisited) and its context grows ~5k
  tokens a call, to 364k on average (max 642k: Opus runs in the 1M window, and auto-compaction never fired). By what
  is being carried: the agent's own earlier output 22%, command output 19%, the starting context 15%, file reads
  11%. No cache was ever lost to a wait (1-hour cache; the longest await was 19 min) and the 44 await wake-ups
  cost about 1% — awaits are not a cost.
- **The starting context** (~50–57k tokens, sent with all 2,783 calls) is ~30k of tool definitions, of which
  about 80% belong to tools a step never calls (`Artifact` alone 47%), plus the skill list (~5k), the user's own
  MCP connectors and the step prompt (5–10k).

What changed:

- **Launch flags for step sessions** (`src/bun/claude-step-launch.ts`, preference `pipeline_claude_launch`): a
  Claude pipeline step is started with `--disallowedTools Artifact,SendFeedback,Workflow,ScheduleWakeup,ReportFindings`
  by default — a deny-listed tool is left out of the context. Plain tasks are untouched; the flags are repeated
  on `--resume`. Options, all per step name too:
  `agetor config pipeline_claude_launch '{"skills":false,"strictMcp":true,"steps":{"Build":{"autocompact":300000}}}'`
  - `disallowedTools` — bare tool names; `[]` passes none.
  - `skills: false` → `--disable-slash-commands` (drops the skill list; ignored for a profile that names skills).
  - `strictMcp: true` → `--strict-mcp-config` (no MCP servers at all: the user's connectors, but also a
    project's `.mcp.json`).
  - `autocompact: <tokens>` → `--autocompact` (100k–1M): compact the session at that size instead of letting it
    grow in the 1M window. Off by default: replaying the day's sessions, compacting at 250–300k saves 3–11% if the
    step needs little re-reading afterwards and nothing if it needs a lot; below ~200k it costs more than it saves.
  - `{"enabled":false}` turns all of it off.
  Checked with `claude -p` on 2.1.296: the default deny list takes 3.3k tokens off a 23.8k print-mode context,
  `skills:false` 2.6k more, `strictMcp` 1.6k more. An interactive session carries more tools (`Artifact` is not in
  print mode), so the saving there should be larger — not yet measured on a real step.
- **"Working economically" in every step prompt** (`STEP_ECONOMY_GUIDANCE`, `src/shared/pipeline.ts`): read ranges
  not whole large files, query big JSON/lockfiles instead of printing them, keep command output to the failing part,
  batch lookups, don't re-read the handoff/report files already quoted. A third of all tool-result text was in
  results over 12 KB. Project-specific advice (which files, which commands) goes in the agent profiles.

Not changed: the await wake-up (60-line tail, ~1.3k tokens — nothing to gain), effort and model on the profiles
(the owner's call: thinking is ~11% of the cost directly and about as much again carried), and hard caps on tool
output (`BASH_MAX_OUTPUT_LENGTH`, `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` can be set in the harness's env; a
capped read that the step then repeats in pieces costs more calls, so this is left to try deliberately).

## Milestone Autopilot (`feat/milestone-autopilot`, `feat/autopilot-events`, `feat/autopilot-run-last`)

`src/bun/autopilot.ts` (the rocket button, `AutopilotDialog.tsx`) works a GitHub milestone to done: it keeps up to
`maxInFlight` cards building and signs finished ones off for merging. One dialog, two ways to decide the order:

- **Tracker order** — a milestone (the scope) and a tracker issue (the order): the next section. No milestone = the
  whole roadmap.
- **Thread-driven** — a milestone and no tracker: the milestone-manager Codex thread picks what starts and audits the
  milestone when it empties. This section.

Both share the config, the state, slot accounting, sign-off and triggers described here. The rocket's tooltip says
which is set up (`autopilotLabel` in `src/shared/autopilot.ts`).

- **Config** — `autopilot` preference: `enabled`, `project` (path), `milestone` `{number, title}`, `threadId` (the
  Codex thread), `maxInFlight` (default 5, 1–10), `pipelineId` (else `default_pipeline`), `roadmap` `{issue}` (the
  tracker; set → tracker order, and `threadId` is unused), and for tracker order `milestones` (the scope as an
  ordered list; `milestone` is always its first entry, and a config saved with only `milestone` reads as a list of
  one) and `autoContinue` (next section).
- **State** — `autopilot_state` preference: `phase` (`idle` / `running` / `auditing` / `done`), `cards` (the cards
  Autopilot started), `held` with `holds` (why, for which PR head and rules) and `unread`, `lastAnswer`, `lastError`,
  the back-offs (`quietUntil`, `limitedUntil`), `noWork`, `waits`, `reworked`, and the tracker fields. Two more
  preferences: `autopilot_hands_off` (cards whose sign-off you withdrew) and the optional `autopilot_risky_paths`.
  No table, no migration; fields a build doesn't know are read as empty.
- **API** — `GET /autopilot` → `{config, state, defaultTracker}`. `PUT /autopilot` merges the given fields into the
  config (`applyAutopilotPatch`) and runs a pass at once when enabled. Enabling, changing the milestone, the tracker
  or the project, or `"restart": true` begins a fresh run (`phase` back to `idle`; `held`, `lastError` and the
  20-minute quiet back-off cleared). `phase: "done"` stays until then. `POST /autopilot/roadmap/resolve` is the
  owner's answer to a tracker step that finished without closing its issue, and `POST /autopilot/roadmap/continue`
  the answer to the next-milestone offer (both in the next section).
- **Which issues** (thread-driven) — Autopilot doesn't choose. It resumes the user's milestone-manager Codex thread
  (`src/bun/codex-thread.ts`: `~/.agetor/bin/codex exec resume <threadId>` in the project, one request at a time) with
  the open issues nobody is working on, what is in flight, and the number of free slots; the thread answers with a
  `<next-issues>[{"number", "scope"}]</next-issues>` block. Each accepted pick becomes a card through
  `createTaskFromIssue`; its scope goes into the card's prompt and onto the issue as a comment. While Codex Desktop
  has the thread open it is locked: Autopilot says so and retries every 5 minutes. An answer that starts nothing is
  not asked again for 20 minutes unless the candidates or the in-flight set change.
- **`run-last` label** — issues labelled `run-last` are offered to the thread only when no other issue in the
  milestone is open (`startable`).
- **Slots** (`src/shared/autopilot.ts`, shared with the dialog's count) — a card holds one of the `maxInFlight` slots
  only while it is progressing: in Backlog / Ready / Running, its run not blocked, no question or permission card
  pending, not paused on a usage limit. Cards in Blocked, In Review, Ready to Merge and Done hold none. An issue with
  any live card is never started twice. The one exception is tracker order's never-started backlog cards (next
  section), which hold no slot. Independently, the `step_slots` preference limits how many pipeline steps run at once
  on the machine, so cards Autopilot starts may sit queued for a step slot.
- **Triggers** — passes are event-driven (`startAutopilot`, `freesSlot`): a card reaching Done or moving from a
  building column (Backlog, Ready, Running, Blocked) to one that holds no slot, a pipeline run blocking, a card
  deleted or archived, and `PUT /autopilot`. Events are coalesced (3 s) and one pass runs at a time. A pass also runs
  30 s after the core starts and every 15 minutes as a fallback.
- **Sign-off** (`signOffPass`) — each pass moves Autopilot's own cards that are in In Review with a finished run and
  an open PR to Ready to Merge (the merge queue lands them), unless the PR changes sensitive product code. Then the
  card stays in In Review for you, is remembered in `held`, and its timeline names the files ("PR #n changes
  sensitive code (a.ts, b.sql and 2 more)").
  - **What is sensitive** (`src/shared/risky-paths.ts`, pure; the lists are exported constants) is decided by path
    *segment*, never by substring:
    1. Never: tests, fixtures, recorded data and docs — a directory named `__tests__`, `__mocks__`, `__fixtures__`,
       `__snapshots__`, `test(s)`, `testdata`, `testing`, `fixture(s)`, `golden(s)`, `snapshots`, `mocks`, `docs`,
       `doc`, or starting `e2e`; a file `*.test.*`, `*.spec.*`, `*.stories.*`, `*.snap`, `*.golden`, `*_test.<ext>`,
       `test_*.py`; `*.md` / `*.mdx` / `*.rst`.
    2. A directory named exactly `billing`, `stripe`, `checkout`, `subscription(s)`, `auth`, `authn`, `authz`,
       `authentication`, `authorization`, `clerk`, `session(s)`, `permission(s)`, `migration(s)` or `drizzle`
       (`RISKY_DIRS`). A Next.js route group or dynamic segment counts by its name (`(auth)/` is `auth`); a longer
       name does not (`permission-denied/` is not `permission`).
    3. A source file (`SOURCE_EXTENSIONS`) whose name has one of those words, or `authorize`, `rbac`, `roles`
       (`RISKY_FILE_WORDS`), split on `-`, `_`, `.` and camelCase: `deviceAuth.ts`, `stripe.ts`,
       `BillingNotice.tsx`, `migrationCheck.ts`. `authoritative.ts` has no such word. Data files (`.json`, `.txt`,
       `.yaml`) are matched by their directory only.
    4. `schema.ts`, `db/schema*`, `db/schema/**`, and the request middleware (`middleware.ts`, Next 16's `proxy.ts`).
  - **Override**: `agetor config autopilot_risky_paths '["apps/web/src/lib/billing/**","**/*.sql"]'` — a JSON array
    of globs (`**`, `*`, `?`; whole path, case-insensitive) that *replaces* all four rules, exclusions included. An
    empty or malformed value means the built-in rules; nothing turns the hold off by accident.
  - **A file list that can't be read is not "risky"** (`unread`): the card is not held and not signed off on that
    pass, its timeline says so once, and every later pass looks again. The list is read with
    `gh api --paginate …/pulls/n/files` (every page; `gh pr view --json files` stops at 100 files).
  - **Holds are decided again** when the PR's head commit or the rules change — otherwise a held card costs no
    lookup. A card in `held` with nothing in `holds` (held by a build before this one, which matched substrings and
    also held on failed lookups) is decided again once: if the rules above don't apply, the hold is lifted and the
    card signed off, with a timeline note; if they do, it gets a note naming the files. A failed lookup never lifts
    a hold.
  - **A card you moved is yours.** A held card you drag to Ready to Merge stops being held. A card of Autopilot's
    that you drag *out* of Ready to Merge (the task PATCH withdraws the sign-off) is recorded in
    `autopilot_hands_off` and is never signed off by Autopilot again, whatever its PR looks like later — drag it
    back yourself. Entries go when the card is Done or archived.
- **Nothing to build** (thread-driven) — one of its cards that finishes with no commits beyond its base and no PR
  while its issue is still open (typically after a `Refs` PR) is moved to Done and the thread is asked what to do with
  the issue: `close` (Agetor closes it with the thread's comment, which must name the owning issues/PRs), `wait` (not
  started again until the named issues close) or `rework` (one new card with the thread's scope — once per issue).
- **Audit** (thread-driven) — when the milestone has no open issues, none of Autopilot's cards is unfinished and no
  live card on the board is linked to an issue, the thread is asked for a deep audit (up to 90 minutes) and told to
  file what it finds into the milestone. Open issues afterwards → the loop continues; none → `phase: "done"`.

## Roadmap mode: a tracker for the order (`feat/roadmap-autopilot`)

With a **tracker issue** set, the order comes from that issue instead of the thread (`roadmapPass` in
`src/bun/autopilot.ts`): its body has a section whose heading contains "completion order", holding one table —
`Step | Task and outcome | Milestone | Predecessor steps`, each task written `#123 Title`. Step ids are strings
(`78.1` sits between 78 and 79), predecessors name steps or their issues, and a step is yours to do when its title
starts `[Human]` or its milestone column is `H`. No Codex thread is involved, so there is no scope clarification, no
nothing-to-build decision and no audit: the table decides the order.

- **Rules** (`src/shared/roadmap.ts`, pure): a step is *complete* when its issue is closed as completed, *declined*
  when closed any other way (a no-go: unlocks nothing, never started), *ready* when open with every predecessor
  complete. Each pass reads the tracker and every step's issue — state, URL and GitHub milestone in one batched GraphQL
  query per 100 issues (`src/bun/roadmap-fetch.ts`) — and starts the ready agent steps in step order, up to
  `maxInFlight`, with the same slot accounting, usage-limit hold and Ready to Merge sign-off as above. The card's
  prompt names its step, the tracker and its predecessors' issues, and repeats the `Fixes` / `Refs` rule — a step only
  closes (and unlocks the next) when its merged PR says `Fixes #n`.
- **Scope: the milestone.** With a milestone chosen, only the steps *whose issue is in that GitHub milestone* are
  worked (`roadmapScope`) — the issue's real milestone, not the table's milestone column, so the scope is what GitHub
  shows. Where the two disagree the step is listed under the roadmap problems (`milestone-mismatch`); only an issue
  whose state couldn't be read falls back to comparing the table's code with the code the milestone title starts with
  (`M01 — …`, `X07 · …`, `H — …`). Steps outside the milestone still gate readiness; this run never starts them.
  A milestone none of the roadmap's issues is in is an error, not "done". No milestone ("All milestones") works the
  whole roadmap, as before. The scope can hold several milestones (see "The next milestone" below): the steps in
  scope are then the steps of all of them, and counts, backlog cards, needs-you and holds span them.
  `phase: "done"` when every step in scope is complete or declined *and* no milestone follows, or the owner said no
  to the one that does.
- **Backlog cards up front** (with a milestone). Every pass makes a card in the Backlog for each open step in scope
  that has no live card — the owner's steps too — without starting it, so a step added to the milestone later gets
  its card as well. Making a card (`createTaskFromIssue` with `start: false`) reads the issue thread from GitHub once,
  runs a few read-only `git rev-parse`, inserts the task row, records its base branch and writes the thread snapshot
  under `<dataDir>/issue-threads/<id>/`. No worktree, no branch, no `worktree_setup` command, no agent session and no
  write to GitHub happens until the card starts. The cards are remembered in `roadmapBacklog` (issue → card id),
  saved after each one.
  - A never-started backlog card holds **no slot** and doesn't make its issue busy (`neverStarted`; `slotCounts`'
    `noSlot` / `notBusy`). When its step is ready and a slot is free, Autopilot **starts that card** — its step
    section rewritten for the roadmap as it is then (`withRoadmapStepPrompt`) — instead of making another.
  - Each card says why it waits (`roadmapCardLine`, shown through `cardStatus`): "Step 7 · waits on steps 3 (#808),
    4 (#809)", "Step 7 · ready — waiting for a slot", "Step 5 · yours to do — open the issue". This is the status
    line only — `card_dependencies` is not used, because `dependencyTick` would start the card on "PR merged",
    past the slot limit and the issue-closed rule.
  - **Owner's cards** are never started by Autopilot and take no slot. Nothing else starts them either (no
    dependency entry, no suggestion rule, no merge-queue or auto-issue path touches an unstarted card). Starting one
    by hand is your call: Autopilot then leaves it alone (no sign-off). An agent step's card started by hand is
    followed like any card Autopilot started.
  - An issue that closes (completed or not planned) before its card ever started: the card is moved to Done with an
    activity note.
  - **Pausing** leaves the backlog cards alone. **Switching milestone** too: the previous milestone's unstarted cards
    stay in the Backlog, untouched and never started by the new run (they hold no slot); switching back picks them up
    again. In thread-driven mode leftovers hold no slot either, but their issues stay busy — archive or start them
    first if the thread should work those issues.
- **The next milestone** — no more switching milestones by hand. Each pass works out which milestone follows the
  scope (`nextRoadmapMilestone` in `src/shared/roadmap.ts`): stages are the table's milestone column in the order
  the table first names them; the owner's stage (`H`) is never one; a stage with no open agent step outside the
  scope is passed over; and the stage maps to a GitHub milestone through its steps' issues (the first open agent
  step whose issue is in one — the same milestone the scope rule reads). So an unfinished stage *before* the one
  being worked comes first: it is what the scope waits on. A stage none of whose open steps has a GitHub milestone
  can't be scoped and is passed over. An ordered-milestones section elsewhere in the tracker is not read: the
  table is the authority for order.
  - **When it is offered** (`roadmapContinuation`): once the agent steps in scope that haven't started and still
    can (not busy, not needing you, not held by a roadmap problem; the owner's steps never count) are fewer than
    `maxInFlight` — the scope can no longer fill its slots. The offer is `nextMilestone` in `state.roadmap`: stage,
    GitHub milestone, how many steps it has and how many can start now ("0 can start yet — waiting on steps 3
    (#13), 4 (#14)"), how many are left in the current scope, why it is offered (`reason`: `nearly-done` →
    `nothing-left` → `finished`; null while not due) and `dismissedAt`. It is recomputed every pass, so changing
    `maxInFlight` moves it. A milestone smaller than `maxInFlight` is on offer from its first pass.
  - **The answer** is the owner's: the board's popup (`NextMilestonePrompt.tsx` — **Start M02**, **Always
    continue**, **Not now**), the Autopilot dialog, or `agetor roadmap continue [--always | --not-now]`, all through
    `POST /autopilot/roadmap/continue {"action": "accept" | "always" | "dismiss"}` (`continueRoadmap`; applied
    between passes, 409 with the reason when there is nothing to answer). One native notification per offered
    milestone (`notifiedOffer`).
    - **Accepting adds, never replaces**: the milestone is appended to `milestones`. What is left of the current
      milestones keeps running, the new one's open steps get Backlog cards on the next pass (the usual 60 per
      pass) and start as slots free — slot accounting is unchanged. It is not a fresh run: holds, cards and
      ledgers stay. `accept` is also allowed before the offer is due (an explicit request).
    - **Not now** is remembered (`roadmapOffer`: milestone and stage) and holds for that stage: the offer comes
      back when it reaches a later one — nothing left to start, then the scope finished — not on every pass.
      Declined when finished, the run is `done`; `agetor roadmap continue` still starts it later.
    - While a finished scope's offer is unanswered the run is `idle`, not `done`.
  - **Blocked** (`reason: "blocked"`): the next milestone is also offered when slots are idle, no step in scope can
    start to fill them (what is left waits on unfinished steps), and the next milestone has at least one step that
    can start now. A next milestone with nothing startable isn't offered for this reason, so a chain stops there.
  - **Always continue** (`autoContinue`; the popup's button, the dialog's checkbox, `agetor roadmap start
    --auto-continue`, `agetor roadmap continue --always` / `--off`): the pass adds the next milestone by itself
    under the same condition, records it (`roadmapContinued`, shown as "continued into M02 at …" in the dialog and
    `agetor roadmap status`) and sends a native notification instead of asking. Never without the flag. It applies
    the same rule to the wider scope, so several small milestones can be pulled in one after another (at most 4
    per pass, 12 in scope).
  - **Finished milestones leave the scope** while another is still being worked (the pass saves the shorter
    list). When everything in scope is finished they stay named, so the status still says what is done.
  - **Choosing a milestone by hand** (the dialog, `agetor roadmap start --milestone`, `PUT /autopilot` with
    `milestone` or `milestones`) sets the scope to exactly that — a fresh run, and the offer, its "not now" and the
    continued list start over. While Autopilot is on, the dialog sends only the slot count and the flag, so a
    scope the pass changed meanwhile isn't written back.
  - The whole roadmap ("All milestones") has no next milestone and never offers one.
- **Blocker lines** (`BlockerLines.tsx`, `src/mainview/lib/blocker-lines.ts`): hovering a card — or reaching it
  with the keyboard — draws a line from every card it waits on (solid, the warning colour) and to every card it
  blocks (dashed, the info colour), whichever column those are in, outlines them, and shows a small panel that
  lists every direct predecessor and successor as "step · #issue title — state". The panel is where the links
  with no card show up, since they can't have a line: a finished step (complete), a step of another milestone
  ("open in another milestone (M02)"), the owner's step ("yours to do"), a declined one. Arrows point the way the
  work flows. Direct links only; **hold Shift** for the whole chain (fainter lines). A card scrolled out of view
  gets its line cut at the board's edge with a label ("↑ step 2 · #12"); a card that isn't rendered (filtered out,
  folded into Done's "Show more") is listed as not shown.
  - **Data**: `links` in `state.roadmap` (`RoadmapStepLinks`): every open step in scope with its direct
    predecessors (all of them, with where each stands) and open successors, each carrying its card id when it has
    a live card. Bounded: steps in scope only (300 at most), 16 links per step and direction with a count of the
    rest, titles cut to 100 characters.
  - **Manual `card_dependencies`** (the "waits on" / "blocks" chips) are drawn the same way, from the task's
    `blockedBy` / `blocking`.
  - An overlay beside the board's scroller that takes no pointer events and listens on the board for pointer and
    focus events reaching a `[data-task-id]` card; nothing is drawn while a mouse button is down, so dragging is
    untouched. Positions are read in an animation-frame loop that runs only while lines are shown. No animation.
  - Without a mouse: `agetor roadmap why <issue|step>` prints the same — what the step waits on, its finished
    predecessors and what it blocks (`#12` is an issue, `2.1` a step, a bare number a step when one has that id).
- **Yours**: ready owner steps are never given to an agent. With a milestone, the ones raised are those in it plus
  those outside it that a step in it waits on, directly or through other steps. Each gets one native notification
  (the app only; the headless daemon has none) and a line in the Needs you strip at the top of the board that opens
  the issue. Closing the issue as completed releases what waits on it — picked up within 5 minutes (tracker order
  also polls GitHub, on top of the triggers above).
- **Idle, and why**: `idleReason` names what is in the way — your steps, steps that need you, steps whose card
  waits in In Review for your sign-off, steps held by roadmap problems, and with a milestone the unfinished agent
  steps of *other* milestones that steps in scope wait on ("steps 2 (#12), 3 (#13) of milestone M01 must finish
  first — run that milestone"; also `blockedOutside`).
- **Cards waiting for your sign-off need you too**: a step whose card sits in In Review because its PR changes
  sensitive code (Sign-off, above), or because you took it back from Ready to Merge, is listed in
  `state.roadmap.needsUser` with `kind: "held"`, the reason, the files and the PR URL — in `agetor roadmap status`,
  in the Autopilot dialog and in the Needs you strip (**Open PR**, **Open card**). It is still in flight: its issue
  stays busy, it is counted under `inFlight` (and `counts.held`), not under `waiting`. When nothing else is running,
  the roadmap reads as waiting (`phase: "idle"`) and the idle reason says "step 7 (#807) waits in In Review for your
  sign-off".
- **No restart loops**: if a step's card finished (Done for more than 3 minutes, or a run with no commits and no PR)
  and the issue is still open, Autopilot doesn't start another and makes no backlog card for it; the step shows under
  Needs you ("PR #n merged but the issue is still open", `kind: "stuck"`) until you resolve it.
  - **Why it is open**: for a merged PR the guard reads the PR's description once (`prBody`, kept in
    `roadmapStuck`) and records what it says about the issue (`prIssueMention` in `src/shared/roadmap.ts`): the
    `Refs #n` line and what follows it up to the next heading ("PR #n left it open on purpose: “Refs #n — the
    nightly job is not wired”"), or that the description names neither `Fixes #n` nor `Refs #n`, or that it says
    `Fixes #n` and closing must have failed. It is shown in the Needs you entry, `agetor roadmap status`, the
    Autopilot dialog and the card's timeline. The excerpt is text from GitHub: one line, 400 characters at most,
    control characters, terminal escapes and HTML comments removed (`displayText`), rendered as text and never
    interpreted.
  - **Resolving it** — `POST /autopilot/roadmap/resolve {"issue": n, "action": "close" | "redo"}`
    (`resolveRoadmapStep`), from the Needs you strip (**Resolve…** opens a panel that shows the PR's words first;
    the two buttons are in that panel) or `agetor roadmap resolve <issue> --close | --redo`:
    - `close` closes the issue as completed with the comment "Closed by the owner from Agetor: step N of roadmap
      #T accepted as complete; PR #x merged." and clears the ledger entry; the next pass starts its successors.
    - `redo` clears the entry and records the step in `roadmapRedo`: the finished card no longer sets off the
      guard, and the next card for the step (a new one, or its backlog card) gets an "Earlier attempt" part in its
      step section naming the PR and quoting what it left. A card that found nothing to build is moved to Done
      first. If the new card also ends with the issue open, the step needs you again.
    - Both check again when applied — the entry must still be there and the issue still open on GitHub — and
      answer 409 with the reason otherwise; a double click closes nothing twice. They run between passes and ask
      for a pass.
    - **Closing is only ever your request.** No pass, no thread answer and no other loop calls it
      (`RoadmapDeps` has no way to write to GitHub). The route and the CLI are open to anything that holds the API
      token, as every other route is — an agent on the board that ran `agetor roadmap resolve … --close` would be
      closing an issue in your name, so don't put that command in a pipeline's instructions.
- **Problems** in the table (duplicate step or issue, a predecessor that names no step, a cycle, a malformed row) are
  listed in the dialog and `agetor roadmap status`; the steps they touch are held. A tracker with no usable table
  starts nothing.
- **Only this project's cards count**: in tracker order, slots and busy issues are counted among cards whose project
  is Autopilot's — issue #12 of another repository is another issue.
- **Default tracker**: the dialog's Tracker issue field shows the configured tracker, else the
  `autopilot_default_tracker` preference — the last tracker saved (`PUT /autopilot` with a `roadmap`), or set alone
  with `{"defaultTracker": n}` (`null` forgets it). Clearing the field before Start turns tracker order off (the
  thread decides); the default stays to be offered next time.
- **Use**: Autopilot dialog → Milestone (or "All milestones") and Tracker issue, or
  `agetor roadmap start --project <dir> [--issue <n>] [--milestone <number|title-prefix|all>] [--max <n>]
  [--pipeline <id|name>]` (`--issue` defaults to the default tracker; `--milestone M01` matches the milestone whose
  title starts with it; none = the whole roadmap), `agetor roadmap status [--json]` (scope, counts incl. backlog
  cards, needs-you with each PR's stated reason and how to resolve it, what waits on other milestones),
  `agetor roadmap pause`, `agetor roadmap resolve <issue> --close | --redo`, `agetor roadmap why <issue|step>`,
  `agetor roadmap continue [--always | --off | --not-now]` and `start --auto-continue`
  (`src/cli/commands/roadmap.ts`; all go through `GET/PUT /autopilot` and `POST /autopilot/roadmap/resolve` /
  `continue`). `status` names the next milestone, why it is or isn't on offer yet, and the command that starts it.
- **State**: status, the restart guard, the steps being done again, the announced owner steps and the backlog
  ledger are `roadmap`, `roadmapStuck`, `roadmapRedo`, `notifiedHuman` and `roadmapBacklog` in `autopilot_state`;
  the "not now", the announced offers and the milestones continued into are `roadmapOffer`, `notifiedOffer` and
  `roadmapContinued`. A different tracker drops the first four; a scope chosen by hand drops the status and the
  last three; a different project also empties the ledger (the cards stay).
- **Upgrading**: before this, a tracker made Autopilot ignore `milestone`. A config saved then with both (a
  milestone left from an earlier thread-driven run) has that milestone dropped once, on first start
  (`normalizeLegacyConfig`, marked by `autopilot_config_version`), so a run on the whole roadmap isn't silently
  narrowed; its tracker becomes the default tracker.
- **Upgrading to scope lists**: no migration. A config with one `milestone` is a scope of that one milestone, and
  the run in progress carries on untouched (no fresh run, no card moved). The first pass after installing adds
  `links` and `nextMilestone` to the status; if the milestone already has fewer steps left to start than
  `maxInFlight`, the popup and one notification appear then. Nothing is added to the scope without an answer.
  Going back to an older build is safe too: it reads `milestone` (the first in scope) and drops the list when it
  next saves the config, so later milestones' unstarted cards just wait in the Backlog.
- **Rendered checks**: `e2e/roadmap-board.spec.ts` draws both pieces in Chromium against a throwaway core, with
  the status built by the real pure functions from a synthetic tracker (`bunx --bun playwright test
  e2e/roadmap-board.spec.ts`; set `ROADMAP_SHOTS=<dir>` to keep the screenshots). The app's real web view is
  WebKit, which this doesn't exercise.
- **Upgrading to segment-based sign-off**: no migration. On the first pass after installing (30 s after the core
  starts), every card in `held` is decided again under the rules above — one that was held only because a path
  *contained* a sensitive word, or because its file list couldn't be read, is signed off and moves to Ready to
  Merge; and each `roadmapStuck` entry gets its PR's stated reason filled in (one `gh pr view` per entry) with a
  timeline note. Nothing is closed and no card is started by the upgrade itself.

## Velocity: how fast the roadmap run is going (`feat/roadmap-autopilot`)

Tracker order keeps a record of the run and reports on it: the one-line summary beside the rocket ("20 done · 6.0/day ·
M02 and M03 ≈ 8–20 hours") opens the Velocity view (`VelocityView.tsx`, a full view like the run view; also the
**Velocity** button in the Autopilot dialog), `agetor roadmap velocity [--json] [--scope current|roadmap] [--owner-delay <hours>]` prints the same, and
both read `GET /autopilot/roadmap/velocity[?scope=current|roadmap][&ownerDelayHours=n]`. The metrics are pure
(`src/shared/velocity.ts`); the core keeps the ledger (`src/bun/roadmap-velocity.ts`). No table, no migration.

- **What is measured**
  - **Throughput** — steps whose issue closed as completed since the run began, per day: last 24 hours, 3 days, 7 days
    and the whole run (a window longer than the run is clipped to the run's age), per hour over the last 24, agent steps
    and the owner's separately, and complete/total per stage (the table's milestone column). The run *began* at the
    earliest "…of roadmap #T" entry in a card's timeline (else the first pass with this build); steps closed before that
    are the burn-up's starting height, not throughput.
  - **Cycle time** — card start (its pipeline run's start) → issue closed, for agent steps a card worked: median, p75,
    p90 (linear interpolation between order statistics), min, max; overall and per stage.
  - **Lead time** — the step became ready → issue closed. Ready is when its last predecessor's issue closed, never
    earlier than the run began (a step with no predecessors was ready when the run began). It includes waiting for a
    slot and waiting for the step's milestone to be in scope. The owner's steps have a lead time and no cycle time.
  - **Where the time goes** — every instant between card start and issue closed gets one label, so the parts sum to the
    cycle time. *Active*: inside a pipeline step — Understand, Build, Review, Finish (all visits summed), follow-ups
    (Fix CI, resolving conflicts, opening the PR), any other step. *Waiting*: **CI and merge queue** (from the run's
    last step finishing to the issue closing, less the holds), **held for you** (a sensitive-code hold until the
    sign-off or the card reaching the merge queue; a merged PR whose issue stayed open, from the note that says so; a
    step that blocked or failed with no automatic retry), **usage-limit waits**, **waiting for a step slot** (between
    one step handing off and the next starting), **automatic retries**. **Flow efficiency** = active ÷ (active + waiting).
  - **Rework** — review visits per step (1 = approved first time) with their distribution, Finish handing back to
    Build, automatic Fix CI runs.
  - **Slots** — from the samples: slots in use on average and by hour (48 hours), the share of time *blocked* (slots
    idle, no agent step in scope able to start, not holding for a usage limit), and the share spent holding new starts
    for a usage limit.
  - **Bottlenecks now** — the open steps whose predecessors are all complete (in flight, ready, yours, needing you),
    ranked by how many open steps wait behind them, followed all the way; how long each card has been going; and the
    steps waiting on you, with for how long.
- **The ledger** — `<dataDir>/roadmap-velocity/<tracker>-<project hash>.jsonl`, append-only, written by each roadmap
  pass (`RoadmapDeps.velocity` → `recordVelocityPass`): `run` (once: when the run began), `step` (the facts of a step
  the first time a pass sees it complete — start, close, ready, phases, rounds — taken from its card's run history and
  `<dataDir>/activity/<id>.jsonl` at that moment, so they outlive the card being archived or deleted), `s` (a sample:
  `max`, slots `used`, `blocked`, `quota`, ready and held counts — on a change, and every 4 minutes as a heartbeat),
  `c` (a card's state when it changes: building, merging, held, blocked, quota, retry), `h` (an hour of older samples).
  Beside it `<same>.json`, rewritten each pass: every step with its predecessors, state and closing time, and what is
  in flight. The API reads these two files and nothing else; it never reaches GitHub.
  - **Bounded**: past 1 MB the ledger is rewritten — each step's latest facts, the newest 2,000 samples (a week),
    older samples folded into hours (180 days kept), card states only of steps still open.
  - **Gaps**: two samples more than 20 minutes apart mean nothing was watching (the app was closed, Autopilot
    paused). That stretch is *unknown* — not idle, not blocked — and is reported as such.
  - **Closing time** is GitHub's `closedAt` (added to the batched state query in `roadmap-fetch.ts`); failing that
    the card's "Closed issue" entry, failing that the pass that first saw it closed. The report says how many were not
    GitHub's.
  - **Backfill**: the first pass with this build writes the facts of every step already complete, from the cards
    that still exist (archived ones included). What can't be reconstructed stays unknown: a step with no card (closed
    by hand, done outside Agetor, or its card deleted) counts for throughput and has no cycle time; slot samples start
    with that pass; and time a step spent blocked on a question or paused on a usage limit *inside* a running step
    is counted as that step's time for steps finished before then — the run's history keeps a retried step's record
    open, so only the passes' `c` events can tell, and they start now (to within a pass, 5 minutes at most).
  - A card from before the run isn't counted as the run's work on a step unless its timeline names the roadmap or a
    pass saw it in flight. A different tracker or project is a different ledger.
- **Forecast** — an estimate, shown as a range and never as a date, with the sample it rests on. Three targets: the
  scope, the main-release gate (the first step whose title reads like "Publish … main release"; set
  `agetor config autopilot_velocity_gate <issue>` when that guesses wrong) and the whole roadmap. Each counts its open
  steps *and every unfinished step they wait on*.
  - **Minimum sample**: 5 agent steps completed in the run with a measured cycle time, and 6 hours of history. Below
    that: "3 steps completed with a measured cycle time — not enough for a forecast (it needs 5)".
  - **Naive**: remaining agent steps ÷ recent throughput — the 3-day and 7-day rates, each widened by its counting
    noise (±√n); with 7 full days of history, daily completions of the last 14 days resampled instead (10th–90th
    percentile). It ignores dependencies.
  - **Simulated** (`simulateOnce`): 200 seeded runs of the dependency graph forward from now. Steps start in table
    order when every predecessor is complete and a slot is free; an agent step takes a cycle time drawn from the
    observed ones and holds its slot for that step's observed time out of CI, the merge queue and holds; a step
    already in flight needs what is left of a longer observed cycle. It is run twice — with all `maxInFlight` slots,
    and with as many as have actually been busy on average (from the samples once there are 6 hours of them, before
    that from the time cards spent building; rounded down) — and the range runs from the 10th percentile of the first
    to the 90th of the second. The seed comes from the roadmap's state, so the same state gives the same answer.
  - **Your steps** have no measured duration. The forecast says how many lie on the path and shows the range twice:
    with them taking no time, and with each taking an assumed time once it is ready — yours to set (the view's input,
    `--owner-delay`), by default the median lead time of the owner's steps finished so far once there are 3.
  - **Limits**: it assumes Autopilot stays on, that every ready step may start whatever milestone it is in (the real
    run only starts steps of milestones in scope), and that later steps take as long as the ones finished so far. It
    doesn't model usage limits, the merge queue backing up, or steps declined later; steps behind a declined step are
    left out and counted.
- **`?scope`**: the speed figures (throughput, cycle time, the breakdown, rework, slots) are always the whole run's —
  finished milestones leave the scope, and their history shouldn't go with them. `scope` chooses what the progress
  chart and the bottleneck list cover: the milestones in scope (`current`, the default) or the whole roadmap.
- **The view** (`feat/velocity-and-run-view`): `VelocityRoute.tsx` reads the report with `scope=roadmap` and
  `VelocityView.tsx` lays it out; `src/mainview/lib/velocity-view.ts` holds what it derives, and none of it
  calculates or forecasts. A switch chooses the forecast scope, *Release gate* or *Whole roadmap*: the range ("a
  range, not a promised date"), agent and human steps remaining, the assumed time per human step. Completion is shown
  for the whole roadmap only, from the report's totals; for the gate the view says it is not supplied, and no total is
  derived from the gate's step number. Rates (24 hours, 3 days, since the start), cycle time, review rounds, the
  working share and capacity are the whole run's and say "run-wide". "Where time goes" folds the phases into four
  buckets of accumulated task time (longer than calendar time, since tasks run side by side). "Move these next" joins
  each bottleneck to its board card and shows that card's `cardState` and button; a step with no card keeps the
  report's state and an unavailable reason; the counts are "N steps behind it" and overlap. Capacity is slots
  *occupied* (a slot may be waiting, not executing), averaged over all observed time. The charts (`VelocityCharts.tsx`)
  are under "Phase timings, distributions and forecast method", in the board's state colours; each has its numbers as
  a table ("Show as a table") and a text alternative.
- **Upgrading**: no migration. The first pass after installing (30 s after the core starts) reads every card made from
  a step's issue once, writes the backfill and the first sample, and the summary appears beside the rocket. Going back
  to an older build leaves the two files unread.
- **Rendered checks**: `e2e/roadmap-board.spec.ts` ("velocity") seeds a synthetic three-day run and draws the view in
  light and dark, with too little data, and with none.

**Trying the two views without a core.** `bun run hmr`, then `http://localhost:5173/fixtures/run.html?case=<name>`
(executing, ci, dependency, auto-retry, recheck, step-cap, needs-input, failed, cancelled, loop, fanout, done,
ci-failed, not-started, long; `?theme=dark`, `?tab=checks`, `?presentation=graph`, `?card=1` to draw the task's board
card beside it) and `/fixtures/velocity.html?case=<name>` (roadmap, no-forecast, no-gate, no-samples, empty;
`?scope=gate`). Both go through the real components from made-up data (the velocity report through the real
`computeVelocity`), import no API client, and are not entries of `vite build`. The run fixture has no canvas, which
needs the core. `e2e/views-fixtures.spec.ts` runs against them with no backend; set `VIEWS_SHOTS_DIR` to keep its
screenshots. `e2e/board-context.spec.ts` checks, against the real app, that the board comes back as it was.

## Token savers (`feat/token-savers`)

Five changes the owner approved on 2026-10-13 to cut what a card costs in tokens, one commit each so they can be
merged apart. The measure for all of them is the first one.

### Tokens per step visit: `scripts/step-tokens.ts`

```bash
bun scripts/step-tokens.ts --project pillar --pipeline Change --last 10            # a table
bun scripts/step-tokens.ts --project pillar --pipeline Change --last 10 --json     # the same, for a diff
```

For the last N finished (`done`) pipeline cards of a project: one row per step visit — step, visit number, harness,
model, input, output, cache-read and cache-write tokens, model calls and turns — then the median per visit and the
total per step, for all visits and split into the first visit and the repeats. `weighted` is the one number of the
cost section above (output×5 + cache write×1.25 + input + cache read×0.1). `--pipeline` is a name prefix.

- **Read-only, and meant for the live board.** The database is opened read-only with `bun:sqlite` (never through
  `src/bun/db.ts`, which migrates); session files are only read. It is a script, not a CLI command: a command needs a
  route in the core, so an installed build, before the first number.
- **How a visit maps to tokens.** A visit is a step task (`tasks.pipeline_parent_id`); its sessions are the ids on its
  runs (`runs.claude_session_id`, `runs.codex_session_id`). Claude: `<config dir>/projects/<worktree path with every
  non-alphanumeric as ->/<session>.jsonl`, each response counted once by `message.id` (it is written once per content
  block), plus the session's `subagents/*.jsonl` (Scouts; their part is `subagents` in the JSON). Codex: the rollout
  named after the session id under `<codex home>/sessions`, the last cumulative `total_token_usage`. `input` is the
  uncached part for both. The parsing is `src/shared/step-usage.ts`.
- **Visit numbers count every run of the card**: a restart's earlier visits are included and marked `*`
  (`inCurrentRun: false`), as are follow-up steps (grouped as "Follow-up").
- **What it cannot attribute**, listed under the table with the reason and never estimated: a step task with no
  session id (never started, or a Finish visit Agetor ran itself — which cost no tokens), a session id whose file is
  gone (Claude Code deletes old transcripts) and harnesses other than Claude Code and Codex. A visit with some of its
  session files missing is counted and flagged as a lower bound. A DeepSeek-backed step is counted from its Claude
  transcript under the model name Claude Code recorded.

Baseline, 2026-10-13, the last 10 finished Change cards of Pillar (349 visits; median per visit, total in brackets):

| Step | Visits | Input | Output | Cache read | Cache write | Calls | Weighted |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Understand | 14 | 124 (1.8k) | 49.6k (0.70M) | 2.72M (40.6M) | 264k (3.56M) | 59 (849) | 0.86M (12.0M) |
| Build, first | 10 | 110 (1.6k) | 68.9k (0.89M) | 5.56M (106.7M) | 158k (2.47M) | 55 (792) | 1.11M (18.2M) |
| Build, repeat | 112 | 28 (0.65M) | 4.8k (1.55M) | 0.58M (162.9M) | 33k (6.05M) | 13 (2,463) | 0.13M (32.2M) |
| Review, first | 10 | 124k (1.50M) | 20.8k (0.21M) | 2.08M (23.9M) | 0 | 24 (263) | 0.50M (4.9M) |
| Review, repeat | 112 | 66k (8.19M) | 5.5k (0.80M) | 0.52M (85.1M) | 0 | 10 (1,389) | 0.14M (20.7M) |
| Finish | 79 | 35k (3.22M) | 2.9k (0.27M) | 0.33M (29.0M) | 0 | 11 (888) | 0.08M (7.4M) |
| Follow-up | 12 | 47k (0.71M) | 3.1k (0.05M) | 0.53M (9.5M) | 0 | 13 (202) | 0.12M (1.9M) |

All ten cards: 97.4M weighted tokens, 6,846 calls, 669 turns. One visit of 349 was a lower bound (one of its three
session files was gone). Build ran on Claude (Sonnet, with a DeepSeek backup), Review and Finish on Codex.

### CI failures, trimmed (`src/shared/ci-failure.ts`, `scripts/ci-wait/ci-wait`)

Before: a CI failure reached Build as the **last 60 lines** of `gh run view <run> --log-failed` (6,000 characters at
most), for up to two runs — from `ci-wait` when an agent ran Finish, from `logTail` (`src/bun/merge-rework.ts`) when
Agetor ran it or the merge queue started a fix round. A failed log ends with the runner cleaning up, so the tail was
mostly `git config --unset …`: in the saved wait for PR #1539, 40 of the 60 lines were cleanup and one of ten test
failures was visible.

Now, per failed job: a heading with workflow, job, step and exit code, then the lines that match a failure marker
(`FAIL`, `Error:`, `error TS<n>`, `panic:`, `--- FAIL:`, `AssertionError`, `✗`, `×`, `##[error]`; case-sensitive) with
20 lines either side, colour codes and timestamps removed, lines over 400 characters cut, at most 150 log lines a job;
above them the run's URL and the path of the whole failed log, which is saved.

- **Fitting 150 lines.** Context is narrowed (20, 10, 5, 2, 0 lines) until the excerpt fits; with more failure lines
  than the cap, the first third and the last two thirds of them are kept. Every cut says `… N lines omitted …`.
  Context never crosses `Process completed with exit code`: what follows it is cleanup. A job in which nothing
  matches shows its last 60 lines.
- **Agetor-run Finish and merge-queue fix rounds** (`src/bun/ci-failure-log.ts`, used by `publish-step.ts` and
  `merge-rework.ts`): the report is the handoff's `reason`. A handoff field holds 8,000 characters
  (`PIPELINE_LIMITS.handoffField`), shared by the (at most two) runs, so the cap per job is lowered until it fits and
  a shortened report ends with the path of the 150-line one. Files, in `<data dir>/pipeline-runs/<card>/`:
  `ci-failed-<run>.log` (the whole failed log) and `ci-failure-<run>.md` (the full excerpt, written only when the
  handoff's copy was shortened). One more `gh run view --json workflowName,url` per failed run. The runner-fault
  decision (`infraReason`) still reads the tail, unchanged.
- **Agent-run Finish**: `ci-wait` is in the repository now and `install:local` installs it. Exit codes (0, 1, 2, 3,
  4) and every line it printed are unchanged except the log part of a failure: where it printed
  `--- last 60 lines of the failed log, run N … ---` and the tail, it prints the report above, and ends with one
  `ci-wait: failed jobs: …` line so the 60-line tail Agetor quotes when it wakes the step names every failed job. The
  whole failed log goes to `$(git rev-parse --absolute-git-dir)/agetor/ci-failed-<run>.log`. It reads subprocess
  output as UTF-8 with replacement, so an odd byte in a log no longer ends the wait with a traceback.
- **One algorithm, two languages.** `ci-wait` is Python and carries the algorithm itself;
  `src/shared/ci-failure.test.ts` runs both implementations on the same logs and requires the same bytes, and
  `src/bun/ci-wait.test.ts` holds `ci-wait` to its contract with stand-in `gh` and `git` (set `CI_WAIT_SCRIPT` to run
  the same cases against another copy). Change the two together.

Not done: the excerpt is quoted inside the handoff's JSON, so its newlines arrive escaped, as the tail's did; the
workflow name is not read for a run whose log could not be read; the Finish step's own instructions still say "log
tail" (they are Pillar's, in `docs/engineering/agetor/`).

### Build starts with its reading done (`pipeline_gates` → `preload`)

**Off unless switched on.** Build's instructions begin "read the file map, then the line ranges it lists"; each of
those reads is a model call that re-sends the session. For a card the switch covers, Agetor does them when it
launches Build and puts the result in the prompt. `src/shared/preload.ts` is the pure half (the map parser, the
budgets, the text), `src/bun/preload.ts` reads the worktree and git, `launchStep` adds the sections.

| Visit | Decided by | What the prompt gets |
| --- | --- | --- |
| Build, first | the run's history holds no visit of Build, Review or Finish (`preloadKind`) — whatever came of such a visit | `## File map` (the map itself) and `## Code at the file map's ranges`: the map's Touch points, then Read for context, each headed `path:L<start>-L<end>` and read from the worktree as it is at launch |
| Build, after anything else ran (Review's findings, Finish's CI failure, a merge-queue fix round, the fresh session after exhausted check turns) | the same test, the other way | `## File map` with a warning that its numbers may have moved, and `## What this branch changes so far`: `git diff -U10 <base>...HEAD`. No slice by line number. What already arrives (the handoff, the report, the CI excerpt) is unchanged |

- **Line numbers are only used when they are true.** Slices are taken only when the commit the map's header names
  is the worktree's HEAD (`mapHeadMatches`: the full sha or a prefix of at least 7). Another commit, or none named:
  nothing is sliced, the prompt says which commit the map is for, and only the map is inlined. No map: nothing is
  added. Each range is checked against the file as read: a range past its end is named as "the map is out of date
  for it", never cut to fit.
- **Never inlined, always named**: a path listed under Ruled out (wherever else the map lists it), a file that is
  not there, a link out of the worktree, a binary, and by name (`excludedPath`, the same test for a slice and a file
  of a diff) lockfiles, `*.snap`, JSON under `fixtures`/`testdata`/`golden`/`__snapshots__`, generated or vendored
  code (`*.generated.*`, `*.pb.go`, `*.min.js`, `dist/`, `node_modules/` …). An excluded file of a diff is not even
  asked of git: `--numstat` first, then the diff for the rest.
- **Budgets** (`PRELOAD_LIMITS`, tokens at 4 characters): slices 12,000 in all and 400 lines each; a diff 20,000 in
  all and 6,000 a file; the map 4,000. Over a budget the **largest items go first**, each with a
  `- trimmed: read <path> yourself (<why>)` line; context ranges only get what touch points leave. Nothing is
  dropped without a line. They are sized to what Build reads at its start anyway (the cost section above: a 50–57k
  starting context, ~55 calls a first Build): what is saved is the calls, not the carrying.
- **Today's loose maps** are read as they are: sections by their first words ("Touch points (done)", "Additional
  touch points confirmed by Review"), the header's commit as `HEAD: <sha>`, `commit: <sha>` or `Header: commit
  <sha>`, quoted or not; entries as `path:L12-L40`, `path:12-40`, `path:375–380,463–471`, `` `path` :277–279 ``,
  `(new, 1–496)`, with or without quotes. A single line (`:88`, `L12`) gets a window (5 before, 40 after). An entry
  with no range is named, not sliced. On the nine maps on the board on 2026-10-13 this finds every header commit
  and 0–8 sliceable ranges a map; the exact `path:L<start>-L<end>` format Pillar's prompts are moving to is what
  makes it worth switching on.
- **Other prompt-size rules are untouched and separate**: the handoff's 16 KB and the report's 24 KB stay as they
  are, and the budgets above are on top. A harness with a short prompt (gemini's argv cap) gets no inlined content,
  only the map's path, in the same recomposition that already drops the inlined handoff. A Claude step prompt was
  already over the 4 KB argv limit and pasted; it is pasted the same way, larger, with control characters removed
  from everything inlined.

**The switch** is `pipeline_gates`, under its own key, with the entries the gates have:

```json
{"preload": {"pipelines": ["<pipeline id>"], "cards": ["<task id>", "<task id>"]}}
```

`pipelines` (ids or exact names) turns it on; `cards` is the trial list, and leaving it out covers every card of
those pipelines; an entry that matches nothing is reported like a gate's (`unmatchedGateRefs`). Unlike a gate it is
**not adopted by a run**: nothing is stored on the card, it is read at each launch, and it takes effect at the next
launch of Build with no refresh. With it off — or the card not named — prompts are byte for byte what they were, and
no file or git command is read for them. It can be combined with `publish` and `steps` in the same preference.

Not done: a Retry re-sends the visit's stored prompt, so what was inlined is as old as the launch (the sections say
so and tell the step the worktree is newer); the base is the one last fetched, nothing is fetched; a pasted prompt
of this size (up to ~100 KB more) has been exercised with the scripted agent only, not in a real Claude session.

### One review bundle on entering Review (the same `preload` switch)

When Review is launched for a covered card, Agetor writes `<git dir>/agetor/review-bundle.md` — beside the file
map, outside the working tree — and Review starts from it instead of assembling the same things call by call:

1. **Acceptance criteria**: the card's goal as the run has it (`task.prompt`, the issue snapshot every step is
   given as "Overall goal") and the issue's URL. GitHub is not called: the runner does not read the issue at this
   point, and the bundle does not make it.
2. **The file map**, whole (or a line saying there is none).
3. **`git diff -U5 <base>...HEAD`**: the files changed with their counts, then the diff, with the same files named
   and left out as on a Build visit.
4. **What each hunk is inside**: per file, `L<start>-L<end> in <line>` — the text git itself puts after `@@` in a
   hunk header (its own function-context rules for the file type), with the hunk's lines in the new file. Nothing
   else is parsed: where git finds no enclosing line, the entry is the range alone.

- **Once per visit**: rewritten at every launch of Review (written beside and renamed, so never half there), with
  the step number, the time and the HEAD it was written for. It is added to the step task's references.
- **In the prompt**: `## File map` after the goal and `## Review bundle: the change` after the context from the
  previous step — the bundle's path, the hunk index and the diff within the diff budget (20,000 tokens, 6,000 a
  file, largest trimmed first and named). The goal is not repeated; the section points at "Overall goal". The file
  keeps the diff whole (a file up to 200,000 characters, 2,000,000 in all).
- **A card that never visited Build** — Understand's trivial change, routed to Review once Pillar's prompt sync
  moves that edge — gets the same bundle: it needs no Build handoff, no Build record and no map, only the worktree
  and the base. With the edge still going to Finish, no Review runs on that route and nothing is written.
- Nothing committed, or no base ref to diff against: the bundle and the prompt say so. A bundle that cannot be
  written does not stop the launch: the prompt carries what it would have held.

Not done: Finish and Understand are not pre-loaded; a check-feedback turn (the same Review session) gets no new
bundle — the next launch does.
