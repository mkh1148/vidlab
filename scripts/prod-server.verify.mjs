// A1 item 1 + item 4 · the BUILT app on the production server.
//
// Kit A step 1 is "one process serves the built editor and the API"; P9 says the
// check must run against the build, never the dev server. This starts
// scripts/serve-prod.mjs (the embedded server the desktop app ships, serving
// dist/), then asserts:
//
//   - the built editor HTML and a built asset are served with 200;
//   - a foreign Host gets 403 on the editor route AND on /api/keys, the read
//     endpoint P3 is about; loopback names get 200 (control: the same server
//     with the guard off answers 200 to the foreign Host, which is the bug);
//   - a ranged media request gets 206 (kit A exit test).
//
// Run: node scripts/prod-server.verify.mjs   (needs `npm run build` first)
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { freePort, repoRoot, request, scratchDir, startProdServer } from './a1-harness.mjs';

const dist = join(repoRoot, 'dist');
assert.ok(
  existsSync(join(dist, 'index.html')),
  `no built editor at ${dist} — run "npm run build" first (a dev-server check would hide this, P9)`,
);

const home = await scratchDir('home');
const dataDir = await scratchDir('data');
const port = await freePort();
const server = await startProdServer({ home, dataDir, port });

try {
  // ── the built editor is what is being served ────────────────────────────
  const index = await request(port, '/');
  assert.equal(index.status, 200, 'GET / must serve the built editor');
  assert.match(index.headers['content-type'] ?? '', /text\/html/);
  assert.match(index.text(), /<div id="root"/, 'the built index.html must be the shell');

  const assetPath = index.text().match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  assert.ok(assetPath, 'the built index.html must reference a hashed bundle');
  const asset = await request(port, assetPath);
  assert.equal(asset.status, 200, `built asset ${assetPath} must be served`);
  assert.match(asset.headers['content-type'] ?? '', /javascript/);

  // ── P3: the Host allowlist, on the built app ────────────────────────────
  const localKeys = await request(port, '/api/keys', { host: `127.0.0.1:${port}` });
  assert.equal(localKeys.status, 200, 'a loopback Host must reach the API');
  assert.match(localKeys.text(), /^\{/, '/api/keys must answer JSON');

  const localhostKeys = await request(port, '/api/keys', { host: `localhost:${port}` });
  assert.equal(localhostKeys.status, 200, 'the localhost name must reach the API');

  const foreignKeys = await request(port, '/api/keys', { host: 'evil.example' });
  assert.equal(foreignKeys.status, 403, 'a foreign Host must not read /api/keys');
  assert.match(foreignKeys.text(), /host not allowed/);

  const foreignIndex = await request(port, '/', { host: 'evil.example' });
  assert.equal(foreignIndex.status, 403, 'a foreign Host must not read the editor either');

  const rebind = await request(port, '/api/keys', { host: `127.0.0.1.nip.io:${port}` });
  assert.equal(rebind.status, 403, 'a name that resolves to loopback is still a foreign Host');

  // The guard covers every route, including the mobile-upload control route: a
  // LAN listener is gated separately (server/mobile-upload-bind.verify.ts), but
  // the control API must never be reachable through a foreign Host.
  const mobileControl = await request(port, '/api/mobile-upload/sessions', {
    method: 'POST',
    host: 'evil.example',
  });
  assert.equal(mobileControl.status, 403, 'a foreign Host must not reach the mobile-upload control');
  const mobileLocal = await request(port, '/api/mobile-upload/sessions', {
    method: 'POST',
    host: `127.0.0.1:${port}`,
    headers: { origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' },
  });
  assert.equal(
    mobileLocal.status,
    201,
    'a loopback same-origin request must clear the Host guard and open a session '
    + `(got ${mobileLocal.status})`,
  );
  // C2: the production server's own mobile-upload session listens on loopback.
  // A LAN bind is an explicit opt-in (OPENCHATCUT_MOBILE_UPLOAD_BIND=lan).
  const mobileSession = JSON.parse(mobileLocal.text());
  assert.ok(Array.isArray(mobileSession.urls) && mobileSession.urls.length > 0);
  for (const url of mobileSession.urls) {
    assert.equal(
      new URL(url).hostname,
      '127.0.0.1',
      `the production server must advertise a loopback upload URL by default, got ${url}`,
    );
  }
  await request(port, `/api/mobile-upload/sessions/${mobileSession.id}`, {
    method: 'DELETE',
    host: `127.0.0.1:${port}`,
    headers: { origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' },
  });

  // ── ranged media request: 206 ───────────────────────────────────────────
  const mediaDir = join(dataDir, 'media', 'uploads');
  await mkdir(mediaDir, { recursive: true });
  await writeFile(join(mediaDir, 'a1-range.mp4'), Buffer.alloc(64 * 1024, 7));
  const ranged = await request(port, '/media/uploads/a1-range.mp4', {
    headers: { range: 'bytes=0-1023', origin: `http://127.0.0.1:${port}` },
  });
  assert.equal(ranged.status, 206, 'a ranged media request must answer 206');
  assert.equal(ranged.body.length, 1024);
  assert.equal(ranged.headers['content-range'], 'bytes 0-1023/65536');

  // ── control: without the guard, the foreign Host is served (the P3 bug) ──
  const unguardedPort = await freePort();
  const unguarded = await startProdServer({
    home,
    dataDir,
    port: unguardedPort,
    extraEnv: { OPENCHATCUT_HOST_GUARD: 'off' },
  });
  try {
    const before = await request(unguardedPort, '/api/keys', { host: 'evil.example' });
    assert.equal(
      before.status,
      200,
      'control: with the guard off the foreign Host is answered — this is the defect the guard removes',
    );
  } finally {
    await unguarded.stop();
  }

  console.log(
    `prod-server.verify: built editor 200, asset 200, /api/keys local 200 / foreign 403, `
    + `mobile-upload control foreign 403 / loopback 201 with a loopback URL, `
    + `range 206, unguarded control 200 (ready ${server.settings.readyMs} ms)`,
  );
} finally {
  await server.stop();
  await rm(home, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
}
