// The D6 separation engine child: raw 44.1 kHz stereo float32 in, vocals WAV out.
//
// It runs as its own process for the same three reasons the D1 matting child does —
// ONNX Runtime is a native addon, a bad model or an OOM must not take the editor's
// server down with it, and a child is what the D-job contract's single kill policy
// (SIGKILL on a real pid) can actually stop — plus one that is specific to this
// feature: the legacy isolate-voice route spawned FFmpeg from the request handler and
// a broker-side cancel never reached it, so the child outlived the job. This child
// spawns NOTHING. Decode happens in the parent (a direct FFmpeg child the kill policy
// reaches) and the clean-up chain runs after this child has exited, so there is no
// grandchild that a SIGKILL could orphan.
//
// argv: <mixRawFile> <vocalsWavOut> <vocalsModel> <accompanimentModel> [threads]
//
// The model paths arrive as arguments, not environment variables: a spawned engine
// should not depend on the parent's environment, and an explicit argument is what a
// verify can assert on.
//
// Memory is O(one split), not O(clip). The model's unit is 512 consecutive frames
// (~11.9 s) and its splits are bit-exactly independent (measured: one 2-split call
// versus two 1-split calls differ by 0), so this loop reads one window of samples,
// runs both UNets once, masks the mix spectrum and overlap-adds the result. A
// six-minute clip is 190 splits of ~65 MB of buffers instead of 190 MB of complex
// spectrum plus a whole decoded clip.
//
// stdout: one `step <i>/<n>` line per split, then `done`.
// exit: 0 done, 2 bad arguments, 3 the mix file is unreadable, 4 model failed,
//       5 the artifact could not be written.
import { createRequire } from 'node:module';
import { closeSync, fstatSync, openSync, readSync, writeSync } from 'node:fs';
import {
  SPLEETER_HOP,
  SPLEETER_MODEL_BINS,
  SPLEETER_N_FFT,
  SPLEETER_SAMPLE_RATE,
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

const require = createRequire(import.meta.url);

const [mixFile, outFile, vocalsModel, accompanimentModel, threadsArg] = process.argv.slice(2);
const threads = Math.max(1, Math.min(12, Math.round(Number(threadsArg)) || 6));

if (!mixFile || !outFile || !vocalsModel || !accompanimentModel) {
  process.stderr.write('separation engine: bad arguments\n');
  process.exit(2);
}

const SPLIT = SPLEETER_SPLIT_FRAMES;
/** Samples one split's frames read: `(512 - 1) * hop + n_fft`. */
const WINDOW = windowSamples(SPLIT);
/** Samples one split's frames write, plus the window the next split's first frame reaches back over. */
const ACCUMULATOR = SPLIT * SPLEETER_HOP + SPLEETER_N_FFT;
const CHANNELS = 2;
const BYTES_PER_FRAME = CHANNELS * 4;

function fail(code: number, message: string): never {
  process.stderr.write(`separation engine: ${message}\n`);
  process.exit(code);
}

/** A WAV header for interleaved 32-bit float stereo. */
function wavHeader(dataBytes: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(3, 20); // WAVE_FORMAT_IEEE_FLOAT
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SPLEETER_SAMPLE_RATE, 24);
  header.writeUInt32LE(SPLEETER_SAMPLE_RATE * BYTES_PER_FRAME, 28);
  header.writeUInt16LE(BYTES_PER_FRAME, 32);
  header.writeUInt16LE(32, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

async function main(): Promise<void> {
  let rawFd: number;
  let samples: number;
  try {
    rawFd = openSync(mixFile, 'r');
    samples = Math.floor(fstatSync(rawFd).size / BYTES_PER_FRAME);
  } catch (error) {
    fail(3, `could not read the decoded mix: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (samples <= 0) fail(3, 'the decoded mix is empty');

  const frames = frameCount(samples);
  const splits = splitCount(frames);

  const ort = require('onnxruntime-node') as typeof import('onnxruntime-node');
  let vocals: import('onnxruntime-node').InferenceSession;
  let accompaniment: import('onnxruntime-node').InferenceSession;
  try {
    const options = {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all' as const,
      intraOpNumThreads: threads,
    };
    vocals = await ort.InferenceSession.create(vocalsModel, options);
    accompaniment = await ort.InferenceSession.create(accompanimentModel, options);
  } catch (error) {
    fail(4, `could not create the ONNX sessions: ${error instanceof Error ? error.message : String(error)}`);
  }

  let outFd: number;
  try {
    outFd = openSync(outFile, 'w');
    writeSync(outFd, wavHeader(samples * BYTES_PER_FRAME));
  } catch (error) {
    fail(5, `could not open the artifact: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Every buffer is allocated once and reused: the loop runs 190 times on a
  // six-minute clip and 65 MB of fresh typed arrays per iteration would be churn.
  const rawBytes = Buffer.allocUnsafe(WINDOW * BYTES_PER_FRAME);
  const windowL = new Float32Array(WINDOW);
  const windowR = new Float32Array(WINDOW);
  const specL = emptySpectrum(SPLIT);
  const specR = emptySpectrum(SPLIT);
  const masked = emptySpectrum(SPLIT);
  const patch = new Float32Array(CHANNELS * SPLIT * SPLEETER_MODEL_BINS);
  const mask = new Float32Array(SPLIT * SPLEETER_MODEL_BINS);
  const outL = new Float32Array(ACCUMULATOR);
  const normL = new Float32Array(ACCUMULATOR);
  const outR = new Float32Array(ACCUMULATOR);
  const normR = new Float32Array(ACCUMULATOR);
  const flushL = new Float32Array(SPLIT * SPLEETER_HOP);
  const flushR = new Float32Array(SPLIT * SPLEETER_HOP);
  const writeBytes = Buffer.allocUnsafe(SPLIT * SPLEETER_HOP * BYTES_PER_FRAME);

  /** Read the window of samples starting at global sample `firstSample`, zero-padded. */
  const readWindow = (firstSample: number): void => {
    windowL.fill(0);
    windowR.fill(0);
    const from = Math.max(0, firstSample);
    const to = Math.min(samples, firstSample + WINDOW);
    if (to <= from) return;
    const bytes = (to - from) * BYTES_PER_FRAME;
    let read = 0;
    while (read < bytes) {
      const got = readSync(rawFd, rawBytes, read, bytes - read, from * BYTES_PER_FRAME + read);
      if (got <= 0) break;
      read += got;
    }
    const offset = from - firstSample;
    for (let i = 0; i < (to - from); i += 1) {
      windowL[offset + i] = rawBytes.readFloatLE(i * BYTES_PER_FRAME);
      windowR[offset + i] = rawBytes.readFloatLE(i * BYTES_PER_FRAME + 4);
    }
  };

  /**
   * Write the samples of one split that are FINAL after it.
   *
   * Frame `t` covers samples `[t * hop - n_fft, t * hop)`, so the next split's first
   * frame reaches back `n_fft` samples into this split's range. Everything before
   * that boundary has all four of its covering frames and is final; the rest is
   * flushed by the next iteration (or by the tail flush below).
   */
  const flush = (splitStart: number, from: number, to: number): void => {
    if (to <= from) return;
    const count = to - from;
    const local = from - splitStart + SPLEETER_N_FFT;
    finishSynthesis(outL, normL, count, local, flushL);
    finishSynthesis(outR, normR, count, local, flushR);
    for (let i = 0; i < count; i += 1) {
      writeBytes.writeFloatLE(flushL[i]!, i * BYTES_PER_FRAME);
      writeBytes.writeFloatLE(flushR[i]!, i * BYTES_PER_FRAME + 4);
    }
    try {
      writeSync(outFd, writeBytes, 0, count * BYTES_PER_FRAME);
    } catch (error) {
      fail(5, `could not write the artifact: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  let lastSplitStart = 0;
  try {
    for (let split = 0; split < splits; split += 1) {
      const splitStart = split * SPLIT * SPLEETER_HOP;
      lastSplitStart = splitStart;
      readWindow(splitStart - SPLEETER_N_FFT);
      analyseFrames(windowL, SPLIT, specL);
      analyseFrames(windowR, SPLIT, specR);

      magnitudePatch(specL, SPLIT, patch.subarray(0, SPLIT * SPLEETER_MODEL_BINS));
      magnitudePatch(specR, SPLIT, patch.subarray(SPLIT * SPLEETER_MODEL_BINS));
      const input = new ort.Tensor('float32', patch, [CHANNELS, 1, SPLIT, SPLEETER_MODEL_BINS]);
      const vocalsOut = (await vocals.run({ x: input })).y!.data as Float32Array;
      const accompanimentOut = (await accompaniment.run({ x: input })).y!.data as Float32Array;

      outL.fill(0);
      normL.fill(0);
      outR.fill(0);
      normR.fill(0);
      for (let channel = 0; channel < CHANNELS; channel += 1) {
        const base = channel * SPLIT * SPLEETER_MODEL_BINS;
        softMask(
          vocalsOut.subarray(base, base + SPLIT * SPLEETER_MODEL_BINS),
          accompanimentOut.subarray(base, base + SPLIT * SPLEETER_MODEL_BINS),
          mask,
        );
        const spec = channel === 0 ? specL : specR;
        maskSpectrumInto(spec, SPLIT, mask, masked);
        synthesiseInto(
          masked,
          SPLIT,
          channel === 0 ? outL : outR,
          channel === 0 ? normL : normR,
        );
      }

      // Final after this split: everything before the next split's first frame reaches.
      flush(splitStart, splitStart, Math.min(samples, splitStart + SPLIT * SPLEETER_HOP - SPLEETER_N_FFT));
      process.stdout.write(`step ${split + 1}/${splits}\n`);
    }

    // The tail: samples the last split's frames cover but the boundary above held back.
    flush(lastSplitStart, Math.min(samples, lastSplitStart + SPLIT * SPLEETER_HOP - SPLEETER_N_FFT), samples);
  } finally {
    closeSync(rawFd);
    closeSync(outFd);
  }

  process.stdout.write('done\n');
}

await main();
