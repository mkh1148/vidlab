// The D2 voice-clean-up engine, mounted on the D-job module exactly as the contract
// demands: `run(signal, onProgress)` and nothing else.
//
// `server/media-job.ts` is consumed UNCHANGED — that is the D-job contract's own
// acceptance criterion, and D2 is the second real consumer that proves it (D1b was
// the first). Everything the engine needs lives on this side of the boundary.
//
// One job is three FFmpeg passes over the SAME decoded audio, never a second decode
// of the video:
//
//   pass 1  the chain: rumble -> denoise -> sibilance -> shape -> level
//           (writes `<artifact>.stage1.wav`, the pre-normalization track)
//   pass 2  measure: `loudnorm=print_format=json` over pass 1's output (no audio out)
//   pass 3  normalize: one LINEAR loudnorm with the measured values + a limiter,
//           writing `<artifact>.partial.wav`, renamed to the artifact on success
//
// Why the loudness stage is measure-then-apply and not a single dynamic pass: measured
// on the owner's 6-minute clip, dynamic single-pass loudnorm lifted the noise floor in
// the pauses by 3.4 dB relative to a loudnorm-only reference — it boosts quiet passages
// to hit the target, which is exactly what a noise floor must not do. A linear pass
// applies one gain, so the signal-to-noise ratio the denoiser created survives.
//
// Alignment is a measured property, not an assumption (kit D2: "keep the cleaned audio
// aligned with the picture; verify it"):
//
//   * `arnndn` delays its output by exactly one 10 ms frame (480 samples at 48 kHz) —
//     measured with a one-sample impulse, `server/media-job-voice-cleanup.verify.ts`;
//   * it also emits whole frames only, so an input that is not a multiple of 480 loses
//     its last partial frame (measured on the owner's clip: 616448 samples in, 616800
//     out, the final 128 samples of real audio dropped). The chain therefore pads one
//     frame of silence BEFORE the model, which makes it flush the tail;
//   * `alimiter` delays by its 5 ms lookahead unless `latency=true`, which compensates
//     internally (also measured);
//   * so the chain ends with `atrim=start_sample=480`: sample n of the artifact is
//     sample n of the source (offset 0, measured), nothing is dropped, and the artifact
//     is the source's length rounded up to a whole frame — at most 10 ms of trailing
//     silence (+352 samples / +7.3 ms on the owner's clip).
//
// Channel handling, which is what arnndn's 48 kHz MONO model allows and nothing more:
//
//   * mono source    -> no downmix, artifact stays mono;
//   * stereo source  -> downmix to mono for the chain, then duplicate the cleaned mono
//     track back to stereo (a voice is centre-panned; keeping the layout means the mix
//     does not change shape when the artifact replaces the source);
//   * more than two  -> REFUSED at the probe, before the model download and before any
//     decode, with an EN message naming the channel count.
//
// The refusal is the honest answer, not a limitation to hide. The downmix above takes
// c0 and c1 only, so on 5.1 material it would drop the CENTRE channel — where dialogue
// lives — and hand back a stereo artifact that sounds like a different take. A real
// downmix is a layout-aware policy (ITU-R BS.775 weights per layout, with its own
// per-layout tests); until that exists, refusing is better than a silently
// centre-less artifact, and it keeps this engine's channel claim to what the probe
// actually enforces.
//
// Cleanup under abort follows D1b's three layers: the engine writes `.partial.wav` and
// renames only after the encoder closed cleanly, the parent deletes its own partials on
// abort (SIGKILL cannot run a handler in the child), and a parent that dies too leaves a
// `.partial`/`.stage1` name in the per-source directory so a restart can tell finished
// work from unfinished work without a database.
import { mkdir, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ffprobeBin } from './media-binaries.ts';
import {
  mediaJobArtifactLocation,
  type MediaJobArtifactLocation,
} from './media-job-artifact.ts';
import { mediaJobs, type MediaJobQueue, type MediaJobStartResult } from './media-job.ts';
import { runJobProcess } from './media-job-process.ts';
import { ensureRnnoiseModel, rnnoiseModelPath, VOICE_CLEANUP_ENGINE_VERSION } from './rnnoise-model.ts';
import {
  assertVoiceCleanupChannels,
  runVoiceCleanupChain,
  voiceCleanupPartialPath,
  voiceCleanupStage1Path,
} from './voice-cleanup-chain.ts';

/**
 * Working set this engine needs, MEASURED (the D1b C2 rule: never the 1.5 GiB floor).
 *
 * Measurement: peak summed `PeakWorkingSet64` of this engine's FFmpeg children — the
 * OS-tracked peak, so there is no sampling error — read with `Get-Process ffmpeg`
 * every ~20 ms while the job ran. The Node parent that hosts the job is NOT included
 * (same convention as RVM's constant, which measures its engine child and adds
 * headroom for the FFmpeg children it did not sample).
 *
 *   owner's 6-minute clip   357 s, 44.1 kHz stereo -> 78,032,896 bytes (74.4 MiB)
 *   talking-head clip        13 s, 48 kHz stereo   -> 87,605,248 bytes (83.5 MiB)
 *
 * The passes are sequential, so the peak is one child's, not three.
 *
 * The constant is three times the larger peak, rounded to a power of two. That is
 * deliberate: the sample cannot see the parent's own buffers or the WAV I/O, and
 * over-declaring only defers a job on a machine that is already nearly full, while
 * under-declaring is an out-of-memory kill. It is still far below the 1.5 GiB floor,
 * so a healthy machine never defers this engine.
 */
export const VOICE_CLEANUP_JOB_REQUIRED_BYTES = 256 * 1024 * 1024;

// The chain, its constants and its alignment story now live in ONE place, because
// D6's kit line is "separation followed by the D2 clean-up" and a second copy would
// drift. They are re-exported here so this engine's public surface — and every
// verify that asserts it — is unchanged by the extraction.
export {
  VOICE_CLEANUP_FRAME_DELAY_SAMPLES,
  VOICE_CLEANUP_MAX_CHANNELS,
  VOICE_CLEANUP_SAMPLE_RATE,
  VOICE_CLEANUP_TARGET_LRA,
  VOICE_CLEANUP_TARGET_LUFS,
  VOICE_CLEANUP_TARGET_TRUE_PEAK,
  assertVoiceCleanupChannels,
  parseLoudnormMeasurement,
  voiceCleanupFilterChain,
  voiceCleanupPartialPath,
  voiceCleanupStage1Path,
} from './voice-cleanup-chain.ts';

export interface AudioProbe {
  readonly sampleRate: number;
  readonly channels: number;
  readonly duration: number;
  readonly codec: string;
}

/** Probe the first audio stream. Throws when the source has no audio at all. */
export async function probeAudio(file: string, signal?: AbortSignal): Promise<AudioProbe> {
  const result = await runJobProcess(
    ffprobeBin(),
    [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_streams', '-show_format',
      '-of', 'json',
      file,
    ],
    { signal, timeoutMs: 60_000 },
  );
  const data = JSON.parse(result.stdout || '{}') as {
    streams?: Array<Record<string, unknown>>;
    format?: { duration?: string };
  };
  const stream = data.streams?.[0];
  if (!stream) throw new Error('the source has no audio stream');
  const sampleRate = Number(stream.sample_rate) || 0;
  const channels = Number(stream.channels) || 0;
  const duration = Number(stream.duration) || Number(data.format?.duration) || 0;
  if (sampleRate <= 0 || channels <= 0 || duration <= 0) {
    throw new Error('the source audio stream is missing a sample rate, channel count or duration');
  }
  return { sampleRate, channels, duration, codec: String(stream.codec_name ?? '') };
}

export interface VoiceCleanupJobRequest {
  /** Mutation seam for the kill wiring, same shape as the other engines'. */
  readonly kill?: (child: import('node:child_process').ChildProcess) => void;
  /** Upload name of the source, e.g. `clip.mp4`. */
  readonly sourceName: string;
  /** Absolute path of the source on disk. */
  readonly sourceFile: string;
  /** Source revision, so a re-import produces a new artifact instead of a stale hit. */
  readonly revision?: string | number;
}

/** Where the cleaned track for this source would land. Pure path arithmetic. */
export function voiceCleanupArtifactLocation(
  request: VoiceCleanupJobRequest,
): MediaJobArtifactLocation {
  return mediaJobArtifactLocation({
    sourceName: request.sourceName,
    segments: ['voice'],
    ...(request.revision === undefined ? {} : { revision: request.revision }),
    engineVersion: VOICE_CLEANUP_ENGINE_VERSION,
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

/**
 * Start one voice-clean-up job.
 *
 * The key is the artifact path, so a second click while the first job is in flight
 * reuses it (keyed dedup) instead of cleaning the same clip twice.
 */
export function startVoiceCleanupMediaJob(
  request: VoiceCleanupJobRequest,
  queue: MediaJobQueue = mediaJobs,
): MediaJobStartResult {
  const location = voiceCleanupArtifactLocation(request);
  return queue.start({
    key: `voice-cleanup:${location.file}`,
    target: { file: location.file, url: location.url },
    requiredBytes: VOICE_CLEANUP_JOB_REQUIRED_BYTES,
    run: async (signal, onProgress) => {
      signal.throwIfAborted();
      await mkdir(dirname(location.file), { recursive: true });

      // 0.00: cache hit. The artifact identity is revision + engine version, so a
      // non-empty file at this exact path IS this derivation — pass 3 renames only
      // after the encoder closed cleanly, so a file that exists here is finished work.
      const cached = await bytesOf(location.file);
      if (cached > 0) {
        onProgress({ progress: 1, phase: 'done', detail: { cached: 1 } });
        return {
          artifact: { file: location.file, url: location.url, bytes: cached },
          intermediate: [],
        };
      }

      // 0.00: probe, and refuse what this engine cannot honour. Both happen BEFORE the
      // model download and before any decode, so an unusable source costs nothing —
      // a 5.1 clip is refused without touching the network or the disk.
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

      // 0.00-0.02: provisioning. A cache hit is instant; the first run pays the 300 KB
      // download once and never again.
      onProgress({ progress: 0.02, phase: 'provisioning' });
      const model = await ensureRnnoiseModel({
        signal,
        onProgress: (bytes) => onProgress({
          progress: 0.02,
          phase: 'provisioning',
          detail: { modelBytes: bytes },
        }),
      });
      signal.throwIfAborted();

      try {
        // The chain is D2's own three passes, shared rather than copied: this job
        // spends 0.02..0.99 of its progress on it, exactly as before the extraction.
        await runVoiceCleanupChain({
          inputFile: request.sourceFile,
          outputFile: location.file,
          modelFile: model.file,
          channels: probe.channels,
          duration: probe.duration,
          signal,
          ...(request.kill ? { kill: request.kill } : {}),
          onProgress: ({ phase, fraction, detail }) => onProgress({
            progress: 0.02 + fraction * (0.99 - 0.02),
            phase,
            ...(detail ? { detail } : {}),
          }),
        });
      } catch (error) {
        // Cleanup under abort, parent side: the child was SIGKILLed and could not run a
        // handler, so its partials are removed here. The final file is removed by the
        // job module itself (it owns `target`).
        await removeQuietly(voiceCleanupPartialPath(location.file));
        await removeQuietly(voiceCleanupStage1Path(location.file));
        await removeQuietly(location.file);
        throw error;
      }

      const bytes = await bytesOf(location.file);
      if (bytes <= 0) throw new Error('the voice clean-up engine wrote no artifact');
      onProgress({ progress: 1, phase: 'done' });
      return {
        artifact: { file: location.file, url: location.url, bytes },
        intermediate: [],
      };
    },
  });
}

/** The model path the engine will load; exported for the verify and docs. */
export function voiceCleanupModelPath(): string {
  return rnnoiseModelPath();
}
