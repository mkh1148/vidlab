// The D1 matting model: one pinned file, one verified path (I5 + H3).
//
// Robust Video Matting (RVM) is an ONNX model that runs through ONNX Runtime. It
// is recurrent — every frame takes the previous frame's four recurrent states and
// returns the next four — so the engine must feed frames in order and can never
// parallelise across the timeline.
//
// Provisioning rules this module owns:
//
//   * the model is downloaded ONCE into the data directory's model cache
//     (`server/model-cache.ts`), never into a hidden home path, so the 5 GB model
//     budget lands where the owner pointed it;
//   * the download is pinned by size AND sha256, and the hash is re-checked on
//     every resolve — a truncated or swapped file must fail loudly instead of
//     producing a matte that is subtly wrong;
//   * the licence is recorded honestly. The weights come from the upstream RVM
//     project, which is GPL-3.0; the Hugging Face mirror's card claims
//     apache-2.0 and is NOT authoritative. Personal use is unaffected; a future
//     distribution slice has to revisit this row, which is why it is a field on
//     the descriptor rather than a comment somewhere.
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { sha256File } from '../shared/node-content-hash.ts';
import { assertModelCacheUnderDataDir, modelCacheDir } from './model-cache.ts';
import { downloadModelFile, type ProxyTarget } from './plugins/hf-proxy.ts';
import type { RuntimeProfile } from './runtime-profile.ts';

/** Bumped when the model file or the matting recipe changes. */
export const RVM_ENGINE_VERSION = 'rvm-mobilenetv3-v1';

/** Subdirectory of the model cache that holds matting weights. */
export const RVM_MODEL_DIR = 'rvm';

export interface RvmModelDescriptor {
  /** Hugging Face repo id the pinned file comes from. */
  readonly modelId: string;
  readonly revision: string;
  readonly filePath: string;
  readonly bytes: number;
  readonly sha256: string;
  /** Upstream project the weights belong to. */
  readonly upstream: string;
  /** Licence of the WEIGHTS, as stated by the upstream project. */
  readonly licence: string;
  /** What the mirror claims, recorded so the difference is not a surprise later. */
  readonly mirrorLicenceClaim: string;
  /** ONNX input/output names, so the engine child and the verify agree. */
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
}

/**
 * The pinned model.
 *
 * `rvm_mobilenetv3_fp32.onnx` is the mobile variant: the smallest RVM export,
 * which is the right trade on a 6-core CPU. The descriptor is the single source
 * of truth for the size and hash — the engine never re-derives them.
 */
export const RVM_MODEL: RvmModelDescriptor = {
  modelId: 'LPDoctor/video_matting',
  revision: 'main',
  filePath: 'rvm_mobilenetv3_fp32.onnx',
  bytes: 14_975_696,
  sha256: '88d4531297118f595bf2fd60f6f566aec2e559393802d1f436c380f0cbbd2828',
  upstream: 'PeterL1n/RobustVideoMatting',
  licence: 'GPL-3.0',
  mirrorLicenceClaim: 'apache-2.0 (mirror card; not authoritative)',
  inputs: ['src', 'r1i', 'r2i', 'r3i', 'r4i', 'downsample_ratio'],
  outputs: ['fgr', 'pha', 'r1o', 'r2o', 'r3o', 'r4o'],
};

/** A refusal a route or a job can report as `{error, code}`. */
export class RvmModelError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'RvmModelError';
    this.code = code;
  }
}

/** Absolute path of the pinned weights inside the model cache. */
export function rvmModelPath(
  profile?: RuntimeProfile,
  model: RvmModelDescriptor = RVM_MODEL,
): string {
  return join(modelCacheDir(profile), RVM_MODEL_DIR, model.filePath);
}

/** The download target the shared multi-source fetcher understands. */
export function rvmModelTarget(): ProxyTarget {
  return {
    modelId: RVM_MODEL.modelId,
    revision: RVM_MODEL.revision,
    filePath: RVM_MODEL.filePath,
  };
}

export interface EnsureRvmModelOptions {
  readonly profile?: RuntimeProfile;
  readonly signal?: AbortSignal;
  readonly onProgress?: (bytes: number) => void;
  /**
   * The descriptor to satisfy. Defaults to the pinned RVM weights; the verify
   * injects a tiny descriptor so the reuse/download logic is provable without a
   * 15 MB fixture, and a future model swap has one seam instead of a rewrite.
   */
  readonly model?: RvmModelDescriptor;
  /** Injection point: the verify must never touch the network. */
  readonly download?: typeof downloadModelFile;
}

export interface RvmModelResolution {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
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
export async function verifyModelFile(
  file: string,
  descriptor: Pick<RvmModelDescriptor, 'bytes' | 'sha256'>,
): Promise<{ bytes: number; sha256: string }> {
  const bytes = await sizeOf(file);
  if (bytes !== descriptor.bytes) {
    throw new RvmModelError(
      `the matting model has ${bytes} bytes, expected ${descriptor.bytes}`,
      'model_size_mismatch',
    );
  }
  const sha256 = await sha256File(file);
  if (sha256 !== descriptor.sha256) {
    throw new RvmModelError(
      `the matting model hash is ${sha256}, expected ${descriptor.sha256}`,
      'model_hash_mismatch',
    );
  }
  return { bytes, sha256 };
}

/**
 * Resolve the weights, downloading them once if they are absent.
 *
 * The hash is checked on both paths: a file that is present but wrong is deleted
 * and re-fetched, and a download that lands wrong is refused. There is no
 * "probably fine" branch — a corrupt model produces a matte that looks plausible
 * and is wrong, which is the worst failure mode this feature has.
 */
export async function ensureRvmModel(
  options: EnsureRvmModelOptions = {},
): Promise<RvmModelResolution> {
  const model = options.model ?? RVM_MODEL;
  const file = rvmModelPath(options.profile, model);
  // D-entry guard: the cache must sit inside the configured data directory.
  assertModelCacheUnderDataDir(dirname(file), options.profile);
  const download = options.download ?? downloadModelFile;

  // A present file is reused only when it verifies; anything else is re-fetched.
  const present = await verifyModelFile(file, model).catch(() => null);
  if (present) {
    return { file, ...present, downloaded: false, engineVersion: RVM_ENGINE_VERSION };
  }

  try {
    await download(
      { modelId: model.modelId, revision: model.revision, filePath: model.filePath },
      file,
      {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        expectedBytes: model.bytes,
        expectedSha256: model.sha256,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RvmModelError(`could not download the matting model: ${message}`, 'model_download_failed');
  }

  const verified = await verifyModelFile(file, model);
  return { file, ...verified, downloaded: true, engineVersion: RVM_ENGINE_VERSION };
}
