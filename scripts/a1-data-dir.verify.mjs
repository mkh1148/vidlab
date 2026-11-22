// A1 item 3 · the data directory moves, and the old projects come with it.
//
// Mechanism used: the base's OWN relocation source — the `OPENCHATCUT_DATA_DIR`
// environment variable, read first in server/runtime-profile.ts
// (configuredDataDir). The Settings-UI pointer file is the same mechanism's
// second source and is deliberately not used here: it lives at a fixed location
// inside the profile, which is exactly what a service must not depend on.
//
// What the base does NOT do on this tag: move the store for you. The in-app
// relocation (server/data-dir.ts relocateDataDir) refuses outright while the
// SQLite store is the authority ('sqlite-store-active'), because copying a live
// WAL database with a plain file copy can produce a torn snapshot. That refusal
// is asserted below, not assumed. The migration step is therefore a COLD copy
// with nothing running: stop, copy the store files, start with the new root.
//
// The check also asserts the source is left untouched (I5: a new build never
// destroys the old data) and that the old project still opens after the move.
//
// Run: node scripts/a1-data-dir.verify.mjs   (needs `npm run build` first)
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { freePort, repoRoot, request, scratchDir, startProdServer } from './a1-harness.mjs';

const run = promisify(execFile);
const PROJECT_NAME = 'A1 legacy project';

/** What a storage root carries that is the user's work (not machine settings).
 *  The SQLite trio is the store itself; the JSON entries are the pre-SQLite
 *  layout and the ledgers that must not be lost. */
const RELOCATED = [
  'project-store-v1.sqlite3',
  'project-store-v1.sqlite3-wal',
  'project-store-v1.sqlite3-shm',
  'project-store-v1.sqlite3.receipt.json',
  'project-store-v1',
  'project-store-v1.json',
  'project-store-auth-v1',
  'deleted-projects-v1.json',
  'generation-operations-v1.json',
  'upload-post-publishes.json',
  'media',
];

async function occ(args, env) {
  const { stdout } = await run(process.execPath, ['--import', 'tsx', join(repoRoot, 'cli', 'main.ts'), ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

const home = await scratchDir('home');
const dataRoot = await scratchDir('data-root');
const oldRoot = join(home, '.openchatcut');
const baseEnv = { USERPROFILE: home, HOME: home, OPENCHATCUT_DATA_DIR: '' };
let walDb;

try {
  // ── 1 · a project in the OLD default location ──────────────────────────
  const created = await occ(['project', 'new', PROJECT_NAME, '--json'], baseEnv);
  const project = JSON.parse(created);
  assert.ok(project.id, 'the CLI must report the new project id');
  const storeFile = join(oldRoot, 'project-store-v1.sqlite3');
  assert.ok(existsSync(storeFile), `the default root must hold the store: ${storeFile}`);
  const beforeList = await occ(['project', 'list', '--json'], baseEnv);
  assert.match(beforeList, new RegExp(PROJECT_NAME), 'the project must exist in the old root');

  // ── 1b · the source must carry a live WAL into the copy ────────────────
  // The real store's content sat entirely in a 1 MB WAL over a 4 KB main file
  // (docs/evidence/a1-migration-real.md), so a copy that ignores `-wal` loses
  // every project silently while still opening cleanly. Hold a write in the WAL
  // (a header pragma, so the check does not depend on the store's schema) and
  // keep the connection open until the copy has run.
  const walMarker = 7;
  walDb = new DatabaseSync(storeFile);
  walDb.exec('PRAGMA wal_autocheckpoint = 0');
  walDb.exec(`PRAGMA user_version = ${walMarker}`);
  assert.ok(existsSync(`${storeFile}-wal`), 'the fixture must leave a live WAL behind');
  assert.ok((await stat(`${storeFile}-wal`)).size > 0, 'the fixture WAL must not be empty');

  // ── 2 · the base's own relocation refuses, so the move is a cold copy ──
  const probe = join(home, 'relocate-probe.mts');
  await writeFile(probe, [
    `import { relocateDataDir } from ${JSON.stringify(pathToFileURL(join(repoRoot, 'server', 'data-dir.ts')).href)};`,
    `const outcome = await relocateDataDir(${JSON.stringify(oldRoot)}, ${JSON.stringify(dataRoot)}, () => {}, true);`,
    'console.log(JSON.stringify(outcome));',
  ].join('\n'));
  const { stdout: probeOut } = await run(process.execPath, ['--import', 'tsx', probe], { cwd: repoRoot });
  const outcome = JSON.parse(probeOut.trim().split('\n').pop());
  assert.equal(
    outcome.refused,
    'sqlite-store-active',
    `the base must refuse an in-app relocation while SQLite is the authority, got ${probeOut}`,
  );
  assert.equal(outcome.copiedEntries, 0, 'a refused relocation must copy nothing');

  await mkdir(dataRoot, { recursive: true });
  const copied = [];
  for (const entry of RELOCATED) {
    const from = join(oldRoot, entry);
    if (!existsSync(from)) continue;
    await cp(from, join(dataRoot, entry), { recursive: true });
    copied.push(entry);
  }
  assert.ok(copied.includes('project-store-v1.sqlite3'), 'the store must have been copied');
  assert.ok(
    copied.includes('project-store-v1.sqlite3-wal'),
    `the copy must carry the live WAL, copied [${copied.join(', ')}]`,
  );
  const migrated = new DatabaseSync(join(dataRoot, 'project-store-v1.sqlite3'));
  const migratedVersion = migrated.prepare('PRAGMA user_version').get().user_version;
  migrated.close();
  walDb.close();
  assert.equal(
    migratedVersion,
    walMarker,
    'the migrated store must contain the WAL content, not just the main file',
  );

  // ── 3 · the production server on the new root still lists it ───────────
  const port = await freePort();
  const server = await startProdServer({ home, dataDir: dataRoot, port });
  try {
    assert.equal(
      server.settings.dataDir,
      dataRoot,
      `the server must run on the configured data root, got ${server.settings.dataDir}`,
    );
    assert.equal(
      server.settings.mediaDir,
      join(dataRoot, 'media', 'uploads'),
      'media must follow the relocated root',
    );
    // `sec-fetch-site: none` is what a local tool (or direct navigation) sends;
    // the store API rejects a request that claims to be cross-site.
    const snapshot = await request(port, '/api/project-store/', {
      host: `127.0.0.1:${port}`,
      headers: { 'sec-fetch-site': 'none' },
    });
    assert.equal(snapshot.status, 200, `project store snapshot failed: ${snapshot.text().slice(0, 300)}`);
    assert.match(snapshot.text(), new RegExp(PROJECT_NAME), 'the server must list the migrated project');
    assert.match(snapshot.text(), new RegExp(project.id), 'the project id must survive the move');
  } finally {
    await server.stop();
  }

  // ── 4 · the CLI on the new root opens the same project (I5) ────────────
  const afterList = await occ(['project', 'list', '--json'], { ...baseEnv, OPENCHATCUT_DATA_DIR: dataRoot });
  assert.match(afterList, new RegExp(PROJECT_NAME), 'the CLI must see the migrated project');
  const shown = await occ(['project', 'show', project.id, '--json'], { ...baseEnv, OPENCHATCUT_DATA_DIR: dataRoot });
  assert.match(shown, new RegExp(project.id), 'the old project must still open');

  // ── 5 · the old root is untouched (I5) ─────────────────────────────────
  const oldEntries = await readdir(oldRoot);
  assert.ok(oldEntries.includes('project-store-v1.sqlite3'), 'the migration must not move the source');
  assert.ok((await stat(storeFile)).size > 0, 'the source store must not be emptied');
  const stillThere = await occ(['project', 'list', '--json'], baseEnv);
  assert.match(stillThere, new RegExp(PROJECT_NAME), 'the old root must still open the project');

  console.log(
    `a1-data-dir.verify: OPENCHATCUT_DATA_DIR relocation, in-app relocation refused `
    + `(${outcome.refused}), cold-copied [${copied.join(', ')}] including a live WAL, project ${project.id} listed by `
    + 'server and CLI after the switch, source root intact and still openable',
  );
} finally {
  try {
    walDb?.close();
  } catch {
    // already closed on the success path
  }
  await rm(home, { recursive: true, force: true });
  await rm(dataRoot, { recursive: true, force: true });
}
