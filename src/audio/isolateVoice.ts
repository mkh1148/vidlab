// Voice isolation on the client: the Library audio-fx ids, and the ONE definition of
// the job protocol (start / poll / wait / cancel) that every caller shares.
//
// This module used to POST `/api/isolate-voice`, the FFmpeg `afftdn` route that ran
// its own child inside the request handler. That route is gone (D6): the work is a
// media job now, so a cancel reaches the child, the RAM gate sees it, and two clicks
// cannot run two separations at once. What changed here is the transport, not the
// feature — the drop path, the inspector control and the tests all keep one client.
//
// Why the client and not the agent tool group: `start_job`/`poll_job`/`apply_artifact`
// is the agent's path (sessionless, so a long job survives a closed tab). This module
// is the EDITOR's path — a UI that wants progress in a bar and a cancel button.
import type { MediaSourceRevision } from '../editor/mediaSourceRevision';

export const AUDIO_FX_ISOLATE_DEFAULT = 'library:audio-fx:isolate-voice';
export const AUDIO_FX_ISOLATE_LIGHT = 'library:audio-fx:isolate-voice-light';
export const AUDIO_FX_ISOLATE_STRONG = 'library:audio-fx:isolate-voice-strong';

/** Map library audio-fx id → denoise strength 0..100 (the dry/wet mix). */
export function strengthFromAudioFxId(id: string): number {
  if (id === AUDIO_FX_ISOLATE_LIGHT || id.endsWith('-light')) return 35;
  if (id === AUDIO_FX_ISOLATE_STRONG || id.endsWith('-strong')) return 90;
  return 70;
}

export function isIsolateAudioFxId(id: string): boolean {
  return id.startsWith('library:audio-fx:isolate-voice') || id === 'isolate-voice';
}

/** The job route pair this feature owns. */
export const VOICE_ISOLATION_MOUNT = '/api/media-job/voice-isolation';

/**
 * The media-pool upload name behind a `/media/uploads/…` source, or null.
 *
 * The job routes name their source by upload name, never by path: a caller cannot
 * point an engine at an arbitrary file on disk. Every control that starts a job
 * therefore decodes the name out of the clip's `src` here, once.
 */
export function uploadNameOf(src: string | undefined | null): string | null {
  if (!src) return null;
  const match = /^\/media\/uploads\/([^/?#]+)/.exec(src);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/** Matches MEDIA_JOB_WAIT_CLAMP_MS on the server; a poll is a short call. */
const WAIT_CLAMP_MS = 20_000;

export type VoiceIsolationJobStatus =
  | 'queued'
  | 'deferred'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface VoiceIsolationJobSnapshot {
  readonly jobId: string;
  readonly status: VoiceIsolationJobStatus;
  readonly progress: number;
  readonly phase: string | null;
  readonly error: string | null;
  readonly code: string | null;
  readonly artifactUrl: string | null;
  /** The engine namespace from the job key (`voice-isolation`), for the engine tag. */
  readonly engine: string | null;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  readonly deferred: boolean;
}

/** A refusal the route reported as `{error, code}`. */
export class VoiceIsolationError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'VoiceIsolationError';
    this.code = code;
  }
}

function numberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function voiceIsolationJobFromPayload(payload: Record<string, unknown>): VoiceIsolationJobSnapshot {
  const artifact = payload.artifact as { url?: unknown } | null | undefined;
  const key = String(payload.key ?? '');
  const status = String(payload.status ?? 'queued');
  return {
    jobId: String(payload.jobId ?? ''),
    status: (status === 'queued' || status === 'deferred' || status === 'running'
      || status === 'completed' || status === 'failed' || status === 'cancelled'
      ? status
      : 'queued'),
    progress: Number(payload.progress) || 0,
    phase: payload.phase ? String(payload.phase) : null,
    error: payload.error ? String(payload.error) : null,
    code: payload.code ? String(payload.code) : null,
    artifactUrl: artifact?.url ? String(artifact.url) : null,
    engine: key.includes(':') ? key.split(':')[0]! : null,
    startedAt: numberOrNull(payload.startedAt),
    finishedAt: numberOrNull(payload.finishedAt),
    deferred: payload.deferred === true,
  };
}

async function readPayload(response: Response): Promise<Record<string, unknown>> {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

export interface StartVoiceIsolationJobOptions {
  /** Upload name of the source, e.g. `clip.mp4`. */
  readonly sourceName: string;
  /**
   * The source revision the artifact identity is built from. A re-imported source
   * gets a new artifact instead of a stale cache hit, which is why every caller
   * passes the revision it captured rather than letting the server guess.
   */
  readonly revision?: MediaSourceRevision | null;
  readonly signal?: AbortSignal;
}

/** Enqueue one isolation job. Throws `VoiceIsolationError` on a refusal. */
export async function startVoiceIsolationJob(
  options: StartVoiceIsolationJobOptions,
): Promise<VoiceIsolationJobSnapshot> {
  const body: Record<string, unknown> = { sourceName: options.sourceName };
  if (options.revision) body.revision = options.revision;
  const response = await fetch(`${VOICE_ISOLATION_MOUNT}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const payload = await readPayload(response);
  if (response.status !== 202 || !payload.jobId) {
    throw new VoiceIsolationError(
      String(payload.error ?? `voice isolation job start failed (${response.status})`),
      String(payload.code ?? 'job_start_failed'),
    );
  }
  return voiceIsolationJobFromPayload({
    ...payload,
    jobId: payload.jobId,
    artifact: null,
    key: `voice-isolation:${options.sourceName}`,
  });
}

/**
 * Read one job. `waitMs` asks the server to hold the call until the job moves, which
 * is how the drop path waits without a busy loop; it is clamped server-side.
 */
export async function pollVoiceIsolationJob(
  jobId: string,
  options: { waitMs?: number; signal?: AbortSignal } = {},
): Promise<VoiceIsolationJobSnapshot> {
  const waitMs = Math.max(0, Math.min(WAIT_CLAMP_MS, options.waitMs ?? 0));
  const path = waitMs > 0
    ? `/jobs/${encodeURIComponent(jobId)}/wait?timeoutMs=${Math.round(waitMs)}`
    : `/jobs/${encodeURIComponent(jobId)}`;
  const response = await fetch(`${VOICE_ISOLATION_MOUNT}${path}`, {
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const payload = await readPayload(response);
  if (response.status === 404) {
    throw new VoiceIsolationError(String(payload.error ?? `media job not found: ${jobId}`), 'job_not_found');
  }
  if (response.status !== 200) {
    throw new VoiceIsolationError(
      String(payload.error ?? `voice isolation job poll failed (${response.status})`),
      String(payload.code ?? 'job_poll_failed'),
    );
  }
  return voiceIsolationJobFromPayload(payload);
}

/** Ask the server to cancel; the child is killed by the job's own kill policy. */
export async function cancelVoiceIsolationJob(jobId: string): Promise<VoiceIsolationJobSnapshot> {
  const response = await fetch(`${VOICE_ISOLATION_MOUNT}/jobs/${encodeURIComponent(jobId)}`, {
    method: 'DELETE',
  });
  return voiceIsolationJobFromPayload(await readPayload(response));
}

export function voiceIsolationJobIsLive(snapshot: VoiceIsolationJobSnapshot | null): boolean {
  return snapshot !== null
    && (snapshot.status === 'queued' || snapshot.status === 'deferred' || snapshot.status === 'running');
}

export interface VoiceIsolationRunResult {
  /** The artifact URL: `/media/derived/<sourceKey>/<name>`. */
  readonly path: string;
  readonly engine: string | null;
  readonly sourceRevision: MediaSourceRevision;
  readonly elapsedMs: number;
}

export interface RunVoiceIsolationJobOptions extends StartVoiceIsolationJobOptions {
  readonly onProgress?: (snapshot: VoiceIsolationJobSnapshot) => void;
}

/**
 * Start a job and wait for it, for callers that have nowhere to show a progress bar
 * (the Library drop path). The wait is a server-side hold, not a poll timer, so a
 * six-minute clip costs a handful of requests rather than hundreds.
 */
export async function runVoiceIsolationJob(
  options: RunVoiceIsolationJobOptions,
): Promise<VoiceIsolationRunResult> {
  const startedAt = Date.now();
  const sourceRevision = options.revision ?? '';
  let snapshot = await startVoiceIsolationJob(options);
  options.onProgress?.(snapshot);
  while (voiceIsolationJobIsLive(snapshot)) {
    snapshot = await pollVoiceIsolationJob(snapshot.jobId, {
      waitMs: WAIT_CLAMP_MS,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    options.onProgress?.(snapshot);
  }
  if (snapshot.status === 'cancelled') {
    throw new VoiceIsolationError('voice isolation was cancelled', 'job_cancelled');
  }
  if (snapshot.status !== 'completed') {
    throw new VoiceIsolationError(
      snapshot.error ?? 'voice isolation failed',
      snapshot.code ?? 'job_failed',
    );
  }
  if (!snapshot.artifactUrl) {
    throw new VoiceIsolationError('the job completed without an artifact', 'artifact_missing');
  }
  return {
    path: snapshot.artifactUrl,
    engine: snapshot.engine,
    sourceRevision,
    elapsedMs: snapshot.startedAt !== null && snapshot.finishedAt !== null
      ? snapshot.finishedAt - snapshot.startedAt
      : Date.now() - startedAt,
  };
}
