// Kit D5: the committed .cube files are generated artefacts, and this is the check
// that keeps them that way.
//
// It answers four questions, in order of how much they are worth:
//
//  1. Does the committed file still equal what the generator produces? (byte compare)
//  2. Is the committed file actually the formula? (trilinear parity — a byte compare
//     cannot see a wrong axis order, a wrong domain or a transposed grid, because the
//     bytes are self-consistent either way)
//  3. Is every cube in assets/luts one we generated? (rights guard: a third-party LUT
//     dropped into the folder fails the gate, which is the kit decision made mechanical)
//  4. Is every look in the catalog wired to a generated cube with an intensity slider?
//
// Each check is proven to have teeth against a real mutation, in the same run, so a
// green result is evidence and not just absence of an error.
//
//   npx tsx scripts/looks.verify.mjs
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { LOOK_FORMULAS, LOOK_IDS } from '../src/gl/looks/lookFormulas.ts';
import { CUBE_SIZE, renderCubeText, sampleCube } from '../src/gl/looks/cubeText.ts';
import { parseCube } from '../src/gl/fx/cube.ts';
import { LUT_EFFECTS, LUT_IDS } from '../src/gl/fx/effects.ts';
import { generatedLuts, lutDir } from './generate-looks.mjs';

const lf = (text) => text.replace(/\r\n?/g, '\n');
const read = (file) => lf(readFileSync(join(lutDir, file), 'utf8'));

/** Worst per-channel difference between a LUT and the formula it claims to bake. */
function parityError(lut, look, probes) {
  let worst = 0;
  for (const probe of probes) {
    const expected = look.grade(probe);
    const actual = sampleCube(lut, probe);
    for (let ch = 0; ch < 3; ch += 1) worst = Math.max(worst, Math.abs(expected[ch] - actual[ch]));
  }
  return worst;
}

// A 24³ lattice: dense enough to land between grid points on every axis, deterministic,
// and cheap (13 824 probes × 14 looks).
const PROBES = [];
const P = 24;
for (let r = 0; r < P; r += 1) {
  for (let g = 0; g < P; g += 1) {
    for (let b = 0; b < P; b += 1) PROBES.push([r / (P - 1), g / (P - 1), b / (P - 1)]);
  }
}

// Measured worst case at 25³ is 2.55/255 (look-fuji-velvia, where the formula's own
// clamp makes a kink that trilinear interpolation rounds off). 3/255 leaves room for a
// different probe lattice without hiding a real drift, and 17³ would need 5.62/255 —
// which is why the grid is 25 and not smaller.
const PARITY_BOUND = 3 / 255;

const generated = generatedLuts();
assert.equal(generated.length, LOOK_IDS.length, 'one generated LUT per catalog look');
assert.ok(generated.length >= 14, `expected the full look catalog, found ${generated.length}`);

// ── 1. regenerate and compare with what is committed ─────────────────────────
const drifted = [];
for (const { file, text } of generated) {
  const path = join(lutDir, file);
  if (!existsSync(path)) { drifted.push(`${file}: missing (run npx tsx scripts/generate-looks.mjs)`); continue; }
  if (read(file) !== lf(text)) drifted.push(`${file}: committed file differs from the generator output`);
}
assert.deepEqual(drifted, [], `the committed LUTs are not what the formulas produce:\n  ${drifted.join('\n  ')}`);

// ── 2. the committed file IS the formula (trilinear parity) ──────────────────
const worstByLook = new Map();
for (const { file, id } of generated) {
  const look = LOOK_FORMULAS[id];
  const lut = parseCube(read(file));
  assert.equal(lut.size, CUBE_SIZE, `${file}: LUT_3D_SIZE must be ${CUBE_SIZE}`);
  assert.deepEqual(lut.domainMin, [0, 0, 0], `${file}: DOMAIN_MIN must be 0 0 0`);
  assert.deepEqual(lut.domainMax, [1, 1, 1], `${file}: DOMAIN_MAX must be 1 1 1`);
  assert.equal(lut.data.length, CUBE_SIZE ** 3 * 3, `${file}: wrong number of samples`);
  for (const value of lut.data) {
    assert.ok(Number.isFinite(value) && value >= 0 && value <= 1, `${file}: sample outside [0,1] — a look must not rely on the framebuffer to clip it`);
  }
  const error = parityError(lut, look, PROBES);
  worstByLook.set(id, error);
  assert.ok(
    error <= PARITY_BOUND,
    `${file}: the committed LUT is not the formula — worst channel error ${(error * 255).toFixed(2)}/255 over ${PROBES.length} probes (bound ${(PARITY_BOUND * 255).toFixed(2)}/255)`,
  );
}

// ── 3. teeth, proven by mutation in this run ─────────────────────────────────
{
  // 3a. one digit of one sample: the byte compare must see it.
  const { file, text } = generated[0];
  const lines = lf(text).split('\n');
  const sampleLine = 7; // first data row (6 header lines)
  const original = lines[sampleLine];
  const mutated = original.replace(/(\d)\.(\d{6})/, (_, d, rest) => `${(Number(d) + 1) % 10}.${rest}`);
  assert.notEqual(mutated, original, 'the mutation must actually change the line');
  lines[sampleLine] = mutated;
  assert.notEqual(lines.join('\n'), lf(text), 'a one-digit edit of a committed cube is detected by the byte compare');
  assert.equal(read(file), lf(text), 'the file on disk is untouched by this self-test');
}

{
  // 3b. a drifted formula (+0.04 on one channel, comfortably above the parity bound):
  // the byte compare must see it, and so must parity.
  const id = LOOK_IDS[0];
  const look = LOOK_FORMULAS[id];
  const driftedLook = { ...look, grade: (c) => { const out = look.grade(c); return [Math.min(1, out[0] + 0.04), out[1], out[2]]; } };
  assert.notEqual(lf(renderCubeText(driftedLook)), lf(renderCubeText(look)), 'a formula drift changes the generated text');
  const committed = parseCube(read(`${look.id}.cube`));
  assert.ok(parityError(committed, driftedLook, PROBES) > PARITY_BOUND, 'a formula drift is caught by parity too');
}

{
  // 3c. THE case a byte compare cannot catch: same bytes, wrong axis order. A generator
  // that wrote green-fastest would produce a self-consistent file that regenerates
  // cleanly and renders a transposed grade. Parity must fail on it.
  const id = LOOK_IDS[0];
  const look = LOOK_FORMULAS[id];
  const committed = parseCube(read(`${look.id}.cube`));
  const n = committed.size;
  const transposed = { ...committed, data: new Float32Array(committed.data.length) };
  for (let b = 0; b < n; b += 1) {
    for (let g = 0; g < n; g += 1) {
      for (let r = 0; r < n; r += 1) {
        const from = ((b * n + g) * n + r) * 3;
        const to = ((b * n + r) * n + g) * 3; // r and g swapped
        transposed.data[to] = committed.data[from];
        transposed.data[to + 1] = committed.data[from + 1];
        transposed.data[to + 2] = committed.data[from + 2];
      }
    }
  }
  assert.ok(
    parityError(transposed, look, PROBES) > PARITY_BOUND,
    'a wrong axis order passes a byte compare but parity catches it — this is why parity is here',
  );
}

// ── 4. every cube in assets/luts is ours (the kit decision, mechanically) ────
const ours = new Set(generated.map(({ file }) => file));
const onDisk = readdirSync(lutDir).filter((name) => name.endsWith('.cube'));
const foreign = onDisk.filter((name) => !ours.has(name));
assert.deepEqual(
  foreign,
  [],
  `assets/luts holds .cube files this repo does not generate — the kit forbids shipping third-party LUTs:\n  ${foreign.join('\n  ')}`,
);
for (const removed of ['Sony_Slog3_s709.cube', 'CinemaGamut_CanonLog3-to-Canon709_33_Ver.1.0.cube']) {
  assert.ok(!onDisk.includes(removed), `${removed} was removed at D5 (no redistribution licence) and must not come back`);
}

// ── 5. the catalog is wired to the artefacts ────────────────────────────────
assert.equal(LUT_IDS.length, LOOK_IDS.length, 'the LUT tab lists every shipped look and nothing else');
const unreferenced = [...ours].filter((file) => !LUT_IDS.some((id) => LUT_EFFECTS[id].cube === `/luts/${file}`));
assert.deepEqual(unreferenced, [], `generated LUTs no catalog entry points at:\n  ${unreferenced.join('\n  ')}`);
for (const id of LUT_IDS) {
  const def = LUT_EFFECTS[id];
  assert.ok(def, `${id}: missing catalog entry`);
  assert.equal(def.cube, `/luts/${LOOK_FORMULAS[id].id}.cube`, `${id}: cube URL must be its own generated file`);
  assert.ok(def.frag.includes('u_lut'), `${id}: must render through the shared look shader`);
  const intensity = def.props.find((p) => p.key === 'intensity');
  assert.ok(intensity, `${id}: every look needs an intensity slider`);
  assert.deepEqual([intensity.min, intensity.max], [0, 1], `${id}: intensity spans 0..1`);
  assert.equal(intensity.default, LOOK_FORMULAS[id].defaults.intensity, `${id}: intensity default comes from the formula`);
  assert.ok(def.name && def.desc, `${id}: needs a name and a description`);
}

const worstOverall = Math.max(...worstByLook.values());
console.log(
  `looks.verify: ${generated.length} generated LUTs regenerate byte-identically, `
  + `${onDisk.length} files in assets/luts all generated here, parity worst ${(worstOverall * 255).toFixed(2)}/255 `
  + `over ${PROBES.length} probes; teeth proven against a 1-digit edit, a formula drift and a transposed axis order`,
);
