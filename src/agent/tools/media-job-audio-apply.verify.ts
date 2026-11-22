// D2 deliverable 3: the AUDIO apply path, proven against a synthetic project and a
// synthetic artifact. `npx tsx src/agent/tools/media-job-audio-apply.verify.ts`
//
// What this pins down:
//
//   * `feature: 'voice_cleanup'` routes start/poll/apply to the voice-clean-up
//     mount, and the artifact lands in the clip's AUDIO slot (`denoisedSrc` at
//     full strength) — not in the picture slot, which is where a tool that guessed
//     the slot from the item kind would put it;
//   * the clip's original source is untouched (I4: the source is never replaced),
//     and its picture reference is untouched too;
//   * undo restores the clip byte-exactly (one history step, snapshot restore);
//   * clear drops the reference, so the clip plays its original audio again, and
//     clear is undoable like any other command;
//   * a video clip and an audio clip both accept the artifact; an image clip is
//     refused with a code, because a cleaned voice needs audio to clean;
//   * an artifact that is not a completed job, or that is not exactly
//     `/media/derived/<sourceKey>/<name>`, is refused with {error, code} and
//     mutates nothing.
//
// The revision-drift half of the contract (a stale session cannot apply) is proven
// at the broker in server/media-job-takeover.verify.ts, because the guard lives
// there, not in the tool.
import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../../shared/project-version';
import type { AgentContext } from '../context.ts';
import { activeEditorState, activeTimeline, type ProjectDoc } from '../../editor/types.ts';
import { historyReduce, type History } from '../../editor/reduce.ts';
import type { EditorCommands } from '../../editor/store.ts';
import { execMediaJobTool, MEDIA_JOB_TOOL_SCHEMAS } from './media-job-tools.ts';

const VOICE_MOUNT = '/api/media-job/voice-cleanup';
const MATTING_MOUNT = '/api/media-job/background-removal';
const ARTIFACT_URL = '/media/derived/clip-1a2b3c4d/clip.voice.r1.rnnoise-sh-v1.wav';
const ARTIFACT_FILE = 'G:/tmp/derived/clip-1a2b3c4d/clip.voice.r1.rnnoise-sh-v1.wav';
const JOB_KEY = 'voice-cleanup:G:/tmp/derived/clip-1a2b3c4d/clip.voice.r1.rnnoise-sh-v1.wav';

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
      {
        id: 'item_logo_003', track: 'track_video', startFrame: 150, durationInFrames: 60,
        name: 'Logo', kind: 'image', src: '/media/uploads/logo.png',
      },
    ],
  }],
};

let history: History = { past: [], present: structuredClone(initial), future: [] };
const commands = {
  setItemDenoise: (id: string, denoisedSrc: string | null, strength?: number | null, engine?: string | null) => {
    history = historyReduce(history, { type: 'setItemDenoise', id, denoisedSrc, strength, engine });
  },
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

const item = (id: string) => activeTimeline(history.present).items.find((entry) => entry.id === id)!;

// ── the tool group advertises the feature and the audio slot ────────────────
{
  const startSchema = MEDIA_JOB_TOOL_SCHEMAS.find((schema) => schema.name === 'start_job')!;
  assert.deepEqual(
    (startSchema.input_schema.properties as Record<string, Record<string, unknown>>).feature?.enum,
    ['background_removal', 'voice_cleanup', 'voice_isolation', 'transcription', 'synthetic'],
    'D3a adds transcription and D6 adds voice_isolation without removing the other engines',
  );
  const applySchema = MEDIA_JOB_TOOL_SCHEMAS.find((schema) => schema.name === 'apply_artifact')!;
  assert.match(applySchema.description ?? '', /AUDIO/, 'apply_artifact documents that D2 writes the audio slot');
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
  ['job_outside', { status: 'completed', artifactUrl: '/media/uploads/not-derived.wav', key: JOB_KEY }],
  ['job_flat', { status: 'completed', artifactUrl: '/media/derived/clip.voice.wav', key: JOB_KEY }],
]);

const calls: Array<{ mount: string; path: string; method: string; body: unknown }> = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const mount = url.startsWith(VOICE_MOUNT) ? VOICE_MOUNT
    : url.startsWith(MATTING_MOUNT) ? MATTING_MOUNT : '';
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
    artifact: job.artifactUrl ? { file: ARTIFACT_FILE, url: job.artifactUrl, bytes: 384_078 } : null,
    target: { file: ARTIFACT_FILE, url: ARTIFACT_URL },
    error: job.error ?? null,
    code: job.code ?? null,
  });
}) as typeof globalThis.fetch;

try {
  // ── start_job routes to the voice-clean-up mount ──────────────────────────
  const started = await execMediaJobTool(
    'start_job',
    { sourceName: 'clip.mov', feature: 'voice_cleanup', revision: 'r1' },
    ctx,
  ) as Record<string, unknown>;
  assert.equal(started.ok, true);
  assert.equal(started.feature, 'voice_cleanup');
  assert.deepEqual(calls.at(-1), {
    mount: VOICE_MOUNT,
    path: '/jobs',
    method: 'POST',
    body: { sourceName: 'clip.mov', revision: 'r1' },
  }, 'voice_cleanup sends the source and its revision, and nothing the matting route owns');

  const noRevision = await execMediaJobTool(
    'start_job',
    { sourceName: 'clip.mov', feature: 'voice_cleanup' },
    ctx,
  ) as Record<string, unknown>;
  assert.equal(noRevision.ok, true);
  assert.deepEqual(calls.at(-1)!.body, { sourceName: 'clip.mov' }, 'an absent revision is not sent as a string');

  const polled = await execMediaJobTool(
    'poll_job',
    { jobId: 'job_done', feature: 'voice_cleanup' },
    ctx,
  ) as Record<string, unknown>;
  assert.equal(polled.status, 'completed');
  assert.equal(calls.at(-1)!.mount, VOICE_MOUNT, 'a poll follows its feature to the voice-clean-up mount');

  // ── refusals: no mutation, machine-parseable code ─────────────────────────
  const beforeRefusals = JSON.stringify(history.present);
  const running = await execMediaJobTool(
    'apply_artifact',
    { itemId: 'item_clip_001', jobId: 'job_running', feature: 'voice_cleanup' },
    ctx,
  ) as Record<string, unknown>;
  assert.equal(running.ok, false);
  assert.equal(running.code, 'job_not_complete', 'a running job cannot be applied');

  for (const [jobId, why] of [
    ['job_outside', 'an artifact outside /media/derived is refused'],
    ['job_flat', 'a flat /media/derived/<name> would put every source in one directory'],
  ] as const) {
    const refused = await execMediaJobTool(
      'apply_artifact',
      { itemId: 'item_clip_001', jobId, feature: 'voice_cleanup' },
      ctx,
    ) as Record<string, unknown>;
    assert.equal(refused.ok, false, why);
    assert.equal(refused.code, 'invalid_artifact_url', why);
  }

  const imageItem = await execMediaJobTool(
    'apply_artifact',
    { itemId: 'item_logo_003', jobId: 'job_done', feature: 'voice_cleanup' },
    ctx,
  ) as Record<string, unknown>;
  assert.equal(imageItem.ok, false);
  assert.equal(imageItem.code, 'unsupported_item_kind', 'a cleaned voice needs a video or audio clip, not an image');

  const unknownItem = await execMediaJobTool(
    'apply_artifact',
    { itemId: 'item_nope', jobId: 'job_done', feature: 'voice_cleanup' },
    ctx,
  ) as Record<string, unknown>;
  assert.equal(unknownItem.code, 'unknown_item');

  const badFeature = await execMediaJobTool(
    'apply_artifact',
    { itemId: 'item_clip_001', jobId: 'job_done', feature: 'clean_everything' },
    ctx,
  ) as Record<string, unknown>;
  assert.equal(badFeature.ok, false);
  assert.equal(badFeature.code, 'invalid_argument', 'an unknown feature is refused before the route');

  const noJob = await execMediaJobTool(
    'apply_artifact',
    { itemId: 'item_clip_001', feature: 'voice_cleanup' },
    ctx,
  ) as Record<string, unknown>;
  assert.equal(noJob.code, 'invalid_argument');

  assert.equal(JSON.stringify(history.present), beforeRefusals, 'every refusal leaves the project untouched');
  assert.equal(history.past.length, 0, 'every refusal leaves history untouched');

  // ── apply on a VIDEO clip: the audio slot changes, nothing else does (I4) ─
  const originalClip = structuredClone(item('item_clip_001'));
  const applied = await execMediaJobTool(
    'apply_artifact',
    { itemId: 'item_clip_001', jobId: 'job_done', feature: 'voice_cleanup' },
    ctx,
  ) as Record<string, unknown>;
  assert.equal(applied.ok, true);
  assert.equal(applied.denoisedSrc, ARTIFACT_URL);
  assert.equal(applied.denoiseStrength, 100, 'the cleaned track replaces the mix at full wet');
  assert.equal(applied.engine, 'voice-cleanup', 'the engine identity is the job key namespace');
  assert.equal(applied.derivedPictureSrc, undefined, 'a cleaned voice never touches the picture slot');
  assert.equal(item('item_clip_001').denoisedSrc, ARTIFACT_URL);
  assert.equal(item('item_clip_001').denoiseStrength, 100);
  assert.equal(item('item_clip_001').denoisedEngine, 'voice-cleanup', 'the slot records which engine produced the artifact');
  assert.equal(item('item_clip_001').derivedPictureSrc, undefined, 'the picture slot stays empty');
  assert.equal(item('item_clip_001').src, originalClip.src, 'I4: applying a cleaned track never replaces the source');
  assert.equal(item('item_clip_001').srcInFrame, originalClip.srcInFrame);
  assert.equal(item('item_clip_001').durationInFrames, originalClip.durationInFrames);
  assert.equal(history.past.length, 1, 'apply is one undoable command');

  const reapply = await execMediaJobTool(
    'apply_artifact',
    { itemId: 'item_clip_001', jobId: 'job_done', feature: 'voice_cleanup' },
    ctx,
  ) as Record<string, unknown>;
  assert.equal(reapply.unchanged, true);
  assert.equal(history.past.length, 1, 're-applying the same artifact is a no-op (no phantom history)');
  assert.equal(calls.at(-1)!.mount, VOICE_MOUNT, 'apply reads the voice-clean-up mount');

  // ── undo restores the clip byte-exactly ───────────────────────────────────
  history = historyReduce(history, { type: 'undo' });
  assert.equal(JSON.stringify(item('item_clip_001')), JSON.stringify(originalClip), 'undo restores the clip byte-exactly');
  assert.equal(history.past.length, 0);

  history = historyReduce(history, { type: 'redo' });
  assert.equal(item('item_clip_001').denoisedSrc, ARTIFACT_URL);

  // ── clear = back to the original audio ────────────────────────────────────
  const cleared = await execMediaJobTool(
    'apply_artifact',
    { itemId: 'item_clip_001', action: 'clear', feature: 'voice_cleanup' },
    ctx,
  ) as Record<string, unknown>;
  assert.equal(cleared.ok, true);
  assert.equal(item('item_clip_001').denoisedSrc, null);
  assert.equal(item('item_clip_001').src, originalClip.src);
  history = historyReduce(history, { type: 'undo' });
  assert.equal(item('item_clip_001').denoisedSrc, ARTIFACT_URL, 'clear is undoable like any other command');

  // ── a clip with no cleaned track: clear is a no-op, not a history step ────
  const pastBefore = history.past.length;
  const clearAgain = await execMediaJobTool(
    'apply_artifact',
    { itemId: 'item_voice_002', action: 'clear', feature: 'voice_cleanup' },
    ctx,
  ) as Record<string, unknown>;
  assert.equal(clearAgain.ok, true);
  assert.equal(history.past.length, pastBefore, 'clearing nothing creates no history step');

  // ── an AUDIO clip accepts the artifact too ────────────────────────────────
  const audioApplied = await execMediaJobTool(
    'apply_artifact',
    { itemId: 'item_voice_002', jobId: 'job_done', feature: 'voice_cleanup' },
    ctx,
  ) as Record<string, unknown>;
  assert.equal(audioApplied.ok, true);
  assert.equal(item('item_voice_002').denoisedSrc, ARTIFACT_URL);
  assert.equal(item('item_voice_002').src, '/media/uploads/clip.mov', 'I4 on an audio clip as well');

  // ── the picture path is untouched by the new feature ──────────────────────
  const pictureApply = await execMediaJobTool(
    'apply_artifact',
    { itemId: 'item_clip_001', jobId: 'job_done' },
    ctx,
  ) as Record<string, unknown>;
  assert.equal(pictureApply.ok, true);
  assert.equal(pictureApply.derivedPictureSrc, ARTIFACT_URL, 'the default feature still writes the picture slot');
  assert.equal(calls.at(-1)!.mount, MATTING_MOUNT, 'a bare apply still reads the matting mount');
  assert.equal(item('item_clip_001').denoisedSrc, ARTIFACT_URL, 'and it leaves the audio slot alone');

  // ── transport failure is a code, not a thrown tool ────────────────────────
  globalThis.fetch = (async () => { throw new Error('ECONNREFUSED 127.0.0.1:5173'); }) as typeof globalThis.fetch;
  const unreachable = await execMediaJobTool(
    'poll_job',
    { jobId: 'job_done', feature: 'voice_cleanup' },
    ctx,
  ) as Record<string, unknown>;
  assert.equal(unreachable.ok, false);
  assert.equal(unreachable.code, 'job_transport_failed');
  assert.match(String(unreachable.error), /ECONNREFUSED/);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('media-job audio apply: voice_cleanup writes denoisedSrc at full wet, source untouched, undo byte-exact, clear restores, refusals coded: OK');
