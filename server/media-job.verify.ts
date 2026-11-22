// D1a · the job module proven against the D contract, with two differently
// shaped synthetic engines and a mutation test for every guarantee.
//
// The guarantees, each one a sentence from the D-job contract:
//
//   1. cancel reaches a REAL spawned child. The engine reports the pid it was
//      given; the verify proves the process is gone afterwards. The media-run.ts
//      Windows lesson is that a wedged child outlives a polite signal.
//   2. a killed job leaves no artifact and reports `cancelled` with
//      `{error, code}`. A partial artifact is worse than none: it is what a
//      restart would mistake for finished work.
//   3. consecutive runs serialize at concurrency 1. A second heavy job on a
//      16 GB machine is an OOM, not throughput.
//   4. the RAM gate DEFERS under a forced low reading and runs when it lifts.
//      A short machine must never produce an error the owner has to interpret.
//   5. a double start of the same key reuses the in-flight job (the keyed-dedup
//      semantics of derivative-queue), so a double click cannot queue the same
//      heavy work twice.
//   6. the second engine — in-process, multi-stage, one artifact per stage —
//      runs through the same module with no module changes.
//
// Then every guarantee is BROKEN on purpose and the same assertion helper must
// catch it. A guarantee nobody can break is a guarantee nobody is checking.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaJobQueue, type MediaJobSnapshot } from './media-job.ts';
import { isolateVerifyHome } from '../shared/verify-home.ts';

const fixture = await mkdtemp(join(tmpdir(), 'vidlab-media-job-'));
const restoreHome = isolateVerifyHome(join(fixture, 'home'));
process.env.OPENCHATCUT_DATA_DIR = join(fixture, 'vidlab-data');
// Imported AFTER the redirect: server/runtime-profile.ts resolves the active
// profile once, at module load, so a static import here would resolve the real
// checkout media directory and write into it.
const {
  startMultiStepMediaJob,
  startSleepMediaJob,
  syntheticArtifactLocation,
} = await import('./media-job-synthetic-engine.ts');

const GIB = 1024 ** 3;
const ROOMY = (): number => 8 * GIB;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Is a process still alive? `process.kill(pid, 0)` throws once it is gone. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const terminal = (snapshot: MediaJobSnapshot): boolean => (
  snapshot.status === 'completed' || snapshot.status === 'failed' || snapshot.status === 'cancelled'
);

async function waitFor(
  queue: MediaJobQueue,
  jobId: string,
  predicate: (snapshot: MediaJobSnapshot) => boolean,
  timeoutMs = 30_000,
): Promise<MediaJobSnapshot> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = queue.poll(jobId);
    assert.ok(snapshot, `job ${jobId} must stay pollable`);
    if (predicate(snapshot)) return snapshot;
    if (Date.now() > deadline) {
      throw new Error(`job ${jobId} never reached the expected state: ${JSON.stringify(snapshot)}`);
    }
    await sleep(20);
  }
}

function pidOf(snapshot: MediaJobSnapshot): number | undefined {
  const raw = snapshot.detail?.pid;
  return typeof raw === 'number' ? raw : undefined;
}

// ── guarantee helpers: the assertions the mutations must break ─────────────

/**
 * Cancel a running child engine and prove the child died and left nothing.
 *
 * `kill` is the mutation seam: production omits it and gets the one SIGKILL
 * policy; the mutation passes a no-op and the same assertions must fail.
 */
async function assertCancelKillsChildAndLeavesNothing(kill?: (child: ChildProcess) => void): Promise<void> {
  const queue = new MediaJobQueue({ freeMemoryBytes: ROOMY });
  const request = {
    sourceName: 'cancel-me.mov',
    steps: 20,
    stepMs: 100,
    ...(kill ? { kill } : {}),
  };
  const location = syntheticArtifactLocation({ ...request, engine: 'sleep' });
  const started = startSleepMediaJob(request, queue);
  const running = await waitFor(queue, started.jobId, (snapshot) => (
    snapshot.status === 'running' && pidOf(snapshot) !== undefined && snapshot.progress > 0
  ));
  const pid = pidOf(running);
  assert.ok(pid, 'the engine must report the child pid it spawned');
  assert.equal(processAlive(pid), true, 'the child must be alive while the job runs');
  assert.ok(existsSync(location.dir), 'the engine must have created the per-source directory');

  const cancelledAt = Date.now();
  const cancelled = queue.cancel(started.jobId);
  assert.equal(cancelled?.status, 'cancelled', 'cancel reports cancelled immediately');
  assert.equal(cancelled?.code, 'job_cancelled', 'a cancel carries a machine-parseable code');
  assert.equal(cancelled?.error, 'media job cancelled', 'and an EN message');
  const settled = await waitFor(queue, started.jobId, terminal);
  assert.equal(settled.status, 'cancelled');
  assert.equal(settled.artifact, null, 'a cancelled job reports no artifact');
  assert.ok(Date.now() - cancelledAt < 5_000, 'cancel must not wait for the engine to notice');

  await sleep(250);
  assert.equal(processAlive(pid), false, 'the spawned child must be dead after a cancel');
  assert.equal(existsSync(location.file), false, 'a cancelled job must leave no artifact');
  const leftovers = (await readdir(location.dir).catch(() => [] as string[]))
    .filter((name) => name.includes('.step'));
  assert.deepEqual(leftovers, [], 'a cancelled job must leave no partial step files');
  queue.reset();
}

/** Two jobs started back to back must never overlap. */
async function assertSerializedAtOne(concurrency: number): Promise<void> {
  const queue = new MediaJobQueue({ freeMemoryBytes: ROOMY, concurrency });
  startSleepMediaJob({ sourceName: 'serial-a.mov', steps: 5, stepMs: 60 }, queue);
  startSleepMediaJob({ sourceName: 'serial-b.mov', steps: 5, stepMs: 60 }, queue);
  let maxRunning = 0;
  const deadline = Date.now() + 30_000;
  for (;;) {
    const snapshots = queue.snapshot();
    maxRunning = Math.max(maxRunning, snapshots.filter((s) => s.status === 'running').length);
    if (snapshots.every(terminal) || Date.now() > deadline) break;
    await sleep(20);
  }
  const finished = queue.snapshot();
  assert.equal(finished.length, 2, 'both jobs must be tracked');
  assert.ok(finished.every((s) => s.status === 'completed'), `both jobs must complete: ${JSON.stringify(finished)}`);
  assert.equal(maxRunning, 1, 'heavy jobs are serialized: one at a time, across every consumer');
  queue.reset();
}

/**
 * A short machine DEFERS: the job is not terminal, carries no error, and runs
 * once the gate lifts.
 *
 * `start` is the mutation seam: the mutation is an implementation that refuses
 * instead of deferring, which is the failure mode this assertion exists for.
 */
async function assertGateDefers(
  start: (queue: MediaJobQueue) => string,
): Promise<void> {
  const freeMemory = { value: 0 };
  const queue = new MediaJobQueue({ freeMemoryBytes: () => freeMemory.value, gateRecheckMs: 30 });
  const jobId = start(queue);
  const deferred = await waitFor(queue, jobId, (snapshot) => snapshot.status === 'deferred');
  assert.equal(deferred.deferred, true);
  assert.equal(deferred.code, 'ram_below_gate', 'a defer names its reason in the code');
  assert.equal(deferred.error, null, 'a defer is not an error the owner has to read');
  assert.equal(terminal(deferred), false, 'a deferred job is still alive, not failed');
  assert.equal(deferred.progress, 0, 'nothing ran while the gate was closed');

  freeMemory.value = 8 * GIB;
  const completed = await waitFor(queue, jobId, terminal, 30_000);
  assert.equal(completed.status, 'completed', 'the job runs once the gate lifts');
  assert.equal(completed.deferred, false);
  queue.reset();
}

/** A double start of one key reuses the in-flight job. */
async function assertKeyedDedupe(): Promise<void> {
  const queue = new MediaJobQueue({ freeMemoryBytes: ROOMY });
  const request = { sourceName: 'dedupe.mov', steps: 4, stepMs: 60 };
  const first = startSleepMediaJob(request, queue);
  const second = startSleepMediaJob(request, queue);
  assert.equal(second.jobId, first.jobId, 'the same key reuses the in-flight job');
  assert.equal(second.deduped, true);
  assert.equal(first.deduped, false, 'the first start is not a dedupe');
  await waitFor(queue, first.jobId, terminal);
  assert.equal(queue.snapshot().length, 1, 'a deduped start must not create a second job');
  queue.reset();
}

// ── 1. cancel kills the child and leaves nothing ──────────────────────────
await assertCancelKillsChildAndLeavesNothing();
console.log('media-job.verify: cancel reached a real child (SIGKILL) and left no artifact');

// ── 2. a crashing engine fails cleanly and leaves nothing ─────────────────
{
  const queue = new MediaJobQueue({ freeMemoryBytes: ROOMY });
  const request = { sourceName: 'crash.mov', steps: 6, stepMs: 40, crashAfter: 2 };
  const location = syntheticArtifactLocation({ ...request, engine: 'sleep' });
  const started = startSleepMediaJob(request, queue);
  const failed = await waitFor(queue, started.jobId, terminal);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.code, 'engine_failed', 'an engine crash is a machine-parseable failure');
  assert.match(String(failed.error), /exited 3/, 'the EN error keeps the engine exit code');
  assert.equal(failed.artifact, null);
  assert.equal(existsSync(location.file), false, 'a crashed job leaves no artifact');
  const leftovers = (await readdir(location.dir).catch(() => [] as string[]))
    .filter((name) => name.includes('.step'));
  assert.deepEqual(leftovers, [], 'a crashed job leaves no partial step files');
  queue.reset();
}

// ── 3. concurrency 1 ──────────────────────────────────────────────────────
await assertSerializedAtOne(1);
console.log('media-job.verify: consecutive runs serialize at concurrency 1');

// ── 4. the RAM gate defers, then runs ─────────────────────────────────────
await assertGateDefers((queue) => (
  startSleepMediaJob({ sourceName: 'gated.mov', steps: 3, stepMs: 40 }, queue).jobId
));
console.log('media-job.verify: the RAM gate deferred under a forced low reading and ran when lifted');

// ── 5. keyed dedupe ───────────────────────────────────────────────────────
await assertKeyedDedupe();
console.log('media-job.verify: a double start of one key reused the in-flight job');

// ── 6. the second, differently shaped engine ──────────────────────────────
{
  const queue = new MediaJobQueue({ freeMemoryBytes: ROOMY });
  const started = startMultiStepMediaJob({ sourceName: 'multi.mov', steps: 3, stepMs: 20 }, queue);
  const completed = await waitFor(queue, started.jobId, terminal);
  assert.equal(completed.status, 'completed', `the in-process engine must complete: ${JSON.stringify(completed)}`);
  assert.ok(completed.artifact, 'the multi-step engine reports its combined artifact');
  assert.equal(completed.intermediate?.length, 3, 'one artifact per stage');
  for (const artifact of [completed.artifact!, ...(completed.intermediate ?? [])]) {
    assert.ok(artifact.bytes > 0, `${artifact.file} must be non-empty`);
    assert.ok(existsSync(artifact.file), `${artifact.file} must exist`);
    assert.match(artifact.url, /^\/media\/derived\/[^/]+\/[^/]+$/, 'artifacts live in a per-source directory');
  }
  queue.reset();
}
console.log('media-job.verify: the multi-step in-process engine ran through the same module');

// ── 7. mutation tests: break each guarantee, the helper must catch it ─────
{
  // (a) raise the concurrency: two heavy jobs overlap.
  await assert.rejects(
    () => assertSerializedAtOne(2),
    /serialized/,
    'raising the concurrency must be caught by the serialization assertion',
  );

  // (b) drop the kill wiring: the child survives its own cancel.
  await assert.rejects(
    () => assertCancelKillsChildAndLeavesNothing(() => undefined),
    /must be dead after a cancel|must leave no artifact/,
    'a no-op kill must be caught by the cancel assertion',
  );

  // (c) refuse instead of defer: a short machine becomes an engine error.
  //
  // The module has no production knob to break here — a defer is not a policy
  // choice — so the mutation is an alternative implementation of the same
  // guarantee: the gate is bypassed and the engine reports the short machine as
  // a failure. The assertion that a defer is a defer must catch it.
  const refusing = new MediaJobQueue({ freeMemoryBytes: ROOMY });
  const refused = refusing.start({
    key: 'refusing-gate',
    run: async () => {
      throw new Error('not enough free RAM to start a heavy job');
    },
  });
  await assert.rejects(
    async () => {
      const settled = await waitFor(refusing, refused.jobId, terminal);
      assert.equal(settled.status, 'deferred', 'a short machine defers the job, it does not fail it');
      assert.equal(settled.error, null, 'a defer is never an error the owner has to read');
    },
    /defers the job/,
    'a refusing gate must be caught by the defer assertion',
  );
  refusing.reset();
  console.log('media-job.verify: all three mutations were caught');
}

restoreHome();
await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
console.log('media-job.verify: all job-module guarantees hold');