import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Task, Run, PipelineRunState } from '../shared/types.ts';
import type { AwaitRecord } from './awaits.ts';
import { rmTestDataDir } from './test-data-dir.ts';

// Isolated database and injected owner evidence; nothing real is run.
const dir = mkdtempSync(join(tmpdir(), 'agetor-remote-wait-'));
process.env.AGETOR_DATA_DIR = dir;
const { tasks, runs, preferences } = await import('./db.ts');
const { activeCardOwners, runnerUse, isRemoteWait } = await import('./dispatch-claims.ts');
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
  return tasks.insert({ id, title: 'synthetic', prompt: 'synthetic', column: 'review', agent: 'claude-code', model: 'fake',
    effort: null, mode: 'auto', workdir: '/synthetic', worktreePath: null, branch: null, branchSource: 'created', baseRef: null,
    isolation: 'none', runId: null, createdAt: now, updatedAt: now, archivedAt: null, taskType: 'task', prUrl: null,
    fast: false, maxMode: false, references: [], backlog: [], draft: null, plans: [], agentProfileId: null, agentProfile: null,
    pipelineId: null, pipelineRun: null, pipelineParentId: null, pipelineStepId: null, hasOpenableRun: false,
    pendingInteractionCount: 0, openTerminalCount: 0, ...extra });
}
function receipt(id: string, status: Run['status']): void {
  const runId = randomUUID();
  runs.insert({ id: runId, taskId: id, agent: 'claude-code', status, startedAt: Date.now(), endedAt: Date.now(),
    exitCode: 0, tmuxSession: null, claudeSessionId: null, codexSessionId: null,
    cursorSessionId: null, geminiSessionId: null, fxSessionId: null });
  tasks.update(id, { runId });
}
/** A step that ended its turn and is parked on one background command. */
function parked(cmd: string) {
  const parent = card({ column: 'running' });
  const cwd = '/synthetic/' + parent.id;
  tasks.update(parent.id, { worktreePath: cwd });
  const child = card({ pipelineParentId: parent.id, pipelineStepId: 's', worktreePath: cwd });
  receipt(child.id, 'succeeded');
  const state: PipelineRunState = { pipelineId: 'synthetic', pipelineName: 'synthetic', snapshot: null, status: 'running',
    active: [{ taskId: child.id, stepId: 's', seq: 1 }], joins: {},
    blocked: [{ taskId: child.id, stepId: 's', kind: 'await', message: 'waiting on a command' }],
    history: [{ taskId: child.id, stepId: 's', seq: 1, startedAt: Date.now(), endedAt: null, outcome: null, handoff: null, nextStepIds: [] }],
    stepCount: 1, startedAt: Date.now(), endedAt: null };
  tasks.setPipelineRun(parent.id, state);
  const record: AwaitRecord = { id: randomUUID(), dir: '/synthetic/awaits/' + parent.id, label: 'ci', cwd, cmd,
    startedAt: Date.now(), pid: 1, exitCode: null, finished: false, notified: false };
  return { parent, child, record };
}
const evidence = (awaits: AwaitRecord[]) => ({ cards: tasks.listLive(), awaits, jobs: [] });

test('isRemoteWait matches the ci-wait helper by name only', () => {
  expect(isRemoteWait({ cmd: '/Users/x/.agetor/bin/ci-wait ' })).toBe(true);
  expect(isRemoteWait({ cmd: 'ci-wait --timeout 30 ' })).toBe(true);
  expect(isRemoteWait({ cmd: 'python3 .github/scripts/verify_changed.py --if-needed ' })).toBe(false);
  expect(isRemoteWait({ cmd: 'sh not-ci-wait-at-all.sh ' })).toBe(false);
});

test('a step parked on CI holds no card-owner place and no slot', () => {
  const records = Array.from({ length: 9 }, () => parked('/Users/x/.agetor/bin/ci-wait ').record);
  expect(activeCardOwners(() => false, evidence(records)).size).toBe(0);
  expect(runnerUse(() => false, evidence(records))).toEqual({ total: 0, heavy: 0 });
});

test('a step parked on a local verification still counts, as heavy', () => {
  const { parent, record } = parked('python3 .github/scripts/verify_changed.py --if-needed ');
  expect([...activeCardOwners(() => false, evidence([record]))]).toEqual([parent.id]);
  expect(runnerUse(() => false, evidence([record]))).toEqual({ total: 1, heavy: 1 });
});

test('a finished CI wait changes nothing until the step is woken', () => {
  const { record } = parked('ci-wait ');
  const done = { ...record, finished: true, exitCode: 0 };
  expect(activeCardOwners(() => false, evidence([done])).size).toBe(0);
  expect(runnerUse(() => false, evidence([done]))).toEqual({ total: 0, heavy: 0 });
});
