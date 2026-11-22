// Production start: ONE process serves the built editor (dist/) and the whole
// API, reusing the embedded server the desktop app already ships
// (desktop/embedded-server.ts). Nothing here is the dev server — P9 exists
// because a check that only ever passes on Vite says nothing about the build.
//
// Usage (from the repo root, or from a release directory):
//   node --import tsx scripts/serve-prod.mjs [--port 5199] [--dist dist]
//
// Machine settings come from the untracked `.env` (see `.env.example`); real
// environment variables win over the file, so a test or a service wrapper can
// override any key without editing it.
//
// Deliberately absent: any browser launch, any external CLI startup. The
// editor is opened by the owner's browser, not by this process (kit A step 8).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const startedAt = Date.now();

/** Load an env file without letting it override a real environment variable. */
function loadEnvFile(path) {
  if (!existsSync(path)) return false;
  process.loadEnvFile(path);
  return true;
}

// `.env.local` keeps the base's provider keys; `.env` holds this machine's
// service settings. Both are untracked; `.env.example` documents every key.
const loaded = ['.env.local', '.env'].filter((name) => loadEnvFile(join(root, name)));

process.env.NODE_ENV ??= 'production';

function flagValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const portFlag = flagValue('--port');
const port = portFlag !== undefined
  ? Number(portFlag)
  : Number(process.env.OPENCHATCUT_PORT ?? 5199);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`[serve-prod] invalid port: ${portFlag ?? process.env.OPENCHATCUT_PORT}`);
  process.exit(2);
}

const distFlag = flagValue('--dist') ?? process.env.OPENCHATCUT_DIST_DIR ?? 'dist';
const distDir = isAbsolute(distFlag) ? distFlag : resolve(root, distFlag);
if (!existsSync(join(distDir, 'index.html'))) {
  console.error(
    `[serve-prod] no built editor at ${distDir} — run "npm run build" first `
    + '(a dev-server check would hide this, see P9)',
  );
  process.exit(2);
}

const { startEmbeddedServer } = await import('../desktop/embedded-server.ts');
const { runtimeProfile } = await import('../server/runtime-profile.ts');

const profile = runtimeProfile();
// P3 Host allowlist: on unless the machine explicitly turns it off. The switch
// exists so the regression test can show the defect it removes; a daily driver
// never sets it.
const hostGuard = !/^(?:0|false|off|no)$/i.test(process.env.OPENCHATCUT_HOST_GUARD ?? '');
const embedded = await startEmbeddedServer(distDir, { port, hostGuard });
const readyMs = Date.now() - startedAt;

const settings = {
  origin: embedded.origin,
  port: embedded.port,
  dist: distDir,
  dataDir: profile.rootDir,
  mediaDir: profile.mediaDir,
  profile: profile.mode,
  hostGuard,
  envFiles: loaded,
  nodeEnv: process.env.NODE_ENV,
  pid: process.pid,
  readyMs,
};
console.log(`[serve-prod] ready in ${readyMs} ms: ${embedded.origin}`);
console.log(`[serve-prod] ${JSON.stringify(settings)}`);
if (process.env.OPENCHATCUT_READY_FILE) {
  // A service wrapper (A2) waits for this file instead of polling the socket.
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.env.OPENCHATCUT_READY_FILE, `${JSON.stringify(settings)}\n`);
}

const shutdown = (signal) => {
  console.log(`[serve-prod] ${signal}: closing`);
  embedded.server.close(() => process.exit(0));
  // A hung keep-alive socket must not keep the service up forever.
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Keep the process obviously alive and make the log useful for a service log.
process.on('unhandledRejection', (error) => {
  console.error('[serve-prod] unhandled rejection:', error instanceof Error ? error.message : error);
});

// Touch the build so a stale dist is visible in the log next to the version.
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
console.log(`[serve-prod] openchatcut ${version} serving ${distDir}`);
