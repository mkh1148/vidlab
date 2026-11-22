// A1 item 8 · P9 hygiene: every path a package.json script names really exists.
//
// P9 is the "it only ever passed on the dev server" pitfall in its packaging
// form: a script that points at a file which is not in the tree (or exists only
// because someone built it once, and is therefore not in git) fails on a clean
// checkout — which is exactly the machine the owner will restore from.
//
// Rules:
//   * a token that looks like a repo path must exist on disk, and
//   * it must be tracked by git, so a fresh clone has it.
// Two classes are exempt: build OUTPUTS (they do not exist before a build) and
// absolute/URL tokens (nothing to check).
//
// Run: node scripts/script-paths.verify.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { repoRoot } from './a1-harness.mjs';

/** Build outputs: created by a build, absent from a fresh checkout by design. */
const OUTPUT_DIRS = ['desktop-dist/', 'release/', 'dist/', 'node_modules/'];
const PATH_LIKE = /\.(?:mjs|cjs|js|mts|cts|ts|tsx|json|sh|ps1|md)$/;

const scripts = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).scripts;

/** Every repo-relative path token in the script bodies, with its script name. */
function pathTokens() {
  const found = new Map();
  for (const [name, body] of Object.entries(scripts)) {
    for (const raw of String(body).split(/\s+/)) {
      // A bundler module specifier (`--external:./app-main.mjs`) names a module,
      // not a file in the tree.
      if (/^--(?:external|alias|loader|define|inject):/.test(raw)) continue;
      // `--outfile=desktop-dist/main.mjs` carries a path inside a flag; keep it.
      const token = raw.includes('=') ? raw.slice(raw.indexOf('=') + 1) : raw;
      const clean = token.replace(/^["']|["']$/g, '');
      if (!PATH_LIKE.test(clean)) continue;
      if (isAbsolute(clean) || /^[a-z]+:\/\//i.test(clean)) continue;
      const relative = clean.replace(/^\.\//, '');
      if (OUTPUT_DIRS.some((dir) => relative.startsWith(dir))) continue;
      if (!found.has(relative)) found.set(relative, []);
      found.get(relative).push(name);
    }
  }
  return found;
}

const tokens = pathTokens();
assert.ok(tokens.size > 100, `expected the script table to name many files, found ${tokens.size}`);

const missing = [];
for (const [path, owners] of tokens) {
  if (!existsSync(join(repoRoot, path))) missing.push(`${path} (${owners.join(', ')})`);
}
assert.deepEqual(missing, [], `package.json scripts name files that do not exist:\n  ${missing.join('\n  ')}`);

// Tracked by git: one `ls-files` for the whole list, so a fresh clone is covered.
const tracked = new Set(
  execFileSync('git', ['ls-files', '--', ...tokens.keys()], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean),
);
const untracked = [...tokens.keys()].filter((path) => !tracked.has(path));
assert.deepEqual(
  untracked,
  [],
  `package.json scripts name files git does not track (a fresh clone would fail):\n  ${untracked.join('\n  ')}`,
);

// The scripts that matter for the production start must be in the tracked set.
for (const required of ['scripts/serve-prod.mjs', 'scripts/release.mjs']) {
  assert.ok(tracked.has(required), `${required} must be tracked and named by a script`);
}

console.log(
  `script-paths.verify: ${tokens.size} paths named by ${Object.keys(scripts).length} scripts all exist `
  + `and are git-tracked (build outputs exempt: ${OUTPUT_DIRS.join(', ')})`,
);
