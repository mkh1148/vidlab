// The D2 denoise model: one pinned RNNoise speech model, one verified path (I5 + H3).
//
// The kit's D2 requirement is "FFmpeg's arnndn filter with an RNNoise speech model
// whose licence allows bundling". That sentence has three consequences this module
// owns:
//
//   * the model is a FILE arnndn loads by path, so it has to be provisioned before
//     the engine can run — downloaded once into the data directory's model cache
//     (`server/model-cache.ts`), never into a hidden home path;
//   * the download is pinned by size AND sha256 and re-checked on every resolve, so
//     a truncated or swapped file fails loudly instead of producing a denoised track
//     that is subtly wrong;
//   * the licence is recorded honestly, and it is the reason this model was chosen
//     over the alternatives (see the descriptor's `licence`/`provenance` fields and
//     docs/d-job-implementation.md §D2).
//
// Why this model and not the one compiled into xiph/rnnoise: arnndn needs a `.rnnn`
// file, and the upstream project ships its weights as a C array (`src/rnn_data.c`),
// not as a `.rnnn`. The GregorR/rnnoise-models repository is the distribution FFmpeg's
// own arnndn documentation points at, and its README states that the model files are
// not creative works and are not subject to copyright — a dedication, not an SPDX
// licence, which is why `licence` below quotes it instead of naming an identifier.
//
// The transport is the app's existing curl downloader (`downloadFromSource`), not a
// second network stack: the same retries, the same size cap, the same abort handling
// and the same `.part` discipline the ASR/RVM downloads already use.
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { sha256File } from '../shared/node-content-hash.ts';
import { assertModelCacheUnderDataDir, modelCacheDir } from './model-cache.ts';
import { downloadFromSource } from './plugins/hf-download-transport.ts';
import type { RuntimeProfile } from './runtime-profile.ts';

/** Bumped when the model file or the cleaning recipe changes. */
export const VOICE_CLEANUP_ENGINE_VERSION = 'rnnoise-sh-v1';

/** Subdirectory of the model cache that holds denoise weights. */
export const RNNOISE_MODEL_DIR = 'rnnoise';

export interface RnnoiseModelDescriptor {
  /** Short id used in artifact names and the inspector. */
  readonly id: string;
  /** The exact file the model cache stores. */
  readonly fileName: string;
  /** Pinned download URL. */
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
  /** The project the weights come from. */
  readonly upstream: string;
  /** Licence of the WEIGHTS, as stated by the project that distributes them. */
  readonly licence: string;
  /** What the file is trained on, so a future swap is an informed choice. */
  readonly provenance: string;
}

/**
 * The pinned model.
 *
 * `sh.rnnn` = "somnolent-hogwash" from GregorR/rnnoise-models: per that repository's
 * own table it is the model trained for RECORDING noise against SPEECH signal, which
 * is the case a travel-vlog narration actually is (room tone, wind, handling noise
 * under a voice). The other four models in that repository are for general noise
 * (`mp`, `cb`) or for non-speech voice (`bd`, `lq`); a swap is a descriptor change
 * plus an engine-version bump, never a code change.
 */
export const RNNOISE_MODEL: RnnoiseModelDescriptor = {
  id: 'sh',
  fileName: 'sh.rnnn',
  url: 'https://raw.githubusercontent.com/GregorR/rnnoise-models/master/somnolent-hogwash-2018-09-01/sh.rnnn',
  bytes: 297_646,
  sha256: '70bb6685eb0c2a1d18e2918dca3fbfbd39317010b1802eb1b6ea73a92f3fdec0',
  upstream: 'GregorR/rnnoise-models (rnnoise-nu), for xiph/rnnoise',
  licence:
    'no copyright asserted by the distributor: the repository README states that, except for '
    + 'its tools/ directory and the README itself, "none of this work is creative and thus none '
    + 'of it is subject to copyright". The RNNoise code that consumes the file is BSD-3-Clause '
    + '(xiph/rnnoise). Not an SPDX identifier — a dedication, recorded verbatim.',
  provenance:
    'trained by Gregor Richards for rnnoise-nu; the repository table maps it to recording noise '
    + 'with speech signal. FFmpeg\'s arnndn documentation names this repository as the model source.',
};

/** A refusal a route or a job can report as `{error, code}`. */
export class RnnoiseModelError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'RnnoiseModelError';
    this.code = code;
  }
}

/** Absolute path of the pinned model inside the model cache. */
export function rnnoiseModelPath(
  profile?: RuntimeProfile,
  model: RnnoiseModelDescriptor = RNNOISE_MODEL,
): string {
  return join(modelCacheDir(profile), RNNOISE_MODEL_DIR, model.fileName);
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
export async function verifyRnnoiseModelFile(
  file: string,
  descriptor: Pick<RnnoiseModelDescriptor, 'bytes' | 'sha256'>,
): Promise<{ bytes: number; sha256: string }> {
  const bytes = await sizeOf(file);
  if (bytes !== descriptor.bytes) {
    throw new RnnoiseModelError(
      `the denoise model has ${bytes} bytes, expected ${descriptor.bytes}`,
      'model_size_mismatch',
    );
  }
  const sha256 = await sha256File(file);
  if (sha256 !== descriptor.sha256) {
    throw new RnnoiseModelError(
      `the denoise model hash is ${sha256}, expected ${descriptor.sha256}`,
      'model_hash_mismatch',
    );
  }
  return { bytes, sha256 };
}

/** Injection point: the verify must never touch the network. */
export type RnnoiseDownload = (
  url: string,
  destination: string,
  options: {
    readonly signal?: AbortSignal;
    readonly onProgress?: (bytes: number) => void;
    readonly expectedBytes: number;
    readonly expectedSha256: string;
  },
) => Promise<void>;

/**
 * Download one pinned URL through the shared curl transport.
 *
 * The transport writes into `<destination>.part` and this function renames only after
 * the transfer finished, so a killed download can never be mistaken for a model.
 */
export const downloadPinnedModelFile: RnnoiseDownload = async (url, destination, options) => {
  const partial = `${destination}.part`;
  try {
    await downloadFromSource(
      { name: 'pinned-url', url: () => url },
      { modelId: RNNOISE_MODEL_DIR, revision: 'pinned', filePath: basename(destination) },
      partial,
      {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        expectedBytes: options.expectedBytes,
        expectedSha256: options.expectedSha256,
        progress: new Map<string, number>(),
      },
    );
    await rename(partial, destination);
  } finally {
    await unlink(partial).catch(() => undefined);
  }
};

export interface EnsureRnnoiseModelOptions {
  readonly profile?: RuntimeProfile;
  readonly signal?: AbortSignal;
  readonly onProgress?: (bytes: number) => void;
  /** Defaults to the pinned model; the verify injects a tiny descriptor. */
  readonly model?: RnnoiseModelDescriptor;
  readonly download?: RnnoiseDownload;
}

export interface RnnoiseModelResolution {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly downloaded: boolean;
  readonly engineVersion: string;
}

/**
 * Resolve the model, downloading it once if it is absent.
 *
 * The hash is checked on both paths: a file that is present but wrong is deleted and
 * re-fetched, and a download that lands wrong is refused. There is no "probably fine"
 * branch — a corrupt model produces a denoised track that sounds plausible and is
 * wrong, which is the worst failure mode this feature has.
 */
export async function ensureRnnoiseModel(
  options: EnsureRnnoiseModelOptions = {},
): Promise<RnnoiseModelResolution> {
  const model = options.model ?? RNNOISE_MODEL;
  const file = rnnoiseModelPath(options.profile, model);
  // D-entry guard: the cache must sit inside the configured data directory.
  assertModelCacheUnderDataDir(dirname(file), options.profile);
  const download = options.download ?? downloadPinnedModelFile;

  const present = await verifyRnnoiseModelFile(file, model).catch(() => null);
  if (present) {
    return { file, ...present, downloaded: false, engineVersion: VOICE_CLEANUP_ENGINE_VERSION };
  }

  await mkdir(dirname(file), { recursive: true });
  try {
    await download(model.url, file, {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      expectedBytes: model.bytes,
      expectedSha256: model.sha256,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RnnoiseModelError(`could not download the denoise model: ${message}`, 'model_download_failed');
  }

  const verified = await verifyRnnoiseModelFile(file, model);
  return { file, ...verified, downloaded: true, engineVersion: VOICE_CLEANUP_ENGINE_VERSION };
}
