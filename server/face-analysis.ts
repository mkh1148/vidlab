// D4 · where "Analyze face" puts its two artifacts, and how a later run finds them.
//
// The analyze pass runs in the renderer (see docs/d-job-implementation.md §D4: the
// MediaPipe runtime needs the DOM, so it cannot be a media-job child), but the
// ARTIFACTS are server-owned, exactly like D1's matte and D3a's transcript:
//
//   <media root>/derived/<sourceKey>/<name>.face-track.<rev>.<engine>.json
//   <media root>/derived/<sourceKey>/<name>.face-atlas.<rev>.<engine>.png
//
// Both names come from the H2 namer through `mediaJobArtifactLocation`, so the
// 240-byte cap, the per-source directory and the `/media/derived/<key>/<name>` URL
// shape are the same rules every other D artifact obeys — no second naming scheme.
//
// Cache identity is revision + engine version + the two options that change the
// bytes (samples per second, atlas cell size). A model change moves
// FACE_ANALYSIS_ENGINE_VERSION and therefore the file name, so an old track stays on
// disk as the record of what the old model measured instead of being overwritten.
import { mkdir, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseFaceTrack } from '../src/face/faceTrack.ts';
import {
  MEDIA_JOB_DERIVED_URL_PREFIX,
  mediaJobArtifactLocation,
  mediaJobDerivedRoot,
  mediaJobSourceKey,
  type MediaJobArtifactLocation,
} from './media-job-artifact.ts';
import { FACE_ANALYSIS_ENGINE_VERSION } from './face-model.ts';
import { runtimeProfile, type RuntimeProfile } from './runtime-profile.ts';

/** Feature markers in the artifact name; `face-track` / `face-atlas` are the kinds. */
export const FACE_TRACK_SEGMENT = 'face-track';
export const FACE_ATLAS_SEGMENT = 'face-atlas';

/** A 128-cell atlas of 128 px cells is ~1 MB of PNG; anything near this is not one. */
export const FACE_ATLAS_MAX_BYTES = 24 * 1024 * 1024;

export interface FaceAnalysisIdentity {
  /** Upload name of the source, e.g. `clip.mp4`. */
  readonly sourceName: string;
  /** Source revision, so a re-import produces a new artifact instead of a stale hit. */
  readonly revision?: string | number;
  /** Samples per second of source time (the track's own `analysisFps`). */
  readonly analysisFps: number;
  /** Atlas cell edge in pixels (the track's own `cell`). */
  readonly cell: number;
}

export interface FaceAnalysisLocations {
  readonly track: MediaJobArtifactLocation;
  readonly atlas: MediaJobArtifactLocation;
  readonly sourceKey: string;
}

/** Where both artifacts for one source would land. Pure path arithmetic. */
export function faceAnalysisLocations(
  identity: FaceAnalysisIdentity,
  profile: RuntimeProfile = runtimeProfile(),
): FaceAnalysisLocations {
  const options = { fps: identity.analysisFps, cell: identity.cell };
  const common = {
    sourceName: identity.sourceName,
    ...(identity.revision === undefined ? {} : { revision: identity.revision }),
    engineVersion: FACE_ANALYSIS_ENGINE_VERSION,
    options,
  };
  const track = mediaJobArtifactLocation(
    { ...common, segments: [FACE_TRACK_SEGMENT], extension: 'json' },
    profile,
  );
  const atlas = mediaJobArtifactLocation(
    { ...common, segments: [FACE_ATLAS_SEGMENT], extension: 'png' },
    profile,
  );
  return { track, atlas, sourceKey: track.sourceKey };
}

export interface FaceAnalysisArtifacts {
  readonly trackUrl: string;
  readonly atlasUrl: string;
  readonly trackBytes: number;
  readonly atlasBytes: number;
  readonly engine: string;
  /** True when both files were already on disk and nothing was written. */
  readonly cached: boolean;
}

async function bytesOf(file: string): Promise<number> {
  try {
    const info = await stat(file);
    return info.isFile() ? info.size : 0;
  } catch {
    return 0;
  }
}

/**
 * The cache hit: both artifacts present and non-empty.
 *
 * Both, not either — a track without its atlas would render the landmark fallback
 * while claiming a mask, and an atlas without its track has no frame to align to.
 */
export async function readFaceAnalysis(
  identity: FaceAnalysisIdentity,
  profile: RuntimeProfile = runtimeProfile(),
): Promise<FaceAnalysisArtifacts | null> {
  const locations = faceAnalysisLocations(identity, profile);
  const [trackBytes, atlasBytes] = await Promise.all([
    bytesOf(locations.track.file),
    bytesOf(locations.atlas.file),
  ]);
  if (trackBytes <= 0 || atlasBytes <= 0) return null;
  return {
    trackUrl: locations.track.url,
    atlasUrl: locations.atlas.url,
    trackBytes,
    atlasBytes,
    engine: FACE_ANALYSIS_ENGINE_VERSION,
    cached: true,
  };
}

/** A refusal a route can translate into `{error, code}` with a status. */
export class FaceAnalysisError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status = 400) {
    super(message);
    this.name = 'FaceAnalysisError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Persist one analysis.
 *
 * The track is re-validated here rather than trusted from the caller: it is the
 * file every later render aligns a mask to, and a malformed one would fail at
 * render time (in the export, minutes later) instead of at write time. The atlas
 * is written first and the track second, so a crash between the two leaves a
 * cache miss (no track) rather than a track promising a mask that is not there.
 */
export async function writeFaceAnalysis(input: {
  readonly identity: FaceAnalysisIdentity;
  readonly track: unknown;
  readonly atlasPng: Uint8Array;
  readonly profile?: RuntimeProfile;
}): Promise<FaceAnalysisArtifacts> {
  const profile = input.profile ?? runtimeProfile();
  const track = parseFaceTrack(input.track);
  if (!track) {
    throw new FaceAnalysisError(
      'the landmark track is not a valid face track (version, ordered samples and boxes are required)',
      'invalid_face_track',
    );
  }
  if (track.analysisFps !== input.identity.analysisFps || track.cell !== input.identity.cell) {
    throw new FaceAnalysisError(
      'the landmark track disagrees with the requested analysis options',
      'face_track_options_mismatch',
    );
  }
  const png = input.atlasPng;
  if (png.length === 0) {
    throw new FaceAnalysisError('the skin-mask atlas is empty', 'empty_face_atlas');
  }
  if (png.length > FACE_ATLAS_MAX_BYTES) {
    throw new FaceAnalysisError('the skin-mask atlas is too large to be an atlas', 'face_atlas_too_large', 413);
  }
  // PNG signature: a caller that posts JSON where an image belongs must not leave a
  // file the renderer will fetch and fail to decode.
  const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!PNG_SIGNATURE.every((byte, index) => png[index] === byte)) {
    throw new FaceAnalysisError('the skin-mask atlas is not a PNG', 'face_atlas_not_png');
  }

  const locations = faceAnalysisLocations(input.identity, profile);
  await mkdir(locations.track.dir, { recursive: true });
  await writeFile(locations.atlas.file, png);
  const trackJson = new TextEncoder().encode(JSON.stringify(track));
  await writeFile(locations.track.file, trackJson);
  return {
    trackUrl: locations.track.url,
    atlasUrl: locations.atlas.url,
    trackBytes: trackJson.length,
    atlasBytes: png.length,
    engine: FACE_ANALYSIS_ENGINE_VERSION,
    cached: false,
  };
}

/** Remove one artifact by URL-shaped location; used by the restore path. */
export async function removeFaceAnalysisFiles(
  identity: FaceAnalysisIdentity,
  profile: RuntimeProfile = runtimeProfile(),
): Promise<void> {
  const locations = faceAnalysisLocations(identity, profile);
  await unlink(locations.track.file).catch(() => undefined);
  await unlink(locations.atlas.file).catch(() => undefined);
}

/**
 * Media clean-up: remove everything derived from one source.
 *
 * The kit's rule is that the atlas is an effect asset and travels with the media, so
 * deleting the upload must not leave a per-source directory behind forever. This
 * removes the whole `<derived>/<sourceKey>/` tree — the matte, the voice copy, the
 * transcript and the face artifacts — because once no project references the source,
 * none of them can be reached again.
 */
export async function removeDerivedSource(
  sourceName: string,
  profile: RuntimeProfile = runtimeProfile(),
): Promise<number> {
  const sourceKey = mediaJobSourceKey(sourceName);
  const dir = join(mediaJobDerivedRoot(profile), sourceKey);
  const entries = await readdir(dir).catch(() => [] as string[]);
  if (entries.length === 0) return 0;
  await rm(dir, { recursive: true, force: true });
  return entries.length;
}

/** The URL prefix the derived read route serves; re-exported for the routes. */
export { MEDIA_JOB_DERIVED_URL_PREFIX };
