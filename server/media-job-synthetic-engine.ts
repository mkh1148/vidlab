// Two synthetic D engines, shaped differently on purpose.
//
// The D-job contract requires the module to be proven against the interface,
// not against a guess, so D1a ships two consumers:
//
//   * `sleep` — a spawned child process that progresses, writes per-step files
//     and can be told to crash. This is the one that proves cancel reaches a
//     real pid (SIGKILL) and that a killed job leaves nothing behind.
//   * `multi-step` — an in-process engine that writes one artifact per stage and
//     then a combined one. It has no child at all, which is the point: the
//     module must not assume an engine is a process.
//
// Both go through `startMediaJob` with no module changes, which is the D2 entry
// condition. D1b replaces the `sleep` engine with RVM matting and keeps the
// module untouched.
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mediaJobArtifactLocation,
  type MediaJobArtifactLocation,
} from './media-job-artifact.ts';
import { mediaJobs, type MediaJobQueue, type MediaJobStartResult } from './media-job.ts';
import { jobProcessNodeBinary, runJobProcess } from './media-job-process.ts';
import type { MediaJobArtifact } from './media-job.ts';

/** Bumped when the synthetic output changes, so old artifacts stop matching. */
export const SYNTHETIC_ENGINE_VERSION = 'synthetic-v1';

const CHILD_SCRIPT = fileURLToPath(new URL('./media-job-synthetic-child.mjs', import.meta.url));

export type SyntheticEngine = 'sleep' | 'multi-step';

export interface SyntheticJobRequest {
  /** Upload name of the source, e.g. `clip.mov`. */
  readonly sourceName: string;
  readonly engine?: SyntheticEngine;
  readonly steps?: number;
  readonly stepMs?: number;
  /** Crash the child at this step (sleep engine only; 0 = never). */
  readonly crashAfter?: number;
  /**
   * Mutation seam for server/media-job.verify.ts: production omits it and gets
   * the one SIGKILL policy from media-job-process.ts.
   */
  readonly kill?: (child: import('node:child_process').ChildProcess) => void;
}

function locationFor(
  request: SyntheticJobRequest,
  segments: readonly string[],
  extension: string,
): MediaJobArtifactLocation {
  return mediaJobArtifactLocation({
    sourceName: request.sourceName,
    segments,
    // A synthetic job has no real source revision; the engine version plus the
    // step count is its whole identity, and a fixed revision keeps the cache
    // key stable across runs.
    revision: 'r1',
    engineVersion: SYNTHETIC_ENGINE_VERSION,
    options: { engine: request.engine ?? 'sleep', steps: request.steps ?? 1 },
    extension,
  });
}

async function bytesOf(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

/** Remove a file and ignore a missing one: cleanup must never mask the cause. */
async function removeQuietly(file: string): Promise<void> {
  await unlink(file).catch(() => undefined);
}

async function removeStepFiles(finalFile: string, steps: number): Promise<void> {
  for (let step = 1; step <= steps; step += 1) await removeQuietly(`${finalFile}.step${step}`);
}

/**
 * The child-process engine: a real spawned process, cancelable by SIGKILL and
 * crashable on demand.
 */
export function startSleepMediaJob(
  request: SyntheticJobRequest,
  queue: MediaJobQueue = mediaJobs,
): MediaJobStartResult {
  const steps = Math.max(1, Math.min(200, Math.round(request.steps ?? 4)));
  const stepMs = Math.max(0, Math.min(5_000, Math.round(request.stepMs ?? 150)));
  const crashAfter = Math.max(0, Math.round(request.crashAfter ?? 0));
  const location = locationFor({ ...request, engine: 'sleep', steps }, ['matte'], 'txt');
  return queue.start({
    key: `synthetic-sleep:${location.file}`,
    target: { file: location.file, url: location.url },
    run: async (signal, onProgress) => {
      await mkdir(dirname(location.file), { recursive: true });
      try {
        await runJobProcess(
          jobProcessNodeBinary(),
          [CHILD_SCRIPT, location.file, String(steps), String(stepMs), String(crashAfter)],
          {
            signal,
            ...(request.kill ? { kill: request.kill } : {}),
            onSpawn(pid) {
              // The pid is a diagnostic counter like any other: the inspector
              // shows it and the verify proves a SIGKILL reached it.
              if (pid !== undefined) onProgress({ progress: 0, phase: 'spawning', detail: { pid } });
            },
            onStdoutLine(line) {
              const match = line.match(/^step (\d+)\/(\d+)$/);
              if (!match) return;
              const done = Number(match[1]);
              const total = Number(match[2]);
              onProgress({
                progress: total > 0 ? done / total : 0,
                phase: 'synthetic',
                detail: { step: done, steps: total },
              });
            },
          },
        );
      } catch (error) {
        // A cancelled or crashed job must leave nothing behind: the artifact is
        // the only crash recovery, so a partial one would be mistaken for a
        // finished job after a restart.
        await removeStepFiles(location.file, steps);
        await removeQuietly(location.file);
        throw error;
      }
      const bytes = await bytesOf(location.file);
      if (bytes <= 0) throw new Error('the synthetic engine wrote no artifact');
      return {
        artifact: { file: location.file, url: location.url, bytes },
        intermediate: [],
      };
    },
  });
}

/**
 * The in-process engine: no child, several stages, one artifact per stage, then
 * a combined artifact. Its shape is deliberately different from the sleep loop.
 */
export function startMultiStepMediaJob(
  request: SyntheticJobRequest,
  queue: MediaJobQueue = mediaJobs,
): MediaJobStartResult {
  const stages = Math.max(1, Math.min(50, Math.round(request.steps ?? 3)));
  const stepMs = Math.max(0, Math.min(5_000, Math.round(request.stepMs ?? 40)));
  const finalLocation = locationFor({ ...request, engine: 'multi-step', steps: stages }, ['matte'], 'txt');
  const stageLocations = Array.from({ length: stages }, (_, index) => (
    locationFor({ ...request, engine: 'multi-step', steps: stages }, ['matte', `stage${index + 1}`], 'txt')
  ));
  return queue.start({
    key: `synthetic-multi:${finalLocation.file}`,
    target: { file: finalLocation.file, url: finalLocation.url },
    run: async (signal, onProgress) => {
      await mkdir(dirname(finalLocation.file), { recursive: true });
      const written: string[] = [];
      try {
        for (let index = 0; index < stages; index += 1) {
          signal.throwIfAborted();
          await new Promise((resolve) => { setTimeout(resolve, stepMs); });
          signal.throwIfAborted();
          const stage = stageLocations[index]!;
          await writeFile(stage.file, `stage ${index + 1} of ${stages}\n`, 'utf8');
          written.push(stage.file);
          onProgress({
            progress: (index + 1) / (stages + 1),
            phase: `stage${index + 1}`,
            detail: { stage: index + 1, stages },
          });
        }
        await writeFile(finalLocation.file, `combined ${stages} stage(s)\n`, 'utf8');
        onProgress({ progress: 1, phase: 'combining' });
      } catch (error) {
        for (const file of written) await removeQuietly(file);
        await removeQuietly(finalLocation.file);
        throw error;
      }
      const intermediate: MediaJobArtifact[] = [];
      for (const stage of stageLocations) {
        intermediate.push({ file: stage.file, url: stage.url, bytes: await bytesOf(stage.file) });
      }
      const bytes = await bytesOf(finalLocation.file);
      if (bytes <= 0) throw new Error('the multi-step engine wrote no artifact');
      return {
        artifact: { file: finalLocation.file, url: finalLocation.url, bytes },
        intermediate,
      };
    },
  });
}

/** Route the request to the engine it names. */
export function startSyntheticMediaJob(
  request: SyntheticJobRequest,
  queue: MediaJobQueue = mediaJobs,
): MediaJobStartResult {
  return request.engine === 'multi-step'
    ? startMultiStepMediaJob(request, queue)
    : startSleepMediaJob(request, queue);
}

/** Where a synthetic artifact would land — used by verifies and by docs. */
export function syntheticArtifactLocation(request: SyntheticJobRequest): MediaJobArtifactLocation {
  return locationFor({ ...request, steps: request.steps ?? 1 }, ['matte'], 'txt');
}
