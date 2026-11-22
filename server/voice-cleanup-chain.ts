// The voice clean-up chain, shared by D2 (clean-up) and D6 (isolation).
//
// D6's kit line is "a small source-separation model ... followed by the D2
// clean-up", so the second half of a voice-isolation job IS the D2 chain. Copying
// it would mean two definitions of the same nine stages, two alignment stories and
// two places to fix the next arnndn surprise; this module is the one definition.
//
// What it owns, and why each part is here rather than in a caller:
//
//   * the chain itself (`voiceCleanupFilterChain`) — the stage order the kit asks
//     for, exported so a verify asserts it instead of trusting a comment;
//   * the alignment constants and the reason for each one (arnndn's 480-sample
//     frame delay, its whole-frame output, alimiter's compensated lookahead);
//   * the three passes: chain -> measure -> one LINEAR loudnorm + limiter, with the
//     `.stage1.wav` / `.partial.wav` naming that makes unfinished work identifiable;
//   * the loudness measurement parsing, including the `-inf` refusal.
//
// What it does NOT own: the job (queue, key, requiredBytes, cache hit), the model
// download, and the artifact path. Those stay with each feature, because they are
// what differs between D2 and D6.
//
// Progress is reported as a CHAIN-LOCAL fraction in [0, 1] plus a phase, not as an
// absolute job progress: D2 spends 0.02..0.99 of its job on this chain, D6 spends
// the tail of its job on it after separation. The weights inside the fraction are
// D2's original absolute ones (0.02..0.99 normalised), so D2's numbers are
// unchanged by the extraction — a refactor that silently moved a progress bar
// would be a behaviour change nobody asked for.
import { rename, unlink } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { ffmpegBin } from './media-binaries.ts';
import { runJobProcess } from './media-job-process.ts';

/** Speech loudness target. -16 LUFS is the podcast/speech convention (EBU R128's -23 is
 *  broadcast, streaming's -14 is music-first); true peak -1.5 dBTP leaves headroom for
 *  the AAC encode the export does afterwards. */
export const VOICE_CLEANUP_TARGET_LUFS = -16;
export const VOICE_CLEANUP_TARGET_TRUE_PEAK = -1.5;
export const VOICE_CLEANUP_TARGET_LRA = 11;

/** The chain's own sample rate: arnndn only accepts 48 kHz. */
export const VOICE_CLEANUP_SAMPLE_RATE = 48_000;

/** arnndn's frame delay at 48 kHz (10 ms), removed by the trailing atrim. */
export const VOICE_CLEANUP_FRAME_DELAY_SAMPLES = 480;

/**
 * The most channels this chain honours end to end. It downsamples to mono for the
 * model and restores a mono or stereo layout, so a source with more channels would
 * lose everything outside c0/c1 — on 5.1 that is the centre channel, which is where
 * dialogue lives. See `assertVoiceCleanupChannels`.
 */
export const VOICE_CLEANUP_MAX_CHANNELS = 2;

/**
 * Refuse a source this chain cannot honour, at the probe and before any work.
 *
 * The thrown message is the owner-facing EN text: a job reports an engine refusal
 * as `{error: <message>, code: 'engine_failed'}`, so the message has to carry the
 * whole explanation.
 */
export function assertVoiceCleanupChannels(probe: { readonly channels: number }): void {
  if (probe.channels <= VOICE_CLEANUP_MAX_CHANNELS) return;
  throw new Error(
    `voice clean-up supports mono and stereo audio, but this clip has ${probe.channels} channels. `
    + 'Downmix it to stereo first, or clean up a stereo copy.',
  );
}

/**
 * The chain, as one FFmpeg `-af` graph. Exported so the verify can assert the stage
 * order the kit asks for instead of trusting a comment.
 */
export function voiceCleanupFilterChain(options: {
  readonly modelName: string;
  readonly channels: number;
}): string {
  // Only mono and stereo reach here: `assertVoiceCleanupChannels` refuses the rest at
  // the probe. A stereo downmix therefore takes every channel the source has.
  const downmix = options.channels > 1 ? ['pan=mono|c0=0.5*c0+0.5*c1'] : [];
  const restore = options.channels > 1 ? ['pan=stereo|c0=c0|c1=c0'] : [];
  return [
    // 1. rumble: a voice has nothing useful below 80 Hz, and a high-pass also keeps
    //    the denoiser from spending its model on rumble it was not trained for.
    'highpass=f=80:poles=2',
    // 2. the model's input format: 48 kHz, mono. Explicit, not left to auto-insertion.
    `aresample=${VOICE_CLEANUP_SAMPLE_RATE}`,
    ...downmix,
    // 3. one frame of silence BEFORE the model. arnndn consumes 480-sample frames and
    //    emits whole frames only, so an input whose length is not a multiple of 480
    //    loses its final partial frame (measured: 616448 samples in, 616800 out, the
    //    last 128 samples of real audio gone). Padding the input by one frame makes
    //    the model flush everything, and the trailing atrim below removes the delay
    //    this pad does not create.
    `apad=pad_len=${VOICE_CLEANUP_FRAME_DELAY_SAMPLES}`,
    // 4. denoise: the RNNoise speech model, full wet.
    `arnndn=m=${options.modelName}:mix=1`,
    // 5. sibilance: de-ess before the presence lift, so the lift cannot re-sharpen it.
    'deesser=i=0.4:m=0.5:f=0.5',
    // 6. shape: take out the boxy 220 Hz region, add presence at 3.2 kHz.
    'equalizer=f=220:t=q:w=1.2:g=-2',
    'equalizer=f=3200:t=q:w=1.4:g=2',
    // 7. level: gentle compression, no makeup gain — the loudness stage owns the gain.
    'acompressor=threshold=-20dB:ratio=3:attack=8:release=180',
    // 8. peak safety with the lookahead delay compensated internally.
    'alimiter=limit=0.95:level=false:latency=true',
    // 9. alignment: drop the model's 480-sample delay. What remains is the source
    //    audio sample for sample, followed by at most one frame of silence that the
    //    model's frame rounding added (measured: +352 samples = +7.3 ms here).
    `atrim=start_sample=${VOICE_CLEANUP_FRAME_DELAY_SAMPLES}`,
    'asetpts=N/SR/TB',
    ...restore,
  ].join(',');
}

/** The pre-normalization track pass 1 writes. */
export function voiceCleanupStage1Path(file: string): string {
  return `${file}.stage1.wav`;
}

/** The track pass 3 writes before it is renamed to the artifact. */
export function voiceCleanupPartialPath(file: string): string {
  return `${file}.partial.wav`;
}

/** `out_time_us=` from FFmpeg's `-progress` line protocol, in seconds. */
function progressSeconds(line: string): number | null {
  const match = /^out_time_us=(\d+)$/.exec(line);
  if (!match) return null;
  const micros = Number(match[1]);
  return Number.isFinite(micros) ? micros / 1_000_000 : null;
}

export interface LoudnormMeasurement {
  readonly input_i: string;
  readonly input_tp: string;
  readonly input_lra: string;
  readonly input_thresh: string;
  readonly target_offset: string;
}

/** Parse the JSON loudnorm prints at the end of a measure pass. */
export function parseLoudnormMeasurement(stderr: string): LoudnormMeasurement | null {
  const start = stderr.indexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(stderr.slice(start, end + 1)) as Record<string, unknown>;
    const field = (key: string): string | null => {
      const value = parsed[key];
      return typeof value === 'string' && value.trim() ? value.trim() : null;
    };
    const measurement = {
      input_i: field('input_i'),
      input_tp: field('input_tp'),
      input_lra: field('input_lra'),
      input_thresh: field('input_thresh'),
      target_offset: field('target_offset'),
    };
    if (Object.values(measurement).some((value) => value === null)) return null;
    return measurement as unknown as LoudnormMeasurement;
  } catch {
    return null;
  }
}

/** True when a measured value is a real number (loudnorm prints `-inf` for silence). */
function measurable(value: string): boolean {
  return Number.isFinite(Number(value));
}

/**
 * The absolute weights this chain used before it was extracted, kept as the
 * reference so D2's progress numbers did not move by a single point.
 */
const CHAIN_START = 0.02;
const CHAIN_END = 0.99;
const STAGE1_END = 0.75;
const MEASURE_END = 0.85;

export type VoiceCleanupPhase = 'cleaning' | 'measuring' | 'normalizing';

export interface VoiceCleanupChainProgress {
  readonly phase: VoiceCleanupPhase;
  /** Progress through the whole chain, 0..1. The caller maps it onto its own range. */
  readonly fraction: number;
  readonly detail?: Readonly<Record<string, number>>;
}

export interface VoiceCleanupChainRequest {
  /** Source audio (or video with audio) to clean. */
  readonly inputFile: string;
  /** Where the finished track lands. Written via `<file>.partial.wav`, then renamed. */
  readonly outputFile: string;
  /** Absolute path of the `.rnnn` model the chain loads. */
  readonly modelFile: string;
  /** Channel count of the INPUT; the chain keeps it (mono stays mono, stereo stays stereo). */
  readonly channels: number;
  /** Input duration in seconds, for the progress fraction. */
  readonly duration: number;
  readonly signal?: AbortSignal;
  readonly kill?: (child: import('node:child_process').ChildProcess) => void;
  readonly onProgress?: (progress: VoiceCleanupChainProgress) => void;
}

/** Map an absolute pre-extraction weight onto the chain-local fraction. */
function fractionOf(absolute: number): number {
  return Math.max(0, Math.min(1, (absolute - CHAIN_START) / (CHAIN_END - CHAIN_START)));
}

/**
 * Run the three passes and commit the artifact.
 *
 * Throws on abort or engine failure after removing its own partials; the caller
 * still removes the FINAL path on failure, because the final path is the caller's
 * `target` and the job module owns it.
 */
export async function runVoiceCleanupChain(request: VoiceCleanupChainRequest): Promise<void> {
  const { signal, kill, onProgress } = request;
  const report = (phase: VoiceCleanupPhase, absolute: number, detail?: Record<string, number>): void => {
    onProgress?.({ phase, fraction: fractionOf(absolute), ...(detail ? { detail } : {}) });
  };
  const stage1 = voiceCleanupStage1Path(request.outputFile);
  const partial = voiceCleanupPartialPath(request.outputFile);
  const chain = voiceCleanupFilterChain({
    modelName: basename(request.modelFile),
    channels: request.channels,
  });
  const outputChannels = request.channels > 1 ? 2 : 1;
  // The model path is passed as a bare file name with the child's working directory
  // set to the model's directory: an absolute Windows path inside a filter graph has
  // to survive FFmpeg's own `:`-and-quoting rules, and a name plus a cwd cannot.
  const modelDir = dirname(request.modelFile);
  const killOption = kill ? { kill } : {};

  try {
    // ── pass 1: the chain ────────────────────────────────────────────────────
    await runJobProcess(
      ffmpegBin(),
      [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
        '-i', request.inputFile,
        '-vn', '-map', '0:a:0?',
        '-af', chain,
        '-ar', String(VOICE_CLEANUP_SAMPLE_RATE),
        '-ac', String(outputChannels),
        '-c:a', 'pcm_s16le',
        '-progress', 'pipe:1', '-nostats',
        stage1,
      ],
      {
        ...(signal ? { signal } : {}),
        cwd: modelDir,
        ...killOption,
        onSpawn(pid) {
          if (pid !== undefined) report('cleaning', CHAIN_START, { pid });
        },
        onStdoutLine(line) {
          const seconds = progressSeconds(line);
          if (seconds === null) return;
          const fraction = Math.max(0, Math.min(1, seconds / request.duration));
          report('cleaning', CHAIN_START + fraction * (STAGE1_END - CHAIN_START), {
            seconds: Math.round(seconds * 10) / 10,
          });
        },
      },
    );
    signal?.throwIfAborted();

    // ── pass 2: measure the loudness of what pass 1 produced ──────────────────
    report('measuring', STAGE1_END);
    const measure = await runJobProcess(
      ffmpegBin(),
      [
        '-nostdin', '-hide_banner', '-nostats',
        '-i', stage1,
        '-af', `loudnorm=I=${VOICE_CLEANUP_TARGET_LUFS}:TP=${VOICE_CLEANUP_TARGET_TRUE_PEAK}`
          + `:LRA=${VOICE_CLEANUP_TARGET_LRA}:print_format=json`,
        '-f', 'null', '-',
      ],
      { ...(signal ? { signal } : {}), ...killOption },
    );
    const measurement = parseLoudnormMeasurement(measure.stderr);
    signal?.throwIfAborted();

    // ── pass 3: one linear gain to the target, then the artifact ─────────────
    report('normalizing', MEASURE_END);
    const normalize = measurement
      && measurable(measurement.input_i)
      && measurable(measurement.input_tp)
      && measurable(measurement.input_lra)
      && measurable(measurement.input_thresh)
      && measurable(measurement.target_offset)
      // A silent or near-silent source has no loudness to normalize; the cleaned
      // track is then passed through unchanged rather than refused.
      ? `loudnorm=I=${VOICE_CLEANUP_TARGET_LUFS}:TP=${VOICE_CLEANUP_TARGET_TRUE_PEAK}`
        + `:LRA=${VOICE_CLEANUP_TARGET_LRA}`
        + `:measured_I=${measurement.input_i}`
        + `:measured_TP=${measurement.input_tp}`
        + `:measured_LRA=${measurement.input_lra}`
        + `:measured_thresh=${measurement.input_thresh}`
        + `:offset=${measurement.target_offset}`
        + ':linear=true'
      : null;
    const finalChain = normalize
      ? `${normalize},alimiter=limit=0.95:level=false:latency=true`
      : 'alimiter=limit=0.95:level=false:latency=true';
    await runJobProcess(
      ffmpegBin(),
      [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
        '-i', stage1,
        '-af', finalChain,
        '-ar', String(VOICE_CLEANUP_SAMPLE_RATE),
        '-ac', String(outputChannels),
        '-c:a', 'pcm_s16le',
        '-progress', 'pipe:1', '-nostats',
        partial,
      ],
      {
        ...(signal ? { signal } : {}),
        ...killOption,
        onStdoutLine(line) {
          const seconds = progressSeconds(line);
          if (seconds === null) return;
          const fraction = Math.max(0, Math.min(1, seconds / request.duration));
          report('normalizing', MEASURE_END + fraction * (CHAIN_END - MEASURE_END));
        },
      },
    );
    signal?.throwIfAborted();

    // The rename is the commit point: a `.partial` name means "not finished".
    await unlink(request.outputFile).catch(() => undefined);
    await rename(partial, request.outputFile);
  } catch (error) {
    // Cleanup under abort, caller side of the kill: the child was SIGKILLed and could
    // not run a handler, so its partials are removed here.
    await unlink(partial).catch(() => undefined);
    await unlink(stage1).catch(() => undefined);
    throw error;
  }

  // Pass 1's intermediate is resume material only while the job runs; the artifact is
  // the answer, so it does not travel in `intermediate`.
  await unlink(stage1).catch(() => undefined);
}
