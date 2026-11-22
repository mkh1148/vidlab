// D6 · the spectrogram pair, measured rather than assumed.
//
// The separation engine is only as trustworthy as its STFT: the model predicts a
// magnitude patch and the caller rebuilds the waveform, so an off-by-one in the
// framing, a missing conjugate half or a wrong row stride produces an artifact
// that is quieter, shifted or hollow — and every one of those has already been
// seen in this feature's prototype. This file pins them:
//
//   1. framing arithmetic — the last real sample is covered by four frames;
//   2. round trip — analysis then synthesis returns the input at 0 samples of
//      offset and within float32 error in amplitude;
//   3. an impulse stays where it was (alignment is a measurement, D2's lesson);
//   4. split windows agree bit-exactly with whole-signal analysis, which is what
//      lets the engine process one 512-frame split at a time;
//   5. the mask is a power ratio with the documented endpoints, and it zeroes the
//      bins above the model's 1024-bin band (the 11.0 kHz limit, stated in the
//      module header as an audible property of the artifact);
//   6. synthesis never produces NaN where no window reached.
//
// Run: npx tsx server/spleeter-spectrogram.verify.ts
import assert from 'node:assert/strict';
import {
  SPLEETER_HOP,
  SPLEETER_MODEL_BINS,
  SPLEETER_N_FFT,
  SPLEETER_SAMPLE_RATE,
  SPLEETER_SPECTRUM_BINS,
  SPLEETER_SPLIT_FRAMES,
  analyseFrames,
  emptySpectrum,
  finishSynthesis,
  frameCount,
  magnitudePatch,
  maskSpectrumInto,
  softMask,
  splitCount,
  synthesiseInto,
  windowSamples,
} from './spleeter-spectrogram.ts';

/** Energy at one frequency, by a single-bin DFT over the middle of a signal. */
function toneDb(samples: Float32Array, hz: number): number {
  const start = Math.floor(samples.length * 0.25);
  const count = Math.floor(samples.length * 0.5);
  const w = (2 * Math.PI * hz) / SPLEETER_SAMPLE_RATE;
  let re = 0;
  let im = 0;
  for (let i = 0; i < count; i += 1) {
    const s = samples[start + i]!;
    re += s * Math.cos(w * i);
    im -= s * Math.sin(w * i);
  }
  return 20 * Math.log10(Math.hypot(re, im) / count + 1e-12);
}

/** Analyse a whole signal with the caller's zero-padded leading window. */
function analyseSignal(samples: Float32Array) {
  const frames = frameCount(samples.length);
  const window = new Float32Array(windowSamples(frames));
  window.set(samples.subarray(0, Math.min(samples.length, window.length)), SPLEETER_N_FFT);
  return { frames, window, spec: analyseFrames(window, frames) };
}

// ── 1. framing arithmetic ───────────────────────────────────────────────────
for (const samples of [1, 1023, 1024, 1025, 44_100, 573_300]) {
  const frames = frameCount(samples);
  // The last real sample is covered by frame `t` when t * hop - 1 >= samples - 1,
  // and it needs the three frames that reach past it to see the full overlap.
  assert.ok(frames * SPLEETER_HOP > samples, `${samples} samples needs ${frames} frames to reach the end`);
  assert.ok(windowSamples(frames) >= frames * SPLEETER_HOP,
    `the window of ${frames} frames must cover the last frame's end`);
  assert.ok(frames >= 4, 'the tail must still have four frames of overlap');
}
assert.equal(frameCount(0), 0);
assert.equal(splitCount(0), 0);
assert.equal(splitCount(SPLEETER_SPLIT_FRAMES), 1);
assert.equal(splitCount(SPLEETER_SPLIT_FRAMES + 1), 2);
console.log(`spectrogram: framing — ${frameCount(573_300)} frames for 13 s, `
  + `${splitCount(frameCount(573_300))} model splits`);

// ── 2 & 3. round trip and impulse alignment ─────────────────────────────────
const seconds = 1.5;
const length = Math.round(seconds * SPLEETER_SAMPLE_RATE);
const source = new Float32Array(length);
for (let i = 0; i < length; i += 1) {
  const t = i / SPLEETER_SAMPLE_RATE;
  source[i] = 0.3 * Math.sin(2 * Math.PI * 220 * t) + 0.2 * Math.sin(2 * Math.PI * 3170 * t) + 0.05;
}
const { frames, window, spec } = analyseSignal(source);
const out = new Float32Array(windowSamples(frames));
const norm = new Float32Array(out.length);
synthesiseInto(spec, frames, out, norm);
const rebuilt = finishSynthesis(out, norm, length, SPLEETER_N_FFT);

let maxError = 0;
for (let i = 0; i < length; i += 1) maxError = Math.max(maxError, Math.abs(rebuilt[i]! - source[i]!));
assert.ok(maxError < 2e-3, `the round trip must be the identity, max error ${maxError}`);

// The impulse is the alignment probe: a shifted STFT moves it, a halved
// amplitude shows up as a smaller peak, and both are silent failures otherwise.
const impulse = new Float32Array(length);
const impulseAt = 30_000;
impulse[impulseAt] = 0.5;
const impulseRun = analyseSignal(impulse);
const impulseOut = new Float32Array(windowSamples(impulseRun.frames));
const impulseNorm = new Float32Array(impulseOut.length);
synthesiseInto(impulseRun.spec, impulseRun.frames, impulseOut, impulseNorm);
const impulseBack = finishSynthesis(impulseOut, impulseNorm, length, SPLEETER_N_FFT);
let peakAt = 0;
for (let i = 0; i < length; i += 1) if (Math.abs(impulseBack[i]!) > Math.abs(impulseBack[peakAt]!)) peakAt = i;
assert.equal(peakAt, impulseAt, `the impulse must return at sample ${impulseAt}, got ${peakAt}`);
assert.ok(Math.abs(impulseBack[peakAt]! - 0.5) < 0.02,
  `the impulse amplitude must survive, got ${impulseBack[peakAt]}`);
console.log(`spectrogram: round trip — max error ${maxError.toExponential(2)}, impulse at ${impulseAt} `
  + `returns at ${peakAt} with amplitude ${impulseBack[peakAt]!.toFixed(4)}`);

// ── 4. split windows agree with whole-signal analysis ───────────────────────
const whole = analyseFrames(window, frames);
const splitStart = Math.floor(frames / 2);
const splitWindow = window.subarray(splitStart * SPLEETER_HOP);
const splitSpec = analyseFrames(splitWindow, Math.min(SPLEETER_SPLIT_FRAMES, frames - splitStart));
let splitDelta = 0;
for (let t = 0; t < splitSpec.frames; t += 1) {
  const wholeRow = (splitStart + t) * SPLEETER_SPECTRUM_BINS;
  const splitRow = t * SPLEETER_SPECTRUM_BINS;
  for (let f = 0; f < SPLEETER_MODEL_BINS; f += 1) {
    splitDelta = Math.max(splitDelta, Math.abs(splitSpec.re[splitRow + f]! - whole.re[wholeRow + f]!));
    splitDelta = Math.max(splitDelta, Math.abs(splitSpec.im[splitRow + f]! - whole.im[wholeRow + f]!));
  }
}
assert.equal(splitDelta, 0, `a split window must analyse bit-exactly like the whole signal, delta ${splitDelta}`);
console.log('spectrogram: split windows — bit-exact against whole-signal analysis');

// ── 5. the mask ─────────────────────────────────────────────────────────────
const mask = softMask(new Float32Array([0, 1, 0, 3]), new Float32Array([0, 0, 1, 1]));
assert.ok(Math.abs(mask[0]! - 0.5) < 1e-6, `a silent bin splits evenly, got ${mask[0]}`);
assert.ok(mask[1]! > 0.999, `a bin only the vocals predict is kept, got ${mask[1]}`);
assert.ok(mask[2]! < 1e-6, `a bin only the accompaniment predicts is dropped, got ${mask[2]}`);
assert.ok(mask[3]! > 0.85 && mask[3]! < 0.95, `a 3:1 power ratio is 0.9, got ${mask[3]}`);

const ones = new Float32Array(SPLEETER_SPLIT_FRAMES * SPLEETER_MODEL_BINS).fill(1);
const masked = emptySpectrum(splitSpec.frames);
maskSpectrumInto(splitSpec, splitSpec.frames, ones, masked);
let bandDelta = 0;
let aboveBand = 0;
for (let t = 0; t < splitSpec.frames; t += 1) {
  const row = t * SPLEETER_SPECTRUM_BINS;
  for (let f = 0; f < SPLEETER_MODEL_BINS; f += 1) {
    bandDelta = Math.max(bandDelta, Math.abs(masked.re[row + f]! - splitSpec.re[row + f]!));
  }
  for (let f = SPLEETER_MODEL_BINS; f < SPLEETER_N_FFT / 2 + 1; f += 1) {
    aboveBand = Math.max(aboveBand, Math.abs(masked.re[row + f]!), Math.abs(masked.im[row + f]!));
  }
}
assert.equal(bandDelta, 0, 'a unit mask must be the identity inside the model band');
assert.equal(aboveBand, 0, 'the mask must zero every bin above the model band');

// The band limit is audible, so it is measured end to end: a 12 kHz tone cannot
// survive a mask the model can only define below 11.0 kHz.
const bandSource = new Float32Array(length);
for (let i = 0; i < length; i += 1) {
  const t = i / SPLEETER_SAMPLE_RATE;
  bandSource[i] = 0.4 * Math.sin(2 * Math.PI * 1000 * t) + 0.4 * Math.sin(2 * Math.PI * 12_000 * t);
}
const bandRun = analyseSignal(bandSource);
const bandMask = new Float32Array(SPLEETER_SPLIT_FRAMES * SPLEETER_MODEL_BINS).fill(1);
const bandMasked = emptySpectrum(bandRun.frames);
for (let start = 0; start < bandRun.frames; start += SPLEETER_SPLIT_FRAMES) {
  const count = Math.min(SPLEETER_SPLIT_FRAMES, bandRun.frames - start);
  const slice = analyseFrames(bandRun.window.subarray(start * SPLEETER_HOP), count);
  const sliceOut = emptySpectrum(count);
  maskSpectrumInto(slice, count, bandMask, sliceOut);
  for (let t = 0; t < count; t += 1) {
    const from = t * SPLEETER_SPECTRUM_BINS;
    const to = (start + t) * SPLEETER_SPECTRUM_BINS;
    bandMasked.re.set(sliceOut.re.subarray(from, from + SPLEETER_N_FFT / 2 + 1), to);
    bandMasked.im.set(sliceOut.im.subarray(from, from + SPLEETER_N_FFT / 2 + 1), to);
  }
}
const bandOut = new Float32Array(windowSamples(bandRun.frames));
const bandNorm = new Float32Array(bandOut.length);
synthesiseInto(bandMasked, bandRun.frames, bandOut, bandNorm);
const bandBack = finishSynthesis(bandOut, bandNorm, length, SPLEETER_N_FFT);
const keptDb = toneDb(bandBack, 1000);
const droppedDb = toneDb(bandBack, 12_000);
assert.ok(keptDb - droppedDb > 40,
  `the 12 kHz tone must be rejected by the model band, kept ${keptDb.toFixed(1)} dB vs `
  + `dropped ${droppedDb.toFixed(1)} dB`);
console.log(`spectrogram: mask — unit mask is the identity in band, 12 kHz rejected by `
  + `${(keptDb - droppedDb).toFixed(1)} dB (the 11.0 kHz band limit is real)`);

// ── 6. a gap in the overlap-add is silence, not NaN ─────────────────────────
const gapOut = new Float32Array(8);
const gapNorm = new Float32Array(8);
const gap = finishSynthesis(gapOut, gapNorm, 8);
for (const value of gap) assert.ok(Number.isFinite(value) && value === 0, 'an uncovered sample is 0, never NaN');

// The patch the model actually sees: 512 x 1024, zero-padded when the final
// split is short, and the magnitude of the complex bin.
const patch = magnitudePatch(splitSpec, 8);
assert.equal(patch.length, SPLEETER_SPLIT_FRAMES * SPLEETER_MODEL_BINS);
let patchTail = 0;
for (let i = 8 * SPLEETER_MODEL_BINS; i < patch.length; i += 1) patchTail = Math.max(patchTail, Math.abs(patch[i]!));
assert.equal(patchTail, 0, 'a short split is zero-padded to the model shape');
const expected = Math.hypot(splitSpec.re[3 * SPLEETER_SPECTRUM_BINS + 7]!, splitSpec.im[3 * SPLEETER_SPECTRUM_BINS + 7]!);
assert.ok(Math.abs(patch[3 * SPLEETER_MODEL_BINS + 7]! - expected) <= expected * 1e-6,
  'the patch is the bin magnitude');
console.log('spectrogram: patch — 512 x 1024, zero-padded, magnitude of the complex bin');
console.log('spleeter spectrogram: analysis and synthesis are measured, not assumed: OK');
