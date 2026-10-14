# Pillar's instruction policy: what Agetor provides — 2026-10-13

Pillar keeps its Agetor profile and step instructions under `docs/engineering/agetor/` and applies them with
`sync_policy.py`. That script reaches Agetor only through the `agetor` CLI. This branch
(`feat/instruction-policy-compatible`) makes the CLI and the runner able to run it as written.

It is a selective port of `004f16e` ("fix: reconcile reviewed pipeline publication and instruction policy", branch
`codex/pillar-instruction-policy`). That commit also reversed four behaviours of `release`. The owner compared the two
and kept `release`'s; they are listed below, and nothing here changes them.

## What the script calls

Every call is `agetor <args> --json --no-daemon`, except the help check.

| Call | Needs | Where |
| --- | --- | --- |
| `profile ls` | a JSON list with `id`, `name`, `instructions` | already there |
| `pipeline show <name>` | the pipeline with `id`, `name`, `description`, `graph`, `maxSteps`; every edge has `label` | already there |
| `config pipeline_decisions` | `{"pipeline_decisions": <string or null>}` | already there |
| `pipeline --help` (no flags) | the text `pipeline edit` on stdout, exit 0 | added: the help block names the verb |
| `profile edit <id> --instructions-file <file>` | JSON on stdout | already there |
| `pipeline edit <id> --file -` (JSON on stdin) | the pipeline updated in place, JSON on stdout | added |
| `config pipeline_decisions <json>` | the mode `agent-followups` accepted when a run starts | added |

## What was added

**`agetor pipeline edit <ref> --file <pipeline.json|->`.** `<ref>` is the pipeline's id or unique name. The file is
`{name, description?, graph, maxSteps?}`, the format `pipeline export` writes; `-` reads stdin. It is validated like
an import and sent as `PATCH /pipelines/:id`, so the pipeline keeps its id and nothing is duplicated. Exported
`profileName` hints are ignored. `--json` prints the updated pipeline.

**The `agent-followups` decision mode.** `pipeline_decisions` is
`{"mode": "planner-recommendation" | "agent-followups", "projects": ["/absolute/project/path"]}`; the mode is frozen
in a run's snapshot when the run starts. Under `agent-followups`:

- `agetor pipeline decision <parent> <record.json>` records in the private ledger and deduplicates by question, as
  before, and answers with `publication: "agent-managed"`, `decisionId` and a stable
  `followupMarker` (`<!-- agetor-decision:<source issue>:<decision id> -->`).
- It never calls the GitHub issue create or update adapters, for a first record, a repeat or a revision. The runner
  does not publish an issue that would compete with the agent's.
- The step's prompt tells the agent it owns one follow-up issue per decision: search for the marker first, reuse the
  issue when it exists, put the marker in the body and the URL in the handoff.

`planner-recommendation` is unchanged, including the text its steps are given. Everything else a decision policy
switches on is the same for both modes: routine choices continue the same card without waiting for the owner, the
step cap extends once and then wraps up, a missing handoff and an interrupted launch are retried, and the Claude
launch flags are trimmed the same way. **An owner decision does not stop a card** in either mode.

**The trivial change through Review.** The script moves the "trivial change made" edge from Understand → Finish to
Understand → Review. A run keeps the routing it started with, so both graphs are live at once. See "Both graphs".

## The four decisions kept from `release`

1. **Step cap.** An unattended run (a project with a decision policy) that reaches its cap extends its allowance by
   itself, once (`AUTO_CAP_EXTENSIONS`). When it reaches the cap again it is finished once through the terminal step
   (`capWrapUpStep`) with the wrap-up section added to that step's prompt (`capWrapUpSection`): publish as usual, do
   not hand back, file one issue per unresolved finding, and say so when the head is published unapproved.
   `run.capWrapUp` records it. That happens once per run; a later cap hit blocks with `step-cap` for a person's
   Retry. `004f16e` removed all of this ("cap parking").
2. **Base moved after approval.** A Finish run by Agetor may merge the base into the approved branch when the merge
   is clean and the change's own diff is unchanged (`git patch-id` of `git diff base...HEAD`, `mergeProbe`). Review's
   approval then carries over to the merge (`carried`, `approvedHeadFor`), and automatic sign-off and position
   resolution accept that head. A conflict goes to Build; so does a merge that changes the diff after the base
   recovered. `004f16e` made publication "immutable" and treated a carried approval as none.
3. **Edited step instructions reach unfinished runs.** Saving a template whose step text changed starts
   `adoptPipelineInstructions`: every running, blocked or stopped run of it takes the new text
   (`refreshPipelineRuns`, `updatedPipelineInstructions`). A step that is executing keeps its prompt until its next
   launch. Nothing else is taken: routing, agents, the cap and check gates stay as the run has them. `pipeline edit`
   is one more way to save a template and does exactly this.
4. **Verification is GitHub CI.** A publication candidate is verified by the pull request's required check on the
   pushed head. Finish does not run `verify_changed.py` locally, the machine guidance tells steps not to, and the
   push skips the local pre-push hook. `004f16e` added a local run in Finish ("approved-head verification").

## `004f16e`, file by file

| Change | Here |
| --- | --- |
| `agent-followups` in the preference, the snapshot, the store's sanitizer, the decision command and its test | taken |
| Unattended behaviour and Claude launch flags follow any decision policy, not the one literal | taken |
| `pipeline edit` and its test | taken; the message and help say what saving does to runs, and the `pipeline` help now contains `pipeline edit` (in `004f16e` it did not, so the script's own check would have refused to apply) |
| "Do not spawn subagents" line explains a Scout request | taken |
| A sentence added to every decision prompt ("Missing mandatory evidence … hold complete acceptance") | left out: it changes `planner-recommendation`'s text |
| Cap parking: `AUTO_CAP_EXTENSIONS`, `capWrapUp`, the wrap-up launch and section removed | left out (1) |
| `merge-base` action, `mergeProbe`'s patch comparison, `approvedHeadFor`, carried approval in position and sign-off removed | left out (2) |
| `publishDeps.verify`, the `verification` build cause, pushing with the pre-push hook, the machine guidance text | left out (4) |
| Tests rewritten for the above (`pipeline-unattended`, `publish-step`, `publish`, `pipeline`, `position`) | left out: these files assert `release`'s behaviour, with cases added |
| `FORK.md` paragraph and this file as written there | replaced |

`004f16e` did not touch instruction adoption (3); its `pipeline edit` message said runs keep a frozen snapshot, which
is not what `release` does.

## Both graphs

| | trivial → Finish | trivial → Review |
| --- | --- | --- |
| `reviewedPipelineShape` | Build, Review, Finish, with Finish → Build | the same |
| Step Agetor publishes (`publishStepOf`), cap wrap-up step (`capWrapUpStep`) | Finish | Finish |
| Finish run by Agetor on the trivial route | no Review visit, no approved head: the step's agent runs it | the head Review approved is published; a dirty tree goes to Build |
| Review's default checks (`defaultChecksOf`) | `tree-clean`, `review-verdict` | on a visit Understand handed the work to, `review-verdict`, with `tree-clean` reported and not required; otherwise both |
| Forward path (`forwardPath`) on the trivial route | Understand, Finish | Understand, Review, Finish |
| …after a later step sent the work to Build and Build finished | Understand, Build, Review, Finish | the same |
| Lifecycle sign-off (`reviewedPillarPipeline`) | only after a round through Build and Review | when Review approved the published head |

Two things changed in code. `forwardPath` treats the trivial route as a shortcut that ends once the skipped Build has
finished after it, so Review is handed Build's report and not Understand's; and a Finish visit that sent the work on
to Build is not held to what it published. Review's default `tree-clean` relies on Build's gate having passed first;
where Understand hands Review the work, Review cannot commit the change and must not discard it, so the check is
reported and the verdict alone holds the visit.

## Applying it

Install this branch's build first. Then, from a Pillar checkout that has the operator kit:
`python3 docs/engineering/agetor/sync_policy.py --project /absolute/path/to/pillar` previews, and `--apply` saves.
The script changes profile instructions, the four step texts, the one edge and this project's decision mode.

Run against a throwaway core seeded with the board's 14 profiles and the Change pipeline (2026-10-13), the script
worked as written: preview, apply, a second preview and `--restore` all exited 0, the pipeline kept its id, and the
restore returned the graph and the preference to what they were.

Known gaps:

- `profile edit --instructions-file` stores the text trimmed. The script compares against text that ends in a
  newline, so every preview reports "14 profile instruction updates", and every apply rewrites the 14 profiles with
  the same text. Comparing `old["instructions"].strip() != text.strip()` in `prepare()` would make it idempotent.
- The script's last line says existing runs keep their frozen snapshot. Unfinished runs take the new step text (3).
- Nothing checks that Understand committed a change before it chose the trivial route.
- Whether GitHub's issue search finds the `followupMarker` inside an HTML comment was not tested; the decision id in
  it is the term to search for.
