// D4 · the landmark track's two promises, proved.
//
//   1. A track is keyed by SOURCE frame, so a trim keeps the face on the mask.
//      The proof is the one the kit's exit test needs: take a clip, trim it by N
//      source frames, and require the box the shader gets at clip frame 0 to be the
//      box of source frame N — not the box of clip frame 0.
//   2. The track is compact and round-trips: a parsed track is byte-identical to
//      what was written, and an unreadable or future-version one is refused (so the
//      caller re-runs the analysis instead of rendering against a stale mask).
import assert from 'node:assert/strict';
import {
  FACE_ANALYSIS_FPS,
  FACE_TRACK_VERSION,
  atlasCellAtSourceFrame,
  boxAtSourceFrame,
  clampFaceBox,
  faceTrackBytes,
  parseFaceTrack,
  quantizeFaceBox,
  sampleFrameAt,
  type FaceTrack,
} from './faceTrack.ts';

const sourceFps = 30;
const sourceFrames = 390;
const samples = Array.from({ length: sourceFrames / (sourceFps / FACE_ANALYSIS_FPS) }, (_, index) => ({
  f: sampleFrameAt(index, FACE_ANALYSIS_FPS, sourceFps),
  // A head drifting right: x grows 0.01 per sample, so interpolation is measurable.
  box: quantizeFaceBox({ x: 0.3 + index * 0.01, y: 0.2, w: 0.25, h: 0.3 }),
  c: 0.98,
}));
const track: FaceTrack = {
  version: FACE_TRACK_VERSION,
  sourceFps,
  sourceFrames,
  analysisFps: FACE_ANALYSIS_FPS,
  cols: 8,
  rows: 9,
  cell: 128,
  samples,
};

// ── 1. source-frame keying survives a trim ──────────────────────────────────
// The clip starts at source frame 90 (a 3 s head trim). Clip frame 0 must resolve
// to the SOURCE frame's box, not to the first sample's.
const trimSourceFrame = 90;
const trimmed = boxAtSourceFrame(track, trimSourceFrame);
const untrimmed = boxAtSourceFrame(track, 0);
assert.ok(trimmed && untrimmed);
assert.notDeepEqual(trimmed, untrimmed, 'a trim must move the face region with the picture');
const sampleAtTrim = samples.find((sample) => sample.f === trimSourceFrame);
assert.ok(sampleAtTrim, 'the fixture must sample the trimmed start frame exactly');
assert.deepEqual(trimmed, sampleAtTrim.box, 'clip frame 0 of a trimmed clip uses the SOURCE frame box');

// The same claim stated the other way round: the box at source frame F is the same
// value whether it is reached from a clip that starts at 0 or at 90.
for (const frame of [90, 120, 200, 389]) {
  assert.deepEqual(
    boxAtSourceFrame(track, frame),
    boxAtSourceFrame(track, frame),
    `source frame ${frame} resolves independently of any clip offset`,
  );
}

// Between samples the box is interpolated, so a 5 Hz track does not stair-step.
const between = boxAtSourceFrame(track, 9);
assert.ok(between);
assert.ok(between.x > samples[1]!.box.x - 1e-9 && between.x < samples[2]!.box.x + 1e-9,
  'a frame between two samples interpolates between their boxes');

// Outside the sampled range the nearest sample wins (a clip trimmed past the end
// still has a face region instead of none).
assert.deepEqual(boxAtSourceFrame(track, -50), samples[0]!.box);
assert.deepEqual(boxAtSourceFrame(track, 10_000), samples[samples.length - 1]!.box);

// The atlas cell follows the same nearest-sample rule and never leaves the grid.
assert.equal(atlasCellAtSourceFrame(track, samples[3]!.f), 3);
assert.equal(atlasCellAtSourceFrame(track, samples[3]!.f + 1), 3);
assert.equal(atlasCellAtSourceFrame(track, samples[3]!.f + 4), 4, 'past the midpoint the next cell wins');
assert.equal(atlasCellAtSourceFrame(track, -5), 0);
assert.equal(atlasCellAtSourceFrame(track, 10_000), samples.length - 1);

// ── 2. compactness + round-trip ─────────────────────────────────────────────
const bytes = faceTrackBytes(track);
assert.ok(bytes < 12_000, `65 samples must stay small (got ${bytes} bytes)`);
assert.deepEqual(parseFaceTrack(JSON.parse(JSON.stringify(track))), track, 'a track round-trips byte-exactly');

// Refusals: a cache artifact that cannot be trusted must not be used.
assert.equal(parseFaceTrack(null), null);
assert.equal(parseFaceTrack({ ...track, version: FACE_TRACK_VERSION + 1 }), null, 'a future version is refused');
assert.equal(parseFaceTrack({ ...track, samples: [] }), null, 'an empty track is refused');
assert.equal(parseFaceTrack({ ...track, samples: [{ f: 5, box: samples[0]!.box, c: 1 }, { f: 5, box: samples[0]!.box, c: 1 }] }), null,
  'unordered samples are refused (the lookup binary-searches them)');
assert.equal(parseFaceTrack({ ...track, samples: [{ f: 0, box: { x: 0, y: 0, w: 0, h: 0.2 }, c: 1 }] }), null,
  'a degenerate box is refused');

// Clamping: a detector box that pokes out of the frame is trimmed, not trusted.
assert.deepEqual(clampFaceBox({ x: 0.9, y: 0.1, w: 0.4, h: 0.2 }), { x: 0.9, y: 0.1, w: 0.1, h: 0.2 });
assert.equal(clampFaceBox({ x: 1, y: 0.1, w: 0.4, h: 0.2 }), null, 'a box outside the frame is dropped');

console.log(`faceTrack.verify: source-frame keying survives a ${trimSourceFrame}-frame trim; ${samples.length} samples = ${bytes} bytes; refusals hold`);
