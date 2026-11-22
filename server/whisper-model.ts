// The D3a speech model: one pinned multilingual whisper.cpp GGML file, resolved
// inside the data directory, verified by size AND sha256 on every use (I5 + H3).
//
// Why this module exists at all, when the base already ships a GGML catalog:
// `shared/asr-models.ts` is the ONE source of truth for which files a tier needs
// (bytes, sha256, HF revision), and `server/plugins/asr-models.ts` is the ONE
// downloader the settings pane drives. Neither is a job engine: the catalog is
// browser-safe and therefore has no filesystem, and the downloader is a Vite
// plugin with an HTTP surface. This module is the job engine's narrow reader of
// both — it resolves the tier's GGML companion, verifies it, and downloads it
// through the SAME `downloadModelFile` transport the settings pane uses (same
// retries, same size cap, same `.part`-then-rename discipline, same mirrors).
// Nothing here is a second download stack, and nothing here re-pins a file the
// catalog already pins.
//
// The licence question the kit asks ("a multilingual speech model, licence-safe
// for bundling") is answered by the pair, not by the weights alone:
//
//   * the weights are OpenAI's Whisper, released under MIT;
//   * the GGML conversion is distributed by ggml-org/whisper.cpp (MIT), which is
//     the same project whose binary the repo already provisions;
//   * so a tier from this catalog is MIT end to end, and `docs/licence-table.md`
//     carries the row.
//
// Multilingual, not English-only: every tier in the catalog is a multilingual
// checkpoint (the `.en` variants are not listed), which is what the kit's
// "multilingual speech model" requires and what the owner's material needs.
import { mkdir, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ASR_MODELS, asrModelEntry, type AsrModelEntry } from '../shared/asr-models.ts';
import { GGML_SOURCE_MODEL_ID, resolveGgmlPath } from '../shared/asr-ggml-cache.ts';
import { sha256File } from '../shared/node-content-hash.ts';
import { assertModelCacheUnderDataDir, modelCacheDir } from './model-cache.ts';
import {
  downloadModelFile,
  type DownloadModelFileOptions,
  type ProxyTarget,
} from './plugins/hf-proxy.ts';
import type { RuntimeProfile } from './runtime-profile.ts';

/**
 * The engine version that goes into every artifact name and cache key.
 *
 * It names the BINARY, not the model: the model is a separate option in the name
 * (`model-base`), so switching tier invalidates the cache without pretending the
 * engine changed, and bumping whisper.cpp invalidates every tier at once.
 */
export const TRANSCRIPTION_ENGINE_VERSION = 'whisper-cpp-v1.9.2';

/** Version of the voice-activity/chunking recipe; part of the cache key too. */
export const TRANSCRIPTION_VAD_VERSION = 'vad-e1';

/**
 * The tier this engine uses unless a caller asks for another one.
 *
 * `base` (q5_1, 59,707,625 bytes) is the measured sweet spot on this machine: it
 * is multilingual, it loads in a fraction of a second into the warm server, and
 * on the owner's 6-minute clip it transcribes at roughly 8x real time on CPU.
 * `small` and `large-v3-turbo` are reachable per job for accuracy, at a measured
 * cost in RAM and time (see docs/d-job-implementation.md §D3a).
 */
export const DEFAULT_TRANSCRIPTION_MODEL_TIER = 'base';

/** Every tier this engine will run: the catalog entries that ship a GGML file. */
export const TRANSCRIPTION_MODEL_TIERS: readonly string[] = ASR_MODELS
  .filter((entry) => entry.ggmlFile !== undefined)
  .map((entry) => entry.id);

export function isTranscriptionModelTier(value: unknown): value is string {
  return typeof value === 'string' && TRANSCRIPTION_MODEL_TIERS.includes(value);
}

export interface WhisperModelDescriptor {
  /** Catalog tier id, e.g. `base`. */
  readonly tier: string;
  /** The exact file the model cache stores. */
  readonly fileName: string;
  readonly bytes: number;
  readonly sha256: string;
  /** HF revision the file is pinned at. */
  readonly revision: string;
  /** Provenance URL: the pinned HF revision, not a moving branch. */
  readonly url: string;
  /** The HF repo the file comes from. */
  readonly upstream: string;
  readonly licence: string;
  readonly provenance: string;
}

/** A refusal a route or a job can report as `{error, code}`. */
export class WhisperModelError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'WhisperModelError';
    this.code = code;
  }
}

const LICENCE =
  'MIT: OpenAI Whisper weights (MIT) converted to GGML and distributed by '
  + 'ggml-org/whisper.cpp (MIT). The binary that loads the file is the same project, '
  + 'provisioned by scripts/sync-whisper-cli.mjs under the same licence.';

const PROVENANCE =
  'quantised GGML conversion of the OpenAI multilingual Whisper checkpoint '
  + '(q5_1 for tiny/base/small, q5_0 for medium and large-v3-turbo), published in the '
  + 'ggerganov/whisper.cpp HF repo at the revision pinned in shared/asr-models.ts.';

/**
 * The descriptor for one tier.
 *
 * Throws `unknown_model_tier` rather than falling back to a default: a caller that
 * asked for `small` and silently got `base` would get a transcript whose accuracy
 * it cannot reason about, and the artifact name would not say which model made it.
 */
export function whisperModelDescriptor(tier: string = DEFAULT_TRANSCRIPTION_MODEL_TIER): WhisperModelDescriptor {
  const entry: AsrModelEntry | undefined = asrModelEntry(tier);
  const ggml = entry?.ggmlFile;
  if (!entry || !ggml) {
    throw new WhisperModelError(
      `unknown transcription model tier ${tier} (use ${TRANSCRIPTION_MODEL_TIERS.join(', ')})`,
      'unknown_model_tier',
    );
  }
  return {
    tier: entry.id,
    fileName: ggml.fileName,
    bytes: ggml.sizeBytes,
    sha256: ggml.sha256,
    revision: ggml.revision,
    url: `https://huggingface.co/${GGML_SOURCE_MODEL_ID}/resolve/${ggml.revision}/${ggml.fileName}`,
    upstream: GGML_SOURCE_MODEL_ID,
    licence: LICENCE,
    provenance: PROVENANCE,
  };
}

/** Absolute path of the pinned model inside the model cache. */
export function whisperModelPath(
  tier: string = DEFAULT_TRANSCRIPTION_MODEL_TIER,
  profile?: RuntimeProfile,
): string {
  return resolveGgmlPath(modelCacheDir(profile), whisperModelDescriptor(tier).fileName);
}

async function sizeOf(file: string): Promise<number> {
  try {
    const info = await stat(file);
    return info.isFile() ? info.size : 0;
  } catch {
    return 0;
  }
}

/** Size + hash of a file, refusing a mismatch with a machine-parseable code. */
export async function verifyWhisperModelFile(
  file: string,
  descriptor: Pick<WhisperModelDescriptor, 'bytes' | 'sha256'>,
): Promise<{ bytes: number; sha256: string }> {
  const bytes = await sizeOf(file);
  if (bytes !== descriptor.bytes) {
    throw new WhisperModelError(
      `the speech model has ${bytes} bytes, expected ${descriptor.bytes}`,
      'model_size_mismatch',
    );
  }
  const sha256 = await sha256File(file);
  if (sha256 !== descriptor.sha256) {
    throw new WhisperModelError(
      `the speech model hash is ${sha256}, expected ${descriptor.sha256}`,
      'model_hash_mismatch',
    );
  }
  return { bytes, sha256 };
}

/** Injection point: the verify must never touch the network. */
export type WhisperModelDownload = (
  target: ProxyTarget,
  destination: string,
  options: DownloadModelFileOptions,
) => Promise<string>;

/** The app's own HF transport, which is what the settings pane downloads through. */
export const downloadWhisperModelFile: WhisperModelDownload = (target, destination, options) =>
  downloadModelFile(target, destination, options);

export interface EnsureWhisperModelOptions {
  readonly tier?: string;
  readonly profile?: RuntimeProfile;
  readonly signal?: AbortSignal;
  readonly onProgress?: (bytes: number) => void;
  /** Defaults to the pinned transport; the verify injects a stand-in. */
  readonly download?: WhisperModelDownload;
  readonly descriptor?: WhisperModelDescriptor;
}

export interface WhisperModelResolution {
  readonly file: string;
  readonly tier: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly downloaded: boolean;
  readonly engineVersion: string;
}

/**
 * Resolve the model, downloading it once if it is absent.
 *
 * The hash is checked on both paths: a file that is present but wrong is deleted
 * and re-fetched, and a download that lands wrong is refused. There is no
 * "probably fine" branch — a corrupt speech model produces a transcript that reads
 * plausibly and is wrong, which is the worst failure mode this feature has.
 */
export async function ensureWhisperModel(
  options: EnsureWhisperModelOptions = {},
): Promise<WhisperModelResolution> {
  const descriptor = options.descriptor ?? whisperModelDescriptor(options.tier);
  const file = resolveGgmlPath(modelCacheDir(options.profile), descriptor.fileName);
  // D-entry guard: the cache must sit inside the configured data directory.
  assertModelCacheUnderDataDir(dirname(file), options.profile);
  const download = options.download ?? downloadWhisperModelFile;

  const present = await verifyWhisperModelFile(file, descriptor).catch(() => null);
  if (present) {
    return {
      file,
      tier: descriptor.tier,
      ...present,
      downloaded: false,
      engineVersion: TRANSCRIPTION_ENGINE_VERSION,
    };
  }

  await mkdir(dirname(file), { recursive: true });
  // A wrong file must not be left for the transport's own reuse check to trust.
  await unlink(file).catch(() => undefined);
  try {
    await download(
      { modelId: GGML_SOURCE_MODEL_ID, revision: descriptor.revision, filePath: descriptor.fileName },
      file,
      {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        expectedBytes: descriptor.bytes,
        expectedSha256: descriptor.sha256,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WhisperModelError(`could not download the speech model: ${message}`, 'model_download_failed');
  }

  const verified = await verifyWhisperModelFile(file, descriptor);
  return {
    file,
    tier: descriptor.tier,
    ...verified,
    downloaded: true,
    engineVersion: TRANSCRIPTION_ENGINE_VERSION,
  };
}

/**
 * Working set one transcription job needs, per tier.
 *
 * MEASURED for `base` on this machine (see docs/d-job-implementation.md §D3a):
 * the warm whisper-server child peaks at ~250 MiB resident with the 57 MiB q5_1
 * model loaded and one 30 s chunk in flight, and the FFmpeg children that decode
 * and cut chunks peak below 80 MiB. The constant is three times the larger
 * measured peak, rounded to a power of two — the same convention D1b and D2 use,
 * because a sample cannot see the parent's own buffers.
 *
 * The other tiers are DERIVED, not measured, and they are derived conservatively:
 * whisper.cpp keeps the model plus a KV/context workspace, which on CPU tracks the
 * file size closely, so 4x the model bytes is the floor for a tier nobody has
 * measured, and the measured `base` figure is the floor for every tier. That keeps
 * a `large-v3-turbo` job (>2 GiB) from being admitted on a machine that cannot
 * hold it, while never over-declaring `base`.
 */
export const TRANSCRIPTION_BASE_JOB_REQUIRED_BYTES = 256 * 1024 * 1024;

export function transcriptionRequiredBytes(tier: string = DEFAULT_TRANSCRIPTION_MODEL_TIER): number {
  const descriptor = whisperModelDescriptor(tier);
  const derived = descriptor.bytes * 4;
  const floor = Math.max(TRANSCRIPTION_BASE_JOB_REQUIRED_BYTES, derived);
  // Round up to the next power of two so the number reads as a budget, not a sample.
  return 2 ** Math.ceil(Math.log2(floor));
}
