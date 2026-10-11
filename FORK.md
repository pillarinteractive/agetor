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
  - **Blocked for another reason**: the run blocks on that step (Needs you), as it did before that rule existed.
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
M02 and M03 ≈ 8–20 hours") opens the Velocity view (`VelocityDialog.tsx`; also the **Velocity** button in the Autopilot
dialog), `agetor roadmap velocity [--json] [--scope current|roadmap] [--owner-delay <hours>]` prints the same, and
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
- **The view**: inline SVG and the app's own tokens (`--info` for agents working, `--warning` for waiting, both also
  said in words); each chart has its numbers as a table ("Show as a table") and a text alternative.
- **Upgrading**: no migration. The first pass after installing (30 s after the core starts) reads every card made from
  a step's issue once, writes the backfill and the first sample, and the summary appears beside the rocket. Going back
  to an older build leaves the two files unread.
- **Rendered checks**: `e2e/roadmap-board.spec.ts` ("velocity") seeds a synthetic three-day run and draws the view in
  light and dark, with too little data, and with none.
