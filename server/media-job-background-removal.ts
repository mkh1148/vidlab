// The D1 matting engine, mounted on the D-job module exactly as the contract
// demands: `run(signal, onProgress)` and nothing else.
//
// `server/media-job.ts` is consumed UNCHANGED. That is a D1b acceptance
// condition, not a preference: D1a proved the interface against two synthetic
// consumers, so a real engine that needs a module change means the interface was
// wrong. Everything an engine needs — the pid, the partial file, the model
// download — lives on this side of the boundary.
//
// Shape of one job:
//
//   an existing non-empty artifact at the derived path is the answer (cache hit)
//     -> probe the source (display dimensions, fps, frame count)
//     -> ensure the pinned weights are in the model cache
//     -> spawn the engine child (decode -> RVM -> VP9-with-alpha encode)
//     -> the child renames `<file>.partial.webm` to `<file>` only when the muxer
//        closed cleanly, so a partial is always identifiable
//     -> success is the module's own check that the artifact exists and is
//        non-empty; this file does not get to declare success
//
// Cleanup under abort is split deliberately. SIGKILL cannot run a handler inside
// the child (that is the whole point of the one kill policy), so the child cannot
// clean up after itself. The PARENT can: its `run` rejects on abort and the catch
// below deletes the partial. And if the parent is killed too, the partial is still
// named `.partial.webm` in the same per-source directory, so a restart can tell
// finished work from unfinished work without a database.
import { mkdir, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ffmpegBin } from './media-binaries.ts';
import {
  mediaJobArtifactLocation,
  type MediaJobArtifactLocation,
} from './media-job-artifact.ts';
import { mediaJobs, type MediaJobQueue, type MediaJobStartResult } from './media-job.ts';
import { jobProcessNodeBinary, runJobProcess } from './media-job-process.ts';
import { probeVideo } from './media-normalization.ts';
import { ensureRvmModel, RVM_ENGINE_VERSION, rvmModelPath } from './rvm-model.ts';

const CHILD_SCRIPT = fileURLToPath(new URL('./media-job-rvm-child.mjs', import.meta.url));

/**
 * Working set this engine needs, MEASURED (reviewer condition C2).
 *
 * Measurement: the engine child on 120 frames of the 1024x576 talking-head clip
 * (576x1024 displayed), ratio 0.375, 6 threads — peak working set 306,688,000
 * bytes (292.5 MiB) sampled every 150 ms from the parent's process handle. The
 * constant below is that measurement plus headroom for the two FFmpeg children
 * (decode and encode) and the pipe buffers, which the sample does not include.
 *
 * It is deliberately NOT the 1.5 GiB admission floor: passing the floor would
 * make the gate refuse (or defer) jobs that this machine can actually run, and
 * the floor exists for engines nobody has measured.
 */
export const RVM_JOB_REQUIRED_BYTES = 384 * 1024 * 1024;

/** RVM's own recommended ratio for footage around 720p; lower is coarser. */
export const RVM_DEFAULT_DOWNSAMPLE_RATIO = 0.375;

/** ONNX Runtime intra-op threads. 6 = the physical cores of the target machine. */
export const RVM_DEFAULT_THREADS = 6;

/** Progress steps the child reports; enough for a smooth bar, few enough to be cheap. */
const PROGRESS_STEPS = 100;

/** Extra arguments the verify injects; production passes none of them. */
export interface BackgroundRemovalJobHooks {
  /** Mutation seam for the kill wiring, same shape as the synthetic engine's. */
  readonly kill?: (child: import('node:child_process').ChildProcess) => void;
}

export interface BackgroundRemovalJobRequest extends BackgroundRemovalJobHooks {
  /** Upload name of the source, e.g. `clip.mp4`. */
  readonly sourceName: string;
  /** Absolute path of the source on disk. */
  readonly sourceFile: string;
  /** Source revision, so a re-import produces a new artifact instead of a stale hit. */
  readonly revision?: string | number;
  /** RVM downsample ratio; see the model card. */
  readonly ratio?: number;
  readonly threads?: number;
}

/** Where the matte for this source would land. Pure path arithmetic. */
export function backgroundRemovalArtifactLocation(
  request: BackgroundRemovalJobRequest,
): MediaJobArtifactLocation {
  return mediaJobArtifactLocation({
    sourceName: request.sourceName,
    segments: ['matte'],
    ...(request.revision === undefined ? {} : { revision: request.revision }),
    engineVersion: RVM_ENGINE_VERSION,
    options: { ratio: request.ratio ?? RVM_DEFAULT_DOWNSAMPLE_RATIO },
    extension: 'webm',
  });
}

async function bytesOf(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

async function removeQuietly(file: string): Promise<void> {
  await unlink(file).catch(() => undefined);
}

/** The partial the encoder writes before the child renames it. */
export function rvmPartialPath(file: string): string {
  return `${file}.partial.webm`;
}

/**
 * Start one background-removal job.
 *
 * The key is the artifact path, so a second click while the first job is in
 * flight reuses it (keyed dedup) instead of matting the same clip twice.
 */
export function startBackgroundRemovalMediaJob(
  request: BackgroundRemovalJobRequest,
  queue: MediaJobQueue = mediaJobs,
): MediaJobStartResult {
  const ratio = request.ratio ?? RVM_DEFAULT_DOWNSAMPLE_RATIO;
  const threads = request.threads ?? RVM_DEFAULT_THREADS;
  const location = backgroundRemovalArtifactLocation({ ...request, ratio });
  return queue.start({
    key: `background-removal:${location.file}`,
    target: { file: location.file, url: location.url },
    requiredBytes: RVM_JOB_REQUIRED_BYTES,
    run: async (signal, onProgress) => {
      signal.throwIfAborted();
      await mkdir(dirname(location.file), { recursive: true });

      // 0.00: cache hit. The artifact identity is revision + engine version +
      // ratio, so a non-empty file at this exact path IS this derivation — the
      // child renames its partial only after the muxer closed cleanly, so a file
      // that exists here is finished work, not a truncated one. This is what
      // makes a repeat run instant (the kit contract's cache-hit rule) and it is
      // the same rule the job module applies to success.
      const cached = await bytesOf(location.file);
      if (cached > 0) {
        onProgress({ progress: 1, phase: 'done', detail: { cached: 1 } });
        return {
          artifact: { file: location.file, url: location.url, bytes: cached },
          intermediate: [],
        };
      }

      // 0.00-0.05: provisioning. A cache hit is instant; the first run pays the
      // 15 MB download once and never again.
      onProgress({ progress: 0, phase: 'provisioning' });
      const model = await ensureRvmModel({
        signal,
        onProgress: (bytes) => onProgress({
          progress: 0,
          phase: 'provisioning',
          detail: { modelBytes: bytes },
        }),
      });
      signal.throwIfAborted();

      // 0.05: the source geometry. The model must see the DISPLAYED frame, so a
      // portrait clip stored landscape-coded with a rotation matrix is probed
      // through media-normalization (which swaps 90/270) rather than from the
      // raw stream header.
      const probe = await probeVideo(request.sourceFile, signal);
      const fps = probe.avgFrameRate ?? probe.nominalFrameRate ?? 30;
      const frames = probe.frameCount
        ?? Math.max(1, Math.round(probe.duration * fps));
      onProgress({
        progress: 0.05,
        phase: 'probed',
        detail: { width: probe.width, height: probe.height, frames, fps: Math.round(fps * 100) / 100 },
      });

      try {
        await runJobProcess(
          jobProcessNodeBinary(),
          [
            CHILD_SCRIPT,
            request.sourceFile,
            location.file,
            model.file,
            String(probe.width),
            String(probe.height),
            String(fps),
            String(frames),
            String(ratio),
            String(PROGRESS_STEPS),
            ffmpegBin(),
            String(threads),
          ],
          {
            signal,
            ...(request.kill ? { kill: request.kill } : {}),
            onSpawn(pid) {
              if (pid !== undefined) {
                onProgress({ progress: 0.05, phase: 'matting', detail: { pid } });
              }
            },
            onStdoutLine(line) {
              const match = line.match(/^step (\d+)\/(\d+)$/);
              if (!match) return;
              const done = Number(match[1]);
              const total = Number(match[2]);
              // 0.05 -> 0.99: the last percent belongs to the finalize check.
              const fraction = total > 0 ? done / total : 0;
              onProgress({
                progress: 0.05 + fraction * 0.94,
                phase: 'matting',
                detail: { frame: done, frames: total },
              });
            },
          },
        );
      } catch (error) {
        // Cleanup under abort, parent side: the child was SIGKILLed and could not
        // run a handler, so its partial is removed here. The final file is
        // removed by the job module itself (it owns `target`).
        await removeQuietly(rvmPartialPath(location.file));
        await removeQuietly(location.file);
        throw error;
      }

      const bytes = await bytesOf(location.file);
      if (bytes <= 0) throw new Error('the matting engine wrote no artifact');
      onProgress({ progress: 1, phase: 'done' });
      return {
        artifact: { file: location.file, url: location.url, bytes },
        intermediate: [],
      };
    },
  });
}

/** The model path the engine child will load; exported for the verify and docs. */
export function backgroundRemovalModelPath(): string {
  return rvmModelPath();
}
