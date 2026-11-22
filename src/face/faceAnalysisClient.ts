// D4 · the browser half of "Analyze face": run the pass, then hand the artifacts to
// the server that owns them.
//
// Why this is not a media-job child: the MediaPipe runtime needs a DOM canvas, and
// Node has none (probe in docs/d-job-implementation.md §D4). The pass therefore runs
// where the decoder and the model already live — the renderer — and the server keeps
// only the ARTIFACT (server/face-analysis.ts). The split is the same one D1 and D3a
// use for their artifacts; only the producer moved.
//
// Everything here is per SOURCE, never per clip: the track is keyed by source frame,
// so one analysis serves every trim, every speed change and every copy of the clip.
import {
  FACE_ANALYSIS_FPS,
  type FaceTrack,
} from './faceTrack.ts';
import { FACE_ATLAS_CELL } from './faceAtlas.ts';
import {
  analyzeFaceFrames,
  encodeFaceAtlasPng,
  videoFrameSeeker,
  type FaceAnalysisProgress,
} from './analyzeFace.ts';
import { FACE_INFERENCE_EDGE, getFaceRuntime } from './faceLandmarker.ts';

/** The route pair that owns the artifacts (server/plugins/media-job-face.ts). */
export const FACE_ANALYSIS_ROUTE = '/api/media-job/face-analysis';

/** What the server needs to name the artifact: the source, its revision, the options. */
export interface FaceAnalysisIdentity {
  readonly sourceName: string;
  readonly revision?: string;
  readonly analysisFps: number;
  readonly cell: number;
}

export interface FaceAnalysisArtifacts {
  readonly trackUrl: string;
  readonly atlasUrl: string;
  readonly trackBytes: number;
  readonly atlasBytes: number;
  readonly engine: string;
}

export interface FaceAnalysisRun extends FaceAnalysisArtifacts {
  readonly sampleCount: number;
  readonly facesFound: number;
  readonly atlasWidth: number;
  readonly atlasHeight: number;
  readonly elapsedMs: number;
}

/** A refusal with a stable code, so the control can word it and the agent can branch. */
export class FaceAnalysisRunError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'FaceAnalysisRunError';
    this.code = code;
  }
}

export function faceAnalysisIdentity(sourceName: string, revision?: string): FaceAnalysisIdentity {
  return {
    sourceName,
    ...(revision ? { revision } : {}),
    analysisFps: FACE_ANALYSIS_FPS,
    cell: FACE_ATLAS_CELL,
  };
}

function queryOf(identity: FaceAnalysisIdentity): string {
  const params = new URLSearchParams({
    sourceName: identity.sourceName,
    analysisFps: String(identity.analysisFps),
    cell: String(identity.cell),
  });
  if (identity.revision) params.set('revision', identity.revision);
  return params.toString();
}

/** Base64 without spreading a megabyte into an argument list. */
function base64Of(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** The cached pair for this source, or null when there is none. */
export async function cachedFaceAnalysis(identity: FaceAnalysisIdentity): Promise<FaceAnalysisArtifacts | null> {
  const response = await fetch(`${FACE_ANALYSIS_ROUTE}?${queryOf(identity)}`);
  if (response.status === 404) return null;
  const payload = await jsonOf(response);
  if (!response.ok) {
    throw new FaceAnalysisRunError(
      String(payload.error ?? `face analysis lookup failed (${response.status})`),
      String(payload.code ?? 'face_analysis_lookup_failed'),
    );
  }
  return {
    trackUrl: String(payload.trackUrl ?? ''),
    atlasUrl: String(payload.atlasUrl ?? ''),
    trackBytes: Number(payload.trackBytes) || 0,
    atlasBytes: Number(payload.atlasBytes) || 0,
    engine: String(payload.engine ?? ''),
  };
}

/** Forget the cached pair (the inspector's "remove analysis"). */
export async function forgetFaceAnalysis(identity: FaceAnalysisIdentity): Promise<void> {
  const response = await fetch(`${FACE_ANALYSIS_ROUTE}?${queryOf(identity)}`, { method: 'DELETE' });
  if (!response.ok) {
    const payload = await jsonOf(response);
    throw new FaceAnalysisRunError(
      String(payload.error ?? `face analysis removal failed (${response.status})`),
      String(payload.code ?? 'face_analysis_remove_failed'),
    );
  }
}

/**
 * Run the pass over one source and persist the pair.
 *
 * `video` must already have metadata (the caller awaits `loadedmetadata`): the frame
 * count comes from the media itself, so a clip that was trimmed on the timeline still
 * analyses its whole source and the track stays valid for every trim of it.
 */
export async function runFaceAnalysis(input: {
  readonly identity: FaceAnalysisIdentity;
  readonly video: HTMLVideoElement;
  readonly sourceFps: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (update: FaceAnalysisProgress) => void;
}): Promise<FaceAnalysisRun> {
  const { identity, video, sourceFps, signal } = input;
  if (!Number.isFinite(video.duration) || video.duration <= 0) {
    throw new FaceAnalysisRunError('the source has no readable duration', 'source_unreadable');
  }
  const runtime = await getFaceRuntime(signal);
  if (!runtime) {
    throw new FaceAnalysisRunError(
      'the face models could not be loaded (check the model cache and the browser console)',
      'face_runtime_unavailable',
    );
  }
  const sourceFrames = Math.max(1, Math.round(video.duration * sourceFps));
  const outcome = await analyzeFaceFrames({
    sourceFps,
    sourceFrames,
    runtime,
    seek: videoFrameSeeker(video, { sourceFps, edge: FACE_INFERENCE_EDGE }),
    analysisFps: identity.analysisFps,
    cell: identity.cell,
    ...(signal ? { signal } : {}),
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
  });
  const atlasPng = await encodeFaceAtlasPng(outcome.atlas, outcome.atlasWidth, outcome.atlasHeight);
  const response = await fetch(FACE_ANALYSIS_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...identity,
      track: outcome.track satisfies FaceTrack,
      atlasPng: base64Of(atlasPng),
    }),
  });
  const payload = await jsonOf(response);
  if (!response.ok) {
    throw new FaceAnalysisRunError(
      String(payload.error ?? `face analysis could not be saved (${response.status})`),
      String(payload.code ?? 'face_analysis_write_failed'),
    );
  }
  return {
    trackUrl: String(payload.trackUrl ?? ''),
    atlasUrl: String(payload.atlasUrl ?? ''),
    trackBytes: Number(payload.trackBytes) || 0,
    atlasBytes: Number(payload.atlasBytes) || 0,
    engine: String(payload.engine ?? ''),
    sampleCount: outcome.sampleCount,
    facesFound: outcome.facesFound,
    atlasWidth: outcome.atlasWidth,
    atlasHeight: outcome.atlasHeight,
    elapsedMs: outcome.elapsedMs,
  };
}

/**
 * A detached video element for one source URL, ready to seek.
 *
 * Detached on purpose: the analysis must not disturb the preview's own element, and
 * the pass needs to seek freely across the whole source rather than wherever the
 * playhead happens to be.
 */
export async function openAnalysisVideo(src: string, signal?: AbortSignal): Promise<HTMLVideoElement> {
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  video.crossOrigin = 'anonymous';
  video.src = src;
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(new FaceAnalysisRunError('the analysis was cancelled', 'cancelled')); };
    const onError = () => { cleanup(); reject(new FaceAnalysisRunError('the source could not be decoded', 'source_unreadable')); };
    const onLoaded = () => { cleanup(); resolve(); };
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    video.addEventListener('loadedmetadata', onLoaded, { once: true });
    video.addEventListener('error', onError, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  return video;
}
