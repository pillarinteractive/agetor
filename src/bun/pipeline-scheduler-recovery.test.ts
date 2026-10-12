import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rmTestDataDir } from './test-data-dir.ts';

// Every job here uses the fake driver and a disposable DB/workdir. No live
// board, provider, native resource helper, or user tmux session is involved.
const dir = mkdtempSync(join(tmpdir(), 'agetor-scheduler-recovery-'));
process.env.AGETOR_DATA_DIR = dir;
process.env.AGETOR_CLAUDE_DRIVER = 'fake';
process.env.AGETOR_CLAUDE_BIN = '/bin/echo';
process.env.AGETOR_CLAUDE_ARGS = '';
process.env.AGETOR_TMUX_BIN = '/bin/echo';
const { tasks, runs, pipelines, agentProfiles, preferences, db } = await import('./db.ts');
const { createTask, startTask, isTaskRunLive, deleteTask } = await import('./orchestrator.ts');
const { initPipelineRunner, reconcilePipelineRuns, fireLaunchRetry, releaseSlotWaits,
  cancelPipelineRun, retryPipelineStep, stopPipelineAutoRetryTimers, __forTest } = await import('./pipeline-runner.ts');
const { newStep } = await import('../shared/pipeline.ts');
const { PIPELINE_DECISIONS_PREF } = await import('../shared/pipeline-decisions.ts');
const { STEP_SLOTS_PREF } = await import('./step-slots.ts');
const { FAKE_CLAUDE_HANDOFF_PROMPT_MARKER: marker } = await import('./agents.ts');
const parents: string[] = [];

beforeAll(() => initPipelineRunner());
afterEach(async () => {
  db.exec('DROP TRIGGER IF EXISTS scheduler_launch_fault');
  __forTest.setListenerEnabled(true);
  stopPipelineAutoRetryTimers();
  delete process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS;
  preferences.set(PIPELINE_DECISIONS_PREF, 'null');
  preferences.set(STEP_SLOTS_PREF, JSON.stringify({ max: 1000, heavy: { max: 1000, steps: [] } }));
  for (const id of parents.splice(0)) if (tasks.get(id)) await deleteTask(id);
});
afterAll(async () => { await Bun.sleep(150); rmTestDataDir(dir); });

async function waitFor<T>(fn: () => T | undefined | null | false): Promise<T> {
  const deadline = Date.now() + 6000;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('scheduler fixture timed out');
    await Bun.sleep(15);
  }
}
function fault(message: string) {
  // A launch fault after the child is inserted reproduces the interrupted
  // admission window; the retry must reuse that execution rather than add one.
  db.exec(`CREATE TRIGGER scheduler_launch_fault BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT, '${message}'); END`);
}
async function fixture(suffix = 'done', optedIn = true, name = 'Build') {
  const wd = mkdtempSync(join(tmpdir(), 'agetor-scheduler-project-'));
  preferences.set(PIPELINE_DECISIONS_PREF, JSON.stringify({ mode: 'planner-recommendation', projects: optedIn ? [wd] : [] }));
  const profile = agentProfiles.insert({ name: randomUUID(), harness: 'claude-code', model: 'fake-model', effort: null,
    mode: null, fast: false, maxMode: false, instructions: 'Preserve permissions and review requirements', skills: [] });
  const step = newStep({ name, agentProfileId: profile.id, instructions: `${marker}:${suffix}` });
  const pipeline = pipelines.insert({ name: randomUUID(), graph: { steps: [step], edges: [], startStepId: step.id }, maxSteps: 3 });
  const made = await createTask({ title: 'scheduler recovery', prompt: 'complete the issue', workdir: wd, isolation: 'none', pipelineId: pipeline.id });
  if ('error' in made) throw new Error(made.error);
  parents.push(made.task.id);
  return { id: made.task.id, step, profile, wd };
}
const run = (id: string) => tasks.get(id)!.pipelineRun!;
const launchRetry = (id: string, child = run(id).active[0]!.taskId) => run(id).launchRetries![child]!;
async function done(id: string) {
  return waitFor(() => run(id).status === 'done' ? run(id) : null);
}

test('scheduler recovery: database-lock launch retries the same child and preserves the step budget', async () => {
  const f = await fixture();
  fault('database is locked');
  await startTask(f.id);
  const child = run(f.id).active[0]!.taskId;
  const retry = launchRetry(f.id, child);
  expect(run(f.id).blocked[0]!.message).toContain('database is locked');
  expect(retry).toMatchObject({ stepId: f.step.id, kind: 'transient', attempt: 1 });
  expect(retry.at! - Date.now()).toBeGreaterThan(50_000);
  expect(runs.listForTask(child)).toHaveLength(0);
  expect(isTaskRunLive(child)).toBe(false);
  db.exec('DROP TRIGGER scheduler_launch_fault');
  expect(await fireLaunchRetry(f.id, child, retry.at!)).toBe(true);
  const finished = await done(f.id);
  expect(finished.stepCount).toBe(1);
  expect(finished.history).toHaveLength(1);
  expect(tasks.stepsForParent(f.id).map(t => t.id)).toEqual([child]);
  expect(runs.listForTask(child)).toHaveLength(1);
  expect(await fireLaunchRetry(f.id, child, retry.at!)).toBe(false);
});

test('scheduler recovery: persistent database contention stops after the bounded retry allowance', async () => {
  const f = await fixture();
  fault('database is locked');
  await startTask(f.id);
  const child = run(f.id).active[0]!.taskId;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const retry = launchRetry(f.id, child);
    expect(retry.attempt).toBe(attempt);
    expect(retry.at).not.toBeNull();
    expect(await fireLaunchRetry(f.id, child, retry.at!)).toBe(false);
  }
  expect(launchRetry(f.id, child)).toMatchObject({ kind: 'transient', attempt: 5, at: null });
  await reconcilePipelineRuns();
  expect(launchRetry(f.id, child).at).toBeNull();
  expect(tasks.stepsForParent(f.id).map(t => t.id)).toEqual([child]);
  expect(run(f.id).stepCount).toBe(1);
});

test('scheduler recovery: targeted retry leaves a sibling evidence hold and pending step cap untouched', async () => {
  const f = await fixture();
  fault('database is locked');
  await startTask(f.id);
  db.exec('DROP TRIGGER scheduler_launch_fault');
  const heldRun = run(f.id), target = heldRun.active[0]!.taskId;
  const owner = newStep({ name: 'Owner evidence', agentProfileId: f.profile.id });
  heldRun.snapshot!.graph.steps.push(owner);
  const sibling = tasks.insert({ ...tasks.get(target)!, id: randomUUID(), title: 'Owner evidence', column: 'blocked', pipelineStepId: owner.id });
  heldRun.active.push({ taskId: sibling.id, stepId: owner.id, seq: 2 });
  const hold = { ...structuredClone(heldRun.history[0]!), taskId: sibling.id, stepId: owner.id, seq: 2,
    handoff: { schemaVersion: 1 as const, purpose: 'Complete the issue', status: 'blocked' as const, summary: 'Authorized evidence required', reason: 'Owner must supply the authorized non-admin reference run',
      next: null, openQuestions: ['Can the owner supply that authorized reference run?'], artifacts: [], waitingOn: { on: 'owner' as const, ref: 'authorized non-admin run' } } };
  heldRun.history.push(hold);
  heldRun.stepCount = 2;
  heldRun.snapshot!.maxSteps = 2;
  const ownerBlock = { taskId: sibling.id, stepId: owner.id, kind: 'step-blocked' as const, message: hold.handoff.reason };
  const cap = { taskId: null, stepId: f.step.id, kind: 'step-cap' as const, message: 'step cap exhausted', pending: { stepId: f.step.id, arrivals: [] } };
  heldRun.blocked.push(ownerBlock, cap);
  tasks.setPipelineRun(f.id, heldRun);
  const at = heldRun.launchRetries![target]!.at!;
  expect(await Promise.all([fireLaunchRetry(f.id, target, at), fireLaunchRetry(f.id, target, at)])).toEqual([true, false]);
  await retryPipelineStep(f.id, { taskId: target });
  await waitFor(() => run(f.id).history[0]!.outcome === 'succeeded');
  expect(run(f.id).history[1]).toEqual(hold);
  expect(run(f.id).blocked).toEqual([ownerBlock, cap]);
  expect(run(f.id).capExtensions ?? 0).toBe(0);
  expect(run(f.id).stepCount).toBe(2);
  expect(runs.listForTask(target)).toHaveLength(1);
  expect(runs.listForTask(sibling.id)).toHaveLength(0);
  expect(tasks.stepsForParent(f.id)).toHaveLength(2);
});

test('scheduler recovery: a never-started opted-in child recovers after boot, and repeated reconciliation is idempotent', async () => {
  const f = await fixture();
  fault('fixture interrupted launch');
  await startTask(f.id);
  db.exec('DROP TRIGGER scheduler_launch_fault');
  const interrupted = run(f.id);
  const child = interrupted.active[0]!.taskId;
  interrupted.blocked = [];
  interrupted.status = 'running';
  tasks.setPipelineRun(f.id, interrupted);
  await reconcilePipelineRuns();
  const first = launchRetry(f.id, child);
  await reconcilePipelineRuns();
  expect(launchRetry(f.id, child)).toEqual(first);
  expect(first.attempt).toBe(1);
  expect(run(f.id).blocked[0]!.message).toContain('never started');
  expect(await fireLaunchRetry(f.id, child, first.at!)).toBe(true);
  await done(f.id);
  expect(tasks.stepsForParent(f.id).map(t => t.id)).toEqual([child]);
  expect(run(f.id).history).toHaveLength(1);
});

test('scheduler recovery: boot preserves non-opted-in, owner, configuration, stopped and cancelled-retry holds', async () => {
  for (const kind of ['non-opted-in', 'owner', 'configuration', 'stopped', 'cancelled-retry']) {
    const f = await fixture('done', kind !== 'non-opted-in');
    fault('fixture interrupted launch');
    await startTask(f.id);
    db.exec('DROP TRIGGER scheduler_launch_fault');
    const held = run(f.id), child = held.active[0]!.taskId;
    held.blocked = kind === 'owner' ? [{ taskId: child, stepId: f.step.id, kind: 'step-blocked', message: 'Owner must supply authorized standard-user evidence' }]
      : kind === 'configuration' ? [{ taskId: child, stepId: f.step.id, kind: 'step-failed', message: 'required agent profile is missing' }] : [];
    if (kind === 'stopped') held.status = 'cancelled';
    if (kind === 'cancelled-retry') held.autoRetry = { stepId: f.step.id, kind: 'transient', attempt: 1, at: null, reason: 'user stopped retry' };
    tasks.setPipelineRun(f.id, held);
    await reconcilePipelineRuns();
    expect(run(f.id).autoRetry?.at ?? null).toBeNull();
    expect(run(f.id).launchRetries?.[child]?.at ?? null).toBeNull();
    expect(runs.listForTask(child)).toHaveLength(0);
    if (kind === 'owner' || kind === 'configuration') expect(run(f.id).blocked).toEqual(held.blocked);
  }
});

test('scheduler recovery: an existing child refused by capacity queues, survives boot, and resumes without another child', async () => {
  const f = await fixture();
  fault('waiting for a slot — 8 of 8 card owners busy');
  await startTask(f.id);
  const child = run(f.id).active[0]!.taskId;
  expect(run(f.id).blocked[0]!.kind).toBe('slot-wait');
  expect(run(f.id).status).toBe('running');
  // Simulate the exact earlier-build persisted classification.
  const legacy = run(f.id); legacy.blocked[0]!.kind = 'step-failed'; legacy.status = 'blocked';
  tasks.setPipelineRun(f.id, legacy);
  await reconcilePipelineRuns();
  expect(run(f.id).blocked[0]!.kind).toBe('slot-wait');
  expect(await releaseSlotWaits()).toBe(0);
  expect(tasks.stepsForParent(f.id)).toHaveLength(1);
  db.exec('DROP TRIGGER scheduler_launch_fault');
  expect(await releaseSlotWaits()).toBe(1);
  await done(f.id);
  expect(await releaseSlotWaits()).toBe(0);
  expect(tasks.stepsForParent(f.id).map(t => t.id)).toEqual([child]);
  expect(run(f.id).stepCount).toBe(1);
  expect(run(f.id).history).toHaveLength(1);
});

test('scheduler recovery: Stop cancels a queued existing child and boot never relaunches it', async () => {
  const f = await fixture();
  fault('waiting for a slot — 8 of 8 card owners busy');
  await startTask(f.id);
  db.exec('DROP TRIGGER scheduler_launch_fault');
  const child = run(f.id).active[0]!.taskId;
  expect(await cancelPipelineRun(f.id)).toHaveProperty('task');
  expect(run(f.id).status).toBe('cancelled');
  await reconcilePipelineRuns();
  expect(await releaseSlotWaits()).toBe(0);
  expect(runs.listForTask(child)).toHaveLength(0);
});

test('scheduler recovery: a handoff reminder queues for heavy capacity and delivers once without rerunning completed work', async () => {
  const f = await fixture('missing-then-done', true, 'Finish');
  __forTest.setListenerEnabled(false);
  await startTask(f.id);
  const child = run(f.id).active[0]!.taskId;
  const original = await waitFor(() => { const r = runs.listForTask(child)[0]; return r?.status === 'succeeded' ? r : null; });
  await waitFor(() => !isTaskRunLive(child));
  fault('waiting for a verification slot — 2 of 2 in use');
  await __forTest.handleRunStatus(child, original.id, 'succeeded');
  expect(run(f.id).blocked[0]!.kind).toBe('slot-wait');
  expect(run(f.id).history[0]!.reminder).toMatchObject({ runId: original.id, delivered: false });
  expect(await releaseSlotWaits()).toBe(0);
  db.exec('DROP TRIGGER scheduler_launch_fault');
  __forTest.setListenerEnabled(true);
  await releaseSlotWaits();
  await done(f.id);
  expect(run(f.id).history[0]!.reminder!.delivered).toBe(true);
  expect(tasks.stepsForParent(f.id).map(t => t.id)).toEqual([child]);
  expect(run(f.id).stepCount).toBe(1);
  const runCount = runs.listForTask(child).length;
  await releaseSlotWaits();
  expect(runs.listForTask(child)).toHaveLength(runCount);
});

test('scheduler recovery: completed Review routes downstream owner-only context to Build but explicit evidence questions remain held', async () => {
  for (const held of [false, true]) {
    const f = await fixture('missing');
    mkdirSync(join(f.wd, '.github/scripts'), { recursive: true });
    writeFileSync(join(f.wd, '.github/scripts/verify_changed.py'), '# managed fixture');
    const review = newStep({ name: 'Review', transition: 'choose', agentProfileId: f.profile.id, instructions: `${marker}:missing` });
    const build = newStep({ name: 'Build', agentProfileId: f.profile.id, instructions: `${marker}:done` });
    const finish = newStep({ name: 'Finish', agentProfileId: f.profile.id, instructions: `${marker}:done` });
    pipelines.update(tasks.get(f.id)!.pipelineId!, { graph: { steps: [review, build, finish], startStepId: review.id,
      edges: [{ id: 'repair', from: review.id, to: build.id, label: 'changes requested' }, { id: 'approved', from: review.id, to: finish.id, label: 'approved' }] }, maxSteps: 3 });
    __forTest.setListenerEnabled(false);
    await startTask(f.id);
    const child = run(f.id).active[0]!.taskId;
    const original = await waitFor(() => { const r = runs.listForTask(child)[0]; return r?.status === 'succeeded' ? r : null; });
    const verdict = { schemaVersion: 1, status: 'done', next: 'Build', artifacts: [],
      summary: 'Changes requested: R1 incomplete acceptance. Conditional owner-only inputs truthfully missing; zero support claimed. No approval granted.',
      reason: 'These are demonstrated defects, not owner decisions. Preserve truthful missing inputs; owner-only receipts remain assigned downstream.',
      openQuestions: held ? ['Can the owner supply the authorized non-admin reference run?'] : [] };
    runs.appendEvent(original.id, 'assistant', '<handoff>' + JSON.stringify(verdict) + '</handoff>');
    await __forTest.handleRunStatus(child, original.id, 'succeeded');
    __forTest.setListenerEnabled(true);
    if (held) {
      expect(run(f.id).status).toBe('blocked');
      expect(tasks.stepsForParent(f.id)).toHaveLength(1);
      expect(run(f.id).history[0]!.handoff!.openQuestions).toEqual(verdict.openQuestions);
    } else {
      await done(f.id);
      expect(run(f.id).history.map(h => h.stepId)).toEqual([review.id, build.id]);
      expect(run(f.id).history[0]!.handoff!.summary).toBe(verdict.summary);
      expect(run(f.id).history[0]!.nextStepIds).toEqual([build.id]);
      expect(tasks.stepsForParent(f.id).some(t => t.pipelineStepId === finish.id)).toBe(false);
    }
  }
});

test('SR1: parallel database launch failures retain independent child retries and stopped/exhausted budgets', async () => {
  for (const disposition of ['recover both', 'recover concurrently', 'first stopped', 'first exhausted']) {
    const f = await fixture();
    const understand = newStep({ name: 'Understand', transition: 'all', agentProfileId: f.profile.id, instructions: `${marker}:done` });
    const one = newStep({ name: 'Build one', agentProfileId: f.profile.id, instructions: `${marker}:done` });
    const two = newStep({ name: 'Build two', agentProfileId: f.profile.id, instructions: `${marker}:done` });
    pipelines.update(tasks.get(f.id)!.pipelineId!, { graph: { steps: [understand, one, two], startStepId: understand.id,
      edges: [{ id: randomUUID(), from: understand.id, to: one.id, label: '' }, { id: randomUUID(), from: understand.id, to: two.id, label: '' }] } });
    process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS = '120';
    await startTask(f.id);
    fault('database is locked');
    await waitFor(() => run(f.id).blocked.length === 2 ? run(f.id) : null);
    const before = run(f.id), children = before.active.map(a => a.taskId);
    expect(before.stepCount).toBe(3);
    expect(Object.keys(before.launchRetries!)).toEqual(children);
    db.exec('DROP TRIGGER scheduler_launch_fault');
    stopPipelineAutoRetryTimers();
    expect((await import('./pipeline-runner.ts')).rearmPipelineAutoRetries()).toBe(2);
    stopPipelineAutoRetryTimers();
    if (disposition.startsWith('recover')) {
      if (disposition === 'recover both') {
        const first = children[0]!, second = children[1]!;
        expect(await fireLaunchRetry(f.id, first, before.launchRetries![first]!.at!)).toBe(true);
        await waitFor(() => run(f.id).history.find(h => h.taskId === first)?.outcome === 'succeeded');
        expect(launchRetry(f.id, second)).toEqual(before.launchRetries![second]!);
        expect(await fireLaunchRetry(f.id, second, before.launchRetries![second]!.at!)).toBe(true);
      } else {
        const results = await Promise.all(children.map(id => fireLaunchRetry(f.id, id, before.launchRetries![id]!.at!)));
        expect(results).toEqual([true, true]);
      }
      await done(f.id);
      expect(Object.keys(run(f.id).launchRetries ?? {})).toHaveLength(0);
      expect(run(f.id).history.map(h => h.outcome)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    } else {
      const first = children[0]!, second = children[1]!;
      const stopped = { ...before.launchRetries![first]!, at: null, attempt: disposition === 'first exhausted' ? 5 : 1 };
      before.launchRetries![first] = stopped;
      tasks.setPipelineRun(f.id, before);
      expect(await fireLaunchRetry(f.id, second, before.launchRetries![second]!.at!)).toBe(true);
      await waitFor(() => run(f.id).history.find(h => h.taskId === second)?.outcome === 'succeeded');
      await reconcilePipelineRuns();
      expect(launchRetry(f.id, first)).toEqual(stopped);
      expect(runs.listForTask(first)).toHaveLength(0);
      expect(run(f.id).active.map(a => a.taskId)).toEqual([first]);
    }
    expect(tasks.stepsForParent(f.id)).toHaveLength(3);
    expect(run(f.id).stepCount).toBe(3);
    for (const id of children) expect(runs.listForTask(id).length).toBeLessThanOrEqual(1);
  }
});

test('SR1: whole-card Stop cancels every pending launch retry without reviving another branch at boot', async () => {
  const f = await fixture();
  const understand = newStep({ name: 'Understand', transition: 'all', agentProfileId: f.profile.id, instructions: `${marker}:done` });
  const one = newStep({ name: 'Build one', agentProfileId: f.profile.id, instructions: `${marker}:done` });
  const two = newStep({ name: 'Build two', agentProfileId: f.profile.id, instructions: `${marker}:done` });
  pipelines.update(tasks.get(f.id)!.pipelineId!, { graph: { steps: [understand, one, two], startStepId: understand.id,
    edges: [{ id: randomUUID(), from: understand.id, to: one.id, label: '' }, { id: randomUUID(), from: understand.id, to: two.id, label: '' }] } });
  process.env.AGETOR_FAKE_CLAUDE_RESOLVE_DELAY_MS = '120';
  await startTask(f.id);
  fault('database is locked');
  await waitFor(() => run(f.id).blocked.length === 2);
  db.exec('DROP TRIGGER scheduler_launch_fault');
  const children = run(f.id).active.map(a => ({ id: a.taskId, at: launchRetry(f.id, a.taskId).at! }));
  expect(await cancelPipelineRun(f.id)).toHaveProperty('task');
  await reconcilePipelineRuns();
  for (const child of children) {
    expect(launchRetry(f.id, child.id).at).toBeNull();
    expect(await fireLaunchRetry(f.id, child.id, child.at)).toBe(false);
    expect(runs.listForTask(child.id)).toHaveLength(0);
  }
});

test('SR2: stale queued formatting note yields to the exact newer completed, held or live turn', async () => {
  for (const recovery of ['boot', 'slot-loop']) for (const result of ['done', 'owner hold', 'live']) {
    const f = await fixture('missing-then-done', true, 'Finish');
    __forTest.setListenerEnabled(false);
    await startTask(f.id);
    const child = run(f.id).active[0]!.taskId;
    const original = await waitFor(() => { const r = runs.listForTask(child)[0]; return r?.status === 'succeeded' ? r : null; });
    await waitFor(() => !isTaskRunLive(child));
    fault('waiting for a verification slot — 2 of 2 in use');
    await __forTest.handleRunStatus(child, original.id, 'succeeded');
    expect(run(f.id).history[0]!.reminder).toMatchObject({ runId: original.id, delivered: false });
    db.exec('DROP TRIGGER scheduler_launch_fault');
    const newer = randomUUID();
    runs.insert({ ...original, id: newer, status: result === 'live' ? 'running' : 'succeeded', startedAt: Date.now(), endedAt: result === 'live' ? null : Date.now(), exitCode: result === 'live' ? null : 0 });
    tasks.update(child, { runId: newer, column: result === 'live' ? 'running' : 'review' });
    const handoff = { schemaVersion: 1, purpose: 'Complete the issue', status: result === 'owner hold' ? 'blocked' : 'done',
      summary: 'Completed after manual follow-up', reason: result === 'owner hold' ? 'Owner must supply authorized evidence' : 'Ordinary completed fixture',
      next: null, openQuestions: result === 'owner hold' ? ['Can the owner supply the authorized reference run?'] : [], artifacts: [] };
    if (result !== 'live') runs.appendEvent(newer, 'assistant', '<handoff>' + JSON.stringify(handoff) + '</handoff>');
    __forTest.setListenerEnabled(true);
    if (recovery === 'boot') await reconcilePipelineRuns();
    await releaseSlotWaits();
    expect(tasks.get(child)!.runId).toBe(newer);
    expect(runs.listForTask(child)).toHaveLength(2);
    expect(run(f.id).history[0]!.reminder ?? null).toBeNull();
    expect(run(f.id).blocked.some(b => b.kind === 'slot-wait')).toBe(false);
    if (result === 'done') {
      expect(run(f.id).status).toBe('done');
      expect(run(f.id).history[0]!.handoff!.summary).toBe(handoff.summary);
    } else if (result === 'owner hold') {
      expect(run(f.id).status).toBe('blocked');
      expect(run(f.id).history[0]!.handoff!.openQuestions).toEqual(handoff.openQuestions);
    } else {
      expect(run(f.id).status).toBe('running');
      expect(runs.get(newer)!.status).toBe('running');
      runs.update(newer, { status: 'cancelled', endedAt: Date.now() });
    }
  }
});
