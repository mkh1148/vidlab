// D4 · the face region is read at DRAW time, not memoized on the URLs.
//
// The defect this pins: `faceRegion` used to be a `useMemo` keyed on
// `[faceTrackUrl, faceAtlasUrl, sourceFrame]`, while `faceTrackFor()` is a
// synchronous cache read that answers null until the fetch resolves. On a cold
// load the memo therefore froze the boxless region from the first render, tick()
// waited for the track to settle and then drew with that stale region — so the
// first frame after a reload showed the clip UNRETOUCHED, and moving a slider
// redrew the same passthrough until the playhead moved (a seek recomputes the
// memo). The reviewer saw exactly that: no visible re-render on a freshly loaded
// editor at frame 0, working after a seek.
//
// Two halves, because either one alone would let the defect back in:
//   1. the SOURCE must read the region inside the draw path, after both inputs
//      have settled, and feed it to the same draw;
//   2. the CACHE must flip from "no face" to "face" when the load settles, which
//      is what makes the ordering in (1) sufficient.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { faceFrameRegion } from '../face/faceRegion.ts';
import { atlasCellAtSourceFrame, FACE_TRACK_VERSION, parseFaceTrack } from '../face/faceTrack.ts';
import { __resetFaceTracks, ensureFaceTrack, faceTrackFor, faceTrackSettled } from '../face/faceTrackCache.ts';

// ── 1. the draw path reads the region after the settle gates ────────────────
const source = await readFile(new URL('./ClipFx.tsx', import.meta.url), 'utf8');

assert.doesNotMatch(source, /const faceRegion = useMemo\(/,
  'the face region must not be memoized: faceTrackFor is a cache read that is null until the fetch resolves');
assert.doesNotMatch(source, /\[faceTrackUrl, faceAtlasUrl, sourceFrame\]/,
  'no memo may be keyed on the track/atlas URLs — that is the stale-region shape this verify exists for');
assert.match(source, /if \(faceTrackUrl && !faceTrackSettled\(faceTrackUrl\)\)[\s\S]{0,600}?faceFrameRegion\(/,
  'the region must be read AFTER the track has settled');
assert.match(source, /if \(faceAtlasUrl && !fxImageSettled\(faceAtlasUrl\)\)[\s\S]{0,600}?faceFrameRegion\(/,
  'the region must be read AFTER the atlas image has settled');
assert.match(source, /faceFrameRegion\([\s\S]{0,600}?buildEffectShaderFrame\(/,
  'the region computed at draw time must be the one the draw uses');
assert.equal((source.match(/faceFrameRegion\(/g) ?? []).length, 1,
  'exactly one call site, so a second (stale) one cannot linger');

// ── 2. the cache flips on settle, which is what makes that ordering work ────
const trackUrl = 'https://face.test/track.json';
const atlasUrl = 'https://face.test/atlas.png';
const trackJson = {
  version: FACE_TRACK_VERSION,
  sourceFps: 30,
  sourceFrames: 391,
  analysisFps: 5,
  cols: 3,
  rows: 1,
  cell: 128,
  samples: [
    { f: 0, box: { x: 0.3, y: 0.2, w: 0.3, h: 0.4 }, c: 1 },
    { f: 6, box: { x: 0.32, y: 0.2, w: 0.3, h: 0.4 }, c: 1 },
    { f: 12, box: { x: 0.34, y: 0.2, w: 0.3, h: 0.4 }, c: 1 },
  ],
};
assert.ok(parseFaceTrack(trackJson), 'the fixture track must be valid, or this verify proves nothing');

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request) => {
  if (String(url) === trackUrl) {
    return { ok: true, status: 200, json: async () => trackJson } as unknown as Response;
  }
  return { ok: false, status: 404, json: async () => null } as unknown as Response;
}) as typeof fetch;

try {
  __resetFaceTracks();
  const sourceFrame = 4;

  // What the old code drew on a cold load: the track is not parsed yet, so the
  // region carries no box and the shader returns the source untouched.
  const beforeLoad = faceFrameRegion({ track: faceTrackFor(trackUrl), atlasUrl, sourceFrame });
  assert.equal(beforeLoad.hasFace, false, 'an unloaded track has no face region');
  assert.equal(beforeLoad.uniforms.u_face_mask, 0, 'and the shader is told there is no mask');
  assert.deepEqual(beforeLoad.images, {}, 'no atlas texture without a region');
  assert.equal(faceTrackSettled(trackUrl), false, 'not settled before the load starts');

  const pending = ensureFaceTrack(trackUrl);
  assert.equal(faceTrackSettled(trackUrl), false, 'still not settled while the fetch is in flight');
  await pending;
  assert.equal(faceTrackSettled(trackUrl), true, 'settled once the fetch resolves');

  const afterLoad = faceFrameRegion({ track: faceTrackFor(trackUrl), atlasUrl, sourceFrame });
  assert.equal(afterLoad.hasFace, true, 'the same call now carries the face');
  assert.equal(afterLoad.hasMask, true, 'and the atlas is attached');
  assert.equal(afterLoad.uniforms.u_face_mask, 1);
  assert.deepEqual(afterLoad.images, { u_face_atlas: atlasUrl }, 'the atlas travels as the texture uniform');
  assert.deepEqual(afterLoad.uniforms.u_face_grid, [3, 1]);
  assert.equal(afterLoad.uniforms.u_face_cell_px, 128);
  const box = afterLoad.uniforms.u_face_box as number[];
  assert.ok(box[0]! > 0.3 && box[0]! < 0.32,
    `source frame ${sourceFrame} interpolates between the samples around it, got x ${box[0]}`);
  assert.equal(box[1], 0.2);
  assert.equal(box[2], 0.3);
  assert.equal(box[3], 0.4);
  const expectedCell = atlasCellAtSourceFrame(parseFaceTrack(trackJson)!, sourceFrame);
  assert.deepEqual(afterLoad.uniforms.u_face_cell, [expectedCell % 3, Math.floor(expectedCell / 3)],
    'the cell the shader samples is the cell the track assigns to this source frame');

  // A track that cannot be read settles as null: the region stays the landmark
  // fallback instead of blocking the render forever.
  const missing = 'https://face.test/missing.json';
  await ensureFaceTrack(missing);
  assert.equal(faceTrackSettled(missing), true, 'a failed load still settles');
  const failed = faceFrameRegion({ track: faceTrackFor(missing), atlasUrl, sourceFrame });
  assert.equal(failed.hasFace, false, 'a failed track falls back to no region, honestly');
} finally {
  globalThis.fetch = realFetch;
  __resetFaceTracks();
}

console.log('clipFxFaceRegion.verify: the region is read at draw time after both inputs settle '
  + '(the cold-load passthrough cannot come back)');
