// P7 regression: the shared derived-artifact namer.
//
// The two properties that matter are in tension, so both are asserted here:
// a name under the cap must be byte-identical run after run (an existing cache
// keyed by name keeps hitting), and a name over the cap must collapse to a
// deterministic prefix+hash that still distinguishes revision, engine and
// options. The cap is counted in BYTES, which is the whole point: the names
// that break are multi-byte before they are long.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DERIVED_ARTIFACT_COLLAPSED_EXTENSION_BYTES,
  DERIVED_ARTIFACT_HASH_HEX,
  DERIVED_ARTIFACT_MAX_BYTES,
  deriveArtifactName,
} from './derived-artifact-name.ts';
import { sanitizeFileName } from './file-name.ts';

const bytes = (value: string) => new TextEncoder().encode(value).length;
const COLLAPSED = new RegExp(`~[0-9a-f]{${DERIVED_ARTIFACT_HASH_HEX}}\\.[a-z0-9]+$`);

// ── 1. deterministic, and short names are unchanged by construction ─────────
const short = {
  sourceName: 'clip.mov',
  segments: ['voice', 's90'],
  revision: 'r7',
  engineVersion: 'voice-v2',
} as const;
assert.equal(deriveArtifactName(short), 'clip.voice.s90.r7.voice-v2.mov');
assert.equal(
  deriveArtifactName({ ...short, options: { strength: 90, model: 'rnn' } }),
  'clip.voice.s90.r7.voice-v2.model-rnn_strength-90.mov',
  'options are canonicalised by sorted key, so their order cannot change the name',
);
for (let run = 0; run < 5; run += 1) {
  assert.equal(deriveArtifactName(short), 'clip.voice.s90.r7.voice-v2.mov', `run ${run} must be byte-identical`);
}
assert.ok(!deriveArtifactName(short).includes('~'), 'a short name carries no hash');

// Option order is not part of the identity.
assert.equal(
  deriveArtifactName({ ...short, options: { model: 'rnn', strength: 90 } }),
  deriveArtifactName({ ...short, options: { strength: 90, model: 'rnn' } }),
);

// The extension is inherited from the source unless the artifact changes kind.
assert.equal(deriveArtifactName({ sourceName: 'a.mp4', segments: ['matte'], extension: 'webm' }), 'a.matte.webm');
assert.equal(deriveArtifactName({ sourceName: 'no-extension', segments: ['voice'] }), 'no-extension.voice');

// ── 2. the cap is counted in bytes, not characters ──────────────────────────
// 70 CJK characters are 210 bytes: under the cap, and returned untouched.
const cjkShort = `${'导'.repeat(70)}.mov`;
assert.equal(bytes(cjkShort), 214, 'a 74-character name is 214 bytes');
assert.equal(deriveArtifactName({ sourceName: cjkShort }), cjkShort, 'a multi-byte name under the cap is unchanged');

// 100 CJK characters are 300 bytes but only 104 characters: a character-counted
// cap would keep this name and the write would fail with ENAMETOOLONG.
const cjkLong = `${'导'.repeat(100)}.mov`;
const cjkCollapsed = deriveArtifactName({ sourceName: cjkLong });
assert.equal([...cjkLong].length, 104, 'the character count stays under the cap');
assert.equal(bytes(cjkLong), 304, 'the byte count exceeds it');
assert.ok(bytes(cjkCollapsed) <= DERIVED_ARTIFACT_MAX_BYTES, `${bytes(cjkCollapsed)} bytes must fit the cap`);
assert.match(cjkCollapsed, COLLAPSED);
assert.ok(cjkCollapsed.endsWith('.mov'), 'the extension survives the collapse');
assert.ok(cjkCollapsed.startsWith('导'), 'the readable prefix survives the collapse');

// ── 3. a travel-vlog identity collapses, and the hash tracks the identity ───
const vlog = {
  sourceName: 'Iceland_Drone_flight_day3_final_cut_with_color_grade_and_music_bed_2026-11-19_v2.mov',
  segments: ['matte', 'rvm', 'temporal-smoothing'],
  revision: '9f2c1d4e5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d',
  engineVersion: 'rvm-mobilenetv3-fp32-onnxruntime-1.22.0-cuda12',
  options: { model: 'rvm_mobilenetv3', alpha: 'webm-vp9', device: 'cpu' },
} as const;
const vlogName = deriveArtifactName(vlog);
assert.match(vlogName, COLLAPSED, 'the vlog identity must collapse to prefix+hash');
assert.ok(bytes(vlogName) <= DERIVED_ARTIFACT_MAX_BYTES, `${bytes(vlogName)} bytes must fit the cap`);
assert.equal(deriveArtifactName(vlog), vlogName, 'the collapsed name is deterministic');

// Control: the same identity fields with a short source stay readable, so the
// collapse is caused by length and not by the presence of options.
const shortControl = deriveArtifactName({ ...vlog, sourceName: 'clip.mov' });
assert.ok(!shortControl.includes('~'), 'a short source with the same options stays readable');

const prefixOf = (name: string) => name.slice(0, name.indexOf('~'));
const hashOf = (name: string) => name.slice(name.indexOf('~'), name.lastIndexOf('.'));
const otherRevision = deriveArtifactName({ ...vlog, revision: '0'.repeat(40) });
const otherOptions = deriveArtifactName({ ...vlog, options: { ...vlog.options, device: 'cuda' } });
assert.notEqual(otherRevision, vlogName, 'a different revision must produce a different name');
assert.notEqual(otherOptions, vlogName, 'a different option set must produce a different name');
assert.notEqual(otherRevision, otherOptions);
assert.notEqual(hashOf(otherRevision), hashOf(vlogName), 'the revision is part of the hashed identity');
// Options are the last identity field, so they fall outside the readable prefix:
// the hash alone has to carry the distinction.
assert.equal(prefixOf(otherOptions), prefixOf(vlogName), 'the readable prefix is unchanged by options');
assert.notEqual(hashOf(otherOptions), hashOf(vlogName), 'the options are part of the hashed identity');

// ── 4. a pathological extension cannot break the cap ────────────────────────
// The extension is the one identity field that is not length-checked upstream:
// sanitizeFileName only replaces forbidden characters, so 250 characters of
// `e` survive it. A collapsed name that carried that extension verbatim reached
// 268 bytes — past the cap and past the 255-byte NTFS limit. The guarantee is
// this module's, not sanitizeFileName's, so it is asserted directly here.
const longExtension = 'e'.repeat(250);
assert.equal(
  sanitizeFileName(longExtension, 'x').length,
  250,
  'sanitizeFileName does not shorten a long extension, so the namer must',
);
const pathological = deriveArtifactName({ sourceName: `a.${longExtension}`, segments: ['voice'] });
assert.ok(
  bytes(pathological) <= DERIVED_ARTIFACT_MAX_BYTES,
  `a 250-character extension must still fit the cap, got ${bytes(pathological)} bytes`,
);
assert.ok(bytes(pathological) < 255, 'the name must also stay under the NTFS component limit');
assert.match(pathological, COLLAPSED, 'the pathological name is a collapsed name');
assert.equal(deriveArtifactName({ sourceName: `a.${longExtension}`, segments: ['voice'] }), pathological);
assert.ok(
  bytes(pathological.slice(pathological.lastIndexOf('.'))) <= DERIVED_ARTIFACT_COLLAPSED_EXTENSION_BYTES + 1,
  'the collapsed extension is bounded by its own budget',
);

// Truncating the extension cannot merge two identities: the hash covers the
// full extension, so two names that differ only past the budget still differ.
const pathologicalSibling = deriveArtifactName({ sourceName: `a.${'e'.repeat(249)}f`, segments: ['voice'] });
assert.notEqual(pathologicalSibling, pathological, 'the full extension is part of the hashed identity');
assert.ok(bytes(pathologicalSibling) <= DERIVED_ARTIFACT_MAX_BYTES);

// A legal long extension is untouched: 220 bytes is 225 with `clip.`, under the
// cap, so it must come back verbatim and unhashed.
const boundaryExtension = 'e'.repeat(220);
const boundary = deriveArtifactName({ sourceName: `clip.${boundaryExtension}` });
assert.equal(bytes(boundary), 225, 'a 220-byte extension is a legal shape');
assert.equal(boundary, `clip.${boundaryExtension}`, 'a legal long extension is not collapsed');
assert.ok(!boundary.includes('~'));

// The same legal extension collapses when the rest of the identity pushes it
// over the cap, and the result still fits.
const boundaryCollapsed = deriveArtifactName({
  sourceName: `${'s'.repeat(60)}.${boundaryExtension}`,
  segments: ['voice'],
});
assert.match(boundaryCollapsed, COLLAPSED);
assert.ok(
  bytes(boundaryCollapsed) <= DERIVED_ARTIFACT_MAX_BYTES,
  `got ${bytes(boundaryCollapsed)} bytes`,
);

// ── 5. mutation probe: the cap is what collapses the name ───────────────────
// Copy the module and its one dependency into a scratch directory with the cap
// lowered, and prove the same short identity collapses there while the real
// module still returns it unchanged. A cap that stopped being read (or that was
// counted in characters) fails this.
const scratch = await mkdtemp(join(tmpdir(), 'openchatcut-artifact-name-'));
try {
  const source = await readFile(new URL('./derived-artifact-name.ts', import.meta.url), 'utf8');
  const mutated = source.replace(
    `export const DERIVED_ARTIFACT_MAX_BYTES = ${DERIVED_ARTIFACT_MAX_BYTES};`,
    'export const DERIVED_ARTIFACT_MAX_BYTES = 24;',
  );
  assert.notEqual(mutated, source, 'the mutation must find the cap declaration');
  await writeFile(join(scratch, 'derived-artifact-name.ts'), mutated);
  await writeFile(
    join(scratch, 'file-name.ts'),
    await readFile(new URL('./file-name.ts', import.meta.url), 'utf8'),
  );
  const mutant = await import(pathToFileURL(join(scratch, 'derived-artifact-name.ts')).href) as {
    deriveArtifactName: typeof deriveArtifactName;
    DERIVED_ARTIFACT_MAX_BYTES: number;
  };
  assert.equal(mutant.DERIVED_ARTIFACT_MAX_BYTES, 24);
  assert.equal(bytes('clip.voice.s90.r7.voice-v2.mov'), 30, 'the probe name is 30 bytes');
  assert.match(mutant.deriveArtifactName(short), COLLAPSED, 'with a 24-byte cap the same name must collapse');
  assert.ok(bytes(mutant.deriveArtifactName(short)) <= 24);
  assert.equal(deriveArtifactName(short), 'clip.voice.s90.r7.voice-v2.mov', 'the real module is unaffected');
} finally {
  await rm(scratch, { recursive: true, force: true });
}

console.log('derived artifact name checks passed');
