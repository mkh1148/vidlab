// D4 · the atlas: grid math, packing round-trip, and the skin mask the shader reads.
//
// The pack/unpack round-trip is the point: the shader samples a cell out of one
// texture, and the only way to know the cell it samples is the cell the analyzer
// wrote is to read it back through the same grid arithmetic.
import assert from 'node:assert/strict';
import {
  FACE_ATLAS_CELL,
  faceAtlasCellOrigin,
  faceAtlasGrid,
  packFaceAtlas,
  skinMaskCell,
  unpackFaceAtlasCell,
} from './faceAtlas.ts';
import { FACE_REGION_FEATHER, FACE_REGION_RADIUS, faceRegionWeight } from './faceRegion.ts';

// ── grid ────────────────────────────────────────────────────────────────────
const grid = faceAtlasGrid(65);
assert.equal(grid.cell, FACE_ATLAS_CELL);
assert.equal(grid.cols, 9);
assert.equal(grid.rows, 8);
assert.equal(grid.width, 9 * FACE_ATLAS_CELL);
assert.equal(grid.height, 8 * FACE_ATLAS_CELL);
assert.ok(grid.cols * grid.rows >= 65, 'the grid holds every sample');
assert.deepEqual(faceAtlasGrid(1), { cols: 1, rows: 1, cell: FACE_ATLAS_CELL, width: 128, height: 128 });
assert.deepEqual(faceAtlasGrid(0).cols, 1, 'a zero-sample atlas still has one cell');
assert.deepEqual(faceAtlasGrid(10_000).cols * faceAtlasGrid(10_000).rows <= 4096, true,
  'a pathological sample count is capped instead of allocating a gigapixel image');

// ── pack / unpack round-trip ────────────────────────────────────────────────
const cells = Array.from({ length: 65 }, (_, index) => {
  const cell = new Uint8Array(FACE_ATLAS_CELL * FACE_ATLAS_CELL);
  // Each cell carries its own index in every pixel, so a misplaced cell is visible.
  cell.fill(index % 251);
  return cell;
});
const packed = packFaceAtlas(cells, grid);
assert.equal(packed.length, grid.width * grid.height * 4);
for (const index of [0, 1, 8, 9, 64]) {
  assert.deepEqual(unpackFaceAtlasCell(packed, grid.width, grid, index), cells[index],
    `cell ${index} reads back where it was written`);
}
// A cell past the sample count stays empty (the atlas is opaque, value 0).
assert.deepEqual(unpackFaceAtlasCell(packed, grid.width, grid, 65), new Uint8Array(FACE_ATLAS_CELL * FACE_ATLAS_CELL));
assert.deepEqual(faceAtlasCellOrigin(0, grid), { x: 0, y: 0 });
assert.deepEqual(faceAtlasCellOrigin(9, grid), { x: 0, y: 128 }, 'cell 9 wraps to the second row');
assert.deepEqual(faceAtlasCellOrigin(10, grid), { x: 128, y: 128 });

// ── the skin mask ───────────────────────────────────────────────────────────
// A person mask that is 255 everywhere: the cell must be the ellipse, not a flat
// white square, or the shader would smooth the whole frame.
const personWidth = 64;
const personHeight = 64;
const person = new Uint8Array(personWidth * personHeight).fill(255);
const box = { x: 0.3, y: 0.2, w: 0.3, h: 0.4 };
const cell = skinMaskCell({ person, personWidth, personHeight, box, cell: 64 });
const at = (x: number, y: number) => cell[y * 64 + x]!;
assert.equal(at(32, 32), 255, 'the centre of the face is fully masked');
assert.equal(at(0, 0), 0, 'the corner of the cell is outside the ellipse');
assert.equal(at(63, 63), 0, 'the opposite corner too');
assert.ok(at(32, 2) < 255 && at(32, 2) > 0, 'the ellipse edge is feathered, not a hard step');

// A person mask that is empty: no skin anywhere, whatever the geometry says.
const empty = skinMaskCell({ person: new Uint8Array(personWidth * personHeight), personWidth, personHeight, box, cell: 64 });
assert.equal(empty.reduce((sum, value) => sum + value, 0), 0, 'no person -> no skin mask');

// ── the fallback region is the SAME ellipse ─────────────────────────────────
// The shader's fallback (no atlas) and the analyzer's mask cut must agree, or a
// clip would change its region the moment analysis completes.
const centre = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
assert.equal(faceRegionWeight(centre, box), 1, 'the face centre is fully inside the fallback region');
assert.equal(faceRegionWeight({ x: 0, y: 0 }, box), 0, 'a corner of the frame is outside it');
const edge = faceRegionWeight({ x: box.x + box.w / 2, y: box.y }, box);
assert.ok(edge > 0 && edge < 1, 'the top edge of the box is inside the feather, not a step');
// The cell's own weight at the same normalized point matches the region function.
const cellWeightAt = (nx: number, ny: number) => {
  const x = Math.min(63, Math.max(0, Math.round(((nx + 1) / 2) * 64)));
  const y = Math.min(63, Math.max(0, Math.round(((ny + 1) / 2) * 64)));
  return cell[y * 64 + x]! / 255;
};
assert.equal(cellWeightAt(0, 0), 1, 'the cell centre is fully masked');
assert.ok(Math.abs(cellWeightAt(0, -1) - faceRegionWeight({ x: box.x + box.w / 2, y: box.y }, box, FACE_REGION_RADIUS, FACE_REGION_FEATHER)) < 0.12,
  'the cell edge weight matches the shader fallback weight at the same point');

console.log(`faceAtlas.verify: ${grid.cols}x${grid.rows} grid of ${grid.cell}px cells packs and reads back; skin mask is the ellipse, not the frame; fallback region agrees`);
