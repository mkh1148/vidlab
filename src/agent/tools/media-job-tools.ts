export { MEDIA_JOB_TOOL_SCHEMAS, MEDIA_JOB_TOOL_NAMES } from './schemas/media-job-tools';
// The D job tool group: start_job -> poll_job -> apply_artifact.
//
// Transport choice (recorded in docs/d-job-implementation.md): the ROUTES are
// server-side (server/media-job-routes.ts) because start/poll are sessionless
// media operations that must survive a closed tab; the TOOLS call those routes
// with the browser bridge, which is the H6 registration convention and the only
// place apply_artifact can run — it is a command-core command, so it must
// dispatch through ctx.commands to be undoable and revision-guarded.
//
// D1b routes `start_job` by `feature`: `background_removal` (the real RVM matting
// engine) is the default, `synthetic` keeps the contract test engine reachable.
// D2 adds `voice_cleanup` (the RNNoise speech clean-up engine) as the second real
// feature. The group's shape — three tools, sessionless start/poll, session-pinned
// apply — is unchanged from D1a.
import type { AgentContext } from '../context';
import { faceAnalysisIdentity, openAnalysisVideo, runFaceAnalysis } from '../../face/faceAnalysisClient';
import type { TimelineItem } from '../../editor/types';
import type { TranscriptWord } from '../../transcript/types';

const MOUNTS: Readonly<Record<string, string>> = {
  background_removal: '/api/media-job/background-removal',
  voice_cleanup: '/api/media-job/voice-cleanup',
  voice_isolation: '/api/media-job/voice-isolation',
  transcription: '/api/media-job/transcription',
  synthetic: '/api/media-job/synthetic',
};

/** The features, spelled once so every refusal lists the same set. */
const FEATURES = 'background_removal, voice_cleanup, voice_isolation, transcription or synthetic';

/**
 * Which editor field a feature's artifact lands in.
 *
 * This is the one place the engines differ in the editor model, so it is declared
 * rather than inferred: a voice clean-up artifact is a WAV and belongs in
 * `denoisedSrc`; a matte is a picture and belongs in `derivedPictureSrc`; a
 * transcript is words and belongs in `transcript` (through `setItemTranscript`).
 */
type ArtifactSlot = 'picture' | 'audio' | 'transcript';

function artifactSlot(feature: string): ArtifactSlot {
  if (feature === 'voice_cleanup' || feature === 'voice_isolation') return 'audio';
  if (feature === 'transcription') return 'transcript';
  return 'picture';
}
/** Matches MEDIA_JOB_WAIT_CLAMP_MS on the server; a poll is a short call. */
const WAIT_CLAMP_MS = 20_000;

/**
 * The only artifact URL shape the app produces (reviewer condition C1):
 * `/media/derived/<sourceKey>/<encodeURIComponent(name)>`.
 *
 * A flat `/media/derived/<name>` would put every source's artifacts in one
 * NTFS-case-insensitive directory, and anything deeper or with a traversal
 * segment is a URL the app never makes. Both are refused rather than normalised.
 */
const DERIVED_ARTIFACT_URL = /^\/media\/derived\/([^/?#]+)\/([^/?#]+)$/;

function derivedArtifactUrlIsValid(url: string): boolean {
  const match = DERIVED_ARTIFACT_URL.exec(url);
  if (!match) return false;
  for (const segment of [match[1]!, match[2]!]) {
    if (segment === '.' || segment === '..') return false;
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return false;
    }
    if (!decoded || decoded === '.' || decoded === '..') return false;
    if (decoded.includes('/') || decoded.includes('\\')) return false;
  }
  return true;
}

type Args = Record<string, unknown>;

interface JobArtifact {
  file?: string;
  url?: string;
  bytes?: number;
}

interface JobPayload {
  ok?: boolean;
  jobId?: string;
  key?: string;
  status?: string;
  progress?: number;
  phase?: string | null;
  detail?: Record<string, number | string> | null;
  artifact?: JobArtifact | null;
  intermediate?: JobArtifact[] | null;
  target?: { file: string; url: string } | null;
  error?: string | null;
  code?: string | null;
  deduped?: boolean;
}

function failure(error: string, code: string, extra?: Record<string, unknown>): Record<string, unknown> {
  return { ok: false, error, code, ...extra };
}

async function callJobRoute(
  mount: string,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: JobPayload }> {
  const response = await fetch(`${mount}${path}`, init);
  const body = (await response.json().catch(() => ({}))) as JobPayload;
  return { status: response.status, body };
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function findItem(items: readonly TimelineItem[], value: unknown): TimelineItem | null {
  const query = String(value ?? '').trim();
  if (!query) return null;
  const exact = items.find((item) => item.id === query);
  if (exact) return exact;
  const matches = items.filter((item) => item.id.startsWith(query));
  return matches.length === 1 ? matches[0]! : null;
}

async function startJob(args: Args): Promise<unknown> {
  const sourceName = String(args.sourceName ?? '').trim();
  if (!sourceName) return failure('sourceName is required (the upload name of the source clip)', 'invalid_argument');
  const feature = String(args.feature ?? 'background_removal');
  const mount = MOUNTS[feature];
  if (!mount) {
    return failure(
      `unknown feature ${feature} (use ${FEATURES})`,
      'invalid_argument',
    );
  }
  const body: Record<string, unknown> = { sourceName };
  if (feature === 'background_removal') {
    const revision = String(args.revision ?? '').trim();
    if (revision) body.revision = revision;
    const ratio = finiteNumber(args.ratio);
    if (ratio !== undefined) body.ratio = ratio;
  } else if (feature === 'voice_cleanup' || feature === 'voice_isolation') {
    const revision = String(args.revision ?? '').trim();
    if (revision) body.revision = revision;
  } else if (feature === 'transcription') {
    const revision = String(args.revision ?? '').trim();
    if (revision) body.revision = revision;
    const model = String(args.model ?? '').trim();
    if (model) body.model = model;
    const language = String(args.language ?? '').trim();
    if (language) body.language = language;
  } else {
    body.engine = args.engine === 'multi-step' ? 'multi-step' : 'sleep';
    const steps = finiteNumber(args.steps);
    if (steps !== undefined) body.steps = steps;
    const stepMs = finiteNumber(args.stepMs);
    if (stepMs !== undefined) body.stepMs = stepMs;
    const crashAfter = finiteNumber(args.crashAfter);
    if (crashAfter !== undefined) body.crashAfter = crashAfter;
  }

  let result: { status: number; body: JobPayload };
  try {
    result = await callJobRoute(mount, '/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return failure(
      `could not reach the media job service: ${error instanceof Error ? error.message : String(error)}`,
      'job_transport_failed',
    );
  }
  if (result.status !== 202 || !result.body.jobId) {
    return failure(
      result.body.error ?? `media job start failed (${result.status})`,
      result.body.code ?? 'job_start_failed',
    );
  }
  return {
    ok: true,
    jobId: result.body.jobId,
    feature,
    status: result.body.status ?? 'queued',
    deduped: result.body.deduped === true,
    next: 'poll_job',
  };
}

async function pollJob(args: Args): Promise<unknown> {
  const jobId = String(args.jobId ?? '').trim();
  if (!jobId) return failure('jobId is required', 'invalid_argument');
  const feature = String(args.feature ?? 'background_removal');
  const mount = MOUNTS[feature];
  if (!mount) {
    return failure(
      `unknown feature ${feature} (use ${FEATURES})`,
      'invalid_argument',
    );
  }
  const waitMs = Math.max(0, Math.min(WAIT_CLAMP_MS, finiteNumber(args.waitMs) ?? 0));
  const path = waitMs > 0
    ? `/jobs/${encodeURIComponent(jobId)}/wait?timeoutMs=${Math.round(waitMs)}`
    : `/jobs/${encodeURIComponent(jobId)}`;

  let result: { status: number; body: JobPayload };
  try {
    result = await callJobRoute(mount, path);
  } catch (error) {
    return failure(
      `could not reach the media job service: ${error instanceof Error ? error.message : String(error)}`,
      'job_transport_failed',
    );
  }
  if (result.status === 404) {
    return failure(result.body.error ?? `media job not found: ${jobId}`, 'job_not_found');
  }
  if (result.status !== 200) {
    return failure(
      result.body.error ?? `media job poll failed (${result.status})`,
      result.body.code ?? 'job_poll_failed',
    );
  }
  const body = result.body;
  return {
    ok: body.status !== 'failed',
    jobId: body.jobId ?? jobId,
    status: body.status ?? null,
    progress: body.progress ?? 0,
    phase: body.phase ?? null,
    detail: body.detail ?? null,
    artifact: body.artifact ?? null,
    target: body.target ?? null,
    error: body.error ?? null,
    code: body.code ?? null,
  };
}

/** Words a transcript artifact may carry; a hostile or corrupt file must not freeze the editor. */
const MAX_TRANSCRIPT_WORDS = 200_000;

type TranscriptRead =
  | { readonly words: TranscriptWord[] }
  | { readonly error: string; readonly code: string };

/**
 * Read a transcript artifact back from its derived URL.
 *
 * The artifact is a JSON file the engine wrote, and the tool is the only reader that
 * turns it into project state — so it is validated here rather than trusted: a word
 * needs non-empty text and finite, ordered, non-negative times, and an artifact with
 * no words is refused instead of silently clearing the clip's transcript.
 */
async function readTranscriptArtifact(url: string): Promise<TranscriptRead> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    return {
      error: `could not read the transcript artifact: ${error instanceof Error ? error.message : String(error)}`,
      code: 'artifact_unreadable',
    };
  }
  if (!response.ok) {
    return {
      error: `the transcript artifact is not readable (${response.status})`,
      code: 'artifact_unreadable',
    };
  }
  const payload = await response.json().catch(() => null) as { words?: unknown } | null;
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.words)) {
    return { error: 'the artifact is not a transcript (no words array)', code: 'invalid_artifact_shape' };
  }
  if (payload.words.length > MAX_TRANSCRIPT_WORDS) {
    return {
      error: `the transcript has ${payload.words.length} words, more than the ${MAX_TRANSCRIPT_WORDS} this tool accepts`,
      code: 'artifact_too_large',
    };
  }
  const words: TranscriptWord[] = [];
  for (const entry of payload.words) {
    if (!entry || typeof entry !== 'object') {
      return { error: 'the transcript has a word that is not an object', code: 'invalid_artifact_shape' };
    }
    const record = entry as Record<string, unknown>;
    const text = String(record.text ?? '').trim();
    const start = Number(record.start);
    const end = Number(record.end);
    if (!text || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
      return {
        error: `the transcript has a word with no usable text or times: ${JSON.stringify(record)}`,
        code: 'invalid_artifact_shape',
      };
    }
    words.push({ text, start: Math.round(start), end: Math.round(end) });
  }
  if (words.length === 0) {
    return {
      error: 'the transcript has no words (the source may hold no speech); nothing was applied',
      code: 'transcript_empty',
    };
  }
  return { words };
}

/**
 * Apply a transcript artifact: ONE command, and the clip keeps everything else.
 *
 * `setItemTranscript` is the existing command-core command for "this clip's words are
 * these" — it starts a new transcript generation, clears the edits that referred to
 * the old words, and is undoable, so the transcript the clip had before is one undo
 * away (I4 for a transcript). A re-apply of the same words is a no-op, not a phantom
 * history step.
 */
async function applyTranscriptArtifact(
  item: TimelineItem,
  url: string,
  jobId: string,
  engine: string | null,
  ctx: AgentContext,
): Promise<unknown> {
  const read = await readTranscriptArtifact(url);
  if ('code' in read) return failure(read.error, read.code);
  const words = read.words;
  const previous = item.transcript ?? [];
  const unchanged = previous.length === words.length
    && previous.every((word, index) => word.text === words[index]!.text
      && word.start === words[index]!.start
      && word.end === words[index]!.end);
  if (unchanged) {
    return {
      ok: true,
      itemId: item.id,
      action: 'apply',
      jobId,
      transcript: words.length,
      transcriptArtifact: url,
      engine,
      unchanged: true,
      note: 'the clip already carries exactly this transcript; nothing changed',
    };
  }
  ctx.commands.setItemTranscript(item.id, words);
  return {
    ok: true,
    itemId: item.id,
    action: 'apply',
    jobId,
    transcript: words.length,
    transcriptArtifact: url,
    engine,
    unchanged: false,
    note: 'the clip keeps its original source (I4) and gains a word-timed transcript; undo restores the transcript it had before',
  };
}

async function applyArtifact(args: Args, ctx: AgentContext): Promise<unknown> {
  const state = ctx.getState();
  const item = findItem(state.items, args.itemId);
  if (!item) {
    return failure(
      `clip not found or ambiguous: ${String(args.itemId ?? '(missing itemId)')}`,
      'unknown_item',
    );
  }
  const feature = String(args.feature ?? 'background_removal');
  const mount = MOUNTS[feature];
  if (!mount) {
    return failure(`unknown feature ${feature} (use ${FEATURES})`, 'invalid_argument');
  }
  const slot = artifactSlot(feature);
  const supported: readonly string[] = slot === 'picture' ? ['video', 'image'] : ['video', 'audio'];
  if (!supported.includes(item.kind)) {
    return failure(
      slot === 'picture'
        ? `item ${item.id} is ${item.kind}; a derived picture needs a video or image clip`
        : slot === 'audio'
          ? `item ${item.id} is ${item.kind}; a cleaned voice track needs a video or audio clip`
          : `item ${item.id} is ${item.kind}; a transcript needs a clip with speech (video or audio)`,
      'unsupported_item_kind',
    );
  }
  const action = String(args.action ?? 'apply').toLowerCase();

  if (action === 'clear') {
    if (slot === 'transcript') {
      if (!item.transcript?.length) {
        return { ok: true, itemId: item.id, action: 'clear', transcript: 0, note: 'the clip has no transcript' };
      }
      // Undoable like every other command: the previous transcript is one history
      // step away, which is what I4 means for a transcript.
      ctx.commands.setItemTranscript(item.id, []);
      return {
        ok: true,
        itemId: item.id,
        action: 'clear',
        transcript: 0,
        note: 'the clip has no transcript; undo restores the previous one',
      };
    }
    if (slot === 'audio') {
      if (!item.denoisedSrc) {
        return { ok: true, itemId: item.id, action: 'clear', denoisedSrc: null, note: 'the clip already plays its original audio' };
      }
      ctx.commands.setItemDenoise(item.id, null);
      return { ok: true, itemId: item.id, action: 'clear', denoisedSrc: null };
    }
    if (!item.derivedPictureSrc) {
      return { ok: true, itemId: item.id, action: 'clear', derivedPictureSrc: null, note: 'the clip already shows its original picture' };
    }
    ctx.commands.setItemDerivedPicture(item.id, null);
    return { ok: true, itemId: item.id, action: 'clear', derivedPictureSrc: null };
  }
  if (action !== 'apply') {
    return failure(`unknown action ${action} (use apply or clear)`, 'invalid_argument');
  }

  const jobId = String(args.jobId ?? '').trim();
  if (!jobId) return failure('jobId is required to apply an artifact', 'invalid_argument');

  let result: { status: number; body: JobPayload };
  try {
    result = await callJobRoute(mount, `/jobs/${encodeURIComponent(jobId)}`);
  } catch (error) {
    return failure(
      `could not reach the media job service: ${error instanceof Error ? error.message : String(error)}`,
      'job_transport_failed',
    );
  }
  if (result.status === 404) {
    return failure(result.body.error ?? `media job not found: ${jobId}`, 'job_not_found');
  }
  if (result.status !== 200) {
    return failure(
      result.body.error ?? `media job poll failed (${result.status})`,
      result.body.code ?? 'job_poll_failed',
    );
  }

  const body = result.body;
  if (body.status !== 'completed') {
    return failure(
      `job ${jobId} is ${body.status ?? 'unknown'}; only a completed job can be applied`,
      'job_not_complete',
      { status: body.status ?? null, jobError: body.error ?? null, jobCode: body.code ?? null },
    );
  }
  const url = String(body.artifact?.url ?? '');
  if (!url) {
    return failure(`job ${jobId} completed without an artifact`, 'artifact_missing');
  }
  if (!derivedArtifactUrlIsValid(url)) {
    return failure(
      `artifact url ${url} is not a derived artifact location; D artifacts live at /media/derived/<sourceKey>/<name>`,
      'invalid_artifact_url',
    );
  }

  // The engine identity is the job key's namespace (`synthetic-sleep:...`), which
  // is what the engine itself declared when it enqueued. D1b's matting engine
  // uses its own namespace, so the inspector and the model cache read the same
  // field without a second lookup.
  const engine = String(body.key ?? '').split(':')[0] || null;

  if (slot === 'transcript') {
    return applyTranscriptArtifact(item, url, jobId, engine, ctx);
  }

  if (slot === 'audio') {
    // Full wet: the artifact IS the processed voice, so the dry/wet blend has no
    // reason to sit anywhere but 1. The original stays in `src` (I4) and the
    // preview/export mix reads `denoisedSrc` at this strength.
    //
    // The engine tag is what tells the two audio engines apart: D2's clean-up and
    // D6's isolation both write this slot, and without the tag the inspector could
    // not say which one produced the file (or offer the right switch).
    const unchanged = item.denoisedSrc === url
      && item.denoiseStrength === 100
      && (item.denoisedEngine ?? null) === engine;
    ctx.commands.setItemDenoise(item.id, url, 100, engine);
    return {
      ok: true,
      itemId: item.id,
      action: 'apply',
      jobId,
      denoisedSrc: url,
      denoiseStrength: 100,
      denoisedEngine: engine,
      engine,
      bytes: body.artifact?.bytes ?? null,
      unchanged,
      note: 'the clip keeps its original source (I4) and plays the processed track in the mix; undo removes the derived reference',
    };
  }

  const unchanged = item.derivedPictureSrc === url;
  ctx.commands.setItemDerivedPicture(item.id, url, engine);
  return {
    ok: true,
    itemId: item.id,
    action: 'apply',
    jobId,
    derivedPictureSrc: url,
    derivedPictureEngine: engine,
    bytes: body.artifact?.bytes ?? null,
    unchanged,
    note: 'the clip keeps its original source for audio and every fallback (I4); undo removes the derived reference',
  };
}

/**
 * D4 · `analyze_face`: run the Face Landmarker over a whole source and store the
 * landmark track + skin-mask atlas as effect assets.
 *
 * Sessionless in the same sense as start_job — it claims no project and touches no
 * timeline — but it runs in the RENDERER rather than on the server, because the
 * MediaPipe runtime needs a DOM canvas (docs/d-job-implementation.md §D4). The
 * artifact still lands in the per-source derived directory through the server route,
 * so the identity, the naming and the clean-up are the D contract's, unchanged.
 */
const FACE_RETOUCH_EFFECT = 'builtin:fx-face-retouch';

async function analyzeFace(args: Args, ctx: AgentContext): Promise<unknown> {
  const sourceName = String(args.sourceName ?? '').trim();
  if (!sourceName) {
    return failure('sourceName is required (the upload name of the source clip)', 'invalid_argument');
  }
  const revision = args.revision === undefined || args.revision === null || args.revision === ''
    ? undefined
    : String(args.revision);
  const identity = faceAnalysisIdentity(sourceName, revision);
  const src = `/media/uploads/${encodeURIComponent(sourceName)}`;
  let video: HTMLVideoElement | null = null;
  try {
    video = await openAnalysisVideo(src);
    const result = await runFaceAnalysis({ identity, video, sourceFps: ctx.getState().fps });
    return {
      ok: true,
      sourceName,
      trackUrl: result.trackUrl,
      atlasUrl: result.atlasUrl,
      engine: result.engine,
      samples: result.sampleCount,
      facesFound: result.facesFound,
      trackBytes: result.trackBytes,
      atlasBytes: result.atlasBytes,
      atlasWidth: result.atlasWidth,
      atlasHeight: result.atlasHeight,
      elapsedMs: result.elapsedMs,
      note: 'the track is keyed by SOURCE frame, so every trim of this source lines up; '
        + 'attach it with apply_face_retouch, which also adds the retouch effect',
    };
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'face_analysis_failed';
    return failure(error instanceof Error ? error.message : String(error), code);
  } finally {
    if (video) {
      video.removeAttribute('src');
      video.load();
    }
  }
}

/**
 * D4 · `apply_face_retouch`: the effect's slot in the editor model.
 *
 * The slot is two clip fields — `faceTrackUrl` and `faceAtlasUrl` — plus the effect
 * instance that reads them. Applying both in one batch keeps undo one step, which is
 * what the user sees: one action put the retouch on the clip.
 */
async function applyFaceRetouch(args: Args, ctx: AgentContext): Promise<unknown> {
  const state = ctx.getState();
  const item = findItem(state.items, args.itemId);
  if (!item) {
    return failure(`clip not found or ambiguous: ${String(args.itemId ?? '(missing itemId)')}`, 'unknown_item');
  }
  if (item.kind !== 'video' && item.kind !== 'image') {
    return failure(`item ${item.id} is ${item.kind}; face retouching needs a video or image clip`, 'unsupported_item_kind');
  }
  const action = String(args.action ?? 'apply').toLowerCase();
  if (action === 'clear') {
    if (!item.faceTrackUrl && !item.faceAtlasUrl) {
      return { ok: true, itemId: item.id, action: 'clear', faceTrackUrl: null, faceAtlasUrl: null, note: 'the clip has no face analysis' };
    }
    ctx.commands.setItemFaceRetouch(item.id, null, null);
    return {
      ok: true,
      itemId: item.id,
      action: 'clear',
      faceTrackUrl: null,
      faceAtlasUrl: null,
      note: 'the clip renders without retouching; the effect instance stays, so the sliders keep their values',
    };
  }
  if (action !== 'apply') {
    return failure(`unknown action ${action} (use apply or clear)`, 'invalid_argument');
  }
  const trackUrl = String(args.trackUrl ?? '').trim();
  const atlasUrl = String(args.atlasUrl ?? '').trim();
  if (!trackUrl || !atlasUrl) {
    return failure('trackUrl and atlasUrl are both required to apply a face analysis', 'invalid_argument');
  }
  if (!derivedArtifactUrlIsValid(trackUrl) || !derivedArtifactUrlIsValid(atlasUrl)) {
    return failure(
      'a face artifact must be a derived artifact location (/media/derived/<sourceKey>/<name>)',
      'invalid_artifact_url',
    );
  }
  const engine = args.engine === undefined || args.engine === null || args.engine === '' ? null : String(args.engine);
  const unchanged = item.faceTrackUrl === trackUrl && item.faceAtlasUrl === atlasUrl;
  const effects = item.effects ?? [];
  if (effects.some((effect) => effect.assetId === FACE_RETOUCH_EFFECT)) {
    ctx.commands.setItemFaceRetouch(item.id, trackUrl, atlasUrl, engine);
  } else {
    ctx.commands.batch([
      {
        type: 'setEffects',
        id: item.id,
        effects: [...effects, { id: `fx_${crypto.randomUUID()}`, assetId: FACE_RETOUCH_EFFECT, overrides: {} }],
      },
      { type: 'setItemFaceRetouch', id: item.id, trackUrl, atlasUrl, engine },
    ], 'Apply face retouch');
  }
  return {
    ok: true,
    itemId: item.id,
    action: 'apply',
    faceTrackUrl: trackUrl,
    faceAtlasUrl: atlasUrl,
    faceRetouchEngine: engine,
    unchanged,
    note: 'the clip keeps its original source (I4) and gains a face track, a skin mask and the retouch effect; undo removes both',
  };
}

export async function execMediaJobTool(
  name: string,
  args: Args,
  ctx: AgentContext,
): Promise<unknown> {
  if (name === 'start_job') return startJob(args);
  if (name === 'poll_job') return pollJob(args);
  if (name === 'apply_artifact') return applyArtifact(args, ctx);
  if (name === 'analyze_face') return analyzeFace(args, ctx);
  if (name === 'apply_face_retouch') return applyFaceRetouch(args, ctx);
  return failure(`unknown tool ${name}`, 'unknown_tool');
}
