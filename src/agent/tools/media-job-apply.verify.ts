// D1a deliverable 4: the apply path, proven against a synthetic project and a
// synthetic artifact. `npx tsx src/agent/tools/media-job-apply.verify.ts`
//
// What this pins down:
//
//   * apply_artifact changes the clip's DERIVED reference and nothing else — the
//     original source stays exactly as it was (I4: the source is never replaced);
//   * undo restores the clip byte-exactly (one history step, snapshot restore);
//   * clear is the same operation as undo at the data level: it drops the
//     reference, so the clip returns to its original picture;
//   * an artifact that is not a completed job, or that is not exactly
//     `/media/derived/<sourceKey>/<name>`, is refused with {error, code} and
//     mutates nothing (reviewer condition C1: flat, traversal and deeper shapes);
//   * a deferred job is a WAIT, not an error (the RAM gate never refuses);
//   * D1b's `feature` argument routes every tool to the right mount, with
//     `background_removal` the default and `synthetic` still reachable.
//
// The revision-drift half of the contract (a stale session cannot apply) is
// proven at the broker in server/media-job-takeover.verify.ts, because the guard
// lives there, not in the tool.
import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../../shared/project-version';
import type { AgentContext } from '../context.ts';
import { activeEditorState, activeTimeline, type ProjectDoc } from '../../editor/types.ts';
import { historyReduce, type History } from '../../editor/reduce.ts';
import type { EditorCommands } from '../../editor/store.ts';
import { execMediaJobTool, MEDIA_JOB_TOOL_SCHEMAS } from './media-job-tools.ts';

const SYNTHETIC_MOUNT = '/api/media-job/synthetic';
const MATTING_MOUNT = '/api/media-job/background-removal';
const ARTIFACT_URL = '/media/derived/clip-1a2b3c4d/matte-r1-synthetic-v1.txt';
const ARTIFACT_FILE = 'G:/tmp/derived/clip-1a2b3c4d/matte-r1-synthetic-v1.txt';
const JOB_KEY = 'synthetic-sleep:G:/tmp/derived/clip-1a2b3c4d/matte-r1-synthetic-v1.txt';

const initial: ProjectDoc = {
  version: CURRENT_PROJECT_VERSION,
  assets: [],
  mediaFolders: [],
  activeTimelineId: 'timeline_main',
  timelines: [{
    id: 'timeline_main', name: 'Main', order: 0, fps: 30, width: 1920, height: 1080,
    trackOrder: ['track_video', 'track_audio'],
    tracks: { track_video: { kind: 'video' }, track_audio: { kind: 'audio' } },
    selectedId: null,
    items: [
      {
        id: 'item_clip_001', track: 'track_video', startFrame: 0, durationInFrames: 150,
        name: 'Clip', kind: 'video', src: '/media/uploads/clip.mov', srcInFrame: 0,
      },
      {
        id: 'item_voice_002', track: 'track_audio', startFrame: 0, durationInFrames: 150,
        name: 'Voice', kind: 'audio', src: '/media/uploads/clip.mov',
      },
    ],
  }],
};

let history: History = { past: [], present: structuredClone(initial), future: [] };
const commands = {
  setItemDerivedPicture: (id: string, src: string | null, engine?: string | null) => {
    history = historyReduce(history, { type: 'setItemDerivedPicture', id, src, engine });
  },
} as EditorCommands;
const ctx = {
  commands,
  getState: () => activeEditorState(history.present),
  getDoc: () => history.present,
  getCreativeMode: () => null,
  templates: [],
  audio: [],
} satisfies AgentContext;

const clip = () => activeTimeline(history.present).items.find((item) => item.id === 'item_clip_001')!;

// ── the tool group is registered with the D tool names ─────────────────────
// D4 added the face pair: the analysis runs in the renderer, so `analyze_face`
// starts it there and `apply_face_retouch` writes the result through the same
// strict-revision command the inspector uses. The job tools stay first, in order.
assert.deepEqual(
  MEDIA_JOB_TOOL_SCHEMAS.map((schema) => schema.name),
  ['start_job', 'poll_job', 'apply_artifact', 'analyze_face', 'apply_face_retouch'],
  'the D job group is start -> poll -> apply, plus the D4 face pair',
);
{
  const applySchema = MEDIA_JOB_TOOL_SCHEMAS.find((schema) => schema.name === 'apply_artifact')!;
  assert.deepEqual(
    (applySchema.input_schema.properties as Record<string, Record<string, unknown>>).action?.enum,
    ['apply', 'clear'],
    'apply_artifact can attach or clear, nothing else',
  );
}

// ── the job routes, stubbed: the tool must be exercised through its transport ─
interface StubJob {
  status: string;
  code?: string | null;
  error?: string | null;
  artifactUrl?: string | null;
  key?: string;
}

const jobs = new Map<string, StubJob>([
  ['job_done', { status: 'completed', artifactUrl: ARTIFACT_URL, key: JOB_KEY }],
  ['job_running', { status: 'running' }],
  ['job_deferred', { status: 'deferred', code: 'ram_below_gate', error: null }],
  ['job_cancelled', { status: 'cancelled', code: 'job_cancelled', error: 'the job was cancelled' }],
  ['job_failed', { status: 'failed', code: 'engine_crashed', error: 'the engine exited with code 3' }],
  ['job_outside', { status: 'completed', artifactUrl: '/media/uploads/not-derived.txt', key: JOB_KEY }],
  ['job_flat', { status: 'completed', artifactUrl: '/media/derived/matte-flat.webm', key: JOB_KEY }],
  ['job_traversal', { status: 'completed', artifactUrl: '/media/derived/../uploads/clip.mov', key: JOB_KEY }],
  ['job_encoded_traversal', { status: 'completed', artifactUrl: '/media/derived/%2e%2e/clip.mov', key: JOB_KEY }],
  ['job_deep', { status: 'completed', artifactUrl: '/media/derived/clip-1a2b3c4d/nested/matte.webm', key: JOB_KEY }],
]);

const calls: Array<{ mount: string; path: string; method: string; body: unknown }> = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const mount = url.startsWith(MATTING_MOUNT) ? MATTING_MOUNT : url.startsWith(SYNTHETIC_MOUNT) ? SYNTHETIC_MOUNT : '';
  const path = mount ? url.slice(mount.length) : url;
  const method = (init?.method ?? 'GET').toUpperCase();
  calls.push({ mount, path, method, body: init?.body ? JSON.parse(String(init.body)) : null });
  const respond = (status: number, body: unknown) => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  });
  if (!mount) return respond(404, { error: `no route for ${url}`, code: 'route_not_supported' });
  if (method === 'POST' && path === '/jobs') {
    const requested = JSON.parse(String(init?.body ?? '{}')) as { sourceName?: string };
    if (!requested.sourceName) return respond(400, { error: 'sourceName is required', code: 'invalid_argument' });
    return respond(202, { ok: true, jobId: 'job_done', deduped: false, status: 'queued' });
  }
  const match = path.match(/^\/jobs\/([^/?]+)(\/wait)?(\?.*)?$/);
  if (!match) return respond(405, { error: `unsupported ${method} ${path}`, code: 'route_not_supported' });
  const job = jobs.get(decodeURIComponent(match[1]!));
  if (!job) return respond(404, { error: `media job not found: ${match[1]}`, code: 'job_not_found' });
  return respond(200, {
    ok: job.status !== 'failed',
    jobId: match[1],
    key: job.key ?? null,
    status: job.status,
    progress: job.status === 'completed' ? 1 : 0.5,
    phase: job.status,
    detail: null,
    artifact: job.artifactUrl
      ? { file: ARTIFACT_FILE, url: job.artifactUrl, bytes: 42 }
      : null,
    target: { file: ARTIFACT_FILE, url: ARTIFACT_URL },
    error: job.error ?? null,
    code: job.code ?? null,
  });
}) as typeof globalThis.fetch;

try {
  // ── start_job → poll_job → apply_artifact, end to end ─────────────────────
  // D1b: `background_removal` is the default feature, so a bare start reaches the
  // matting mount with a body the matting route understands and nothing synthetic.
  const started = await execMediaJobTool('start_job', { sourceName: 'clip.mov' }, ctx) as Record<string, unknown>;
  assert.equal(started.ok, true);
  assert.equal(started.jobId, 'job_done');
  assert.equal(started.status, 'queued');
  assert.equal(started.feature, 'background_removal');
  assert.deepEqual(calls.at(-1), { mount: MATTING_MOUNT, path: '/jobs', method: 'POST', body: { sourceName: 'clip.mov' } });

  const syntheticStart = await execMediaJobTool('start_job', { sourceName: 'clip.mov', feature: 'synthetic' }, ctx) as Record<string, unknown>;
  assert.equal(syntheticStart.ok, true);
  assert.equal(syntheticStart.feature, 'synthetic');
  assert.deepEqual(calls.at(-1), {
    mount: SYNTHETIC_MOUNT,
    path: '/jobs',
    method: 'POST',
    body: { sourceName: 'clip.mov', engine: 'sleep' },
  }, 'the synthetic engine stays reachable behind an explicit feature');

  const badFeature = await execMediaJobTool('start_job', { sourceName: 'clip.mov', feature: 'matte_everything' }, ctx) as Record<string, unknown>;
  assert.equal(badFeature.ok, false);
  assert.equal(badFeature.code, 'invalid_argument', 'an unknown feature is refused before the route');

  const emptyStart = await execMediaJobTool('start_job', {}, ctx) as Record<string, unknown>;
  assert.equal(emptyStart.ok, false);
  assert.equal(emptyStart.code, 'invalid_argument', 'start_job refuses an empty sourceName before the route');

  const polled = await execMediaJobTool('poll_job', { jobId: 'job_done' }, ctx) as Record<string, unknown>;
  assert.equal(polled.status, 'completed');
  assert.deepEqual(polled.artifact, { file: ARTIFACT_FILE, url: ARTIFACT_URL, bytes: 42 });
  assert.equal(calls.at(-1)!.mount, MATTING_MOUNT, 'a bare poll reaches the matting mount');

  const syntheticPoll = await execMediaJobTool('poll_job', { jobId: 'job_done', feature: 'synthetic' }, ctx) as Record<string, unknown>;
  assert.equal(syntheticPoll.status, 'completed');
  assert.equal(calls.at(-1)!.mount, SYNTHETIC_MOUNT, 'a poll follows its feature to the synthetic mount');

  const waited = await execMediaJobTool('poll_job', { jobId: 'job_done', waitMs: 60_000 }, ctx) as Record<string, unknown>;
  assert.equal(waited.status, 'completed');
  assert.match(calls.at(-1)!.path, /^\/jobs\/job_done\/wait\?timeoutMs=20000$/, 'a poll wait is clamped to the 20 s short-call budget');

  const notFound = await execMediaJobTool('poll_job', { jobId: 'job_missing' }, ctx) as Record<string, unknown>;
  assert.equal(notFound.ok, false);
  assert.equal(notFound.code, 'job_not_found');

  // A deferred job is a wait, not an error: the RAM gate never refuses.
  const deferred = await execMediaJobTool('poll_job', { jobId: 'job_deferred' }, ctx) as Record<string, unknown>;
  assert.equal(deferred.ok, true, 'a deferred job is not an error');
  assert.equal(deferred.status, 'deferred');
  assert.equal(deferred.code, 'ram_below_gate');
  assert.equal(deferred.error, null);

  const cancelled = await execMediaJobTool('poll_job', { jobId: 'job_cancelled' }, ctx) as Record<string, unknown>;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.code, 'job_cancelled');

  // ── refusals: no mutation, machine-parseable code ─────────────────────────
  const beforeRefusals = JSON.stringify(history.present);
  const running = await execMediaJobTool('apply_artifact', { itemId: 'item_clip_001', jobId: 'job_running' }, ctx) as Record<string, unknown>;
  assert.equal(running.ok, false);
  assert.equal(running.code, 'job_not_complete', 'a running job cannot be applied');
  assert.equal(history.past.length, 0);

  const outside = await execMediaJobTool('apply_artifact', { itemId: 'item_clip_001', jobId: 'job_outside' }, ctx) as Record<string, unknown>;
  assert.equal(outside.ok, false);
  assert.equal(outside.code, 'invalid_artifact_url', 'an artifact outside /media/derived is refused');

  // Reviewer condition C1: the guard is the STRUCTURAL two-segment shape
  // ^/media/derived/<sourceKey>/<encodeURIComponent(name)>$ — a flat layout, a
  // traversal segment (plain or percent-encoded) and a deeper path are all
  // refused rather than normalised, because the app never produces them.
  for (const [jobId, why] of [
    ['job_flat', 'a flat /media/derived/<name> would put every source in one directory'],
    ['job_traversal', 'a traversal segment must never resolve outside the source directory'],
    ['job_encoded_traversal', 'percent-encoded traversal decodes to the same escape'],
    ['job_deep', 'the artifact sits exactly one directory below /media/derived'],
  ] as const) {
    const refused = await execMediaJobTool('apply_artifact', { itemId: 'item_clip_001', jobId }, ctx) as Record<string, unknown>;
    assert.equal(refused.ok, false, why);
    assert.equal(refused.code, 'invalid_artifact_url', why);
  }

  const unknownItem = await execMediaJobTool('apply_artifact', { itemId: 'item_nope', jobId: 'job_done' }, ctx) as Record<string, unknown>;
  assert.equal(unknownItem.code, 'unknown_item');

  const audioItem = await execMediaJobTool('apply_artifact', { itemId: 'item_voice_002', jobId: 'job_done' }, ctx) as Record<string, unknown>;
  assert.equal(audioItem.code, 'unsupported_item_kind', 'a derived picture needs a video or image clip');

  const noJob = await execMediaJobTool('apply_artifact', { itemId: 'item_clip_001' }, ctx) as Record<string, unknown>;
  assert.equal(noJob.code, 'invalid_argument');

  assert.equal(JSON.stringify(history.present), beforeRefusals, 'every refusal leaves the project untouched');
  assert.equal(history.past.length, 0, 'every refusal leaves history untouched');

  // ── apply: the derived reference changes, the source does not (I4) ────────
  const originalClip = structuredClone(clip());
  const applied = await execMediaJobTool('apply_artifact', { itemId: 'item_clip_001', jobId: 'job_done' }, ctx) as Record<string, unknown>;
  assert.equal(applied.ok, true);
  assert.equal(applied.derivedPictureSrc, ARTIFACT_URL);
  assert.equal(applied.derivedPictureEngine, 'synthetic-sleep', 'the engine identity is the job key namespace');
  assert.equal(clip().derivedPictureSrc, ARTIFACT_URL);
  assert.equal(clip().derivedPictureEngine, 'synthetic-sleep');
  assert.equal(clip().src, originalClip.src, 'I4: applying a derived picture never replaces the source');
  assert.equal(clip().srcInFrame, originalClip.srcInFrame);
  assert.equal(clip().durationInFrames, originalClip.durationInFrames);
  assert.equal(history.past.length, 1, 'apply is one undoable command');

  const reapply = await execMediaJobTool('apply_artifact', { itemId: 'item_clip_001', jobId: 'job_done' }, ctx) as Record<string, unknown>;
  assert.equal(reapply.unchanged, true);
  assert.equal(history.past.length, 1, 're-applying the same artifact is a no-op (no phantom history)');
  assert.equal(calls.at(-1)!.mount, MATTING_MOUNT, 'a bare apply reads the matting mount');

  const syntheticApply = await execMediaJobTool('apply_artifact', { itemId: 'item_clip_001', jobId: 'job_done', feature: 'synthetic' }, ctx) as Record<string, unknown>;
  assert.equal(syntheticApply.ok, true);
  assert.equal(calls.at(-1)!.mount, SYNTHETIC_MOUNT, 'apply follows its feature to the synthetic mount');
  assert.equal(history.past.length, 1, 'an unchanged synthetic re-apply adds no history step');

  // ── undo restores the clip byte-exactly ───────────────────────────────────
  history = historyReduce(history, { type: 'undo' });
  assert.equal(JSON.stringify(clip()), JSON.stringify(originalClip), 'undo restores the clip byte-exactly');
  assert.equal(history.past.length, 0);

  history = historyReduce(history, { type: 'redo' });
  assert.equal(clip().derivedPictureSrc, ARTIFACT_URL);

  // ── clear = back to the original picture ──────────────────────────────────
  const cleared = await execMediaJobTool('apply_artifact', { itemId: 'item_clip_001', action: 'clear' }, ctx) as Record<string, unknown>;
  assert.equal(cleared.ok, true);
  assert.equal(clip().derivedPictureSrc, null);
  assert.equal(clip().src, originalClip.src);
  history = historyReduce(history, { type: 'undo' });
  assert.equal(clip().derivedPictureSrc, ARTIFACT_URL, 'clear is undoable like any other command');

  // ── a clip with no derived picture: clear is a no-op, not a history step ──
  history = historyReduce(history, { type: 'undo' });
  const pastBefore = history.past.length;
  const clearAgain = await execMediaJobTool('apply_artifact', { itemId: 'item_clip_001', action: 'clear' }, ctx) as Record<string, unknown>;
  assert.equal(clearAgain.ok, true);
  assert.equal(history.past.length, pastBefore, 'clearing nothing creates no history step');

  // ── transport failure is a code, not a thrown tool ────────────────────────
  globalThis.fetch = (async () => { throw new Error('ECONNREFUSED 127.0.0.1:5173'); }) as typeof globalThis.fetch;
  const unreachable = await execMediaJobTool('poll_job', { jobId: 'job_done' }, ctx) as Record<string, unknown>;
  assert.equal(unreachable.ok, false);
  assert.equal(unreachable.code, 'job_transport_failed');
  assert.match(String(unreachable.error), /ECONNREFUSED/);

  const unknownTool = await execMediaJobTool('matte_everything', {}, ctx) as Record<string, unknown>;
  assert.equal(unknownTool.code, 'unknown_tool');
} finally {
  globalThis.fetch = originalFetch;
}

console.log('media-job apply: apply/undo/clear byte-exact, refusals coded, defer is not an error: OK');
