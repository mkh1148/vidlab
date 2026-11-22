// The D6 separation models: two pinned files, one verified path (I5 + H3).
//
// `spleeter:2stems` is a pair of UNets — one predicts the vocals magnitude
// spectrogram, the other the accompaniment — so "the model" is two files, and
// both have to be present and correct before the engine can run. They are
// downloaded ONCE into the data directory's model cache (`server/model-cache.ts`),
// pinned by size AND sha256, and re-checked on every resolve: a swapped or
// truncated file must fail loudly instead of producing a stem that is subtly
// wrong (the D1b rule, unchanged).
//
// Provenance, recorded honestly because it is a licence question:
//
//   * the WEIGHTS are Deezer's Spleeter 2stems, MIT (`deezer/spleeter`, the
//     `2stems` checkpoint). That is the licence the kit's D6 line names;
//   * the FILES here are the ONNX export of those weights published by the
//     sherpa-onnx project (Apache-2.0) — a conversion, not a retrain. The
//     conversion script is committed there (`scripts/spleeter/export_onnx.py`
//     and the `export-spleeter-to-onnx` workflow), which is what makes the chain
//     checkable rather than asserted;
//   * the Hugging Face repository that hosts them carries NO licence card
//     (`tags: ['onnx']` and nothing else). That is recorded on the descriptor
//     rather than smoothed over: the authoritative licence is the upstream one,
//     and a future distribution slice has to re-read it, exactly like RVM's
//     mirror row.
//
// The engine consumes the export's contract, measured on this machine rather
// than assumed: input `x` is `[2, num_splits, 512, 1024]` float32 and output `y`
// is the same shape, one magnitude spectrogram per stereo channel. Splits are
// bit-exactly independent, which is what lets the engine stream one 512-frame
// slice at a time instead of holding a whole clip's spectrogram in memory
// (`server/spleeter-spectrogram.verify.ts` pins both facts).
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { sha256File } from '../shared/node-content-hash.ts';
import { assertModelCacheUnderDataDir, modelCacheDir } from './model-cache.ts';
import { downloadModelFile, type ProxyTarget } from './plugins/hf-proxy.ts';
import type { RuntimeProfile } from './runtime-profile.ts';

/** Bumped when the model files or the separation recipe change. */
export const VOICE_ISOLATION_ENGINE_VERSION = 'spleeter-2stems-onnx-v1';

/** Subdirectory of the model cache that holds separation weights. */
export const SPLEETER_MODEL_DIR = 'spleeter';

export interface SpleeterModelFile {
  /** File name inside `spleeter/`. */
  readonly fileName: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface SpleeterModelDescriptor {
  /** Hugging Face repo id the pinned files come from. */
  readonly modelId: string;
  readonly revision: string;
  /** The vocals UNet. */
  readonly vocals: SpleeterModelFile;
  /** The accompaniment UNet. */
  readonly accompaniment: SpleeterModelFile;
  /** Upstream project the weights belong to. */
  readonly upstream: string;
  /** Licence of the WEIGHTS, as stated by the upstream project. */
  readonly licence: string;
  /** What the hosting repository claims (nothing, here) — recorded, not resolved. */
  readonly hostLicenceClaim: string;
  /** The toolchain that produced the ONNX files, and its licence. */
  readonly converter: string;
  /** ONNX input/output names, so the engine child and the verify agree. */
  readonly input: string;
  readonly output: string;
}

/**
 * The pinned pair.
 *
 * Sizes and hashes are the bytes this machine downloaded and verified; the
 * descriptor is the single source of truth and the engine never re-derives them.
 */
export const SPLEETER_MODEL: SpleeterModelDescriptor = {
  modelId: 'csukuangfj/sherpa-onnx-spleeter-2stems',
  revision: 'main',
  vocals: {
    fileName: 'vocals.onnx',
    bytes: 39_318_336,
    sha256: 'bdc16ab6bf6117ddd4842c19e80e40e2be188fc555295064d424616b0224ac97',
  },
  accompaniment: {
    fileName: 'accompaniment.onnx',
    bytes: 39_318_343,
    sha256: '671ace17acd3720674a2bc14de32ac6292453dec20d9eb0ba4255d4ad8e3d8c0',
  },
  upstream: 'deezer/spleeter (2stems checkpoint)',
  licence: 'MIT',
  hostLicenceClaim: 'none (the hosting repository has no licence card)',
  converter: 'k2-fsa/sherpa-onnx ONNX export (Apache-2.0)',
  input: 'x',
  output: 'y',
};

/** A refusal a route or a job can report as `{error, code}`. */
export class SpleeterModelError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'SpleeterModelError';
    this.code = code;
  }
}

/** Absolute path of one pinned file inside the model cache. */
export function spleeterModelPath(
  file: SpleeterModelFile,
  profile?: RuntimeProfile,
): string {
  return join(modelCacheDir(profile), SPLEETER_MODEL_DIR, file.fileName);
}

/** The download target the shared multi-source fetcher understands. */
export function spleeterModelTarget(
  file: SpleeterModelFile,
  model: SpleeterModelDescriptor = SPLEETER_MODEL,
): ProxyTarget {
  return { modelId: model.modelId, revision: model.revision, filePath: file.fileName };
}

export interface EnsureSpleeterModelsOptions {
  readonly profile?: RuntimeProfile;
  readonly signal?: AbortSignal;
  /** Cumulative bytes downloaded across both files, for the job's progress. */
  readonly onProgress?: (bytes: number) => void;
  /** The descriptor to satisfy; the verify injects a tiny one. */
  readonly model?: SpleeterModelDescriptor;
  /** Injection point: the verify must never touch the network. */
  readonly download?: typeof downloadModelFile;
}

export interface SpleeterModelResolution {
  readonly vocals: string;
  readonly accompaniment: string;
  readonly bytes: number;
  readonly downloaded: boolean;
  readonly engineVersion: string;
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
export async function verifySpleeterFile(
  file: string,
  descriptor: Pick<SpleeterModelFile, 'bytes' | 'sha256'>,
): Promise<{ bytes: number; sha256: string }> {
  const bytes = await sizeOf(file);
  if (bytes !== descriptor.bytes) {
    throw new SpleeterModelError(
      `the separation model has ${bytes} bytes, expected ${descriptor.bytes}`,
      'model_size_mismatch',
    );
  }
  const sha256 = await sha256File(file);
  if (sha256 !== descriptor.sha256) {
    throw new SpleeterModelError(
      `the separation model hash is ${sha256}, expected ${descriptor.sha256}`,
      'model_hash_mismatch',
    );
  }
  return { bytes, sha256 };
}

/**
 * Resolve both files, downloading whatever is missing or wrong.
 *
 * The hash is checked on both paths: a file that is present but wrong is
 * re-fetched, and a download that lands wrong is refused. There is no "probably
 * fine" branch — a corrupt separation model produces a stem that sounds like a
 * bad mix, which is the worst failure mode this feature has.
 */
export async function ensureSpleeterModels(
  options: EnsureSpleeterModelsOptions = {},
): Promise<SpleeterModelResolution> {
  const model = options.model ?? SPLEETER_MODEL;
  const download = options.download ?? downloadModelFile;
  const files = [model.vocals, model.accompaniment];
  const paths = files.map((file) => spleeterModelPath(file, options.profile));
  // D-entry guard: the cache must sit inside the configured data directory.
  assertModelCacheUnderDataDir(dirname(paths[0]!), options.profile);

  let downloaded = false;
  let received = 0;
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]!;
    const path = paths[index]!;
    const present = await verifySpleeterFile(path, file).catch(() => null);
    if (present) continue;
    try {
      await download(spleeterModelTarget(file, model), path, {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onProgress
          ? {
            onProgress: (bytes: number) => {
              options.onProgress?.(received + bytes);
            },
          }
          : {}),
        expectedBytes: file.bytes,
        expectedSha256: file.sha256,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SpleeterModelError(
        `could not download the separation model: ${message}`,
        'model_download_failed',
      );
    }
    await verifySpleeterFile(path, file);
    received += file.bytes;
    downloaded = true;
  }

  return {
    vocals: paths[0]!,
    accompaniment: paths[1]!,
    bytes: model.vocals.bytes + model.accompaniment.bytes,
    downloaded,
    engineVersion: VOICE_ISOLATION_ENGINE_VERSION,
  };
}
