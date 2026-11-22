// The D6 spectrogram: the analysis/synthesis pair the separation model needs, in
// first-party code.
//
// Why this exists at all: the Spleeter 2stems ONNX export is the UNet alone. It
// takes a MAGNITUDE spectrogram patch and returns the magnitude spectrogram of
// one stem — the STFT, the mask arithmetic and the inverse STFT are the caller's
// job. The reference implementation (sherpa-onnx `scripts/spleeter/separate_onnx.py`)
// does that with kaldi-native-fbank; this module is the same pipeline with no
// native dependency, so the engine needs nothing beyond the ONNX runtime the
// repo already ships.
//
// The numbers are the model's, not a preference:
//
//   * 44.1 kHz — `spleeter:2stems` was trained at 44100 Hz;
//   * n_fft 4096, hop 1024, periodic Hann — the frame the UNet expects;
//   * only the first 1024 of the 2049 bins reach the model (its F axis is 1024).
//     The mask is therefore defined for bins 0..1023 and ZERO above them, so the
//     artifact carries no content above 1023 * 44100 / 4096 = 11.0 kHz. That is
//     the model's own band limit, stated here because it is audible on a hissy
//     source and must not be discovered later as a mystery.
//
// Alignment is a measured property, not an assumption (the D2 lesson): analysis
// and synthesis use the SAME window and hop, framing is centred by one window of
// silence in front so every real sample sees the full four-frame overlap, and the
// synthesis divides by the summed squared window instead of trusting a constant.
// `server/spleeter-spectrogram.verify.ts` measures the round trip at 0 samples of
// offset and the engine's own output against the source with an impulse.
//
// Everything here is SPLIT-SCOPED rather than whole-signal: the model's own unit
// is 512 consecutive frames, its splits are bit-exactly independent (measured:
// one 2-split call versus two 1-split calls differ by 0), and a six-minute clip is
// 15.5k frames — 190 MB of complex spectrum if held at once. The engine therefore
// hands this module one 512-frame window at a time and the memory is O(split)
// instead of O(clip).
export const SPLEETER_SAMPLE_RATE = 44_100;
export const SPLEETER_N_FFT = 4096;
export const SPLEETER_HOP = 1024;
/** Frequency bins the model consumes (its F axis). */
export const SPLEETER_MODEL_BINS = 1024;
/** Frames per model call — the model's own split length. */
export const SPLEETER_SPLIT_FRAMES = 512;
/** Bins of a full one-sided spectrum: n_fft / 2 + 1. */
export const SPLEETER_SPECTRUM_BINS = SPLEETER_N_FFT / 2 + 1;
/** Row stride of a spectrogram: one-sided bins per frame. */
const SPECTRUM_STRIDE = SPLEETER_SPECTRUM_BINS;

export interface FrameSpectra {
  /** Number of analysis frames held; frame `t` starts at sample `t * hop - n_fft`. */
  readonly frames: number;
  /** Real part, `frames * SPLEETER_SPECTRUM_BINS` long, row-major by frame. */
  readonly re: Float32Array;
  /** Imaginary part, same layout as `re`. */
  readonly im: Float32Array;
}

/** The periodic Hann window the model was trained with. */
export function hannWindow(length = SPLEETER_N_FFT): Float32Array {
  const window = new Float32Array(length);
  for (let i = 0; i < length; i += 1) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / length);
  return window;
}

const WINDOW = hannWindow();

/**
 * In-place iterative radix-2 FFT. `inverse` also applies the 1/n scaling, so
 * forward followed by inverse is the identity.
 */
export function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = ((2 * Math.PI) / len) * (inverse ? 1 : -1);
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    const half = len / 2;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k += 1) {
        const ur = re[i + k]!;
        const ui = im[i + k]!;
        const jr = re[i + k + half]!;
        const ji = im[i + k + half]!;
        const vr = jr * cr - ji * ci;
        const vi = jr * ci + ji * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + half] = ur - vr;
        im[i + k + half] = ui - vi;
        const nextCr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nextCr;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i += 1) {
      re[i] = re[i]! / n;
      im[i] = im[i]! / n;
    }
  }
}

/**
 * Frames a signal of `samples` length needs.
 *
 * The `+ n_fft` is not slack: frame `t` covers samples `[t * hop - n_fft, t * hop)`,
 * so the LAST real sample is only covered by the four frames that reach past it.
 * Stopping at `ceil(samples / hop) + 1` would leave the final 3072 samples with one
 * frame instead of four and the tail would be visibly quieter.
 */
export function frameCount(samples: number): number {
  if (samples <= 0) return 0;
  return Math.floor((samples + SPLEETER_N_FFT - 1) / SPLEETER_HOP) + 1;
}

/** Samples a window of `frames` consecutive frames reads: `(frames - 1) * hop + n_fft`. */
export function windowSamples(frames: number): number {
  return frames <= 0 ? 0 : (frames - 1) * SPLEETER_HOP + SPLEETER_N_FFT;
}

/** Model calls needed for `frames` frames. */
export function splitCount(frames: number): number {
  return frames <= 0 ? 0 : Math.ceil(frames / SPLEETER_SPLIT_FRAMES);
}

/**
 * Analyse `frames` consecutive frames from a window of samples.
 *
 * `window[0]` is the sample one window BEFORE the first frame's start, i.e. global
 * sample `firstFrame * hop - n_fft`; local frame `k` therefore reads
 * `window[k * hop .. k * hop + n_fft)`. That single convention is what keeps the
 * analysis and the synthesis in the same coordinate system, and it is why the
 * caller pads the window with zeros at the start of the file instead of the
 * analyser special-casing frame 0.
 *
 * `into` lets a split loop reuse one buffer pair instead of allocating 8 MB per
 * 512-frame split; a six-minute clip is 190 splits.
 */
export function analyseFrames(window: Float32Array, frames: number, into?: FrameSpectra): FrameSpectra {
  const size = frames * SPECTRUM_STRIDE;
  const re = into && into.re.length >= size ? into.re : new Float32Array(size);
  const im = into && into.im.length >= size ? into.im : new Float32Array(size);
  const fr = new Float64Array(SPLEETER_N_FFT);
  const fi = new Float64Array(SPLEETER_N_FFT);
  for (let t = 0; t < frames; t += 1) {
    const base = t * SPLEETER_HOP;
    for (let i = 0; i < SPLEETER_N_FFT; i += 1) {
      fr[i] = (window[base + i] ?? 0) * WINDOW[i]!;
      fi[i] = 0;
    }
    fft(fr, fi, false);
    const row = t * SPECTRUM_STRIDE;
    for (let f = 0; f < SPECTRUM_STRIDE; f += 1) {
      re[row + f] = fr[f]!;
      im[row + f] = fi[f]!;
    }
  }
  return { frames, re, im };
}

/**
 * Overlap-add `frames` frames into `out`, accumulating the squared window in
 * `norm`. Frame `k` lands at `out[k * hop .. k * hop + n_fft)`.
 *
 * `out` and `norm` are the caller's buffers so a split loop allocates them once;
 * they must be zeroed before the first frame of a run that shares a buffer.
 */
export function synthesiseInto(
  spec: FrameSpectra,
  frames: number,
  out: Float32Array,
  norm: Float32Array,
): void {
  const fr = new Float64Array(SPLEETER_N_FFT);
  const fi = new Float64Array(SPLEETER_N_FFT);
  for (let t = 0; t < frames; t += 1) {
    const row = t * SPECTRUM_STRIDE;
    for (let f = 0; f < SPECTRUM_STRIDE; f += 1) {
      fr[f] = spec.re[row + f]!;
      fi[f] = spec.im[row + f]!;
    }
    // A real signal's spectrum is conjugate-symmetric; the caller only carried
    // bins 0..n/2, so the upper half is rebuilt here. Skipping this halves the
    // amplitude (measured: a 0.5 sine came back at 0.25).
    for (let f = 1; f < SPLEETER_N_FFT / 2; f += 1) {
      fr[SPLEETER_N_FFT - f] = fr[f]!;
      fi[SPLEETER_N_FFT - f] = -fi[f]!;
    }
    fft(fr, fi, true);
    const base = t * SPLEETER_HOP;
    for (let i = 0; i < SPLEETER_N_FFT; i += 1) {
      const s = base + i;
      out[s] = out[s]! + fr[i]! * WINDOW[i]!;
      norm[s] = norm[s]! + WINDOW[i]! * WINDOW[i]!;
    }
  }
}

/**
 * Divide the overlap-added signal by the window power and copy `count` samples
 * into `target`. Samples no window reached stay 0 rather than becoming NaN.
 *
 * `offset` is the window index of the first sample to keep. It is NOT a detail a
 * caller may guess: `out` is indexed like the analysis window, so sample 0 of the
 * signal lives at index `n_fft` — the one window of silence the centring puts in
 * front. Reading from index 0 instead shifts the whole result by 4096 samples.
 */
export function finishSynthesis(
  out: Float32Array,
  norm: Float32Array,
  count: number,
  offset = 0,
  target?: Float32Array,
): Float32Array {
  const result = target ?? new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    const energy = norm[offset + i] ?? 0;
    result[i] = energy > 1e-6 ? out[offset + i]! / energy : 0;
  }
  return result;
}

/**
 * The model's input patch for `frames` frames of one channel.
 *
 * Layout is the export's: `[2, splits, 512, 1024]` where dim 0 is the stereo
 * channel and dim 1 the split index. One split is one call, so this fills
 * `[512, 1024]` worth of samples per channel and the caller stacks two channels
 * into the batch axis. A short final split is zero-padded to 512 frames — the
 * model has no other shape.
 */
export function magnitudePatch(
  spec: FrameSpectra,
  frames: number,
  into?: Float32Array,
): Float32Array {
  const patch = into ?? new Float32Array(SPLEETER_SPLIT_FRAMES * SPLEETER_MODEL_BINS);
  const rows = Math.min(frames, SPLEETER_SPLIT_FRAMES);
  for (let t = 0; t < rows; t += 1) {
    const row = t * SPECTRUM_STRIDE;
    const out = t * SPLEETER_MODEL_BINS;
    for (let f = 0; f < SPLEETER_MODEL_BINS; f += 1) {
      const re = spec.re[row + f]!;
      const im = spec.im[row + f]!;
      patch[out + f] = Math.hypot(re, im);
    }
  }
  return patch;
}

/**
 * The soft mask the reference implementation applies: a power ratio of the two
 * stems' predicted magnitudes, with a tiny epsilon so a silent bin splits evenly
 * instead of dividing by zero.
 */
export function softMask(
  vocals: Float32Array,
  accompaniment: Float32Array,
  into?: Float32Array,
): Float32Array {
  const mask = into ?? new Float32Array(vocals.length);
  const eps = 1e-10;
  for (let i = 0; i < vocals.length; i += 1) {
    const v = vocals[i]!;
    const a = accompaniment[i]!;
    mask[i] = (v * v + eps / 2) / (v * v + a * a + eps);
  }
  return mask;
}

/**
 * Multiply the complex spectrum of `frames` frames by a mask patch into `out`.
 *
 * Above the model's band the mask is zero by construction: the model never saw
 * those bins, so it cannot have an opinion about them.
 */
export function maskSpectrumInto(
  spec: FrameSpectra,
  frames: number,
  mask: Float32Array,
  out: FrameSpectra,
): void {
  const rows = Math.min(frames, SPLEETER_SPLIT_FRAMES);
  for (let t = 0; t < rows; t += 1) {
    const row = t * SPECTRUM_STRIDE;
    const maskRow = t * SPLEETER_MODEL_BINS;
    for (let f = 0; f < SPECTRUM_STRIDE; f += 1) {
      const m = f < SPLEETER_MODEL_BINS ? mask[maskRow + f]! : 0;
      out.re[row + f] = spec.re[row + f]! * m;
      out.im[row + f] = spec.im[row + f]! * m;
    }
  }
}

/** A zeroed spectrum with room for `frames` frames. */
export function emptySpectrum(frames: number): FrameSpectra {
  return {
    frames,
    re: new Float32Array(frames * SPECTRUM_STRIDE),
    im: new Float32Array(frames * SPECTRUM_STRIDE),
  };
}
