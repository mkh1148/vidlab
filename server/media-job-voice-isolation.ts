// The D6 voice-isolation engine, mounted on the D-job module exactly as the contract
// demands: `run(signal, onProgress)` and nothing else.
//
// `server/media-job.ts` is consumed UNCHANGED — D6 is the fourth real consumer of the
// contract (D1 matting, D2 clean-up, D3 transcription), so a change here would mean
// the contract was wrong. Everything this engine needs lives on this side.
//
// Shape of one job:
//
//   an existing non-empty artifact at the derived path is the answer (cache hit)
//     -> probe the source audio, refuse what the chain cannot honour (before any
//        download and before any decode)
//     -> ensure the pinned Spleeter pair is in the model cache
//     -> FFmpeg decode to raw 44.1 kHz stereo float32  (`<artifact>.mix.f32`)
//     -> the separation child: Spleeter 2stems -> vocals stem (`<artifact>.vocals.wav`)
//     -> the D2 chain on that stem (server/voice-cleanup-chain.ts) -> the artifact
//
// Why the decode is a PARENT-side FFmpeg child and not something the separation child
// does itself: the legacy `/api/isolate-voice` route spawned FFmpeg from the request
// handler, so a broker-side cancel never reached the child and it outlived the job.
// The D-job contract's kill policy is SIGKILL on the job's own child pid, and Windows
// does not propagate that to grandchildren. So the separation child spawns NOTHING
// (pure compute: read raw samples, write a WAV), the decode is a direct child the
// policy can kill, and the clean-up chain runs after the child has exited. There is no
// grandchild in this job for a cancel to orphan.
//
// The artifact is separation AND clean-up, not separation alone: the kit's D6 line is
// "a small source-separation model ... followed by the D2 clean-up", and a raw Spleeter
// stem is a magnitude-masked mix — it keeps the music's reverb tail and the model's
// own hiss. What the owner hears when they switch to Processed is the D2 chain's work.
//
// Cleanup under abort follows D1b/D2's layers: the chain writes `.partial.wav` and
// renames only after the encoder closed cleanly, the parent deletes its own
// intermediates on abort (SIGKILL cannot run a handler in the child), and a parent that
// dies too leaves `.mix.f32` / `.vocals.wav` / `.partial.wav` names in the per-source
// directory so a restart can tell finished work from unfinished work without a database.
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
import { probeAudio } from './media-job-voice-cleanup.ts';
import { ensureRnnoiseModel, rnnoiseModelPath } from './rnnoise-model.ts';
import { SPLEETER_SAMPLE_RATE } from './spleeter-spectrogram.ts';
import {
  SPLEETER_MODEL,
  VOICE_ISOLATION_ENGINE_VERSION,
  ensureSpleeterModels,
  spleeterModelPath,
} from './spleeter-model.ts';
import { assertVoiceCleanupChannels, runVoiceCleanupChain } from './voice-cleanup-chain.ts';

/**
 * The separation engine child. A `.ts` file, spawned through the SAME loader the
 * server itself runs under (`node --import tsx`, see `scripts/serve-prod.mjs`), so the
 * DSP has one definition instead of a `.mjs` copy that could drift from the verified
 * module. The loader URL is resolved from this module, not from the child's cwd.
 */
const CHILD_SCRIPT = fileURLToPath(new URL('./media-job-separation-child.ts', import.meta.url));

/**
 * Working set this engine needs, MEASURED (the D1b C2 rule: never the 1.5 GiB floor).
 *
 * Measurement: peak `PeakWorkingSet64` of the separation child — the OS-tracked peak,
 * so there is no sampling error — read every 40 ms while the job ran, on this machine
 * (i5-10400, 15.9 GB, Windows 11, ONNX Runtime 1.22 CPU, 6 threads):
 *
 *   13 s clip, 2 splits   529,965,056 bytes (505.4 MiB)
 *   60 s clip, 6 splits   556,085,248 / 553,390,080 / 534,286,336 bytes
 *                         (530.3 / 527.8 / 509.5 MiB, three re-measures)
 *
 * The buffers are O(one 512-frame split) by construction, so the peak does not grow
 * with the clip: 60 s of audio costs 25 MiB more than 13 s, not 5x. That is why a
 * single measured constant can cover a six-minute clip.
 *
 * The constant is the largest measurement rounded up to the next power of two. It is
 * deliberately NOT three times the peak: 3 x 530 MiB is 1.55 GiB, which crosses the
 * 1.5 GiB admission floor and would defer jobs this machine can run — the same
 * reasoning D1 recorded for RVM. What the sample cannot see is the Node parent's own
 * buffers and the two FFmpeg children (decode ~50 MiB, chain ~85 MiB); 1 GiB leaves
 * ~490 MiB for those.
 */
export const VOICE_ISOLATION_JOB_REQUIRED_BYTES = 1024 * 1024 * 1024;

/** ONNX Runtime intra-op threads. 6 = the physical cores of the target machine. */
export const VOICE_ISOLATION_THREADS = 6;

/** Progress split: the child owns the middle, the chain owns the tail. */
const PROVISION_END = 0.04;
const DECODE_END = 0.12;
const SEPARATION_START = 0.14;
const SEPARATION_END = 0.70;
const CHAIN_END = 0.99;

export interface VoiceIsolationJobRequest {
  /** Mutation seam for the kill wiring, same shape as the other engines'. */
  readonly kill?: (child: import('node:child_process').ChildProcess) => void;
  /** Upload name of the source, e.g. `clip.mp4`. */
  readonly sourceName: string;
  /** Absolute path of the source on disk. */
  readonly sourceFile: string;
  /** Source revision, so a re-import produces a new artifact instead of a stale hit. */
  readonly revision?: string | number;
  readonly threads?: number;
}

/** Where the isolated track for this source would land. Pure path arithmetic. */
export function voiceIsolationArtifactLocation(
  request: VoiceIsolationJobRequest,
): MediaJobArtifactLocation {
  return mediaJobArtifactLocation({
    sourceName: request.sourceName,
    segments: ['isolated'],
    ...(request.revision === undefined ? {} : { revision: request.revision }),
    engineVersion: VOICE_ISOLATION_ENGINE_VERSION,
    extension: 'wav',
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

/** The decoded mix the separation child reads. */
export function voiceIsolationMixPath(file: string): string {
  return `${file}.mix.f32`;
}

/** The vocals stem the separation child writes and the chain then cleans. */
export function voiceIsolationStemPath(file: string): string {
  return `${file}.vocals.wav`;
}

/** `out_time_us=` from FFmpeg's `-progress` line protocol, in seconds. */
function progressSeconds(line: string): number | null {
  const match = /^out_time_us=(\d+)$/.exec(line);
  if (!match) return null;
  const micros = Number(match[1]);
  return Number.isFinite(micros) ? micros / 1_000_000 : null;
}

/**
 * Start one voice-isolation job.
 *
 * The key is the artifact path, so a second click while the first job is in flight
 * reuses it (keyed dedup) instead of separating the same clip twice.
 */
export function startVoiceIsolationMediaJob(
  request: VoiceIsolationJobRequest,
  queue: MediaJobQueue = mediaJobs,
): MediaJobStartResult {
  const threads = request.threads ?? VOICE_ISOLATION_THREADS;
  const location = voiceIsolationArtifactLocation(request);
  const killOption = request.kill ? { kill: request.kill } : {};
  return queue.start({
    key: `voice-isolation:${location.file}`,
    target: { file: location.file, url: location.url },
    requiredBytes: VOICE_ISOLATION_JOB_REQUIRED_BYTES,
    run: async (signal, onProgress) => {
      signal.throwIfAborted();
      await mkdir(dirname(location.file), { recursive: true });

      // 0.00: cache hit. The artifact identity is revision + engine version, so a
      // non-empty file at this exact path IS this derivation — the chain renames only
      // after the encoder closed cleanly, so a file that exists here is finished work.
      const cached = await bytesOf(location.file);
      if (cached > 0) {
        onProgress({ progress: 1, phase: 'done', detail: { cached: 1 } });
        return {
          artifact: { file: location.file, url: location.url, bytes: cached },
          intermediate: [],
        };
      }

      // 0.00: probe, and refuse what the chain cannot honour. Both happen BEFORE the
      // model download and before any decode, so a 5.1 source costs nothing.
      const probe = await probeAudio(request.sourceFile, signal);
      assertVoiceCleanupChannels(probe);
      onProgress({
        progress: 0,
        phase: 'probed',
        detail: {
          sampleRate: probe.sampleRate,
          channels: probe.channels,
          seconds: Math.round(probe.duration * 100) / 100,
        },
      });

      // 0.00-0.04: provisioning. A cache hit is instant; the first run pays the 78 MB
      // pair once and never again.
      onProgress({ progress: 0, phase: 'provisioning' });
      const separation = await ensureSpleeterModels({
        signal,
        onProgress: (bytes) => onProgress({
          progress: 0,
          phase: 'provisioning',
          detail: { modelBytes: bytes },
        }),
      });
      signal.throwIfAborted();

      // 0.04-0.12: decode, once, to the format the model was trained on. 44.1 kHz
      // stereo float32 is the model's own contract; resampling here rather than inside
      // the child keeps the child free of FFmpeg.
      const mixFile = voiceIsolationMixPath(location.file);
      const stemFile = voiceIsolationStemPath(location.file);
      onProgress({ progress: PROVISION_END, phase: 'decoding' });
      try {
        await runJobProcess(
          ffmpegBin(),
          [
            '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
            '-i', request.sourceFile,
            '-vn', '-map', '0:a:0?',
            '-ac', '2',
            '-ar', String(SPLEETER_SAMPLE_RATE),
            '-f', 'f32le',
            '-progress', 'pipe:1', '-nostats',
            mixFile,
          ],
          {
            signal,
            ...killOption,
            onStdoutLine(line) {
              const seconds = progressSeconds(line);
              if (seconds === null) return;
              const fraction = Math.max(0, Math.min(1, seconds / probe.duration));
              onProgress({
                progress: PROVISION_END + fraction * (DECODE_END - PROVISION_END),
                phase: 'decoding',
              });
            },
          },
        );
        signal.throwIfAborted();

        // 0.12-0.14: the clean-up model, so a provisioning failure cannot waste the
        // separation pass.
        onProgress({ progress: DECODE_END, phase: 'provisioning' });
        const rnnoise = await ensureRnnoiseModel({
          signal,
          onProgress: (bytes) => onProgress({
            progress: DECODE_END,
            phase: 'provisioning',
            detail: { modelBytes: bytes },
          }),
        });
        signal.throwIfAborted();

        // 0.14-0.70: separation. The child reports one `step i/n` line per 512-frame
        // split, so the bar moves with the work rather than with a timer.
        await runJobProcess(
          jobProcessNodeBinary(),
          [
            '--import', import.meta.resolve('tsx'),
            CHILD_SCRIPT,
            mixFile,
            stemFile,
            separation.vocals,
            separation.accompaniment,
            String(threads),
          ],
          {
            signal,
            ...killOption,
            onSpawn(pid) {
              if (pid !== undefined) {
                onProgress({ progress: SEPARATION_START, phase: 'separating', detail: { pid } });
              }
            },
            onStdoutLine(line) {
              const match = line.match(/^step (\d+)\/(\d+)$/);
              if (!match) return;
              const done = Number(match[1]);
              const total = Number(match[2]);
              const fraction = total > 0 ? done / total : 0;
              onProgress({
                progress: SEPARATION_START + fraction * (SEPARATION_END - SEPARATION_START),
                phase: 'separating',
                detail: { split: done, splits: total },
              });
            },
          },
        );
        signal.throwIfAborted();

        // 0.70-0.99: the D2 chain on the stem. This is the artifact.
        await runVoiceCleanupChain({
          inputFile: stemFile,
          outputFile: location.file,
          modelFile: rnnoise.file,
          channels: 2,
          duration: probe.duration,
          signal,
          ...killOption,
          onProgress: ({ phase, fraction, detail }) => onProgress({
            progress: SEPARATION_END + fraction * (CHAIN_END - SEPARATION_END),
            phase,
            ...(detail ? { detail } : {}),
          }),
        });
      } catch (error) {
        // Cleanup under abort, parent side: the child was SIGKILLed and could not run a
        // handler, so its intermediates are removed here. The final file is removed by
        // the job module itself (it owns `target`).
        await removeQuietly(mixFile);
        await removeQuietly(stemFile);
        throw error;
      }

      // The decoded mix and the raw stem are resume material only while the job runs;
      // the artifact is the answer, so they do not travel in `intermediate`.
      await removeQuietly(mixFile);
      await removeQuietly(stemFile);

      const bytes = await bytesOf(location.file);
      if (bytes <= 0) throw new Error('the voice isolation engine wrote no artifact');
      onProgress({ progress: 1, phase: 'done' });
      return {
        artifact: { file: location.file, url: location.url, bytes },
        intermediate: [],
      };
    },
  });
}

/** The model paths the engine loads; exported for the verify and docs. */
export function voiceIsolationModelPaths(): { vocals: string; accompaniment: string; cleanup: string } {
  return {
    vocals: spleeterModelPath(SPLEETER_MODEL.vocals),
    accompaniment: spleeterModelPath(SPLEETER_MODEL.accompaniment),
    cleanup: rnnoiseModelPath(),
  };
}
