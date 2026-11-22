// Bake every shipped film look into a committed .cube 3D LUT.
//
// The formulas live in src/gl/looks/lookFormulas.ts and are the only place a look's
// colour exists; this script is the only thing allowed to write assets/luts/*.cube.
// `scripts/looks.verify.mjs` regenerates the same text in memory and compares it with
// what is committed, so a formula edit that was not re-baked fails the gate, and a
// hand-edited .cube fails it too.
//
// Usage:
//   npx tsx scripts/generate-looks.mjs          write the files
//   npx tsx scripts/generate-looks.mjs --list   names only (used by the verify)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LOOK_FORMULAS, LOOK_IDS } from '../src/gl/looks/lookFormulas.ts';
import { CUBE_SIZE, renderCubeText } from '../src/gl/looks/cubeText.ts';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const lutDir = join(repoRoot, 'assets', 'luts');

/** Every look as `{ id, file, text }`, in catalog order. Nothing is written. */
export function generatedLuts(size = CUBE_SIZE) {
  return LOOK_IDS.map((id) => {
    const look = LOOK_FORMULAS[id];
    return { id, file: `${look.id}.cube`, text: renderCubeText(look, size) };
  });
}

// Only act when run as a script: scripts/looks.verify.mjs imports the helpers above and
// must not rewrite the files it is about to compare.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  if (process.argv.includes('--list')) {
    for (const { file } of generatedLuts()) console.log(file);
  } else {
    mkdirSync(lutDir, { recursive: true });
    let bytes = 0;
    for (const { file, text } of generatedLuts()) {
      writeFileSync(join(lutDir, file), text);
      bytes += Buffer.byteLength(text);
    }
    console.log(`generate-looks: wrote ${LOOK_IDS.length} LUTs (${(bytes / 1024 / 1024).toFixed(2)} MB) into assets/luts/`);
  }
}
