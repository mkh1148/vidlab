// The D1 background-removal engine child: FFmpeg decode -> RVM (ONNX) -> FFmpeg
// encode with alpha.
//
// It runs as its own process for two reasons: ONNX Runtime is a native addon and
// a bad model or an OOM would otherwise take the editor's server down with it,
// and a child is what the D-job contract's single kill policy (SIGKILL on a real
// pid) can actually stop.
//
// argv: <sourceFile> <outFile> <modelPath> <width> <height> <fps> <frames> <ratio>
//       <stepCount> <ffmpegBin> [threads]
//
// The FFmpeg path and the thread count arrive as arguments, not environment
// variables: a spawned engine should not depend on the parent's environment, and
// an explicit argument is what a verify can assert on.
//
// Output discipline (the reviewer's D1b note): the encoder writes
// `<outFile>.partial.webm` and the child renames it to `<outFile>` only when the
// muxer closed cleanly. A partial is therefore always visible, co-resident in the
// same per-source directory, and never mistakable for a finished artifact — which
// matters because SIGKILL cannot run a cleanup handler.
//
// stdout: one `step <i>/<n>` line per progress step, then `done`.
// exit: 0 done, 2 bad arguments, 3 decode failed, 4 model failed, 5 encode failed.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { renameSync, rmSync, statSync } from 'node:fs';
import { once } from 'node:events';

const require = createRequire(import.meta.url);

const [
  sourceFile,
  outFile,
  modelPath,
  widthArg,
  heightArg,
  fpsArg,
  framesArg,
  ratioArg,
  stepCountArg,
  ffmpegArg,
  threadsArg,
] = process.argv.slice(2);

const width = Math.round(Number(widthArg));
const height = Math.round(Number(heightArg));
const fps = Number(fpsArg);
const frames = Math.round(Number(framesArg));
const ratio = Number(ratioArg);
const stepCount = Math.max(1, Math.round(Number(stepCountArg)));
const threads = Math.max(1, Math.min(12, Math.round(Number(threadsArg)) || 6));

if (!sourceFile || !outFile || !modelPath || !Number.isFinite(width) || !Number.isFinite(height)
  || !Number.isFinite(fps) || !Number.isFinite(frames) || frames < 1 || !Number.isFinite(ratio)) {
  process.stderr.write('rvm engine: bad arguments\n');
  process.exit(2);
}

/** Below this peak alpha the frame has no person in it. */
const NO_PERSON_ENTER = 0.05;
/** Above this peak alpha a person is back; the gap is hysteresis, not a guess. */
const NO_PERSON_EXIT = 0.15;

const partialFile = `${outFile}.partial.webm`;
const FRAME_BYTES = width * height * 3;
const PIXELS = width * height;

// The environment fallback exists only so the engine can be benched standalone.
const ffmpegBin = ffmpegArg || process.env.VIDLAB_FFMPEG_BIN;
if (!ffmpegBin) {
  process.stderr.write('rvm engine: VIDLAB_FFMPEG_BIN is not set\n');
  process.exit(2);
}

/** Remove a file we may or may not have created. */
function removeQuietly(file) {
  try {
    rmSync(file, { force: true });
  } catch {
    // Best effort: a leftover partial is named `.partial`, so it can never be
    // mistaken for a finished artifact.
  }
}

function fail(code, message) {
  process.stderr.write(`${message}\n`);
  removeQuietly(partialFile);
  process.exit(code);
}

// ── decode: FFmpeg raw rgb24 on stdout, exactly one frame at a time ──────────
const decoder = spawn(ffmpegBin, [
  '-v', 'error', '-nostdin',
  '-i', sourceFile,
  '-f', 'rawvideo', '-pix_fmt', 'rgb24',
  '-an', '-sn', '-dn',
  '-',
], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

let decodeError = '';
decoder.stderr.on('data', (chunk) => {
  decodeError = (decodeError + String(chunk)).slice(-2_000);
});

let pending = Buffer.alloc(0);
let decodeEnded = false;
const frameQueue = [];
let waiting = null;
/** Frames allowed to sit decoded-but-unprocessed before the decoder is paused. */
const MAX_QUEUED_FRAMES = 4;
let paused = false;

decoder.stdout.on('data', (chunk) => {
  pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
  while (pending.length >= FRAME_BYTES) {
    frameQueue.push(pending.subarray(0, FRAME_BYTES));
    pending = pending.subarray(FRAME_BYTES);
  }
  // Backpressure, not politeness: without it the decoder races to the end of the
  // file, starving the encoder of CPU and holding every frame in memory (a
  // 6-minute 720p clip would be ~19 GB of queued buffers).
  if (frameQueue.length >= MAX_QUEUED_FRAMES) {
    paused = true;
    decoder.stdout.pause();
  }
  if (waiting) {
    const wake = waiting;
    waiting = null;
    wake();
  }
});
decoder.stdout.on('end', () => {
  decodeEnded = true;
  if (waiting) {
    const wake = waiting;
    waiting = null;
    wake();
  }
});
decoder.on('error', (error) => {
  decodeError = `${decodeError}\n${error.message}`;
  decodeEnded = true;
  if (waiting) {
    const wake = waiting;
    waiting = null;
    wake();
  }
});

/** The next decoded frame, or null when the decoder is done. */
async function nextFrame() {
  for (;;) {
    if (frameQueue.length) {
      const frame = frameQueue.shift();
      if (paused && frameQueue.length < MAX_QUEUED_FRAMES) {
        paused = false;
        decoder.stdout.resume();
      }
      return frame;
    }
    if (decodeEnded) return null;
    await new Promise((resolve) => { waiting = resolve; });
  }
}

// ── encode: FFmpeg raw rgba on stdin -> VP9 with alpha in WebM ───────────────
// yuva420p is what makes libvpx-vp9 carry an alpha plane; without it the file is
// opaque and the whole feature silently does nothing. `-auto-alt-ref 0` keeps
// the alpha plane legal in every frame (VP9 alpha and alt-ref frames do not mix).
const encoder = spawn(ffmpegBin, [
  '-v', 'error', '-nostdin', '-y',
  '-f', 'rawvideo', '-pix_fmt', 'rgba',
  '-s', `${width}x${height}`, '-framerate', String(fps),
  '-i', '-',
  '-an',
  '-c:v', 'libvpx-vp9',
  '-pix_fmt', 'yuva420p',
  '-b:v', '0', '-crf', '30',
  '-row-mt', '1', '-auto-alt-ref', '0',
  '-deadline', 'good', '-cpu-used', '4',
  partialFile,
], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });

let encodeError = '';
encoder.stderr.on('data', (chunk) => {
  encodeError = (encodeError + String(chunk)).slice(-2_000);
});

async function writeFrame(buffer) {
  if (encoder.stdin.destroyed) throw new Error('the encoder closed its input');
  if (!encoder.stdin.write(buffer)) await once(encoder.stdin, 'drain');
}

// ── model ───────────────────────────────────────────────────────────────────
const ort = require('onnxruntime-node');
let session;
try {
  session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
    intraOpNumThreads: threads,
  });
} catch (error) {
  fail(4, `rvm engine: could not create the ONNX session: ${error.message}`);
}

let state = ['r1i', 'r2i', 'r3i', 'r4i'].map(() => new ort.Tensor('float32', new Float32Array([0]), [1, 1, 1, 1]));
const src = new Float32Array(3 * PIXELS);
// Uint8ClampedArray rounds and clamps on assignment, which is the whole
// composition step: the model's float output lands as a legal byte with no
// Math.round/Math.min in the hot loop.
const rgba = new Uint8ClampedArray(PIXELS * 4);
const BYTE_TO_UNIT = new Float32Array(256);
for (let index = 0; index < 256; index += 1) BYTE_TO_UNIT[index] = index / 255;
const ratioTensor = new ort.Tensor('float32', new Float32Array([ratio]), [1]);

/** One frame through the recurrent model, composed to RGBA with alpha. */
async function matte(frame) {
  for (let p = 0; p < PIXELS; p += 1) {
    const base = p * 3;
    src[p] = BYTE_TO_UNIT[frame[base]];
    src[PIXELS + p] = BYTE_TO_UNIT[frame[base + 1]];
    src[2 * PIXELS + p] = BYTE_TO_UNIT[frame[base + 2]];
  }
  const feeds = { src: new ort.Tensor('float32', src, [1, 3, height, width]) };
  for (let index = 0; index < 4; index += 1) feeds[`r${index + 1}i`] = state[index];
  feeds.downsample_ratio = ratioTensor;
  const out = await session.run(feeds);
  state = ['r1o', 'r2o', 'r3o', 'r4o'].map((name) => out[name]);
  return { fgr: out.fgr.data, pha: out.pha.data };
}

// ── the loop ────────────────────────────────────────────────────────────────
let noPerson = false;
let processed = 0;
let personFrames = 0;
let stepSize = Math.max(1, Math.ceil(frames / stepCount));
// Phase accounting, so a recorded measurement can say where the seconds went
// instead of guessing (kit D-5: engine and device recorded per measurement).
const profile = { decode: 0, model: 0, compose: 0, write: 0, writes: [], models: [] };
const profiling = process.env.VIDLAB_RVM_PROFILE === '1';

try {
  for (let index = 0; index < frames; index += 1) {
    const beforeDecode = performance.now();
    const frame = await nextFrame();
    if (!frame) break;
    profile.decode += performance.now() - beforeDecode;
    const beforeModel = performance.now();
    const { fgr, pha } = await matte(frame);
    profile.model += performance.now() - beforeModel;
    if (profiling) profile.models.push(Math.round(performance.now() - beforeModel));
    const beforeCompose = performance.now();

    let peak = 0;
    for (let p = 0; p < PIXELS; p += 1) {
      const value = pha[p];
      if (value > peak) peak = value;
    }
    // Kit rule: a stretch with no person keeps the ORIGINAL picture — a
    // transparent screen recording exports as black and reads as a bug. The two
    // thresholds are hysteresis so the picture cannot flicker at the boundary.
    if (noPerson) {
      if (peak > NO_PERSON_EXIT) noPerson = false;
    } else if (peak < NO_PERSON_ENTER) {
      noPerson = true;
    }

    if (noPerson) {
      for (let p = 0; p < PIXELS; p += 1) {
        const base = p * 3;
        const target = p * 4;
        rgba[target] = frame[base];
        rgba[target + 1] = frame[base + 1];
        rgba[target + 2] = frame[base + 2];
        rgba[target + 3] = 255;
      }
    } else {
      personFrames += 1;
      for (let p = 0; p < PIXELS; p += 1) {
        const target = p * 4;
        rgba[target] = fgr[p] * 255;
        rgba[target + 1] = fgr[PIXELS + p] * 255;
        rgba[target + 2] = fgr[2 * PIXELS + p] * 255;
        rgba[target + 3] = pha[p] * 255;
      }
    }

    profile.compose += performance.now() - beforeCompose;
    const beforeWrite = performance.now();
    await writeFrame(Buffer.from(rgba));
    profile.write += performance.now() - beforeWrite;
    if (profiling) profile.writes.push(Math.round(performance.now() - beforeWrite));
    processed += 1;
    if (processed % stepSize === 0 || processed === frames) {
      process.stdout.write(`step ${processed}/${frames}\n`);
    }
  }
} catch (error) {
  fail(5, `rvm engine: ${error.message}`);
}

// The decoder is usually still mid-file when the loop ends (it is paused behind
// backpressure); stop it so the encoder is the only child left and the process
// can exit on its own once stdout has flushed.
decoder.kill();
decoder.stdout.destroy();

encoder.stdin.end();
const [code] = await once(encoder, 'close');
if (code !== 0) {
  fail(5, `rvm engine: the encoder exited ${code}: ${encodeError.slice(-500)}`);
}
if (processed === 0) fail(3, `rvm engine: no frames decoded: ${decodeError.slice(-500)}`);

let bytes = 0;
try {
  bytes = statSync(partialFile).size;
} catch {
  fail(5, 'rvm engine: the encoder wrote nothing');
}
if (bytes <= 0) fail(5, 'rvm engine: the encoder wrote an empty file');

// The rename is the "finished" signal: until it happens the artifact is a
// visible `.partial` beside its final name, in the same per-source directory.
renameSync(partialFile, outFile);
if (profiling) {
  const round = (value) => Math.round(value);
  process.stderr.write(`profile decode=${round(profile.decode)}ms model=${round(profile.model)}ms compose=${round(profile.compose)}ms write=${round(profile.write)}ms frames=${processed} bytes=${bytes} models=${profile.models.join(',')} writes=${profile.writes.join(',')}\n`);
}
process.stdout.write(`person ${personFrames}/${processed}\n`);
process.stdout.write('done\n');
