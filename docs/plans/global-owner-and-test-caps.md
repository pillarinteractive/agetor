# Global capacity and Pillar pipeline sign-off

This repair follows the live eight-card / two-heavy-job audit of 2026-10-11.
It adds no credentials, permissions, database migration, or worker teardown.

Capacity uses distinct top-level card IDs across projects and issue states.
An executing detached command counts even without a legacy runner claim.
A live child plus detached jobs retains one card identity, while raw agents
and actual jobs retain their separate limits. An explicitly queued verifier
without a lease does not count as executing. Two other occupied slots never
erase running or unknown phase evidence. Unknown held locks remain occupied. Terminal
old receipts cannot release a newer running, orphaned, or missing receipt.
Fresh manual/API pipeline starts reserve before awaited preparation; when
full, they queue without starting an agent or preparing a worktree.

SQLite uses a 1,000ms busy timeout and at most three synchronous reservation
transaction attempts. Only rolled-back busy/locked transactions retry.
Autopilot clears its in-memory pass flag independently of final persistence;
failed completion leaves one durable wake to reconcile the exact local cycle.
Foreign live cycle tokens and uncertain worker receipts remain held.

`agetor-heavy -- <direct argv>` and managed PATH routes share Pillar's
existing `~/.cache/pillar/verify-slots/slot0.lock` and `slot1.lock` protocol.
The routes cover go test/build/vet, pnpm/npm/bun test/build/check scripts,
Vitest/Jest/Playwright/Vite/tsc, and node's direct supported runner paths.
Git resolves the owning root for subdirectory and linked-worktree launches;
an unrelated nested repository without the marker remains excluded.
Environment prefixes cannot change the managed count/root or emulate CI.
Nested children reuse a same-worktree live ancestor's occupied job lease;
unrelated or malformed identities fail closed. The original verifier keeps
its own planning, cache and command behavior; only its resource context is
substituted. Development/test data directories use isolated fixture locks.

This is a supported launch guard, not an OS sandbox. Absolute binary paths,
custom scripts and unrelated external processes require the explicit wrapper
and can otherwise bypass PATH routing. Existing Claude sessions retain their
old process environment; no active worker is restarted to inject PATH.

The supported Autopilot patch `{autoMergePipelines:true}` opts Pillar #639
into lifecycle sign-off independently of `{enabled:false}` admission pause.
The activation timestamp is fixed on opt-in. Only task-linked open,
non-draft PRs targeting develop, completed after activation, with the frozen
GPT-6.1 Sol Review immediately followed by successful Finish and its exact
published PR artifact are eligible. Review must persist `reviewApproval`
with approved verdict, full current head SHA, exact issue identity, complete
acceptance and no findings. Contradictory Changes requested/incomplete
acceptance prose still refuses sign-off. Head changes require independent
review again. Correctness findings route to the existing corrective Build
edge while preserving the original review report. Unresolved handoff questions, manual
withdrawals, old plans and main PRs remain excluded. Eligible manually
created cards also enter the existing merge queue. Its CI, review-thread,
conflict, branch-policy and Sonnet repair behavior is unchanged.

A stale handoff reminder cannot block or duplicate a newer exact active
continuation. Ordinary missing-run delivery failures remain visible and held.

Verification includes the unchanged reviewer detached-owner and SQLite-busy
probes, independent-process final-slot races, exhausted busy recovery,
managed direct/nested/spoofed guard fixtures, and native pipeline/sign-off/
merge-queue regressions. Installation requires independent candidate review.
