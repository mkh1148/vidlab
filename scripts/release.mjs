// Release layout and rollback (kit A step 9, Windows form per D-2).
//
// The rule the kit states: build into a fresh directory, never in place over the
// running copy, and make rolling back a rename. On Windows the "rename" is a
// directory junction (`release/current` → `release/<stamp>-<label>`), which needs
// no administrator rights and no service restart to inspect.
//
//   node scripts/release.mjs build [--label NAME] [--dry-run]
//   node scripts/release.mjs switch <release-dir> [--dry-run]
//   node scripts/release.mjs status
//
// What a release directory holds: the built editor (dist/), a release.json
// manifest, and nothing else. Code and node_modules are shared with the
// checkout — this is a personal-machine release, not a distributable package
// (Milestone F). The production server is started with
// `node --import tsx scripts/serve-prod.mjs --dist release/current/dist`.
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const command = args[0];
const dryRun = args.includes('--dry-run');
const flag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

// `--root` exists so the switch check can prove the swap in a throwaway tree
// instead of pointing the real `release/current` at a fake build.
const releaseRoot = resolve(
  flag('--root') ?? process.env.OPENCHATCUT_RELEASE_ROOT ?? join(root, 'release'),
);
const currentLink = join(releaseRoot, 'current');

function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * Provenance of the working tree the build is about to read.
 *
 * A manifest that mislabels the code it carries is worse than no manifest: it is
 * the one thing a rollback decision rests on. So the full HEAD goes in, and a
 * dirty tree is refused unless the caller says `--allow-dirty` — in which case
 * the manifest records `dirty: true` and the switch output repeats it.
 */
function gitProvenance() {
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  let head;
  try {
    head = git(['rev-parse', 'HEAD']);
  } catch {
    throw new Error('not a git checkout: a release needs a commit to name');
  }
  const status = git(['status', '--porcelain']);
  const dirtyPaths = status ? status.split('\n').filter(Boolean) : [];
  return { head, short: head.slice(0, 8), dirtyPaths };
}

/** True when `commit` is a commit object in this repository. */
function isKnownCommit(commit) {
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) return false;
  try {
    execFileSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: root, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** Refuse to swap while anything is listening on the port the server uses. */
async function assertPortFree(port) {
  const probe = createServer();
  try {
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(port, '127.0.0.1', resolve);
    });
  } catch (error) {
    const code = error instanceof Error ? error.code : '';
    throw new Error(
      code === 'EADDRINUSE'
        ? `port ${port} is in use — stop the server before switching (kit A: never swap under a running copy)`
        : `cannot probe port ${port}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await new Promise((resolve) => probe.close(() => resolve()));
  }
}

/** Read and validate a release manifest; throws with the reason it is unusable. */
async function readManifest(name) {
  const dir = join(releaseRoot, name);
  if (!existsSync(join(dir, 'dist', 'index.html'))) {
    throw new Error(`refusing to switch: ${dir} has no built editor (dist/index.html)`);
  }
  const manifestPath = join(dir, 'release.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`refusing to switch: ${manifestPath} is missing, so the code it carries is unknown`);
  }
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`refusing to switch: ${manifestPath} is not valid JSON (${error instanceof Error ? error.message : error})`);
  }
  if (manifest.name !== name) {
    throw new Error(`refusing to switch: manifest names "${manifest.name}" but the directory is "${name}"`);
  }
  if (typeof manifest.commit !== 'string' || !manifest.commit) {
    throw new Error('refusing to switch: the manifest has no commit, so the code it carries is unknown');
  }
  if (!isKnownCommit(manifest.commit)) {
    throw new Error(
      `refusing to switch: manifest commit ${manifest.commit} is not a commit in this repository`,
    );
  }
  if (typeof manifest.version !== 'string' || !manifest.version) {
    throw new Error('refusing to switch: the manifest has no version');
  }
  return manifest;
}

/** Directory size in bytes, for the manifest. */
async function directoryBytes(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(path);
    else total += (await stat(path)).size;
  }
  return total;
}

/** Remove a junction WITHOUT touching what it points at. */
function removeJunction(path) {
  // `rmdir` on a junction removes the link; `rm -r` would delete the target.
  execFileSync('cmd', ['/c', 'rmdir', path], { stdio: 'pipe' });
}

function createJunction(link, target) {
  execFileSync('cmd', ['/c', 'mklink', '/J', link, target], { stdio: 'pipe' });
}

async function build() {
  const label = flag('--label') ?? 'prod';
  const name = `${stamp()}-${label}`;
  const dir = join(releaseRoot, name);
  const distDir = join(dir, 'dist');
  const startedAt = new Date();
  const allowDirty = args.includes('--allow-dirty');
  const provenance = gitProvenance();
  console.log(`[release] building ${name} from ${provenance.short}`);
  console.log(`[release] dist target: ${distDir}`);
  if (provenance.dirtyPaths.length > 0) {
    if (!allowDirty) {
      throw new Error(
        `the working tree has ${provenance.dirtyPaths.length} uncommitted change(s), so the release `
        + 'would not match any commit — commit first, or pass --allow-dirty to record it:\n  '
        + provenance.dirtyPaths.slice(0, 10).join('\n  '),
      );
    }
    console.log(`[release] WARNING: dirty tree (${provenance.dirtyPaths.length} paths) recorded in the manifest`);
  }
  if (dryRun) {
    console.log('[release] dry run: would run "npm run build -- --outDir <dist>" and write release.json');
    return;
  }
  await mkdir(dir, { recursive: true });
  // `--outDir` reaches vite through the build script, so the checkout's own dist/
  // is never rewritten and a running server keeps serving its own snapshot.
  const started = Date.now();
  execFileSync('npm', ['run', 'build', '--', '--outDir', distDir], {
    cwd: root,
    stdio: 'inherit',
    shell: true,
  });
  const durationMs = Date.now() - started;
  const manifest = {
    name,
    version: JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version,
    commit: provenance.head,
    commitShort: provenance.short,
    dirty: provenance.dirtyPaths.length > 0,
    dirtyPaths: provenance.dirtyPaths.length,
    builtAt: startedAt.toISOString(),
    buildDurationMs: durationMs,
    dist: 'dist',
    distBytes: await directoryBytes(distDir),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
  };
  await writeFile(join(dir, 'release.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[release] built ${name} in ${(durationMs / 1000).toFixed(1)} s from ${provenance.short}`);
  console.log(`[release] switch to it with: node scripts/release.mjs switch ${name}`);
}

async function switchTo() {
  // The first bare argument after the command; `--root X`, `--port N` and
  // `--dry-run` are flags, not release names.
  const target = args.slice(1).find((value, index, rest) => {
    if (value.startsWith('--')) return false;
    return rest[index - 1] !== '--root' && rest[index - 1] !== '--label'
      && rest[index - 1] !== '--port';
  });
  if (!target || target.startsWith('--')) throw new Error('switch needs a release directory name');
  const targetDir = join(releaseRoot, target);
  // The manifest is checked BEFORE anything is touched: a release whose code
  // cannot be named is not a release this machine should serve.
  const manifest = await readManifest(target);
  const port = Number(flag('--port') ?? process.env.OPENCHATCUT_PORT ?? 5199);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port: ${port}`);
  console.log(`[release] target: ${targetDir}`);
  console.log(
    `[release] manifest: v${manifest.version} ${String(manifest.commit).slice(0, 8)}`
    + ` built ${manifest.builtAt}${manifest.dirty ? ' (DIRTY TREE)' : ''}`,
  );
  // Actually check, not just print: a swap under a running server serves a
  // half-written tree to whoever is using it.
  await assertPortFree(port);
  console.log(`[release] port ${port} is free — the server is stopped`);
  if (dryRun) {
    console.log(`[release] dry run: would point ${currentLink} at ${targetDir}`);
    return;
  }
  const staging = `${currentLink}.incoming`;
  if (existsSync(staging)) removeJunction(staging);
  createJunction(staging, targetDir);
  if (existsSync(currentLink)) removeJunction(currentLink);
  // The swap itself: one rename, so `current` is never half-pointed.
  execFileSync('cmd', ['/c', 'move', staging, currentLink], { stdio: 'pipe' });
  console.log(`[release] ${currentLink} -> ${targetDir}`);
  if (manifest.dirty) {
    console.log('[release] WARNING: this release was built from an uncommitted tree; '
      + 'it does not correspond to a clean checkout of its commit');
  }
}

async function status() {
  if (!existsSync(releaseRoot)) {
    console.log('[release] no releases yet: node scripts/release.mjs build');
    return;
  }
  const current = existsSync(currentLink)
    ? execFileSync('cmd', ['/c', 'dir', releaseRoot], { encoding: 'utf8' })
      .split('\n')
      .find((line) => /current\s+\[/i.test(line) || /JUNCTION/i.test(line)) ?? '(junction present)'
    : '(none)';
  const entries = (await readdir(releaseRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((name) => name !== 'current')
    .sort();
  console.log(`[release] root: ${releaseRoot}`);
  for (const name of entries) {
    const manifestPath = join(releaseRoot, name, 'release.json');
    const manifest = existsSync(manifestPath)
      ? JSON.parse(await readFile(manifestPath, 'utf8'))
      : { version: '?', commit: '?', builtAt: '?', distBytes: 0 };
    console.log(
      `  ${name}  v${manifest.version}  ${String(manifest.commit).slice(0, 8)}`
      + `${manifest.dirty ? ' DIRTY' : ''}  ${manifest.builtAt}  `
      + `${(manifest.distBytes / 1024 / 1024).toFixed(1)} MB`,
    );
  }
  console.log(`[release] current: ${current.trim()}`);
}

try {
  if (command === 'build') await build();
  else if (command === 'switch') await switchTo();
  else if (command === 'status') await status();
  else {
    console.error('usage: node scripts/release.mjs <build|switch|status> [args] [--dry-run] [--allow-dirty] [--port N]');
    process.exit(2);
  }
} catch (error) {
  console.error(`[release] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
