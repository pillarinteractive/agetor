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
their routes match) and installs the keepalive check to `~/.agetor/bin/agetor-keepalive`.

`install:local` quits Agetor; the user has to confirm the Quit dialog. Agents keep running in tmux and the new app
reattaches to them. Roll back by quitting, moving the previous app from `~/.agetor/backups/` back into `/Applications`,
and restoring the database backup only if the new build ran a migration. A build that adds a migration makes the database
unreadable by older builds, so call that out before installing.

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

## Knowing what each card is doing (`feat/board-clarity`)

- **Status line** under every card title (`src/mainview/lib/card-status.ts`): the step and how long it's been running,
  what it waits on (lab, base-branch CI), the PR's state, or the result headline; ⓘ when it needs you.
- **Needs you** (`src/mainview/components/kanban/NeedsYouBar.tsx`): a card that waits on the user says so on its own
  status line. The strip at the top of the board is mounted with `roadmapOnly`, so it lists only Autopilot's roadmap
  steps that wait on the user (they have no card) and is hidden when there are none. Its per-card entries and its
  suggestion rows are still in the component but are not shown.
- **Activity** timeline in the run view (`src/bun/activity.ts`): steps derived from the run's history, plus PR, CI,
  review, merge, lease and auto-fix events appended to `<dataDir>/activity/<taskId>.jsonl` as they happen.
- The run view header leads with the card's title; a step's panel strip names the card it belongs to.

## Orchestrator suggestions, layer 1 (`feat/suggestions`)

`src/bun/suggestions.ts` recognises situations that used to need a person and proposes the fix. The board no longer
shows them (see Needs you above); they are read with `agetor suggestions` / `GET /suggestions` and `agetor board`, and
applied with `agetor suggestions apply <taskId> <suggestionId>` / `POST /suggestions/apply`. Nothing runs without that,
and each suggestion is recomputed at apply time.
Rules: step blocked on a lease that's free → Retry; PR behind its base whose failing checks pass on the base → Update
branch (only when `pr_autoupdate` is off); finished run with commits and no PR → Open PR preset; blocked step with
open questions → show the first one (not appliable: open the card). A card waiting on another card gets none.
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
  `activity <id>`, `followups <id>`, `followup <id> <actionId> [--request <text>]`, `blocks [--days N]`,
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
  or a user Stop never is. The schedule is stored on the run (`autoRetry`) and re-armed when the core restarts.
- **Pipelines own their PRs**: auto Fix CI is on by default for pipeline cards (`pr_autofix` true/false overrides;
  max 2 per PR, never twice on one head). A PR behind its base whose failing checks pass on the base gets its branch
  updated automatically (`pr_autoupdate=false` to stop) — so the Update-branch suggestion only exists when that's off.
- **Block log** (`src/bun/block-log.ts`): every new pipeline block is appended to `blocks.jsonl`; `agetor blocks
  [--days N]` / `GET /blocks` group them by pipeline › step › kind, most frequent first.
- **Steps that can finish** (`PipelineStep.canFinish`, editor: "Can also finish the pipeline"): a choose step with
  outgoing edges that may also end the run by handing off `next: null`. Pillar's Finish uses it with a
  "verification failed" edge back to Fix (Bugfix) / Build (Feature), so a failing final check loops back instead of
  blocking (bounded by maxSteps).

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
  (`merge_method` pref). Agetor opens the PR itself (`openPrDirectly`: push, then the API) and starts the Open PR
  follow-up only when that fails; the branch is updated from its base only when GitHub requires it or CI is failing.
  Each automatic step once per PR head, ≤4 fix-ups per card. A pipeline's fix-up run returns the card to Ready to
  Merge (runner honours the intent), not In Review. Dragging back to In Review/Backlog withdraws the sign-off.
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
disband, members merge individually. A lone ready PR waits the window for company, then merges alone. One train at a
time. Config `merge_train` = {"enabled":true,"windowMin":10,"max":6}. Cards show "In merge train #T" / "Merged in
merge train #T" (`Task.mergeTrain`). Ready to Merge's **Merge together** button (`POST /merge-train/depart`) sends a
train now with every PR that can go, without waiting for the window or for each PR's own checks; it replaces a train
whose CI hasn't started and is refused once one is running CI.

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

## Milestone Autopilot (`feat/milestone-autopilot`, `feat/autopilot-events`, `feat/autopilot-run-last`)

`src/bun/autopilot.ts` (the rocket button, `AutopilotDialog.tsx`) works a GitHub milestone to done: it keeps up to
`maxInFlight` cards building, signs finished ones off for merging and audits the milestone when it empties. It has two
modes: **milestone** (this section) and **roadmap** (next section). Both share the config, the state, slot accounting,
card creation, sign-off and triggers described here.

- **Config** — `autopilot` preference: `enabled`, `project` (path), `milestone` `{number, title}`, `threadId` (the
  Codex thread), `maxInFlight` (default 5, 1–10), `pipelineId` (else `default_pipeline`), `roadmap` `{issue}` (set →
  roadmap mode; `milestone` and `threadId` are then unused).
- **State** — `autopilot_state` preference: `phase` (`idle` / `running` / `auditing` / `done`), `cards` (the cards
  Autopilot started), `held`, `lastAnswer`, `lastError`, the back-offs (`quietUntil`, `limitedUntil`), `noWork`,
  `waits`, `reworked`, and the roadmap fields. No table, no migration.
- **API** — `GET /autopilot` → `{config, state}`. `PUT /autopilot` merges the given fields into the config and runs a
  pass at once when enabled. Enabling, changing the milestone or the roadmap, or `"restart": true` begins a fresh run
  (`phase` back to `idle`; `held`, `lastError` and the 20-minute quiet back-off cleared). `phase: "done"` stays until
  then.
- **Which issues** (milestone mode) — Autopilot doesn't choose. It resumes the user's milestone-manager Codex thread
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
  any live card is never started twice. Independently, the `step_slots` preference limits how many pipeline steps run
  at once on the machine, so cards Autopilot starts may sit queued for a step slot.
- **Triggers** — passes are event-driven (`startAutopilot`, `freesSlot`): a card reaching Done or moving from a
  building column (Backlog, Ready, Running, Blocked) to one that holds no slot, a pipeline run blocking, a card
  deleted or archived, and `PUT /autopilot`. Events are coalesced (3 s) and one pass runs at a time. A pass also runs
  30 s after the core starts and every 15 minutes as a fallback.
- **Sign-off** — each pass moves Autopilot's own cards that are in In Review with a finished run and an open PR to
  Ready to Merge (the merge queue lands them). A PR whose files match the risky pattern (`RISKY`: billing, Stripe,
  checkout, subscription, auth, Clerk, session, permission, migrations, Drizzle, the DB schema) — or whose file list
  can't be read — is left in In Review for the user and remembered in `held`.
- **Nothing to build** — one of its cards that finishes with no commits beyond its base and no PR while its issue is
  still open (typically after a `Refs` PR) is moved to Done and the thread is asked what to do with the issue: `close` (Agetor
  closes it with the thread's comment, which must name the owning issues/PRs), `wait` (not started again until the
  named issues close) or `rework` (one new card with the thread's scope — once per issue).
- **Audit** — when the milestone has no open issues, none of Autopilot's cards is unfinished and no live card on the
  board is linked to an issue, the thread is asked for a deep audit (up to 90 minutes) and told to file what it finds
  into the milestone. Open issues afterwards → the loop continues; none → `phase: "done"`.

## Roadmap mode (`feat/roadmap-autopilot`)

Autopilot can work a **roadmap** instead of a milestone (`roadmapPass` in `src/bun/autopilot.ts`): a tracker issue
whose body has a `## Numbered completion order` section with one table — `Step | Task and outcome | Milestone |
Predecessor steps`, each task written `#123 Title`. Step ids are strings (`78.1` sits between 78 and 79), predecessors
name steps, and a title starting `[Human]` is yours to do. No Codex thread is involved, so there is no scope
clarification, no nothing-to-build decision and no audit: the table decides the order, and the run is done when every
step is complete or declined.

- **Rules** (`src/shared/roadmap.ts`, pure): a step is *complete* when its issue is closed as completed, *declined*
  when closed any other way (a no-go: unlocks nothing, never started), *ready* when open with every predecessor
  complete. Each pass reads the tracker and every step's issue state (`src/bun/roadmap-fetch.ts`) and starts the
  ready agent steps in step order, up to `maxInFlight`, through the same card creation, slot accounting, usage-limit
  hold and Ready to Merge sign-off as milestone mode. The card's prompt names its step, the tracker and its
  predecessors' issues, and repeats the `Fixes` / `Refs` rule — a step only closes (and unlocks the next) when its
  merged PR says `Fixes #n`.
- **Yours**: ready `[Human]` steps are never given to an agent. Each gets one native notification (the app only; the
  headless daemon has none) and a line in the Needs you strip at the top of the board that opens the issue. Closing
  the issue as completed releases what waits on it — picked up within 5 minutes (roadmap mode also polls GitHub, on
  top of the triggers above).
- **No restart loops**: if a step's card finished (Done for more than 3 minutes, or a run with no commits and no PR)
  and the issue is still open, Autopilot doesn't start another; the step shows under Needs you ("PR #n merged but the
  issue is still open") until you close the issue or start the work again yourself from the Issues queue.
- **Problems** in the table (duplicate step or issue, a predecessor that names no step, a cycle, a malformed row) are
  listed in the dialog and `agetor roadmap status`; the steps they touch are held. A tracker with no usable table
  starts nothing.
- **Use**: Autopilot dialog → Work from **Roadmap** → tracker issue number, or
  `agetor roadmap start --project <dir> --issue <n> [--max <n>] [--pipeline <id|name>]`, `agetor roadmap status
  [--json]`, `agetor roadmap pause` (`src/cli/commands/roadmap.ts`; all three go through `GET/PUT /autopilot`). Config
  is `roadmap: {"issue": n}` in the `autopilot` preference; status, the restart guard and the announced human steps
  are `roadmap`, `roadmapStuck` and `notifiedHuman` in `autopilot_state`, dropped when the roadmap changes.
