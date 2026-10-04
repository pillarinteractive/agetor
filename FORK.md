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
- **Issue queue** (top-bar Issues button, `src/bun/issue-queue.ts`): a project's open issues with label chips and search;
  pick a pipeline and **Fix** to create and start a pipeline task from the issue (built like `agetor add --issue`), with
  the prompt asking the PR to say `Fixes #n`. Issues that already have a live task show it instead.
