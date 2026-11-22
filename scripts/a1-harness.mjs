// Shared harness for the Milestone A1 production-server checks.
//
// Every check runs the REAL production start command (scripts/serve-prod.mjs) as
// a child process on its own port with its own data directory and its own HOME,
// then talks HTTP to it. Nothing here touches the owner's data root or the
// owner's profile: the kit's verification discipline is one test instance per
// check, closed by PID.
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** A port nothing is listening on right now. */
export async function freePort() {
  const probe = createServer();
  await new Promise((done) => probe.listen(0, '127.0.0.1', done));
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  return port;
}

/** A throwaway directory that the caller removes. */
export async function scratchDir(label) {
  return mkdtemp(join(tmpdir(), `vidlab-a1-${label}-`));
}

/**
 * Start the production server and wait for its ready line.
 *
 * Returns the child, its origin and the parsed settings line. The caller MUST
 * call `stop()` — the harness never leaves a listening process behind.
 */
export async function startProdServer({ home, dataDir, port, extraEnv = {}, dist } = {}) {
  const args = ['--import', 'tsx', join(repoRoot, 'scripts', 'serve-prod.mjs'), '--port', String(port)];
  if (dist) args.push('--dist', dist);
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      // Windows reads USERPROFILE, POSIX reads HOME; set both so the profile
      // (pointer file, MCP token, remembered port) is fully isolated.
      USERPROFILE: home,
      HOME: home,
      OPENCHATCUT_DATA_DIR: dataDir,
      // The suite must never inherit a real provider key or a pinned port.
      OPENCHATCUT_PORT: String(port),
      // A machine `.env` pins the editor origin to the daily port; a test server
      // on a free port would then refuse its own requests. Empty means "derive
      // it from the loopback host", which is what a test wants.
      OPENCHATCUT_EDITOR_URL: '',
      OPENCHATCUT_ALLOWED_HOSTS: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let log = '';
  let settings = null;
  const ready = new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => {
      rejectReady(new Error(`production server did not become ready in 120 s:\n${log}`));
    }, 120_000);
    const onData = (chunk) => {
      log += String(chunk);
      const match = log.match(/\[serve-prod\] (\{.*\})/);
      if (match && !settings) {
        settings = JSON.parse(match[1]);
        clearTimeout(timer);
        resolveReady(settings);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      rejectReady(new Error(`production server exited early (${code}):\n${log}`));
    });
  });

  const startSettings = await ready;
  return {
    child,
    port: startSettings.port,
    origin: startSettings.origin,
    settings: startSettings,
    log: () => log,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await new Promise((done) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); }, 10_000);
        child.once('exit', () => { clearTimeout(timer); done(); });
      });
    },
  };
}

/**
 * HTTP request with an explicit Host header, so a test can lie about the name
 * the way a rebinding page does.
 *
 * `fetch` is unusable here: undici treats Host as a forbidden header and drops
 * it, which would make every Host-guard check pass for the wrong reason. Raw
 * `http.request` sends whatever Host it is given.
 */
export async function request(port, path, { host, method = 'GET', headers = {}, body } = {}) {
  const payload = body === undefined
    ? null
    : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  return new Promise((resolveResponse, rejectResponse) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        host: host ?? `127.0.0.1:${port}`,
        ...(payload ? { 'content-length': String(payload.length) } : {}),
        ...headers,
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolveResponse({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: buffer,
          text: () => buffer.toString('utf8'),
        });
      });
    });
    req.on('error', rejectResponse);
    req.setTimeout(120_000, () => req.destroy(new Error(`request timed out: ${method} ${path}`)));
    if (payload) req.write(payload);
    req.end();
  });
}
