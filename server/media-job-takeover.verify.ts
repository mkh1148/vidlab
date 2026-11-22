// D-entry condition 3, proven: a D job holds NO project ownership, so a second
// client taking the edit session over mid-job cannot affect it — and the stale
// session cannot smuggle its result onto the timeline afterwards.
//
// `npx tsx server/media-job-takeover.verify.ts`
//
// The sequence is the contract's own sentence:
//
//   "a second client takes the session over while a D job runs — the job is
//    unaffected (media op); a later apply from the stale session is refused."
//
// plus the half the contract implies: a FRESH apply, from the session that now
// owns the editor, still succeeds. If the artifact could only be applied by the
// client that started the job, the sessionless design would be pointless.
//
// The broker harness is in-process (no browser, no MCP transport): the same
// registry, ownership registry and revision guards the real bridge uses.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolateVerifyHome } from '../shared/verify-home.ts';
import type { MediaJobSnapshot } from './media-job.ts';

const fixture = await mkdtemp(join(tmpdir(), 'vidlab-media-job-takeover-'));
const restoreHome = isolateVerifyHome(join(fixture, 'home'));
process.env.OPENCHATCUT_DATA_DIR = join(fixture, 'vidlab-data');
// Everything below is imported AFTER the redirect. server/runtime-profile.ts
// resolves the active profile once, at module load, and the artifact placement is
// derived from it — a static import of the broker would pull the profile in
// first and write the artifact into the checkout's public/media.
const { MediaJobQueue } = await import('./media-job.ts');
const {
  editorBinding,
  ExternalEditorCallError,
  invokeEditorTool,
  nextEditorCall,
  orphanStaleEditorSessions,
  pendingEditorCallsForTest,
  registerEditor,
  resetExternalAgentBrokerForTest,
  settleEditorCall,
} = await import('./external-agent/broker.ts');
const { startSleepMediaJob } = await import('./media-job-synthetic-engine.ts');

const GIB = 1024 ** 3;
const ROOMY = (): number => 8 * GIB;

const projectId = 'project-d1a-takeover';
const editorA = 'editor-window-a';
const editorB = 'editor-window-b';
const revisionA = 'v1-project-d1a';
const revisionB = 'v2-project-d1a';
const editSessionA = 'edit-session-d1a-a';
const editSessionB = 'edit-session-d1a-b';
const tools = [{
  name: 'apply_artifact',
  input_schema: { type: 'object' as const, properties: {} },
}];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

function hasOutcome(outcome: string): (error: unknown) => boolean {
  return (error) => error instanceof ExternalEditorCallError && error.outcome === outcome;
}

async function waitForJob(
  queue: InstanceType<typeof MediaJobQueue>,
  jobId: string,
  predicate: (snapshot: MediaJobSnapshot) => boolean,
  timeoutMs = 30_000,
): Promise<MediaJobSnapshot> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = queue.poll(jobId);
    assert.ok(snapshot, `job ${jobId} stays pollable`);
    if (predicate(snapshot)) return snapshot;
    if (Date.now() > deadline) throw new Error(`job never settled: ${JSON.stringify(snapshot)}`);
    await sleep(20);
  }
}

try {
  resetExternalAgentBrokerForTest();

  // ── client A connects at v1 and opens an edit session ─────────────────────
  const capabilityA = registerEditor(projectId, editorA, revisionA, tools);
  const bindingA = editorBinding(projectId);
  assert.ok(bindingA);
  const beginA = invokeEditorTool('owner-a', bindingA, 'begin_edit_session', { approvalMode: 'manual' });
  const beginCallA = await nextEditorCall(projectId, editorA, revisionA, new AbortController().signal, capabilityA);
  assert.ok(beginCallA);
  assert.equal(settleEditorCall(beginCallA.id, 'applied', { editSessionId: editSessionA, status: 'drafting' }, capabilityA), true);
  const sessionAResult = await beginA as { editSessionId?: string };
  assert.equal(sessionAResult.editSessionId, editSessionA);

  // ── a long D job starts. It is a media op: no edit session, no ownership ──
  const queue = new MediaJobQueue({ concurrency: 1, freeMemoryBytes: ROOMY });
  const started = startSleepMediaJob({ sourceName: 'takeover.mov', steps: 10, stepMs: 120 }, queue);
  const running = await waitForJob(queue, started.jobId, (snapshot) => snapshot.status === 'running' && snapshot.progress > 0);
  assert.equal(
    pendingEditorCallsForTest().length,
    0,
    'the job is not a browser-bridge call: nothing is queued for the editor while it runs',
  );

  // ── client B takes the project over at v2, mid-job ────────────────────────
  const capabilityB = registerEditor(projectId, editorB, revisionB, tools);
  const bindingB = editorBinding(projectId);
  assert.ok(bindingB);
  assert.equal(bindingB.baseRevision, revisionB);
  assert.equal(editorBinding(projectId)?.editorInstanceId, editorB, 'the takeover replaced the editor binding');

  // ── the job is UNAFFECTED: still progressing, and it still lands ──────────
  const afterTakeover = queue.poll(started.jobId);
  assert.ok(afterTakeover);
  assert.equal(afterTakeover.status, 'running', 'taking the edit session over does not touch a running media job');
  assert.ok(
    afterTakeover.progress >= running.progress,
    'progress keeps moving after the takeover (the job never went backwards or stopped)',
  );
  const completed = await waitForJob(queue, started.jobId, (snapshot) => snapshot.status === 'completed');
  assert.equal(completed.code, null);
  assert.ok(completed.artifact, 'the artifact still lands');
  assert.equal(existsSync(completed.artifact!.file), true, 'the artifact file exists on disk');
  assert.ok((await stat(completed.artifact!.file)).size > 0, 'and it is non-empty');
  assert.equal(
    pendingEditorCallsForTest().length,
    0,
    'the job never became a pending editor call, before or after the takeover',
  );

  // ── a later apply from the STALE session is refused, strictly ─────────────
  // The session was opened on v1; the editor now reports v2. A session-pinned
  // call stays pinned to the revision its session was opened on — the exact
  // C-accepted strict behavior verifyOldRevisionMutation pins for mutations. A D
  // job must not smuggle a mutation past it, so no allowRevisionDrift widening.
  assert.throws(
    () => invokeEditorTool('owner-a', bindingA, 'apply_artifact', {
      itemId: 'item_clip_001',
      jobId: started.jobId,
      editSessionId: editSessionA,
    }),
    hasOutcome('stale'),
    'a stale session cannot apply an artifact',
  );
  assert.equal(
    pendingEditorCallsForTest('owner-a').length,
    0,
    'the refused apply never reaches the editor queue',
  );

  // Once the MCP layer notices the editor binding changed, the old transport's
  // session is orphaned: applying through it is refused outright, and the escape
  // hatch is recover_edit_session, not apply_artifact.
  orphanStaleEditorSessions('owner-a', bindingB);
  assert.throws(
    () => invokeEditorTool('owner-a', bindingA, 'apply_artifact', {
      itemId: 'item_clip_001',
      jobId: started.jobId,
      editSessionId: editSessionA,
    }),
    hasOutcome('rejected'),
    'an orphaned session cannot apply an artifact either',
  );

  // ── a fresh apply, from the session that now owns the editor, succeeds ────
  const beginB = invokeEditorTool('owner-b', bindingB, 'begin_edit_session', { approvalMode: 'manual' });
  const beginCallB = await nextEditorCall(projectId, editorB, revisionB, new AbortController().signal, capabilityB);
  assert.ok(beginCallB);
  assert.equal(settleEditorCall(beginCallB.id, 'applied', { editSessionId: editSessionB, status: 'drafting' }, capabilityB), true);
  assert.equal((await beginB as { editSessionId?: string }).editSessionId, editSessionB);

  const freshApply = invokeEditorTool('owner-b', bindingB, 'apply_artifact', {
    itemId: 'item_clip_001',
    jobId: started.jobId,
    editSessionId: editSessionB,
  });
  const applyCall = await nextEditorCall(projectId, editorB, revisionB, new AbortController().signal, capabilityB);
  assert.ok(applyCall, 'the fresh session dispatches the apply');
  assert.equal(applyCall.name, 'apply_artifact');
  assert.equal(settleEditorCall(applyCall.id, 'applied', { ok: true, derivedPictureSrc: completed.artifact!.url }, capabilityB), true);
  const applied = await freshApply as { ok?: boolean; derivedPictureSrc?: string };
  assert.equal(applied.ok, true);
  assert.equal(applied.derivedPictureSrc, completed.artifact!.url, 'the artifact applies after re-targeting');

  // ── the job record itself never carried a session ────────────────────────
  const snapshot = queue.poll(started.jobId)!;
  assert.equal('editSessionId' in snapshot, false, 'a job has no edit session field to go stale');
  assert.equal('ownerId' in snapshot, false, 'a job has no owner field to renew');

  // ── no allowRevisionDrift widening for apply_artifact ─────────────────────
  // The one tool allowed to drift is get_edit_session (a terminal status read
  // after the editor advanced its own revision). A same-editor revision advance
  // is the case where drift is legitimate, so it is the sharpest test: the read
  // still works, and the apply is still refused.
  resetExternalAgentBrokerForTest();
  const driftProject = 'project-d1a-drift';
  const driftSession = 'edit-session-d1a-drift';
  const driftCapability = registerEditor(driftProject, editorA, revisionA, tools);
  const driftBindingV1 = editorBinding(driftProject);
  assert.ok(driftBindingV1);
  const beginDrift = invokeEditorTool('owner-drift', driftBindingV1, 'begin_edit_session', { approvalMode: 'manual' });
  const beginDriftCall = await nextEditorCall(driftProject, editorA, revisionA, new AbortController().signal, driftCapability);
  assert.ok(beginDriftCall);
  assert.equal(settleEditorCall(beginDriftCall.id, 'applied', { editSessionId: driftSession, status: 'drafting' }, driftCapability), true);
  assert.equal((await beginDrift as { editSessionId?: string }).editSessionId, driftSession);

  // The same editor reports a new revision (an autosave landed).
  const driftCapabilityV2 = registerEditor(driftProject, editorA, revisionB, tools, undefined, driftCapability);
  assert.equal(driftCapabilityV2, driftCapability, 'a renewal keeps the live capability');
  assert.equal(editorBinding(driftProject)?.baseRevision, revisionB);

  const driftRead = invokeEditorTool('owner-drift', driftBindingV1, 'get_edit_session', { editSessionId: driftSession });
  const driftReadCall = await nextEditorCall(driftProject, editorA, revisionB, new AbortController().signal, driftCapabilityV2);
  assert.ok(driftReadCall, 'get_edit_session is still the one tool allowed to drift a revision');
  assert.equal(driftReadCall.name, 'get_edit_session');
  assert.equal(settleEditorCall(driftReadCall.id, 'applied', { editSessionId: driftSession, status: 'drafting' }, driftCapabilityV2), true);
  assert.equal((await driftRead as { editSessionId?: string }).editSessionId, driftSession);

  assert.throws(
    () => invokeEditorTool('owner-drift', driftBindingV1, 'apply_artifact', {
      itemId: 'item_clip_001',
      jobId: started.jobId,
      editSessionId: driftSession,
    }),
    hasOutcome('stale'),
    'apply_artifact is NOT in the drift allowance: a stale session cannot apply',
  );
  assert.equal(pendingEditorCallsForTest('owner-drift').length, 0);

  console.log('media-job takeover: job unaffected by takeover, stale apply refused, fresh apply succeeds: OK');
} finally {
  restoreHome();
  await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
}
