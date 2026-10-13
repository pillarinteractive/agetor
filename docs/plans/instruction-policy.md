# Reviewed pipeline instruction policy — 2026-10-13

The Pillar owner chose focused iteration checks, one selected local verification on the clean committed approved head before publication, entirely read-only Review, immutable Finish, agent-owned decision follow-ups, explicit authority/acceptance holds and finite-budget parking. Pillar's versioned profiles and step definitions are maintained in its `docs/engineering/agetor/` operator kit.

## Runtime behavior

- Finish never merges, commits, rebases or carries approval to a new SHA, even when a synthetic merge has an unchanged patch. It probes mergeability without creating a merge commit. After an inherited CI failure recovers on a newer base, Build merges that base and Review checks the resulting head. Persisted legacy carry-over is not independent approval, including in automatic sign-off and position recovery.
- Before a Pillar publication, the code-run Finish runs `.github/scripts/verify_changed.py --if-needed`, preserving its log and clean-HEAD cache. It rechecks HEAD and tracked cleanliness after verification. Failure routes to Build without a push. Pushes retain the enabled pre-push hook; its verification record avoids repeating successful checks. GitHub's required CI remains mandatory.
- A finite step cap parks before an agent or code-run Finish is launched. Retry explicitly grants another allowance. No automatic allowance extension or unapproved terminal wrap-up is launched; old cap-wrap-up metadata is not permission to bypass checks.
- `pipeline_decisions` accepts `{"mode":"agent-followups","projects":["/absolute/project/path"]}`. It is frozen in new run snapshots. In this mode the decision command records redacted rationale locally and returns a stable `followupMarker`; it never calls GitHub issue create/update adapters. Agents search all issue states for that marker and create or reuse one portable issue per decision. Legacy `planner-recommendation` remains available for projects that intentionally choose runner-owned issues; historical publication identities are retained for inspection.
- Machine guidance allows selected publication verification and focused iteration checks, preserving the existing two-slot and await behavior. Delegation instructions make any request for Scouts conditional on the actual harness's supported tools and step permissions.

## Adoption

`agetor pipeline edit <ref> --file <pipeline.json|->` updates an existing template through the authenticated API rather than creating a duplicate. It accepts the same validated input format as import; exported name hints are not remapped during edit, which is for this machine's existing profile identities. Existing runs retain their frozen snapshots.

Install these CLI/runner changes before applying Pillar's operator kit. Preview and backup/apply happen explicitly; no source change here rewrites saved user profiles, broadens gate trials, restarts active cards or publishes a release. Preserve the existing card's unresolved findings and deliberately adopt the new instructions/policy at a safe run boundary.

This policy supersedes the prior automatic-extension, cap-wrap-up, same-patch approval-carry and CI-only local-verification descriptions in the historical check-gate design and cost notes. Awaited commands stay with their originating step; resource/CI waits remain parked without a model slot. Missing mandatory owner evidence and essential contradictory requirements hold complete acceptance; routine decisions within authorized scope proceed without owner confirmation.
