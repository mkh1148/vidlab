// Where a D artifact lands, and what it is called (D-job contract H1/H2 + the
// placement ruling this slice owns).
//
// The namer (shared/derived-artifact-name.ts) guarantees the NAME and nothing
// else. Placement is decided here, and the ruling is per-source subdirectory:
//
//   <media root>/derived/<source key>/<namer output>
//
// Why not one flat directory beside the uploads: NTFS is case-insensitive, so a
// flat directory silently merges two sources whose names differ only by case
// (`clip.mov` and `Clip.mov`), and the namer preserves case on purpose (a short
// name must stay byte-identical for an existing cache to keep hitting). The
// source key therefore folds case AND carries a short hash of the exact source
// name, so the two sources get two directories instead of one collision. It is
// also the layout the runtime profile already uses — `<root>/media/uploads` —
// with `derived` as its sibling, so a per-source tree sits next to the media it
// was derived from and travels with the data directory (I5).
//
// Inside one source's directory every artifact shares the source name, so the
// identity that separates them is revision + engine version + options. Both are
// lowercase by convention in this codebase (`source-v1-<base36>` revisions,
// engine version constants), which is what keeps the case-merge class closed.
import { dirname, join } from 'node:path';
import {
  deriveArtifactName,
  type DerivedArtifactIdentity,
} from '../shared/derived-artifact-name.ts';
import { sanitizeFileName } from '../shared/file-name.ts';
import { runtimeProfile, type RuntimeProfile } from './runtime-profile.ts';

/** Sibling of `uploads` under the media root; never inside it. */
export const MEDIA_JOB_DERIVED_DIR = 'derived';

/** Byte budget for the readable half of a source key. */
export const MEDIA_JOB_SOURCE_KEY_STEM_BYTES = 48;

/** URL prefix the render path will read artifacts from (D1b serves it). */
export const MEDIA_JOB_DERIVED_URL_PREFIX = '/media/derived';

export interface MediaJobArtifactRequest {
  /** Upload name of the source, e.g. `clip.mov`. A path is flattened. */
  readonly sourceName: string;
  /** Feature markers in order, e.g. `['matte']`. */
  readonly segments: readonly string[];
  /** Source revision the artifact was derived from. */
  readonly revision?: string | number;
  /** Engine/model version; lowercase by convention (see the header). */
  readonly engineVersion?: string;
  /** Options that change the output. */
  readonly options?: DerivedArtifactIdentity['options'];
  /** Output extension without the dot, e.g. `webm`. */
  readonly extension: string;
}

export interface MediaJobArtifactLocation {
  /** Absolute per-source directory; created by the engine before it writes. */
  readonly dir: string;
  /** Absolute artifact path. */
  readonly file: string;
  /** The namer's output — the only name rule in the repo (P7). */
  readonly name: string;
  /** Media URL the clip reference stores. */
  readonly url: string;
  /** Directory name under `derived/`; stable for one exact source name. */
  readonly sourceKey: string;
}

/** `<media root>/derived`, the parent of every per-source directory. */
export function mediaJobDerivedRoot(profile: RuntimeProfile = runtimeProfile()): string {
  return join(dirname(profile.mediaDir), MEDIA_JOB_DERIVED_DIR);
}

/** 32-bit FNV-1a over the UTF-8 bytes, 8 hex characters. */
function shortHash(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Longest whole-codepoint prefix of `value` that fits in `budget` bytes. */
function truncateToBytes(value: string, budget: number): string {
  const encoder = new TextEncoder();
  let used = 0;
  let end = 0;
  for (const character of value) {
    const width = encoder.encode(character).length;
    if (used + width > budget) break;
    used += width;
    end += character.length;
  }
  return value.slice(0, end);
}

/** Flatten a source name to its stem, without the extension. */
function sourceStem(sourceName: string): string {
  const flat = sanitizeFileName(sourceName.trim().split(/[\\/]/).pop() ?? '', 'source');
  const dot = flat.lastIndexOf('.');
  return dot > 0 ? flat.slice(0, dot) : flat;
}

/**
 * Directory name for one exact source.
 *
 * Case-folded readable stem + `-` + 8 hex of the EXACT name: the fold keeps the
 * tree readable and the hash keeps `clip.mov` and `Clip.mov` in two
 * directories instead of one NTFS merge.
 */
export function mediaJobSourceKey(sourceName: string): string {
  const exact = sourceName.trim().split(/[\\/]/).pop() ?? '';
  const readable = truncateToBytes(
    sanitizeFileName(sourceStem(sourceName).toLowerCase(), 'source'),
    MEDIA_JOB_SOURCE_KEY_STEM_BYTES,
  ).replace(/[._-]+$/, '');
  return `${readable || 'source'}-${shortHash(exact)}`;
}

/**
 * Absolute location of one artifact, plus the URL a clip reference stores.
 *
 * Pure path arithmetic: nothing is created here, so a caller can compute the
 * location before the engine writes and compare it after a restart.
 */
export function mediaJobArtifactLocation(
  request: MediaJobArtifactRequest,
  profile: RuntimeProfile = runtimeProfile(),
): MediaJobArtifactLocation {
  const sourceKey = mediaJobSourceKey(request.sourceName);
  const dir = join(mediaJobDerivedRoot(profile), sourceKey);
  const name = deriveArtifactName({
    sourceName: request.sourceName,
    segments: request.segments,
    ...(request.revision === undefined ? {} : { revision: request.revision }),
    ...(request.engineVersion === undefined ? {} : { engineVersion: request.engineVersion }),
    ...(request.options === undefined ? {} : { options: request.options }),
    extension: request.extension,
  });
  return {
    dir,
    file: join(dir, name),
    name,
    url: `${MEDIA_JOB_DERIVED_URL_PREFIX}/${sourceKey}/${encodeURIComponent(name)}`,
    sourceKey,
  };
}

/** The URL for a location whose source key and name are already known. */
export function mediaJobArtifactUrl(sourceKey: string, name: string): string {
  return `${MEDIA_JOB_DERIVED_URL_PREFIX}/${sourceKey}/${encodeURIComponent(name)}`;
}
