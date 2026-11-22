// P3 · The Host allowlist.
//
// Two layers of assertion:
//   1. the pure allowlist/parse rules, including the malformed values a proxy or
//      an absolute-form request target can produce;
//   2. a real HTTP server with the guard mounted first, proving a foreign Host is
//      refused on a static path AND on the API path that lists provider keys,
//      while the loopback names pass.
//
// The built-app variant (scripts/prod-server.verify.mjs) repeats the same
// assertions against dist/ on the production server.
//
// Run: npx tsx server/host-guard.verify.ts
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  configuredHostAllowlist,
  hostAllowlist,
  hostAllowed,
  hostGuardMiddleware,
  parseHostHeader,
} from './host-guard.ts';

// ── parsing ───────────────────────────────────────────────────────────────
assert.deepEqual(parseHostHeader('localhost'), { hostname: 'localhost', port: null });
assert.deepEqual(parseHostHeader('LOCALHOST:5199'), { hostname: 'localhost', port: '5199' });
assert.deepEqual(parseHostHeader('127.0.0.1:5199'), { hostname: '127.0.0.1', port: '5199' });
assert.deepEqual(parseHostHeader('[::1]:5199'), { hostname: '::1', port: '5199' });
assert.deepEqual(parseHostHeader('[::1]'), { hostname: '::1', port: null });
for (const bad of [
  undefined, '', '   ', 'evil.example', 'http://127.0.0.1/', '127.0.0.1\\@evil',
  'localhost:abc', 'localhost:99999', '::1', '[::1', 'a:b:c', '127.0.0.1 5199',
]) {
  if (bad === 'evil.example') continue; // parses fine; the allowlist rejects it
  assert.equal(parseHostHeader(bad), null, `must refuse to parse ${JSON.stringify(bad)}`);
}

// ── allowlist ─────────────────────────────────────────────────────────────
assert.deepEqual([...hostAllowlist()].sort(), ['127.0.0.1', '::1', 'localhost']);
assert.equal(hostAllowed('localhost:5199'), true);
assert.equal(hostAllowed('127.0.0.1:5199'), true);
assert.equal(hostAllowed('[::1]:5199'), true);
assert.equal(hostAllowed('evil.example'), false);
assert.equal(hostAllowed('127.0.0.1.evil.example'), false);
assert.equal(hostAllowed('evil.example:5199'), false);
assert.equal(hostAllowed(undefined), false);
// The configured editor host joins the allowlist; junk in the config does not.
assert.equal(hostAllowed('vidlab.local:5199', { editorUrl: 'http://vidlab.local:5199' }), true);
assert.equal(hostAllowed('vidlab.local:5199', { editorUrl: 'not a url' }), false);
assert.deepEqual(configuredHostAllowlist(' a.local , ,[::1],b.local '), ['a.local', '::1', 'b.local']);
assert.equal(hostAllowed('b.local', { extraHosts: configuredHostAllowlist('b.local') }), true);
// A configured extra host cannot smuggle a path or a wildcard through.
assert.equal(hostAllowed('anything', { extraHosts: configuredHostAllowlist('*') }), false);

// ── a real server: foreign Host 403 on static and API, loopback 200 ───────
const guard = hostGuardMiddleware(() => ({}));
const server = createServer((req, res) => {
  guard(req, res, () => {
    if ((req.url ?? '').startsWith('/api/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ keys: [] }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html>editor</html>');
  });
});

function call(port: number, path: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers: { host } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as AddressInfo).port;
try {
  // The API route that lists stored provider keys: the exact read P3 is about.
  assert.equal((await call(port, '/api/keys', `127.0.0.1:${port}`)).status, 200);
  assert.equal((await call(port, '/api/keys', `localhost:${port}`)).status, 200);
  const foreignApi = await call(port, '/api/keys', 'evil.example');
  assert.equal(foreignApi.status, 403, 'a foreign Host must not read /api/keys');
  assert.match(foreignApi.body, /host not allowed/);

  // Static editor route, same rule.
  assert.equal((await call(port, '/', `127.0.0.1:${port}`)).status, 200);
  assert.equal((await call(port, '/', 'evil.example')).status, 403);
  assert.equal((await call(port, '/', `[::1]:${port}`)).status, 200);
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

console.log('host-guard.verify: foreign Host 403 on / and /api/keys, loopback names 200');
