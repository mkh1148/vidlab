// D4 · the Face Landmarker weights: pinned bytes, sha256 and provenance, cached in
// the data directory (I5 — downloaded models are data, not code).
//
// Why the model is served by the app instead of living under `public/`: the browser
// cannot read the storage root, and the storage root is where I5 says a downloaded
// model belongs. So the browser asks this server for the model (one route), and the
// first request pays the 3.6 MB download once; every later run — including a
// restart, including an offline one — reads the verified file from
// `<storage root>/models/mediapipe/`.
//
// The pin is the whole safety story: a model that does not match these bytes is
// refused rather than loaded, so a changed or truncated download cannot silently
// change what "Analyze face" measures. Same rule as scripts/sync-mediapipe.mjs
// applies to the two models it provisions, and the same shape as rvm-model.ts.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assertModelCacheUnderDataDir, modelCacheDir } from './model-cache.ts';
import { runtimeProfile, type RuntimeProfile } from './runtime-profile.ts';

/** Provenance: the MediaPipe model card's own download URL (Apache-2.0). */
export const FACE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

/** Pinned size of the float16 face_landmarker.task bundle. */
export const FACE_MODEL_BYTES = 3_758_596;

/** Pinned sha256 of the same bundle. */
export const FACE_MODEL_SHA256 = '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff';

/** File name inside the model cache. */
export const FACE_MODEL_FILE = 'face_landmarker.task';

/**
 * Engine identity for the artifact name. A model or preprocessing change must move
 * this string, because it is what makes the cached track and atlas invalid.
 */
export const FACE_ANALYSIS_ENGINE_VERSION = 'mediapipe-face-landmarker-v1';

/** Sub-directory of the model cache that holds MediaPipe bundles. */
export const FACE_MODEL_CACHE_SUBDIR = 'mediapipe';

export interface FaceModelLocation {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly url: string;
}

/** Where the model lives, without touching the disk. */
export function faceModelLocation(profile: RuntimeProfile = runtimeProfile()): FaceModelLocation {
  const dir = join(modelCacheDir(profile), FACE_MODEL_CACHE_SUBDIR);
  return {
    file: join(dir, FACE_MODEL_FILE),
    bytes: FACE_MODEL_BYTES,
    sha256: FACE_MODEL_SHA256,
    url: FACE_MODEL_URL,
  };
}

/** True when the file exists at the pinned size (the cheap half of the check). */
async function sizeMatches(file: string): Promise<boolean> {
  try {
    const info = await stat(file);
    return info.isFile() && info.size === FACE_MODEL_BYTES;
  } catch {
    return false;
  }
}

/** Full verification: size and sha256. */
export async function verifyFaceModel(file: string): Promise<boolean> {
  try {
    const bytes = await readFile(file);
    if (bytes.length !== FACE_MODEL_BYTES) return false;
    return createHash('sha256').update(bytes).digest('hex') === FACE_MODEL_SHA256;
  } catch {
    return false;
  }
}

/**
 * Ensure the pinned bundle is in the model cache and return its path.
 *
 * A verified file is a cache hit. Anything else — absent, truncated, or a different
 * file wearing the right name — is replaced from the provenance URL, and the
 * replacement is verified before it is renamed into place, so a failed download
 * never leaves a half-written model that the next run would trust.
 */
export async function ensureFaceModel(options: {
  readonly signal?: AbortSignal;
  readonly profile?: RuntimeProfile;
  readonly fetchImpl?: typeof fetch;
} = {}): Promise<FaceModelLocation> {
  const profile = options.profile ?? runtimeProfile();
  const location = faceModelLocation(profile);
  assertModelCacheUnderDataDir(dirname(location.file), profile);
  if (await sizeMatches(location.file) && await verifyFaceModel(location.file)) return location;

  const fetchImpl = options.fetchImpl ?? fetch;
  await mkdir(dirname(location.file), { recursive: true });
  const response = await fetchImpl(FACE_MODEL_URL, options.signal ? { signal: options.signal } : {});
  if (!response.ok) {
    throw new Error(`failed to download ${FACE_MODEL_FILE} (HTTP ${response.status})`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== FACE_MODEL_BYTES || digest !== FACE_MODEL_SHA256) {
    throw new Error(
      `integrity mismatch for ${FACE_MODEL_FILE}: got ${bytes.length} bytes / ${digest}, `
      + `expected ${FACE_MODEL_BYTES} bytes / ${FACE_MODEL_SHA256}`,
    );
  }
  const temporary = `${location.file}.download-${process.pid}`;
  await writeFile(temporary, bytes);
  await rm(location.file, { force: true });
  await rename(temporary, location.file);
  return location;
}
