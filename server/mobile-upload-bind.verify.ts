// A1 condition 2 · the mobile-upload listener is loopback unless the owner opts in.
//
// The defect: server/mobile-upload-service.ts defaulted `bindHost` to 0.0.0.0, and
// the plugin is in the production serverPlugins() list, so an owner-initiated
// mobile-upload session opened a LAN listener on the production server. Planning
// decision D-8 says this machine serves loopback only, so a LAN bind has to be an
// explicit, documented opt-in — never a default.
//
// Asserted here:
//   1. the resolver: unset => 127.0.0.1; `lan` / 0.0.0.0 / :: => every interface;
//      a named IPv4 => that interface; anything unrecognised => loopback + a note;
//   2. end to end: a default service really binds 127.0.0.1, advertises only
//      loopback URLs, and is NOT reachable on the machine's LAN address;
//   3. the opt-in is honoured: with `lan` the listener binds 0.0.0.0;
//   4. the production server's Host guard still covers the control route
//      (/api/mobile-upload/sessions) — see scripts/prod-server.verify.mjs.
//
// Run: npx tsx server/mobile-upload-bind.verify.ts
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MOBILE_UPLOAD_BIND_ENV,
  MobileUploadService,
  localIpv4Addresses,
  resolveMobileUploadBind,
} from './mobile-upload-service';

// ── 1 · the resolver ───────────────────────────────────────────────────────
assert.deepEqual(resolveMobileUploadBind({}), { host: '127.0.0.1', lan: false });
assert.deepEqual(
  resolveMobileUploadBind({ [MOBILE_UPLOAD_BIND_ENV]: 'lan' }),
  { host: '0.0.0.0', lan: true },
);
assert.deepEqual(
  resolveMobileUploadBind({ [MOBILE_UPLOAD_BIND_ENV]: '0.0.0.0' }),
  { host: '0.0.0.0', lan: true },
);
assert.deepEqual(
  resolveMobileUploadBind({ [MOBILE_UPLOAD_BIND_ENV]: '::' }),
  { host: '0.0.0.0', lan: true },
);
assert.deepEqual(
  resolveMobileUploadBind({ [MOBILE_UPLOAD_BIND_ENV]: '192.168.1.50' }),
  { host: '192.168.1.50', lan: true },
);
assert.deepEqual(
  resolveMobileUploadBind({ [MOBILE_UPLOAD_BIND_ENV]: '127.0.0.1' }),
  { host: '127.0.0.1', lan: false },
);
// A typo must never be the thing that widens the bind.
const typo = resolveMobileUploadBind({ [MOBILE_UPLOAD_BIND_ENV]: 'yes-please' });
assert.equal(typo.host, '127.0.0.1');
assert.equal(typo.lan, false);
assert.match(typo.note ?? '', /binding loopback/);

// ── 2 · end to end: the default service cannot reach the LAN ───────────────
const tempDir = await mkdtemp(join(tmpdir(), 'openchatcut-mobile-bind-'));
const logLines: string[] = [];
const lanAddresses = localIpv4Addresses();

const defaultService = new MobileUploadService({
  uploadDirectory: () => tempDir,
  maxBytes: 1024,
  sessionTtlMs: 5_000,
  log: (message) => logLines.push(message),
});

/** True when a TCP connect to host:port never completes (refused or dropped). */
function unreachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (reached: boolean) => { socket.destroy(); resolve(!reached); };
    // A firewall drops the packet rather than refusing it, so a timeout counts as
    // unreachable — only a completed connect proves the listener is there.
    socket.setTimeout(2_000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** The local addresses the OS reports listening on a port, for this process. */
function listeningAddresses(port: number): string[] {
  return execFileSync('netstat', ['-ano'], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.includes('LISTENING') && line.includes(`:${port} `))
    .map((line) => line.trim().split(/\s+/)[1] ?? '')
    .filter((local) => local.endsWith(`:${port}`));
}

try {
  assert.equal(defaultService.bindPlan.host, '127.0.0.1');
  assert.equal(defaultService.bindPlan.lan, false);

  const session = await defaultService.createSession('en');
  assert.equal(defaultService.boundAddress, '127.0.0.1', 'the default bind must be loopback');
  assert.equal(session.urls.length, 1, 'a loopback listener advertises one URL');
  assert.match(session.urls[0] ?? '', /^http:\/\/127\.0\.0\.1:\d+\/s\/[A-Za-z0-9_-]+$/);
  const port = Number(new URL(session.urls[0]!).port);
  assert.ok(port > 0);

  // The OS's own view: the listening socket is on 127.0.0.1, never 0.0.0.0.
  const listening = listeningAddresses(port);
  assert.deepEqual(
    listening,
    [`127.0.0.1:${port}`],
    `the default session must listen on loopback only, OS reports ${listening.join(', ') || 'nothing'}`,
  );

  // And the same port is not reachable on any non-loopback address this machine has.
  const reachable = [];
  for (const address of lanAddresses) {
    if (!(await unreachable(address, port))) reachable.push(address);
  }
  assert.deepEqual(
    reachable,
    [],
    `a default mobile-upload session must not answer on the LAN, but ${reachable.join(', ')} connected`,
  );
  await defaultService.stop();
  assert.equal(defaultService.boundAddress, null);

  // ── 3 · the opt-in is honoured ───────────────────────────────────────────
  const optedIn = new MobileUploadService({
    bindHost: resolveMobileUploadBind({ [MOBILE_UPLOAD_BIND_ENV]: 'lan' }).host,
    uploadDirectory: () => tempDir,
    maxBytes: 1024,
    sessionTtlMs: 5_000,
  });
  assert.equal(optedIn.bindPlan.host, '0.0.0.0');
  assert.equal(optedIn.bindPlan.lan, true);
  const lanSession = await optedIn.createSession('en');
  assert.equal(optedIn.boundAddress, '0.0.0.0', 'the opt-in must reach server.listen');
  assert.ok(lanSession.urls.length >= 1);
  await optedIn.stop();

  console.log(
    `mobile-upload-bind.verify: default binds 127.0.0.1 (${lanAddresses.length} LAN `
    + `address${lanAddresses.length === 1 ? '' : 'es'} refused on the session port), `
    + `"lan" opt-in binds 0.0.0.0, a typo falls back to loopback with a note`,
  );
} finally {
  await defaultService.stop().catch(() => undefined);
  await rm(tempDir, { recursive: true, force: true });
}
