// D-entry condition 2, proven: parallel sessionless media calls overlap safely,
// and the revision guard that C accepted stays exactly as strict as it was.
//
// `npx tsx server/media-job-concurrency.verify.ts`
//
// Two independent claims, because they can break independently:
//
//   1. start_job / poll_job are sessionless, so several of them may be in flight
//      for the same project at once. Nothing about them is pinned to a revision:
//      a queued sessionless call is REBASED onto the revision the editor reports,
//      which is what lets a poll survive an autosave landing mid-flight.
//   2. A session-pinned call (apply_artifact) is not rebased. If a second pinned
//      call is queued while a first is in flight and the editor advances its
//      revision, the queued one is refused 'stale' — the C-accepted contract
//      (verifyOldRevisionMutation). A D slice must not widen it.
//
// The job module is exercised in the same run so the two guarantees are not
// proven in isolation from the thing they exist to protect: parallel starts
// produce parallel job ids and still serialize at concurrency 1.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolateVerifyHome } from '../shared/verify-home.ts';

const fixture = await mkdtemp(join(tmpdir(), 'vidlab-media-job-concurrency-'));
const restoreHome = isolateVerifyHome(join(fixture, 'home'));
process.env.OPENCHATCUT_DATA_DIR = join(fixture, 'vidlab-data');
// Imported after the redirect: the artifact placement is derived from the active
// runtime profile, which resolves once at module load.
const { MediaJobQueue } = await import('./media-job.ts');
const {
  editorBinding,
  ExternalEditorCallError,
  invokeEditorTool,
  nextEditorCall,
  pendingEditorCallsForTest,
  registerEditor,
  resetExternalAgentBrokerForTest,
  settleEditorCall,
} = await import('./external-agent/broker.ts');
const { startSleepMediaJob } = await import('./media-job-synthetic-engine.ts');

const GIB = 1024 ** 3;
const ROOMY = (): number => 8 * GIB;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

const projectId = 'project-d1a-concurrency';
const editorId = 'editor-concurrency';
const revisionV1 = 'v1-project-d1a-c';
const revisionV2 = 'v2-project-d1a-c';
const tools = [{
  name: 'apply_artifact',
  input_schema: { type: 'object' as const, properties: {} },
}];

function hasOutcome(outcome: string): (error: unknown) => boolean {
  return (error) => error instanceof ExternalEditorCallError && error.outcome === outcome;
}

try {
  // ── 1. parallel sessionless calls overlap, and are rebased, not refused ────
  resetExternalAgentBrokerForTest();
  const capability = registerEditor(projectId, editorId, revisionV1, tools);
  const bindingV1 = editorBinding(projectId);
  assert.ok(bindingV1);

  const parallel = Array.from({ length: 3 }, (_, index) => (
    invokeEditorTool(`owner-parallel-${index}`, bindingV1, 'poll_job', { jobId: `job_${index}` })
  ));
  const dispatched: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const call = await nextEditorCall(projectId, editorId, revisionV1, new AbortController().signal, capability);
    assert.ok(call, `parallel call ${index} dispatches`);
    assert.equal(call.name, 'poll_job');
    dispatched.push(call.id);
  }
  assert.equal(new Set(dispatched).size, 3, 'three sessionless calls are in flight at the same time');
  assert.equal(pendingEditorCallsForTest().length, 3, 'none of them blocked the others');
  for (const [index, id] of dispatched.entries()) {
    assert.equal(settleEditorCall(id, 'applied', { ok: true, jobId: `job_${index}` }, capability), true);
  }
  const parallelResults = await Promise.all(parallel) as Array<{ jobId?: string }>;
  assert.deepEqual(
    parallelResults.map((result) => result.jobId),
    ['job_0', 'job_1', 'job_2'],
    'every parallel call gets its own result back',
  );

  // A sessionless call INVOKED with a stale binding (the caller cached the old
  // one) is adopted onto the revision the editor reports instead of refused: it
  // carries no revision to be pinned to. This is the pre-existing adopt path for
  // calls without edit-session ownership, and it is what makes a poll safe to
  // re-issue after an autosave landed.
  const capabilityV2 = registerEditor(projectId, editorId, revisionV2, tools, undefined, capability);
  assert.equal(editorBinding(projectId)?.baseRevision, revisionV2);
  const rebased = invokeEditorTool('owner-rebased', bindingV1, 'poll_job', { jobId: 'job_rebased' });
  const rebasedCall = await nextEditorCall(projectId, editorId, revisionV2, new AbortController().signal, capabilityV2);
  assert.ok(rebasedCall, 'a sessionless call with a stale binding is dispatched, not refused');
  assert.equal(rebasedCall.name, 'poll_job');
  assert.equal(rebasedCall.binding.baseRevision, revisionV2, 'and it is rebased onto the current revision');
  assert.equal(settleEditorCall(rebasedCall.id, 'applied', { ok: true, jobId: 'job_rebased' }, capabilityV2), true);
  assert.deepEqual(await rebased, { ok: true, jobId: 'job_rebased' });

  // ── 2. a session-pinned call stays pinned: queued behind an in-flight one ──
  resetExternalAgentBrokerForTest();
  const pinnedProject = 'project-d1a-pinned';
  const pinnedSession = 'edit-session-d1a-pinned';
  const pinnedCapability = registerEditor(pinnedProject, editorId, revisionV1, tools);
  const pinnedBinding = editorBinding(pinnedProject);
  assert.ok(pinnedBinding);
  const begin = invokeEditorTool('owner-pinned', pinnedBinding, 'begin_edit_session', { approvalMode: 'manual' });
  const beginCall = await nextEditorCall(pinnedProject, editorId, revisionV1, new AbortController().signal, pinnedCapability);
  assert.ok(beginCall);
  assert.equal(settleEditorCall(beginCall.id, 'applied', { editSessionId: pinnedSession, status: 'drafting' }, pinnedCapability), true);
  assert.equal((await begin as { editSessionId?: string }).editSessionId, pinnedSession);

  // First pinned call: dispatched, in flight, not settled.
  const firstApply = invokeEditorTool('owner-pinned', pinnedBinding, 'apply_artifact', {
    itemId: 'item_clip_001',
    jobId: 'job_first',
    editSessionId: pinnedSession,
  }).then(() => null, (error: unknown) => error);
  const firstCall = await nextEditorCall(pinnedProject, editorId, revisionV1, new AbortController().signal, pinnedCapability);
  assert.ok(firstCall);
  assert.equal(firstCall.name, 'apply_artifact');

  // Second pinned call: queued behind it.
  const secondApply = invokeEditorTool('owner-pinned', pinnedBinding, 'apply_artifact', {
    itemId: 'item_clip_002',
    jobId: 'job_second',
    editSessionId: pinnedSession,
  }).then(() => null, (error: unknown) => error);
  assert.equal(pendingEditorCallsForTest('owner-pinned').length, 2, 'one in flight, one queued');

  // The revision advances while the first call is still in flight.
  const pinnedCapabilityV2 = registerEditor(pinnedProject, editorId, revisionV2, tools, undefined, pinnedCapability);
  assert.equal(editorBinding(pinnedProject)?.baseRevision, revisionV2);

  // Both pending calls are refused 'stale' — the in-flight one and the queued
  // one. That is the C-accepted contract: a revision advance cancels every call
  // pinned to the old revision rather than letting it land against a document
  // that moved. Nothing is dispatched at the new revision.
  const firstOutcome = await firstApply;
  const secondOutcome = await secondApply;
  assert.ok(firstOutcome instanceof ExternalEditorCallError, 'the in-flight pinned call is refused');
  assert.equal(firstOutcome.outcome, 'stale');
  assert.ok(secondOutcome instanceof ExternalEditorCallError, 'the queued pinned call is refused');
  assert.equal(secondOutcome.outcome, 'stale');
  assert.equal(pendingEditorCallsForTest('owner-pinned').length, 0, 'no pinned call survives the revision advance');
  const staleCall = await nextEditorCall(pinnedProject, editorId, revisionV2, AbortSignal.timeout(200), pinnedCapabilityV2);
  assert.equal(staleCall, null, 'a stale pinned call is never dispatched at the new revision');

  // And it stays refused on a re-invoke: the pin is the session, not the queue.
  assert.throws(
    () => invokeEditorTool('owner-pinned', pinnedBinding, 'apply_artifact', {
      itemId: 'item_clip_003',
      jobId: 'job_third',
      editSessionId: pinnedSession,
    }),
    hasOutcome('stale'),
    'a re-invoked pinned call from the stale binding is still refused',
  );
  // The contrast, in one place: the same stale binding still adopts a sessionless
  // call, so the refusal above is the session pin and not a blanket ban.
  const adoptedPoll = invokeEditorTool('owner-pinned', pinnedBinding, 'poll_job', { jobId: 'job_adopted' });
  const adoptedCall = await nextEditorCall(pinnedProject, editorId, revisionV2, new AbortController().signal, pinnedCapabilityV2);
  assert.ok(adoptedCall, 'a sessionless call with the same stale binding is adopted');
  assert.equal(adoptedCall.name, 'poll_job');
  assert.equal(settleEditorCall(adoptedCall.id, 'applied', { ok: true, jobId: 'job_adopted' }, pinnedCapabilityV2), true);
  assert.deepEqual(await adoptedPoll, { ok: true, jobId: 'job_adopted' });

  // ── 3. the job module under parallel starts: distinct ids, serialized ──────
  const queue = new MediaJobQueue({ concurrency: 1, freeMemoryBytes: ROOMY });
  const starts = ['a.mov', 'b.mov', 'c.mov'].map((sourceName) => (
    startSleepMediaJob({ sourceName, steps: 3, stepMs: 60 }, queue)
  ));
  assert.equal(new Set(starts.map((start) => start.jobId)).size, 3, 'parallel starts get distinct job ids');
  assert.equal(starts.every((start) => start.deduped === false), true);

  let maxRunning = 0;
  const deadline = Date.now() + 30_000;
  for (;;) {
    const snapshots = starts.map((start) => queue.poll(start.jobId)!);
    maxRunning = Math.max(maxRunning, snapshots.filter((snapshot) => snapshot.status === 'running').length);
    if (snapshots.every((snapshot) => snapshot.status === 'completed')) break;
    if (Date.now() > deadline) throw new Error(`parallel jobs never finished: ${JSON.stringify(snapshots)}`);
    await sleep(20);
  }
  assert.equal(maxRunning, 1, 'parallel starts still serialize at concurrency 1');
  for (const start of starts) {
    const snapshot = queue.poll(start.jobId)!;
    assert.ok(snapshot.artifact, `job ${start.jobId} produced its artifact`);
  }

  console.log('media-job concurrency: sessionless calls overlap, pinned calls stay strict, jobs serialize: OK');
} finally {
  restoreHome();
  await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
}
