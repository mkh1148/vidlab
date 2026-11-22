// D4 · the analyze pass, driven without a browser.
//
// The seek loop takes a callback and a runtime, so the whole pass can be proven in
// Node: the sample frames are source frames, a frame with no face still produces an
// aligned sample with an empty cell, the atlas packs one cell per sample, progress
// never goes backwards, and an abort stops the run instead of finishing it.
import assert from 'node:assert/strict';
import { analyzeFaceFrames, faceSampleFrames } from './analyzeFace.ts';
import { FACE_ANALYSIS_FPS } from './faceTrack.ts';
import { faceAtlasGrid, unpackFaceAtlasCell } from './faceAtlas.ts';
import type { FaceFrameInference, FaceRuntime } from './faceLandmarker.ts';

// ── which frames get sampled ────────────────────────────────────────────────
const frames = faceSampleFrames(30, 390, FACE_ANALYSIS_FPS);
assert.equal(frames.length, 65, '13 s at 30 fps sampled at 5 Hz is 65 samples');
assert.equal(frames[0], 0);
assert.deepEqual(frames.slice(0, 4), [0, 6, 12, 18], 'samples land every 6 source frames');
assert.equal(frames[frames.length - 1], 384, 'the last sample stays inside the source');
assert.deepEqual(faceSampleFrames(30, 1, 5), [0], 'a one-frame source still has one sample');
assert.deepEqual(faceSampleFrames(24, 24, 48).slice(0, 3), [0, 1, 2], 'a faster analysis rate cannot repeat a frame');

// ── the pass ───────────────────────────────────────────────────────────────
const seen: number[] = [];
const progress: number[] = [];
const personWidth = 32;
const personHeight = 32;
const person = new Uint8Array(personWidth * personHeight).fill(255);

let inferCalls = 0;
const runtime: FaceRuntime = {
  infer: (): FaceFrameInference => {
    // Face present on every third sample, absent otherwise.
    const present = inferCalls % 3 === 0;
    inferCalls += 1;
    return {
      box: present ? { x: 0.3, y: 0.2, w: 0.3, h: 0.4 } : null,
      person,
      personWidth,
      personHeight,
      confidence: present ? 1 : 0,
    };
  },
  close: () => undefined,
};

const outcome = await analyzeFaceFrames({
  sourceFps: 30,
  sourceFrames: 390,
  runtime,
  seek: async (sourceFrame) => {
    seen.push(sourceFrame);
    return {} as HTMLCanvasElement;
  },
  onProgress: (update) => progress.push(update.progress),
  now: () => 1_000,
});

assert.deepEqual(seen, frames, 'the pass seeks each sampled SOURCE frame exactly once, in order');
assert.equal(outcome.sampleCount, 65);
assert.equal(outcome.facesFound, 22, 'every third sample found a face');
assert.equal(outcome.track.samples.length, 65, 'a frame with no face still gets a sample');
assert.deepEqual(outcome.track.samples.map((sample) => sample.f), frames, 'samples are keyed by source frame');
assert.equal(outcome.track.version, 1);
assert.equal(outcome.track.analysisFps, FACE_ANALYSIS_FPS);
assert.equal(outcome.track.sourceFps, 30);
assert.equal(outcome.track.sourceFrames, 390);
assert.equal(outcome.elapsedMs, 0);

// The no-face samples keep a degenerate-but-valid box, so the parser accepts the
// track and the shader's region weight is zero there.
const noFace = outcome.track.samples[1]!;
assert.equal(noFace.c, 0);
assert.ok(noFace.box.w > 0 && noFace.box.h > 0, 'a no-face sample still has a parseable box');
assert.ok(noFace.box.w < 0.001, 'the no-face box is a point, not a face');

// ── the atlas ──────────────────────────────────────────────────────────────
const grid = faceAtlasGrid(65);
assert.equal(outcome.atlasWidth, grid.width);
assert.equal(outcome.atlasHeight, grid.height);
const firstCell = unpackFaceAtlasCell(outcome.atlas, outcome.atlasWidth, grid, 0);
assert.ok(firstCell.some((value) => value > 0), 'a face sample has skin in its cell');
const emptyCell = unpackFaceAtlasCell(outcome.atlas, outcome.atlasWidth, grid, 1);
assert.equal(emptyCell.reduce((sum, value) => sum + value, 0), 0, 'a no-face sample has an empty cell');

// ── progress and abort ─────────────────────────────────────────────────────
assert.equal(progress.length, 66, 'one progress update per sample, plus the encode step');
for (let index = 1; index < progress.length; index += 1) {
  assert.ok(progress[index]! >= progress[index - 1]!, 'progress never goes backwards');
}
assert.equal(progress[progress.length - 1], 1);

const controller = new AbortController();
let seeks = 0;
await assert.rejects(
  analyzeFaceFrames({
    sourceFps: 30,
    sourceFrames: 390,
    runtime,
    signal: controller.signal,
    seek: async () => {
      seeks += 1;
      if (seeks === 3) controller.abort();
      return {} as HTMLCanvasElement;
    },
  }),
  (error: unknown) => (error as Error).name === 'AbortError',
  'an aborted pass rejects instead of finishing',
);
assert.equal(seeks, 3, 'the abort stops the seek loop at the frame it was raised on');

// A seek that cannot decode a frame is a "no face" sample, not a hang.
const undecodable = await analyzeFaceFrames({
  sourceFps: 30,
  sourceFrames: 30,
  runtime,
  seek: async () => null,
});
assert.equal(undecodable.facesFound, 0);
assert.equal(undecodable.track.samples.length, 5);
assert.ok(undecodable.track.samples.every((sample) => sample.c === 0));

console.log(`analyzeFace.verify: ${outcome.sampleCount} source-keyed samples, ${outcome.facesFound} faces, atlas ${outcome.atlasWidth}x${outcome.atlasHeight}; abort and undecodable frames behave`);
