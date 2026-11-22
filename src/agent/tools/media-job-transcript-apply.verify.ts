// D3a deliverable 3: the TRANSCRIPT apply path, proven against a synthetic project and a
// synthetic artifact. `npx tsx src/agent/tools/media-job-transcript-apply.verify.ts`
//
// What this pins down:
//
//   * `feature: 'transcription'` routes start/poll/apply to the transcription mount, and
//     the artifact lands on the clip's TRANSCRIPT — not in the picture slot and not in
//     the audio slot, which is where a tool that guessed from the item kind would put it;
//   * the apply is ONE command (`setItemTranscript`), so it is one undo step, and undo
//     restores whatever transcript the clip had before — including a transcript that came
//     from somewhere else (I4 for a transcript: the original is never destroyed);
//   * the clip's source, its picture slot and its audio slot are untouched;
//   * a re-apply of the same words is a no-op, not a phantom history step;
//   * clear empties the transcript and is undoable; clearing nothing is not a history step;
//   * a video clip and an audio clip both accept the artifact; an image clip is refused
//     with a code, because a transcript needs speech;
//   * an artifact that is not a completed job, that is not exactly
//     `/media/derived/<sourceKey>/<name>`, that is unreadable, that is not a transcript,
//     that carries no words, or that carries more words than the tool accepts, is refused
//     with {error, code} and mutates nothing.
//
// The revision-drift half of the contract (a stale session cannot apply) is proven at the
// broker in server/media-job-takeover.verify.ts, because the guard lives there.
import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../../shared/project-version';
import type { AgentContext } from '../context.ts';
import { activeEditorState, activeTimeline, type ProjectDoc } from '../../editor/types.ts';
import { historyReduce, type History } from '../../editor/reduce.ts';
import type { EditorCommands } from '../../editor/store.ts';
import type { TranscriptWord } from '../../transcript/types.ts';
import { execMediaJobTool, MEDIA_JOB_TOOL_SCHEMAS } from './media-job-tools.ts';

const TRANSCRIPTION_MOUNT = '/api/media-job/transcription';
const VOICE_MOUNT = '/api/media-job/voice-cleanup';
const ARTIFACT_URL = '/media/derived/clip-1a2b3c4d/clip.transcript.r1.whisper-cpp-v1.9.2.model-base.vad-e1.lang-auto.json';
const ARTIFACT_FILE = `G:/tmp/derived/clip-1a2b3c4d/${ARTIFACT_URL.split('/').pop()}`;

const LOCAL_WORDS: TranscriptWord[] = [
  { text: 'Good', start: 120, end: 380 },
  { text: 'evening', start: 380, end: 900 },
  { text: 'everyone,', start: 900, end: 1_420 },
];
// A transcript the clip already had, from a different (cloud) provider. It must survive
// an undo of the local apply, byte for byte, generation id included.
const PREVIOUS_WORDS: TranscriptWord[] = [
  { id: 'w_old_1', text: 'Hello', start: 0, end: 400 },
  { id: 'w_old_2', text: 'there', start: 400, end: 800 },
];

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
        transcript: PREVIOUS_WORDS, transcriptGenerationId: 'gen_cloud_1',
        denoisedSrc: '/media/derived/clip-1a2b3c4d/clip.voice.r1.rnnoise-sh-v1.wav',
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
  setItemTranscript: (id: string, words: TranscriptWord[]) => {
    history = historyReduce(history, { type: 'setItemTranscript', id, words });
  },
  // Present so the voice-clean-up path can be exercised too: this suite proves the
  // transcript slot, and the audio slot must stay reachable and unchanged.
  setItemDenoise: (id: string, denoisedSrc: string | null, strength?: number | null) => {
    history = historyReduce(history, { type: 'setItemDenoise', id, denoisedSrc, strength });
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

// ── the tool group advertises the feature ───────────────────────────────────
{
  const startSchema = MEDIA_JOB_TOOL_SCHEMAS.find((schema) => schema.name === 'start_job')!;
  assert.deepEqual(
    (startSchema.input_schema.properties as Record<string, Record<string, unknown>>).feature?.enum,
    ['background_removal', 'voice_cleanup', 'voice_isolation', 'transcription', 'synthetic'],
    'D3a adds transcription and D6 adds voice_isolation without removing the other engines',
  );
  const properties = startSchema.input_schema.properties as Record<string, Record<string, unknown>>;
  assert.ok(properties.model, 'the model tier is a start_job argument');
  assert.ok(properties.language, 'the language is a start_job argument');
  const applySchema = MEDIA_JOB_TOOL_SCHEMAS.find((schema) => schema.name === 'apply_artifact')!;
  assert.match(applySchema.description ?? '', /transcript/i, 'apply_artifact documents the transcript path');
}

// ── the job routes and the artifact, stubbed ────────────────────────────────
interface StubJob {
  status: string;
  code?: string | null;
  error?: string | null;
  artifactUrl?: string | null;
}

const jobs = new Map<string, StubJob>([
  ['job_done', { status: 'completed', artifactUrl: ARTIFACT_URL }],
  ['job_running', { status: 'running' }],
  ['job_outside', { status: 'completed', artifactUrl: '/media/uploads/not-derived.json' }],
  ['job_flat', { status: 'completed', artifactUrl: '/media/derived/clip.transcript.json' }],
]);

const artifacts = new Map<string, unknown>([
  [ARTIFACT_URL, { version: 1, words: LOCAL_WORDS }],
  ['/media/derived/clip-1a2b3c4d/empty.json', { version: 1, words: [] }],
  ['/media/derived/clip-1a2b3c4d/shape.json', { version: 1, text: 'no words here' }],
  ['/media/derived/clip-1a2b3c4d/badword.json', { version: 1, words: [{ text: 'ok', start: 0, end: 10 }, { text: '', start: 10, end: 20 }] }],
  ['/media/derived/clip-1a2b3c4d/backwards.json', { version: 1, words: [{ text: 'ok', start: 500, end: 100 }] }],
]);

const calls: Array<{ mount: string; path: string; method: string; body: unknown }> = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const mount = url.startsWith(TRANSCRIPTION_MOUNT) ? TRANSCRIPTION_MOUNT
    : url.startsWith(VOICE_MOUNT) ? VOICE_MOUNT : '';
  const path = mount ? url.slice(mount.length) : url;
  const method = (init?.method ?? 'GET').toUpperCase();
  calls.push({ mount, path, method, body: init?.body ? JSON.parse(String(init.body)) : null });
  const respond = (status: number, body: unknown) => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  });
  if (!mount) {
    // The artifact read: a plain GET of a derived URL.
    if (method === 'GET' && artifacts.has(url)) return respond(200, artifacts.get(url));
    return respond(404, { error: `no route for ${url}`, code: 'route_not_supported' });
  }
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
    key: `transcription:${ARTIFACT_FILE}`,
    status: job.status,
    progress: job.status === 'completed' ? 1 : 0.5,
    phase: job.status,
    detail: null,
    artifact: job.artifactUrl ? { file: ARTIFACT_FILE, url: job.artifactUrl, bytes: 12_345 } : null,
    target: { file: ARTIFACT_FILE, url: ARTIFACT_URL },
    error: job.error ?? null,
    code: job.code ?? null,
  });
}) as typeof globalThis.fetch;

try {
  // ── start_job routes to the transcription mount ───────────────────────────
  const started = await execMediaJobTool(
    'start_job',
    { sourceName: 'clip.mov', feature: 'transcription', revision: 'r1', model: 'base', language: 'en' },
    ctx,
  ) as Record<string, unknown>;
  assert.equal(started.ok, true);
  assert.equal(started.feature, 'transcription');
  assert.deepEqual(calls.at(-1), {
    mount: TRANSCRIPTION_MOUNT,
    path: '/jobs',
    method: 'POST',
    body: { sourceName: 'clip.mov', revision: 'r1', model: 'base', language: 'en' },
  }, 'transcription sends the source, its revision, the model tier and the language');

  const defaults = await execMediaJobTool(
    'start_job',
    { sourceName: 'clip.mov', feature: 'transcription' },
    ctx,
  ) as Record<string, unknown>;
  assert.equal(defaults.ok, true);
  assert.deepEqual(calls.at(-1)!.body, { sourceName: 'clip.mov' },
    'an absent revision, model and language are not sent: the route owns the defaults');

  const polled = await execMediaJobTool(
    'poll_job',
    { jobId: 'job_done', feature: 'transcription' },
    ctx,
  ) as Record<string, unknown>;
  assert.equal(polled.status, 'completed');
  assert.equal(calls.at(-1)!.mount, TRANSCRIPTION_MOUNT, 'a poll follows its feature to the transcription mount');

  // ── refusals: no mutation, machine-parseable code ─────────────────────────
  const beforeRefusals = JSON.stringify(history.present);
  const running = await execMediaJobTool(
    'apply_artifact',
    { itemId: 'item_clip_001', jobId: 'job_running', feature: 'transcription' },
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
      { itemId: 'item_clip_001', jobId, feature: 'transcription' },
      ctx,
    ) as Record<string, unknown>;
    assert.equal(refused.ok, false, why);
    assert.equal(refused.code, 'invalid_artifact_url', why);
  }

  const imageItem = await execMediaJobTool(
    'apply_artifact',
    { itemId: 'item_logo_003', jobId: 'job_done', feature: 'transcription' },
    ctx,
  ) as Record<string, unknown>;
  assert.equal(imageItem.ok, false);
  assert.equal(imageItem.code, 'unsupported_item_kind', 'a transcript needs a clip with speech, not an image');

  const unknownItem = await execMediaJobTool(
    'apply_artifact',
    { itemId: 'item_nope', jobId: 'job_done', feature: 'transcription' },
    ctx,
  ) as Record<string, unknown>;
  assert.equal(unknownItem.code, 'unknown_item');

  const badFeature = await execMediaJobTool(
    'apply_artifact',
    { itemId: 'item_clip_001', jobId: 'job_done', feature: 'transcribe_everything' },
    ctx,
  ) as Record<string, unknown>;
  assert.equal(badFeature.ok, false);
  assert.equal(badFeature.code, 'invalid_argument', 'an unknown feature is refused before the route');

  const noJob = await execMediaJobTool(
    'apply_artifact',
    { itemId: 'item_clip_001', feature: 'transcription' },
    ctx,
  ) as Record<string, unknown>;
  assert.equal(noJob.code, 'invalid_argument');

  assert.equal(JSON.stringify(history.present), beforeRefusals, 'every refusal leaves the project untouched');
  assert.equal(history.past.length, 0, 'every refusal leaves history untouched');

  // ── the artifact itself is validated, not trusted ─────────────────────────
  jobs.set('job_empty', { status: 'completed', artifactUrl: '/media/derived/clip-1a2b3c4d/empty.json' });
  jobs.set('job_shape', { status: 'completed', artifactUrl: '/media/derived/clip-1a2b3c4d/shape.json' });
  jobs.set('job_badword', { status: 'completed', artifactUrl: '/media/derived/clip-1a2b3c4d/badword.json' });
  jobs.set('job_backwards', { status: 'completed', artifactUrl: '/media/derived/clip-1a2b3c4d/backwards.json' });
  jobs.set('job_gone', { status: 'completed', artifactUrl: '/media/derived/clip-1a2b3c4d/gone.json' });
  for (const [jobId, code, why] of [
    ['job_empty', 'transcript_empty', 'an artifact with no words is refused instead of clearing the clip'],
    ['job_shape', 'invalid_artifact_shape', 'an artifact that is not a transcript is refused'],
    ['job_badword', 'invalid_artifact_shape', 'a word with no text is refused'],
    ['job_backwards', 'invalid_artifact_shape', 'a word that ends before it starts is refused'],
    ['job_gone', 'artifact_unreadable', 'an artifact that cannot be read is refused'],
  ] as const) {
    const refused = await execMediaJobTool(
      'apply_artifact',
      { itemId: 'item_clip_001', jobId, feature: 'transcription' },
      ctx,
    ) as Record<string, unknown>;
    assert.equal(refused.ok, false, why);
    assert.equal(refused.code, code, why);
    assert.equal(typeof refused.error, 'string', `${why}: the refusal carries EN text`);
  }
  assert.equal(JSON.stringify(history.present), beforeRefusals, 'a bad artifact leaves the project untouched');
  assert.equal(history.past.length, 0);

  // ── apply on a VIDEO clip: the transcript changes, nothing else does (I4) ─
  const originalClip = structuredClone(item('item_clip_001'));
  const applied = await execMediaJobTool(
    'apply_artifact',
    { itemId: 'item_clip_001', jobId: 'job_done', feature: 'transcription' },
    ctx,
  ) as Record<string, unknown>;
  assert.equal(applied.ok, true);
  assert.equal(applied.transcript, LOCAL_WORDS.length);
  assert.equal(applied.transcriptArtifact, ARTIFACT_URL);
  assert.equal(applied.unchanged, false);
  assert.equal(applied.engine, 'transcription', 'the engine identity is the job key namespace');
  const appliedItem = item('item_clip_001');
  assert.equal(appliedItem.transcript?.length, LOCAL_WORDS.length);
  assert.deepEqual(appliedItem.transcript?.map((word) => word.text), ['Good', 'evening', 'everyone,']);
  assert.deepEqual(appliedItem.transcript?.map((word) => [word.start, word.end]),
    LOCAL_WORDS.map((word) => [word.start, word.end]), 'the word times are stored as the artifact reported them');
  assert.equal(appliedItem.src, originalClip.src, 'I4: applying a transcript never replaces the source');
  assert.equal(appliedItem.srcInFrame, originalClip.srcInFrame);
  assert.equal(appliedItem.durationInFrames, originalClip.durationInFrames);
  assert.equal(appliedItem.denoisedSrc, originalClip.denoisedSrc, 'the audio slot is untouched');
  assert.equal(appliedItem.transcriptGenerationId !== 'gen_cloud_1', true,
    'a new transcript is a new generation, so old word references cannot retarget');
  assert.equal(history.past.length, 1, 'apply is one undoable command');
  assert.equal(calls.at(-2)!.mount, TRANSCRIPTION_MOUNT, 'apply polls the transcription mount');
  assert.equal(calls.at(-1)!.path, ARTIFACT_URL, 'and then reads the artifact the job reported');

  // ── a re-apply of the same words is a no-op ───────────────────────────────
  const reapply = await execMediaJobTool(
    'apply_artifact',
    { itemId: 'item_clip_001', jobId: 'job_done', feature: 'transcription' },
    ctx,
  ) as Record<string, unknown>;
  assert.equal(reapply.ok, true);
  assert.equal(reapply.unchanged, true);
  assert.equal(history.past.length, 1, 're-applying the same artifact is a no-op (no phantom history)');

  // ── undo restores the transcript the clip had before, byte-exactly ────────
  history = historyReduce(history, { type: 'undo' });
  assert.equal(JSON.stringify(item('item_clip_001')), JSON.stringify(originalClip),
    'undo restores the clip byte-exactly, including the transcript it had before');
  assert.deepEqual(item('item_clip_001').transcript, PREVIOUS_WORDS,
    'the pre-existing transcript survives the local apply (I4)');
  assert.equal(item('item_clip_001').transcriptGenerationId, 'gen_cloud_1');
  assert.equal(history.past.length, 0);

  history = historyReduce(history, { type: 'redo' });
  assert.equal(item('item_clip_001').transcript?.length, LOCAL_WORDS.length);

  // ── clear = no transcript, and it is undoable ─────────────────────────────
  const cleared = await execMediaJobTool(
    'apply_artifact',
    { itemId: 'item_clip_001', action: 'clear', feature: 'transcription' },
    ctx,
  ) as Record<string, unknown>;
  assert.equal(cleared.ok, true);
  assert.equal(item('item_clip_001').transcript?.length, 0);
  assert.equal(item('item_clip_001').src, originalClip.src);
  history = historyReduce(history, { type: 'undo' });
  assert.equal(item('item_clip_001').transcript?.length, LOCAL_WORDS.length,
    'clear is undoable like any other command');

  // ── a clip with no transcript: clear is a no-op, not a history step ───────
  const pastBefore = history.past.length;
  const clearAgain = await execMediaJobTool(
    'apply_artifact',
    { itemId: 'item_voice_002', action: 'clear', feature: 'transcription' },
    ctx,
  ) as Record<string, unknown>;
  assert.equal(clearAgain.ok, true);
  assert.equal(clearAgain.transcript, 0);
  assert.equal(history.past.length, pastBefore, 'clearing nothing creates no history step');

  // ── an AUDIO clip accepts the artifact too ────────────────────────────────
  const audioApplied = await execMediaJobTool(
    'apply_artifact',
    { itemId: 'item_voice_002', jobId: 'job_done', feature: 'transcription' },
    ctx,
  ) as Record<string, unknown>;
  assert.equal(audioApplied.ok, true);
  assert.equal(item('item_voice_002').transcript?.length, LOCAL_WORDS.length);
  assert.equal(item('item_voice_002').src, '/media/uploads/clip.mov', 'I4 on an audio clip as well');

  // ── the audio path is untouched by the new feature ────────────────────────
  const mountCallsBefore = calls.filter((call) => call.mount).length;
  const audioClear = await execMediaJobTool(
    'apply_artifact',
    { itemId: 'item_clip_001', action: 'clear', feature: 'voice_cleanup' },
    ctx,
  ) as Record<string, unknown>;
  assert.equal(audioClear.ok, true);
  assert.equal(calls.filter((call) => call.mount).length, mountCallsBefore,
    'clear is local: it reads no route, so it cannot fail on a stopped server');
  assert.equal(item('item_clip_001').denoisedSrc, null, 'and it clears the audio slot');
  assert.equal(item('item_clip_001').transcript?.length, LOCAL_WORDS.length,
    'clearing the audio slot leaves the transcript alone');

  // ── transport failure is a code, not a thrown tool ────────────────────────
  globalThis.fetch = (async () => { throw new Error('ECONNREFUSED 127.0.0.1:5173'); }) as typeof globalThis.fetch;
  const unreachable = await execMediaJobTool(
    'poll_job',
    { jobId: 'job_done', feature: 'transcription' },
    ctx,
  ) as Record<string, unknown>;
  assert.equal(unreachable.ok, false);
  assert.equal(unreachable.code, 'job_transport_failed');
  assert.match(String(unreachable.error), /ECONNREFUSED/);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('media-job transcript apply: transcription writes the transcript slot, source untouched, undo restores the previous transcript, clear restores, refusals coded: OK');
