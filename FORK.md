# Working on the pillarinteractive fork

This checkout is `pillarinteractive/agetor`, a fork of `alamops/agetor`. The same person uses a build of it as their daily
Agetor, so a change here can reach a board that is running real agents. Follow this workflow; it keeps development and
the live board apart.

## Layout

| Where | Data | What it's for |
| --- | --- | --- |
| `~/Dev/agetor` (this checkout) | — | Development. `main` = `upstream/main` + the fork's local tooling commits. |
| `bun run dev:hmr` | `~/.agetor-dev`, port 4318, tmux socket `agetor-dev` | Sandbox for trying changes. Runs whatever branch is checked out. |
| `~/Dev/agetor-release` (git worktree, branch `release`) | — | What is installed. `release` = `main` + fix branches merged for local use. |
| `/Applications/Agetor.app` | `~/.agetor`, port 4317, tmux socket `agetor` | The daily board, built from `release`. |

Remotes: `origin` = the fork, `upstream` = `alamops/agetor`.

**Never point a dev run at `~/.agetor`.** `dev:hmr` reloads on save and loads its UI from Vite on :5173, so half-written
code would drive live agents. The real board only ever runs a packaged build from `release`.

## Making a change

1. Branch off upstream, not the fork's `main`, so the branch can go upstream without the local tooling commits:
   `git fetch upstream && git switch -c fix/<name> upstream/main`
2. Verify: `bun run typecheck` and the relevant tests (`bun test src/bun/<file>.test.ts`). The full `bun test` takes about
   5 minutes. On this machine 7 tests fail on unmodified upstream too (`github-network.test.ts`, `tmux-socket.test.ts`:
   they assume no `gh` login / no socket override), so compare against a baseline rather than expecting zero.
3. Try it in the sandbox: `bun run sync:dev` (copies projects, agents, pipelines and harness aliases from `~/.agetor`
   into `~/.agetor-dev` through both APIs; safe to re-run), then `bun run dev:hmr`.

## Shipping to the board

```bash
cd ~/Dev/agetor-release
git merge main fix/<name>      # whatever should be live
bun run build:local            # packages the app: no Developer ID signing/notarization, update feed = the fork's releases
bun run install:local          # backs up ~/.agetor/agetor.sqlite, moves the old app into ~/.agetor/backups/, relaunches
```

`install:local` quits Agetor; the user has to confirm the Quit dialog. Agents keep running in tmux and the new app
reattaches to them. Roll back by quitting, moving the previous app from `~/.agetor/backups/` back into `/Applications`,
and restoring the database backup only if the new build ran a migration. A build that adds a migration makes the database
unreadable by older builds, so call that out before installing.

## Going upstream

Ask the user before pushing a branch or opening a PR: both are public. Upstream PRs target `alamops/agetor` `main`, come
from a `fix/` or `feat/` branch based on `upstream/main`, and stay small (the maintainer asks for focused PRs). After a
merge: `git fetch upstream`, rebase the fork's `main` onto `upstream/main`, then rebuild `release` from `main`.

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

## PR babysitter and issue queue (`feat/pr-watch-issues`)

- **PR watcher** (`src/bun/pr-watch.ts`): every 60s, finds each live card's PR by branch (agents open PRs with `gh`, which
  Agetor never sees), rolls up check runs and counts unresolved review threads. The card shows a PR badge; a merged PR
  moves the card to Done. A finished pipeline's Next box offers suggested **Fix CI** / **Address review** follow-ups
  (agent: `pr_followup_agent` preference, default `Builder`). The Builder profiles may push their own task branch so
  these can update the PR; never `main`/`develop`, never force-push.
  - A failing check that also fails on the PR's base branch is marked inherited: the badge reads
    `✗ CI (also on develop)` and Fix CI isn't offered for it (the aggregate `required` check never counts).
  - Follow-ups also run on a **blocked** run once nothing in it is live.
  - Opt-in auto Fix CI: `agetor config pr_autofix true`. Starts Fix CI by itself for the PR's own failures, at most
    twice per PR and never twice for the same commit (ledger in the `pr_autofix_attempts` preference).
- **Issue queue** (top-bar Issues button, `src/bun/issue-queue.ts`): a project's open issues with label chips and search;
  pick a pipeline and **Fix** to create and start a pipeline task from the issue (built like `agetor add --issue`), with
  the prompt asking the PR to say `Fixes #n`. Issues that already have a live task show it instead.

## Knowing what each card is doing (`feat/board-clarity`)

- **Status line** under every card title (`src/mainview/lib/card-status.ts`): the step and how long it's been running,
  what it waits on (lab, base-branch CI), the PR's state, or the result headline; ⓘ when it needs you.
- **Needs you** bar at the top of the board: only cards waiting on the user, each with its one action
  (Answer / Retry / Fix CI / Open PR / Review).
- **Activity** timeline in the run view (`src/bun/activity.ts`): steps derived from the run's history, plus PR, CI,
  review, merge, lease and auto-fix events appended to `<dataDir>/activity/<taskId>.jsonl` as they happen.
- The run view header leads with the card's title; a step's panel strip names the card it belongs to.

## Orchestrator suggestions, layer 1 (`feat/suggestions`)

`src/bun/suggestions.ts` recognises situations that used to need a person and proposes the fix; they appear at the top
of the Needs you bar with **Apply**. Nothing runs without the click, and each suggestion is recomputed at apply time.
Rules: step blocked on the test environment (`DATABASE_URL`/`.env.local`) → message it to use CI's placeholder; step
blocked on a lease that's free → Retry; PR behind its base whose failing checks pass on the base → Update branch;
finished run with commits and no PR → Open PR preset; blocked step with open questions → show the first one.
The PR watcher also records `behindBy` and `passesOnBase`, so a failure the base has since fixed isn't treated as the
PR's own (no Fix CI / auto-fix). Layer 2 (a Conductor agent you chat with) is planned.
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

## The Conductor, layer 2 (`feat/conductor`)

A chat agent for the whole board: the ✨ button in the top bar starts it the first time (then opens its chat). It's an
ordinary task (isolation none, workdir `~/.agetor/conductor` holding its CLAUDE.md/AGENTS.md, id in the
`conductor_task_id` preference) hidden from the columns. It reads the board through the CLI — new commands
`agetor board`, `suggestions [apply]`, `activity`, `followups`, `followup` (`src/cli/commands/board.ts`, backed by
`GET /board/digest` in `src/bun/board-digest.ts`) — and acts only when asked. `install:local` compiles the CLI to
`~/.agetor/bin/agetor`; the instructions pin it with `--data-dir … --no-daemon`.
- **Watching** (`src/bun/conductor.ts`): every 30s it snapshots each card's column, needs-you reason, pipeline status,
  PR summary, finished lab/E2E result and the suggestions; when that changes and the Conductor is idle it sends an
  "[Automatic board update — not from the user]" message (at most every `minIntervalMin`, `maxPerHour`).
- **Config**: `agetor config conductor '{"model":"opus-5.5","watch":true,"minIntervalMin":5,"maxPerHour":6}'`
  (also `agent`, `mode`); `agetor config conductor_rules '<text>'` appends standing rules to its instructions
  (rewritten at every start). Delete/archive the Conductor task to start a fresh one.
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
  the quietest active step — any harness). After 20 min quiet the card warns "quiet 25m" and lands in Needs you with
  Check — unless a lab/E2E run on it is reporting live progress.
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
- **Crashed / lost steps retry themselves**: a step run that `failed` (session died, API error) or was `orphaned`
  is retried automatically up to 2× (1 min, 2 min), with timeline entries. A "blocked" handoff or a user Stop never is.
- **Pipelines own their PRs**: auto Fix CI is on by default for pipeline cards (`pr_autofix` true/false overrides;
  max 2 per PR, never twice on one head). A PR behind its base whose failing checks pass on the base gets its branch
  updated automatically (`pr_autoupdate=false` to stop) — so the Update-branch suggestion only shows when that's off.
- **Block log** (`src/bun/block-log.ts`): every new pipeline block is appended to `blocks.jsonl`; `agetor blocks
  [--days N]` / `GET /blocks` group them by pipeline › step › kind, most frequent first.
- **Steps that can finish** (`PipelineStep.canFinish`, editor: "Can also finish the pipeline"): a choose step with
  outgoing edges that may also end the run by handing off `next: null`. Pillar's Finish uses it with a
  "verification failed" edge back to Fix (Bugfix) / Build (Feature), so a failing final check loops back instead of
  blocking (bounded by maxSteps).

## Card dependencies (`feat/card-dependencies`)

"Blocked by…" in a card's right-click menu, `agetor depends <id> <dep…>` (or `--clear`), or ask the Conductor.
Stored in the `card_dependencies` preference; `Task.blockedBy` is decorated onto API responses
(`src/bun/dependencies.ts`). A dependency is satisfied when its card is Done/archived/deleted or its PR merged.
While waiting, the card says `Waiting on "<card>" · PR #201 · checks running` and carries a "waits on #201" chip.
When the last one lands, a 15s watcher moves the card on and clears the entry: never-started → started; blocked
pipeline → its blocked step is told to merge the base and carry on; idle single task → told the same.

## Closing issues when their PR merges (`feat/close-issues-on-merge`)

GitHub only auto-closes "Fixes #N" when a PR merges into the default branch; Pillar's PRs merge into `develop`, so
fixed issues stayed open. When a card's PR merges (seen by the PR watcher, including Done cards' one lookup after a
restart), the issue it fixes — its `issueUrl`, else a `Fixes/Closes/Resolves #N` line in its prompt — is closed with
a "Fixed by #PR, merged into develop" comment. `closed_issues` preference remembers what was closed; an issue
already closed is left alone.
