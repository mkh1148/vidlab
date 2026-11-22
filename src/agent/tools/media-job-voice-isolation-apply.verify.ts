// D6 deliverable 3: the ISOLATION apply path and the Original/Processed switch,
// proven against a synthetic project and a synthetic artifact.
// `npx tsx src/agent/tools/media-job-voice-isolation-apply.verify.ts`
//
// What this pins down:
//
//   * `feature: 'voice_isolation'` routes start/poll/apply to the isolation mount
//     and writes the clip's AUDIO slot (`denoisedSrc` at full wet) — the same slot
//     D2's clean-up writes, which is why the engine tag below is load-bearing;
//   * the slot records WHICH engine produced the artifact, so the two inspector
//     controls stop both reading "active" on one clip (the backlog defect);
//   * the Original/Processed switch is a strength change, not a re-run: the artifact
//     reference and the engine tag survive, both files stay, and the mix is what
//     moves (kit D6: "keeps both files", I4);
//   * the clip's original source is untouched (I4), and undo restores it byte-exactly;
//   * clear drops the reference AND the tag, and is undoable;
//   * an artifact that is not exactly `/media/derived/<sourceKey>/<name>` is refused
//     with {error, code} and mutates nothing.
//
// The engine half (separation, reduction, cancel, admission) is proven in
// server/media-job-voice-isolation.verify.ts. This file proves the editor half.
import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../../shared/project-version';
import type { AgentContext } from '../context.ts';
import { activeEditorState, activeTimeline, type ProjectDoc } from '../../editor/types.ts';
import { historyReduce, type History } from '../../editor/reduce.ts';
import type { EditorCommands } from '../../editor/store.ts';
import { execMediaJobTool, MEDIA_JOB_TOOL_SCHEMAS } from './media-job-tools.ts';
import { denoisedSlotOwner, denoisedSlotIs } from '../../audio/denoisedSlot.ts';
import { voiceIsolationMix } from '../../audio/voiceMix.ts';

const ISOLATION_MOUNT = '/api/media-job/voice-isolation';
const CLEANUP_MOUNT = '/api/media-job/voice-cleanup';
const ARTIFACT_URL = '/media/derived/clip-1a2b3c4d/clip.isolated.r1.spleeter-2stems-v1.wav';
const ARTIFACT_FILE = 'G:/tmp/derived/clip-1a2b3c4d/clip.isolated.r1.spleeter-2stems-v1.wav';
const JOB_KEY = `voice-isolation:${ARTIFACT_FILE}`;

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
        id: 'item_legacy_002', track: 'track_audio', startFrame: 0, durationInFrames: 150,
        name: 'Legacy', kind: 'audio', src: '/media/uploads/legacy.wav',
        denoisedSrc: '/media/uploads/legacy.voice.s70.m4a', denoiseStrength: 70,
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
  const featureEnum = (startSchema.input_schema.properties as Record<string, Record<string, unknown>>).feature?.enum;
  assert.ok(
    Array.isArray(featureEnum) && featureEnum.includes('voice_isolation'),
    'start_job advertises voice_isolation',
  );
  const applySchema = MEDIA_JOB_TOOL_SCHEMAS.find((schema) => schema.name === 'apply_artifact')!;
  assert.match(applySchema.description ?? '', /voice_isolation/, 'apply_artifact documents the D6 audio slot');
}

// ── the slot-ownership rule the two inspector controls read ─────────────────
{
  assert.equal(denoisedSlotOwner({ denoisedSrc: null }), null, 'no artifact, no owner');
  assert.equal(
    denoisedSlotOwner({ denoisedSrc: '/media/uploads/x.m4a', denoisedEngine: undefined }),
    'legacy',
    'an untagged artifact is legacy, not a guess',
  );
  assert.equal(
    denoisedSlotOwner({ denoisedSrc: '/media/derived/a/b.wav', denoisedEngine: 'voice-cleanup' }),
    'voice-cleanup',
  );
  assert.equal(
    denoisedSlotIs({ denoisedSrc: '/media/derived/a/b.wav', denoisedEngine: 'voice-isolation' }, 'voice-isolation'),
    true,
  );
  assert.equal(
    denoisedSlotIs({ denoisedSrc: '/media/derived/a/b.wav', denoisedEngine: 'voice-cleanup' }, 'voice-isolation'),
    false,
    'the isolation control does not claim a clean-up artifact',
  );
}

// ── the Original/Processed switch is a mix, and it is equal-power ───────────
{
  assert.deepEqual(voiceIsolationMix(0), { dry: 1, wet: 0 }, 'Original plays the source alone');
  const processed = voiceIsolationMix(100);
  assert.ok(Math.abs(processed.dry) < 1e-12 && processed.wet === 1, 'Processed plays the artifact alone');
  const midpoint = voiceIsolationMix(50);
  assert.ok(midpoint.dry > 0 && midpoint.wet > 0, 'a partial mix plays both files');
  assert.ok(Math.abs(midpoint.dry ** 2 + midpoint.wet ** 2 - 1) < 1e-12, 'the dry/wet mix is equal-power');
}

// ── the job routes, stubbed: the tool is exercised through its transport ────
interface StubJob {
  status: string;
  code?: string | null;
  error?: string | null;
  artifactUrl?: string | null;
  key?: string;
}

const jobs = new Map<string, StubJob>([
  ['job_isolated', { status: 'completed', artifactUrl: ARTIFACT_URL, key: JOB_KEY }],
  ['job_running', { status: 'running' }],
  ['job_outside', { status: 'completed', artifactUrl: '/media/uploads/not-derived.wav', key: JOB_KEY }],
]);

const calls: Array<{ mount: string; path: string; method: string; body: unknown }> = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const mount = url.startsWith(ISOLATION_MOUNT) ? ISOLATION_MOUNT
    : url.startsWith(CLEANUP_MOUNT) ? CLEANUP_MOUNT : '';
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
    return respond(202, { ok: true, jobId: 'job_isolated', deduped: false, status: 'queued' });
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
    artifact: job.artifactUrl ? { file: ARTIFACT_FILE, url: job.artifactUrl, bytes: 1_058_400 } : null,
    target: { file: ARTIFACT_FILE, url: ARTIFACT_URL },
    error: job.error ?? null,
    code: job.code ?? null,
    createdAt: 1,
    startedAt: 1,
    updatedAt: 2,
    finishedAt: 2,
    deferred: false,
  });
}) as typeof globalThis.fetch;

try {
  const originalClip = structuredClone(item('item_clip_001'));

  // ── start_job routes to the isolation mount, with the revision ────────────
  const started = await execMediaJobTool(
    'start_job',
    { sourceName: 'clip.mov', feature: 'voice_isolation', revision: 'r1' },
    ctx,
  ) as Record<string, unknown>;
  assert.equal(started.ok, true);
  assert.equal(started.feature, 'voice_isolation');
  assert.deepEqual(calls.at(-1), {
    mount: ISOLATION_MOUNT,
    path: '/jobs',
    method: 'POST',
    body: { sourceName: 'clip.mov', revision: 'r1' },
  }, 'voice_isolation sends the source and its revision to its own mount');

  // ── apply writes the audio slot AND the engine tag ────────────────────────
  const applied = await execMediaJobTool(
    'apply_artifact',
    { itemId: 'item_clip_001', jobId: 'job_isolated', feature: 'voice_isolation' },
    ctx,
  ) as Record<string, unknown>;
  assert.equal(applied.ok, true);
  assert.equal(applied.denoisedSrc, ARTIFACT_URL);
  assert.equal(applied.denoiseStrength, 100, 'the artifact is the processed voice, so the mix starts full wet');
  assert.equal(applied.denoisedEngine, 'voice-isolation');
  assert.equal(applied.engine, 'voice-isolation', 'the engine identity is the job key namespace');
  assert.equal(applied.derivedPictureSrc, undefined, 'an isolated voice never touches the picture slot');
  assert.equal(item('item_clip_001').denoisedSrc, ARTIFACT_URL);
  assert.equal(item('item_clip_001').denoisedEngine, 'voice-isolation');
  assert.equal(item('item_clip_001').src, originalClip.src, 'I4: applying never replaces the source');
  assert.equal(history.past.length, 1, 'apply is one undoable command');
  assert.equal(denoisedSlotOwner(item('item_clip_001')), 'voice-isolation');

  const reapply = await execMediaJobTool(
    'apply_artifact',
    { itemId: 'item_clip_001', jobId: 'job_isolated', feature: 'voice_isolation' },
    ctx,
  ) as Record<string, unknown>;
  assert.equal(reapply.unchanged, true, 're-applying the same artifact is a no-op');
  assert.equal(history.past.length, 1, 'and creates no phantom history step');

  // ── the switch: Original keeps both files and the tag ─────────────────────
  commands.setItemDenoise('item_clip_001', ARTIFACT_URL, 0);
  assert.equal(item('item_clip_001').denoiseStrength, 0);
  assert.equal(item('item_clip_001').denoisedSrc, ARTIFACT_URL, 'Original keeps the artifact reference (both files stay)');
  assert.equal(item('item_clip_001').denoisedEngine, 'voice-isolation', 'the switch does not rewrite the engine tag');
  assert.deepEqual(voiceIsolationMix(item('item_clip_001').denoiseStrength), { dry: 1, wet: 0 });

  commands.setItemDenoise('item_clip_001', ARTIFACT_URL, 100);
  assert.equal(item('item_clip_001').denoiseStrength, 100);
  assert.equal(item('item_clip_001').denoisedEngine, 'voice-isolation');

  // Switching back and forth is not history noise: same src, same strength, no step.
  const pastBefore = history.past.length;
  commands.setItemDenoise('item_clip_001', ARTIFACT_URL, 100);
  assert.equal(history.past.length, pastBefore, 'a no-op write creates no history step');

  // ── undo restores the clip byte-exactly ───────────────────────────────────
  // Three steps to unwind: the apply, then the two switch writes. Each is its own
  // undoable command, which is what the user expects from a switch.
  history = historyReduce(history, { type: 'undo' });
  assert.equal(item('item_clip_001').denoiseStrength, 0, 'undo steps back through the switch');
  history = historyReduce(history, { type: 'undo' });
  assert.equal(item('item_clip_001').denoiseStrength, 100, 'and back to the applied state');
  history = historyReduce(history, { type: 'undo' });
  assert.equal(JSON.stringify(item('item_clip_001')), JSON.stringify(originalClip), 'undo restores the clip byte-exactly');
  history = historyReduce(history, { type: 'redo' });
  assert.equal(item('item_clip_001').denoisedEngine, 'voice-isolation');

  // ── clear drops the reference AND the tag ─────────────────────────────────
  const cleared = await execMediaJobTool(
    'apply_artifact',
    { itemId: 'item_clip_001', action: 'clear', feature: 'voice_isolation' },
    ctx,
  ) as Record<string, unknown>;
  assert.equal(cleared.ok, true);
  assert.equal(item('item_clip_001').denoisedSrc, null);
  assert.equal(item('item_clip_001').denoisedEngine, null, 'clear leaves no stale engine tag');
  assert.equal(item('item_clip_001').src, originalClip.src);
  assert.equal(denoisedSlotOwner(item('item_clip_001')), null);
  history = historyReduce(history, { type: 'undo' });
  assert.equal(item('item_clip_001').denoisedSrc, ARTIFACT_URL, 'clear is undoable like any other command');
  assert.equal(item('item_clip_001').denoisedEngine, 'voice-isolation', 'and undo restores the tag too');

  // ── a legacy artifact is not claimed by either engine's control ───────────
  assert.equal(denoisedSlotOwner(item('item_legacy_002')), 'legacy');
  assert.equal(denoisedSlotIs(item('item_legacy_002'), 'voice-isolation'), false);
  assert.equal(denoisedSlotIs(item('item_legacy_002'), 'voice-cleanup'), false);
  assert.equal(item('item_legacy_002').denoisedSrc, '/media/uploads/legacy.voice.s70.m4a', 'a legacy clip is left alone');

  // ── refusals: a running job and an artifact outside the derived area ──────
  const running = await execMediaJobTool(
    'apply_artifact',
    { itemId: 'item_clip_001', jobId: 'job_running', feature: 'voice_isolation' },
    ctx,
  ) as Record<string, unknown>;
  assert.equal(running.ok, false);
  assert.equal(running.code, 'job_not_complete');

  const outside = await execMediaJobTool(
    'apply_artifact',
    { itemId: 'item_clip_001', jobId: 'job_outside', feature: 'voice_isolation' },
    ctx,
  ) as Record<string, unknown>;
  assert.equal(outside.ok, false);
  assert.equal(outside.code, 'invalid_artifact_url');
  assert.equal(item('item_clip_001').denoisedSrc, ARTIFACT_URL, 'a refused apply mutates nothing');

  // ── the two engines do not share a mount ──────────────────────────────────
  await execMediaJobTool('poll_job', { jobId: 'job_isolated', feature: 'voice_cleanup' }, ctx);
  assert.equal(calls.at(-1)!.mount, CLEANUP_MOUNT, 'voice_cleanup still reads its own mount');
} finally {
  globalThis.fetch = originalFetch;
}

console.log('media-job voice isolation apply: engine tag, slot ownership, Original/Processed switch, undo byte-exact, coded refusals: OK');
