import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Task, Run, PipelineRunState } from '../shared/types.ts';
import { rmTestDataDir } from './test-data-dir.ts';

// Isolated database and injected owner evidence; no production process,
// provider, private slot helper or actual resource lock is exercised.
const dir = mkdtempSync(join(tmpdir(), 'agetor-queued-owner-'));
process.env.AGETOR_DATA_DIR = dir;
const { tasks, runs, preferences } = await import('./db.ts');
const { activeCardOwners, runnerUse, reserveRunner } = await import('./dispatch-claims.ts');
const created: string[] = [];
beforeEach(() => {
  preferences.set('step_slots', JSON.stringify({ max: 8, heavy: { max: 2, steps: ['Finish'] } }));
  preferences.set('dispatch_runner_reservations_v1', '{}');
});
afterEach(() => { for (const id of created.splice(0)) tasks.delete(id); });
afterAll(() => rmTestDataDir(dir));

function card(extra: Partial<Task> = {}): Task {
  const id = randomUUID(), now = Date.now();
  created.push(id);
  return tasks.insert({ id, title: 'synthetic queue', prompt: 'synthetic', column: 'review', agent: 'claude-code', model: 'fake',
    effort: null, mode: 'auto', workdir: '/synthetic', worktreePath: null, branch: null, branchSource: 'created', baseRef: null,
    isolation: 'none', runId: null, createdAt: now, updatedAt: now, archivedAt: null, taskType: 'task', prUrl: null,
    fast: false, maxMode: false, references: [], backlog: [], draft: null, plans: [], agentProfileId: null, agentProfile: null,
    pipelineId: null, pipelineRun: null, pipelineParentId: null, pipelineStepId: null, hasOpenableRun: false,
    pendingInteractionCount: 0, openTerminalCount: 0, ...extra });
}
function receipt(id: string, status: Run['status']): string {
  const runId = randomUUID();
  runs.insert({ id: runId, taskId: id, agent: 'claude-code', status, startedAt: Date.now(), endedAt: status === 'running' ? null : Date.now(),
    exitCode: status === 'running' ? null : 0, tmuxSession: null, claudeSessionId: null, codexSessionId: null,
    cursorSessionId: null, geminiSessionId: null, fxSessionId: null });
  tasks.update(id, { runId });
  return runId;
}
function queued(status: Run['status'] | null = 'succeeded') {
  const parent = card({ column: 'running' });
  const cwd = '/synthetic/' + parent.id;
  tasks.update(parent.id, { worktreePath: cwd });
  const child = card({ pipelineParentId: parent.id, pipelineStepId: 's', worktreePath: cwd });
  const runId = status ? receipt(child.id, status) : null;
  const state: PipelineRunState = { pipelineId: 'synthetic', pipelineName: 'synthetic', snapshot: null, status: 'running',
    active: [{ taskId: child.id, stepId: 's', seq: 1 }], joins: {},
    blocked: [{ taskId: child.id, stepId: 's', kind: 'slot-wait', message: 'waiting for a slot' }],
    history: [{ taskId: child.id, stepId: 's', seq: 1, startedAt: Date.now(), endedAt: null, outcome: null, handoff: null, nextStepIds: [] }],
    stepCount: 1, startedAt: Date.now(), endedAt: null };
  tasks.setPipelineRun(parent.id, state);
  return { parent, child, state, runId, cwd };
}
const evidence = () => ({ cards: tasks.listLive(), awaits: [], jobs: [] });

test('idle existing children waiting for capacity are queues, not busy card owners', () => {
  for (const status of ['succeeded', 'failed', 'cancelled', null] as const) queued(status);
  expect(activeCardOwners(() => false, evidence()).size).toBe(0);
  expect(runnerUse(() => false, evidence())).toEqual({ total: 0, heavy: 0 });
});

test('eight actual reservations still cap admission while idle queues consume none', () => {
  for (let i = 0; i < 12; i++) queued();
  for (let i = 0; i < 8; i++) expect(reserveRunner('accepted-' + i, 'Build', () => false)).toEqual({ ok: true });
  expect(activeCardOwners(() => false, evidence()).size).toBe(8);
  expect(runnerUse(() => false, evidence()).total).toBe(8);
  expect('error' in reserveRunner('ninth', 'Build', () => false)).toBe(true);
});

test('a live sibling behind a queue label keeps its owner counted once', () => {
  const q = queued();
  const sibling = card({ pipelineParentId: q.parent.id, worktreePath: q.cwd, column: 'running' });
  receipt(sibling.id, 'running');
  q.state.active.push({ taskId: sibling.id, stepId: 'other', seq: 2 });
  tasks.setPipelineRun(q.parent.id, q.state);
  expect([...activeCardOwners(id => id === sibling.id, evidence())]).toEqual([q.parent.id]);
});

test('queued running, orphaned and missing exact run receipts remain conservatively owned', () => {
  const running = queued('running'), orphaned = queued('orphaned'), missing = queued();
  tasks.update(missing.child.id, { runId: 'missing-exact-run' });
  const owners = activeCardOwners(() => false, evidence());
  expect(owners.size).toBe(3);
  for (const q of [running, orphaned, missing]) expect(owners.has(q.parent.id)).toBe(true);
});

test('a live accepted-but-unspawned reservation behind an idle queue is retained', () => {
  const q = queued(null);
  preferences.set('dispatch_runner_reservations_v1', JSON.stringify({ [q.child.id]: {
    taskId: q.child.id, ownerId: q.parent.id, runId: null, pid: process.pid, at: Date.now(), name: 'Build' } }));
  expect([...activeCardOwners(() => false, evidence())]).toEqual([q.parent.id]);
  expect(JSON.parse(preferences.get('dispatch_runner_reservations_v1')!)[q.child.id]).toBeDefined();
});

test('another live creator retains an accepted retry despite an older terminal receipt', () => {
  const foreign = Bun.spawn(['/bin/cat'], { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' });
  try {
    for (const status of ['succeeded', 'failed', 'cancelled'] as const) {
      const q = queued(status);
      const accepted = { taskId: q.child.id, ownerId: q.parent.id, runId: null,
        pid: foreign.pid, at: Date.now(), name: 'Build' };
      preferences.set('dispatch_runner_reservations_v1', JSON.stringify({ [q.child.id]: accepted }));
      const otherOwners: string[] = [];
      for (let i = 0; i < 7; i++) {
        const other = card({ column: 'running' });
        receipt(other.id, 'running');
        otherOwners.push(other.id);
      }
      const owners = activeCardOwners(() => false, evidence());
      expect(owners.has(q.parent.id)).toBe(true);
      expect(owners.size).toBe(8);
      expect(runnerUse(() => false, evidence())).toEqual({ total: 8, heavy: 0 });
      expect('error' in reserveRunner('ninth-' + status, 'Build', () => false)).toBe(true);
      expect(JSON.parse(preferences.get('dispatch_runner_reservations_v1')!)[q.child.id]).toEqual(accepted);

      // Only the new retry's bound receipt can establish its completion.
      const ownRun = receipt(q.child.id, 'succeeded');
      preferences.set('dispatch_runner_reservations_v1', JSON.stringify({ [q.child.id]: { ...accepted, runId: ownRun } }));
      expect(activeCardOwners(() => false, evidence()).has(q.parent.id)).toBe(false);
      expect(JSON.parse(preferences.get('dispatch_runner_reservations_v1')!)[q.child.id]).toBeUndefined();
      for (const id of otherOwners) tasks.delete(id);
    }
  } finally {
    foreign.kill();
  }
});

test('detached running or unknown-phase work remains an owner even when its model turn is queued', () => {
  const q = queued();
  for (const resourceState of ['running', undefined] as const) {
    const ev = { ...evidence(), awaits: [{ id: 'job', dir: '/synthetic/await', label: 'job', cwd: q.cwd, cmd: 'agetor-heavy -- test',
      startedAt: Date.now(), pid: process.pid, exitCode: null, finished: false, notified: false, ...(resourceState ? { resourceState } : {}) }] };
    expect([...activeCardOwners(() => false, ev)]).toEqual([q.parent.id]);
  }
});

test('two actual job slots retain one owner and both heavy slots behind an idle queue', () => {
  const q = queued();
  const ev = { ...evidence(), jobs: [{ pid: process.pid, cwd: q.cwd, slot: 0 }, { pid: process.pid, cwd: q.cwd, slot: 1 }] };
  expect([...activeCardOwners(() => false, ev)]).toEqual([q.parent.id]);
  expect(runnerUse(() => false, ev)).toEqual({ total: 1, heavy: 2 });
});

test('a queue with a missing child is uncertainty, not proof of a free owner', () => {
  const q = queued();
  tasks.delete(q.child.id);
  expect([...activeCardOwners(() => false, evidence())]).toEqual([q.parent.id]);
});
