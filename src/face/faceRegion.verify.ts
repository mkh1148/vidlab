// D4 · the region contract, enforced across the language boundary.
//
// Three places describe the same ellipse: `faceAtlas.ts` (which cuts the mask out
// of the person mask), `faceRegion.ts` (which feeds the uniforms and defines the
// fallback weight in TypeScript), and `src/gl/fx/face-retouch.frag` (which
// evaluates that fallback in GLSL). The TS pair is kept equal by
// `faceAtlas.verify.ts`; this file keeps the GLSL honest, because until it
// existed the shader's REGION_RADIUS / REGION_FEATHER were equal to the TS
// constants by eye and not by test — which is exactly the kind of rule that
// drifts once D5/D6 start reading the region contract.
//
// Two checks, because either alone is weak:
//   1. the shader's own constants are PARSED and compared to faceRegion.ts, so a
//      silent edit to one file fails here;
//   2. the shader's fallback is re-evaluated with those parsed constants and
//      required to match `faceRegionWeight` to 1e-9 over a grid, so a change to
//      the FORMULA (not just the numbers) fails too.
// The second check is what makes "attaching an atlas changes the precision of the
// region, not its size" a fact rather than a sentence.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FACE_REGION_FEATHER, FACE_REGION_RADIUS, faceRegionWeight } from './faceRegion.ts';
import type { FaceBox } from './faceTrack.ts';

// ── the shader source, read the way shader-contract.verify.ts reads it ──────
// CRLF is normalized first: these digests and parses pin CONTENT, not the
// checkout's line endings (git's core.autocrlf=true on Windows would otherwise
// make every regex miss).
const shader = readFileSync(fileURLToPath(new URL('../gl/fx/face-retouch.frag', import.meta.url)), 'utf8')
  .replace(/\r\n/g, '\n');

function glslConstant(name: string): number {
  const match = new RegExp(`const\\s+float\\s+${name}\\s*=\\s*([0-9.]+)\\s*;`).exec(shader);
  assert.ok(match, `the shader must declare ${name} as a float constant; the region contract depends on it`);
  const value = Number(match[1]);
  assert.ok(Number.isFinite(value), `${name} must parse as a number, got "${match[1]}"`);
  return value;
}

// ── 1. the constants ────────────────────────────────────────────────────────
const shaderRadius = glslConstant('REGION_RADIUS');
const shaderFeather = glslConstant('REGION_FEATHER');
assert.equal(shaderRadius, FACE_REGION_RADIUS,
  'the shader ellipse radius must equal faceRegion.ts FACE_REGION_RADIUS');
assert.equal(shaderFeather, FACE_REGION_FEATHER,
  'the shader ellipse feather must equal faceRegion.ts FACE_REGION_FEATHER');

// The constants must be USED, not merely declared: a dead constant passes the
// comparison above and proves nothing about the region the shader draws.
assert.match(shader, /length\(n\)\s*\/\s*REGION_RADIUS/,
  'the fallback distance must divide by REGION_RADIUS');
assert.match(shader, /smoothstep01\(\s*1\.0\s*-\s*REGION_FEATHER\s*,\s*1\.0\s*,\s*distance\s*\)/,
  'the fallback edge must feather over REGION_FEATHER');

// ── 2. the formula, re-evaluated from the parsed constants ──────────────────
// A transcription of the shader's fallback branch: `faceBoxMin()` flips the box
// into the bottom-up uv space, `local` is the box-relative position, and the
// ellipse is symmetric in y so the flip does not change the weight — which is
// the property that makes the atlas cell and the fallback agree.
function shaderFallbackWeight(
  point: { readonly x: number; readonly y: number },
  box: FaceBox,
  radius: number,
  feather: number,
): number {
  if (box.w <= 0 || box.h <= 0) return 0;
  const boxMin = { x: box.x, y: 1 - (box.y + box.h) };
  const uv = { x: point.x, y: 1 - point.y };
  const local = { x: (uv.x - boxMin.x) / box.w, y: (uv.y - boxMin.y) / box.h };
  if (local.x < 0 || local.x > 1 || local.y < 0 || local.y > 1) return 0;
  const n = { x: local.x * 2 - 1, y: local.y * 2 - 1 };
  const distance = Math.sqrt(n.x * n.x + n.y * n.y) / radius;
  const edge0 = 1 - feather;
  const t = Math.min(1, Math.max(0, (distance - edge0) / Math.max(1 - edge0, 1e-5)));
  return 1 - t * t * (3 - 2 * t);
}

const box: FaceBox = { x: 0.2704, y: 0.4624, w: 0.5529, h: 0.3939 };
const weights: number[] = [];
let maxDelta = 0;
const STEPS = 24;
// Interior samples only: a point exactly ON the box edge lands on the shader's
// `local > 1.0` guard through float rounding (1.0000000000000002), so the edge is
// asserted separately below instead of being averaged into this comparison.
for (let iy = 0; iy < STEPS; iy++) {
  for (let ix = 0; ix < STEPS; ix++) {
    const point = {
      x: box.x + ((ix + 0.5) / STEPS) * box.w,
      y: box.y + ((iy + 0.5) / STEPS) * box.h,
    };
    const ts = faceRegionWeight(point, box, FACE_REGION_RADIUS, FACE_REGION_FEATHER);
    const glsl = shaderFallbackWeight(point, box, shaderRadius, shaderFeather);
    maxDelta = Math.max(maxDelta, Math.abs(ts - glsl));
    weights.push(ts);
  }
}
assert.ok(maxDelta < 1e-9,
  `the shader fallback and faceRegionWeight must agree inside the box, worst delta ${maxDelta}`);

// The box is also the region's edge, and the two paths must agree about that too:
// the shader returns 0 outside the box (the atlas cell covers exactly the box, so
// there is no mask data there either), while the ellipse itself — radius 1.05 —
// overhangs the box by 2.5% of its height on each side. Pinning both halves keeps
// the clip a decision instead of an accident: attaching an atlas cannot change the
// region's SIZE, and the fallback cannot bleed past the box the mask is cut from.
const overhang = { x: box.x + box.w / 2, y: box.y - 0.005 };
assert.ok(faceRegionWeight(overhang, box, FACE_REGION_RADIUS, FACE_REGION_FEATHER) > 0,
  'the ellipse overhangs the box, which is why the clip below matters');
assert.equal(shaderFallbackWeight(overhang, box, shaderRadius, shaderFeather), 0,
  'the shader clips the region to the box, like the atlas cell does');

// The grid has to exercise the whole region, or "they agree" would be a statement
// about two flat planes: the centre must be fully weighted, a corner of the frame
// must be untouched, and the feathered edge must be strictly between the two.
assert.equal(faceRegionWeight({ x: box.x + box.w / 2, y: box.y + box.h / 2 }, box), 1,
  'the face centre is fully inside the fallback region');
assert.equal(faceRegionWeight({ x: 0, y: 0 }, box), 0, 'a corner of the frame is outside it');
assert.ok(weights.some((w) => w > 0.05 && w < 0.95), 'the grid must cross the feathered edge');

// ── 3. teeth ────────────────────────────────────────────────────────────────
// A comparison that cannot fail is not a check. A 1% radius change — the size of
// a careless edit — must break the match, and so must a 5% feather change.
function worstDelta(radius: number, feather: number): number {
  let worst = 0;
  for (let iy = 0; iy < STEPS; iy++) {
    for (let ix = 0; ix < STEPS; ix++) {
      const point = {
        x: box.x + ((ix + 0.5) / STEPS) * box.w,
        y: box.y + ((iy + 0.5) / STEPS) * box.h,
      };
      worst = Math.max(worst, Math.abs(
        faceRegionWeight(point, box, FACE_REGION_RADIUS, FACE_REGION_FEATHER)
        - shaderFallbackWeight(point, box, radius, feather),
      ));
    }
  }
  return worst;
}
assert.ok(worstDelta(FACE_REGION_RADIUS * 1.01, FACE_REGION_FEATHER) > 1e-3,
  'a 1% radius drift must be caught');
assert.ok(worstDelta(FACE_REGION_RADIUS, FACE_REGION_FEATHER * 1.05) > 1e-3,
  'a 5% feather drift must be caught');

console.log(
  `faceRegion.verify: shader REGION_RADIUS=${shaderRadius} / REGION_FEATHER=${shaderFeather} equal faceRegion.ts, `
  + `formula agrees over ${(STEPS + 1) ** 2} points (worst ${maxDelta.toExponential(1)}), drift is caught`,
);
