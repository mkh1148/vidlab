// A1 item 8 · release layout, provenance and rollback.
//
// The kit's requirement: build into a fresh dated directory, never in place over
// the running copy, and make rolling back a rename. On Windows the rename is a
// directory junction (`release/current` → `release/<stamp>-<label>`), which needs
// no administrator rights and no service installed — the WinSW service itself is
// A2, this check only proves the swap works and the previous build survives.
//
// Condition 3 (review) added the provenance rules asserted here:
//   * a release must name a commit that exists in this repository, and the
//     manifest must agree with its directory;
//   * a release built from a dirty tree says so, and switching into it warns;
//   * `switch` really probes the port instead of printing an expectation.
//
// Everything runs in a throwaway release root (`--root`), so the real
// `release/current` is never pointed at a fake build.
//
// Run: node scripts/release-switch.verify.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { repoRoot, scratchDir } from './a1-harness.mjs';

const RELEASE = join(repoRoot, 'scripts', 'release.mjs');
const HEAD = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();

function release(args) {
  try {
    const stdout = execFileSync(process.execPath, [RELEASE, ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out: stdout };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

/** A release directory that looks like a build: dist/index.html with a marker. */
async function fakeRelease(root, name, marker, manifestOverrides = {}) {
  const dir = join(root, name, 'dist');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.html'), `<!doctype html><title>${marker}</title>\n`);
  await writeFile(join(root, name, 'release.json'), `${JSON.stringify({
    name,
    version: '0.0.0-test',
    commit: HEAD,
    commitShort: HEAD.slice(0, 8),
    dirty: false,
    dirtyPaths: 0,
    builtAt: new Date(0).toISOString(),
    buildDurationMs: 1,
    dist: 'dist',
    distBytes: 1,
    ...manifestOverrides,
  }, null, 2)}\n`);
  return join(root, name);
}

const root = await scratchDir('releases');
const A = '20260101-000000-a';
const B = '20260102-000000-b';
const busyPort = 5401;
let blocker = null;

try {
  const dirA = await fakeRelease(root, A, 'release-a');
  const dirB = await fakeRelease(root, B, 'release-b');
  const current = join(root, 'current');
  const marker = async () => (await readFile(join(current, 'dist', 'index.html'), 'utf8')).trim();

  // ── dry run plans without touching anything ────────────────────────────
  const dry = release(['switch', A, '--root', root, '--port', String(busyPort), '--dry-run']);
  assert.equal(dry.code, 0, `dry run failed: ${dry.out}`);
  assert.match(dry.out, /dry run: would point/);
  assert.match(dry.out, new RegExp(HEAD.slice(0, 8)), 'the dry run must name the commit it would serve');
  assert.ok(!existsSync(current), 'a dry run must not create the junction');

  // ── switch to A ────────────────────────────────────────────────────────
  const first = release(['switch', A, '--root', root, '--port', String(busyPort)]);
  assert.equal(first.code, 0, `switch to A failed: ${first.out}`);
  assert.ok(existsSync(join(current, 'dist', 'index.html')), 'current must resolve to a built editor');
  assert.match(await marker(), /release-a/);

  // ── switch to B: the previous build survives ───────────────────────────
  const second = release(['switch', B, '--root', root, '--port', String(busyPort)]);
  assert.equal(second.code, 0, `switch to B failed: ${second.out}`);
  assert.match(await marker(), /release-b/);
  assert.ok(existsSync(join(dirA, 'dist', 'index.html')), 'the previous release must survive the swap');
  assert.match(await readFile(join(dirA, 'dist', 'index.html'), 'utf8'), /release-a/);
  assert.ok(existsSync(join(dirA, 'release.json')), 'the previous manifest must survive');

  // ── rollback is the same command pointed at the old release ────────────
  const rollback = release(['switch', A, '--root', root, '--port', String(busyPort)]);
  assert.equal(rollback.code, 0, `rollback failed: ${rollback.out}`);
  assert.match(await marker(), /release-a/, 'rollback must serve the previous build');
  assert.ok(existsSync(join(dirB, 'dist', 'index.html')), 'rollback must not delete the newer build');

  // ── provenance: unusable manifests are refused before anything moves ────
  const cases = [
    { name: '20260103-000000-nomanifest', marker: 'x', manifest: null, expect: /release\.json is missing/ },
    { name: '20260104-000000-unknowncommit', marker: 'x', manifest: { commit: 'deadbeefdeadbeef' }, expect: /not a commit in this repository/ },
    { name: '20260105-000000-nocommit', marker: 'x', manifest: { commit: '' }, expect: /no commit/ },
    { name: '20260106-000000-wrongname', marker: 'x', manifest: { name: 'something-else' }, expect: /manifest names/ },
    { name: '20260107-000000-noversion', marker: 'x', manifest: { version: '' }, expect: /no version/ },
  ];
  for (const entry of cases) {
    const dir = join(root, entry.name, 'dist');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>x</title>\n');
    if (entry.manifest) {
      await writeFile(join(root, entry.name, 'release.json'), `${JSON.stringify({
        name: entry.name,
        version: '0.0.0-test',
        commit: HEAD,
        builtAt: new Date(0).toISOString(),
        distBytes: 1,
        ...entry.manifest,
      }, null, 2)}\n`);
    }
    const refused = release(['switch', entry.name, '--root', root, '--port', String(busyPort)]);
    assert.equal(refused.code, 1, `${entry.name} must be refused: ${refused.out}`);
    assert.match(refused.out, entry.expect, `${entry.name} must be refused with a useful reason: ${refused.out}`);
    assert.match(await marker(), /release-a/, `a refused switch must leave current alone (${entry.name})`);
  }

  // ── a release without a built editor is refused ────────────────────────
  await mkdir(join(root, '20260108-000000-broken'), { recursive: true });
  const refused = release(['switch', '20260108-000000-broken', '--root', root, '--port', String(busyPort)]);
  assert.equal(refused.code, 1, 'switching to an unbuilt directory must fail');
  assert.match(refused.out, /no built editor/);
  assert.match(await marker(), /release-a/, 'a refused switch must leave current alone');

  const missing = release(['switch', 'no-such-release', '--root', root, '--port', String(busyPort)]);
  assert.equal(missing.code, 1, 'switching to a missing release must fail');

  // ── a dirty release is served but flagged ──────────────────────────────
  const dirtyName = '20260109-000000-dirty';
  await fakeRelease(root, dirtyName, 'release-dirty', { dirty: true, dirtyPaths: 3 });
  const dirtySwitch = release(['switch', dirtyName, '--root', root, '--port', String(busyPort)]);
  assert.equal(dirtySwitch.code, 0, `a dirty release must still be switchable: ${dirtySwitch.out}`);
  assert.match(dirtySwitch.out, /DIRTY TREE/, 'the switch must say the release came from a dirty tree');
  assert.match(dirtySwitch.out, /uncommitted tree/);
  assert.match(await marker(), /release-dirty/);

  // ── the port check is real: a listening port blocks the swap ───────────
  const beforeBusy = await marker();
  blocker = createServer();
  await new Promise((resolve) => blocker.listen(busyPort, '127.0.0.1', resolve));
  const busy = release(['switch', A, '--root', root, '--port', String(busyPort)]);
  assert.equal(busy.code, 1, 'a swap under a listening server must be refused');
  assert.match(busy.out, /port 5401 is in use/, `the refusal must name the port: ${busy.out}`);
  assert.equal(await marker(), beforeBusy, 'a refused swap must leave current alone');
  await new Promise((resolve) => blocker.close(resolve));
  blocker = null;

  // With the port free again the same command succeeds.
  const afterFree = release(['switch', A, '--root', root, '--port', String(busyPort)]);
  assert.equal(afterFree.code, 0, `switch after freeing the port failed: ${afterFree.out}`);
  assert.match(afterFree.out, /port 5401 is free/);

  // ── status lists every release and names the current one ───────────────
  const status = release(['status', '--root', root]);
  assert.equal(status.code, 0, `status failed: ${status.out}`);
  assert.match(status.out, new RegExp(A));
  assert.match(status.out, new RegExp(B));
  assert.match(status.out, /DIRTY/, 'status must mark a dirty release');
  assert.match(status.out, /current/);

  // ── the release root holds nothing but releases and the junction ────────
  const entries = (await readdir(root)).sort();
  assert.deepEqual(entries.filter((name) => !name.startsWith('2026')), ['current']);

  console.log(
    `release-switch.verify: dry run planned, ${A} -> current, ${B} -> current, rollback -> ${A}, `
    + 'previous builds intact, 5 unusable manifests refused, dirty release flagged, '
    + `port ${busyPort} probed (busy refused / free accepted), status lists all`,
  );
} finally {
  if (blocker) await new Promise((resolve) => blocker.close(resolve));
  // Remove the junction before the tree: a recursive delete through a junction
  // would reach into whatever it points at.
  if (existsSync(join(root, 'current'))) {
    execFileSync('cmd', ['/c', 'rmdir', join(root, 'current')], { stdio: 'pipe' });
  }
  await rm(root, { recursive: true, force: true });
}
