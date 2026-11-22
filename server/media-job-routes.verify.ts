// The D job transport, exercised over REAL HTTP.
//
// `npx tsx server/media-job-routes.verify.ts`
//
// server/media-job-routes.ts is the route pair every D plugin reuses, so it is
// verified against a real node:http server and real fetch calls rather than by
// calling the handlers directly: the 202/GET/DELETE/wait shapes, the wait clamp,
// the `{error, code}` refusals and the body cap are the contract D1b inherits.
//
// The mount is a connect-style middleware stack, exactly as Vite runs it, so the
// base path is stripped before the handler sees the URL — that path arithmetic is
// the part most likely to break silently.
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ViteDevServer } from 'vite';
import {
  MEDIA_JOB_WAIT_CLAMP_MS,
  MediaJobRouteError,
  registerMediaJobRoutes,
} from './media-job-routes.ts';
import { MediaJobQueue } from './media-job.ts';

const MOUNT = '/api/media-job/route-verify';
const fixture = await mkdtemp(join(tmpdir(), 'vidlab-media-job-routes-'));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

// An isolated registry with a forced roomy reading: the RAM gate reads the real
// machine, and this suite is about the transport, not admission.
const GIB = 1024 ** 3;
const queue = new MediaJobQueue({ concurrency: 1, freeMemoryBytes: () => 8 * GIB });

interface Mounted {
  base: string;
  handler: (req: IncomingMessage, res: ServerResponse) => void;
}

const mounted: Mounted[] = [];
const devServer = {
  middlewares: {
    use(base: string, handler: Mounted['handler']) {
      mounted.push({ base: base.replace(/\/+$/, ''), handler });
    },
  },
  config: { logger: { error() {}, info() {}, warn() {} } },
} as unknown as ViteDevServer;

let jobCounter = 0;
let routeStarts = 0;
let engineRuns = 0;

/** Start a real job on the singleton queue, with a trivial engine. */
function startJob(body: Record<string, unknown>): { jobId: string; deduped: boolean } {
  const sourceName = String(body.sourceName ?? '').trim();
  if (!sourceName) throw new MediaJobRouteError('sourceName is required', 'invalid_argument');
  if (body.explode === true) throw new MediaJobRouteError('engine refused to start', 'engine_unavailable', 503);
  routeStarts += 1;
  const file = join(fixture, `${sourceName}.txt`);
  return queue.start({
    key: `route-verify:${file}`,
    // requiredBytes: 1 keeps the RAM gate out of a transport test; the gate has
    // its own verify.
    requiredBytes: 1,
    target: { file, url: `/media/derived/route-verify/${sourceName}.txt` },
    timeoutMs: 20_000,
    run: async (signal, onProgress) => {
      engineRuns += 1;
      const steps = 10;
      for (let step = 1; step <= steps; step += 1) {
        signal.throwIfAborted();
        await sleep(30);
        onProgress({ progress: step / steps, phase: 'route-verify', detail: { step } });
      }
      await writeFile(file, `route verify ${++jobCounter}\n`, 'utf8');
      return { artifact: { file, url: `/media/derived/route-verify/${sourceName}.txt`, bytes: 20 } };
    },
  });
}

registerMediaJobRoutes(devServer, { mountPath: MOUNT, start: startJob, queue });

const server: Server = createServer((req, res) => {
  const url = req.url ?? '/';
  const path = url.split('?')[0]!;
  const entry = mounted.find((candidate) => (
    path === candidate.base || path.startsWith(`${candidate.base}/`)
  ));
  if (!entry) {
    res.statusCode = 404;
    res.end('not mounted');
    return;
  }
  // connect strips the mount prefix before the handler runs.
  req.url = url.slice(entry.base.length) || '/';
  entry.handler(req, res);
});

await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
const address = server.address();
assert.ok(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}${MOUNT}`;

async function call(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${origin}${path}`, init);
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  return { status: response.status, body };
}

const postJson = (path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> => (
  call(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
);

try {
  // ── POST /jobs → 202 with a job id ────────────────────────────────────────
  const created = await postJson('/jobs', { sourceName: 'route-a' });
  assert.equal(created.status, 202);
  assert.equal(created.body.ok, true);
  assert.equal(typeof created.body.jobId, 'string');
  assert.equal(created.body.deduped, false);
  const jobId = String(created.body.jobId);

  // ── a double start of the same source dedupes through the route ───────────
  const duplicate = await postJson('/jobs', { sourceName: 'route-a' });
  assert.equal(duplicate.status, 202);
  assert.equal(duplicate.body.jobId, jobId, 'the same key reuses the in-flight job');
  assert.equal(duplicate.body.deduped, true);
  assert.equal(routeStarts, 2, 'both clicks reached the route; the queue deduped them');

  // ── GET /jobs/:id → the snapshot ──────────────────────────────────────────
  const polled = await call(`/jobs/${jobId}`);
  assert.equal(polled.status, 200);
  assert.equal(polled.body.jobId, jobId);
  assert.equal(typeof polled.body.progress, 'number');
  assert.equal(polled.body.target !== null, true, 'the destination is known before the job finishes');

  // ── GET /jobs/:id/wait → blocks until terminal, clamped ───────────────────
  const waited = await call(`/jobs/${jobId}/wait?timeoutMs=15000`);
  assert.equal(waited.status, 200);
  assert.equal(waited.body.status, 'completed');
  assert.ok(waited.body.artifact, 'a completed job reports its artifact');
  assert.equal(engineRuns, 1, 'the engine ran ONCE for two clicks: the second was deduped');

  const clamped = await call(`/jobs/${jobId}/wait?timeoutMs=999999999`);
  assert.equal(clamped.status, 200, 'an over-long wait is clamped, not refused');
  assert.equal(MEDIA_JOB_WAIT_CLAMP_MS, 20_000);

  // ── DELETE /jobs/:id → cancel a running job ───────────────────────────────
  const runningId = String((await postJson('/jobs', { sourceName: 'route-cancel' })).body.jobId);
  await sleep(50);
  const cancelled = await call(`/jobs/${runningId}`, { method: 'DELETE' });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, 'cancelled');
  assert.equal(cancelled.body.code, 'job_cancelled');
  assert.equal(cancelled.body.error !== null, true, 'a cancelled job says so in EN');

  // ── refusals are {error, code} with a status ──────────────────────────────
  const missing = await call('/jobs/job_does_not_exist');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'job_not_found');

  const missingWait = await call('/jobs/job_does_not_exist/wait?timeoutMs=10');
  assert.equal(missingWait.status, 404);
  assert.equal(missingWait.body.code, 'job_not_found');

  const unsupported = await call(`/jobs/${jobId}`, { method: 'PUT' });
  assert.equal(unsupported.status, 405);
  assert.equal(unsupported.body.code, 'route_not_supported');

  const badJson = await call('/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(badJson.status, 400);
  assert.equal(badJson.body.code, 'invalid_json');

  const emptyName = await postJson('/jobs', {});
  assert.equal(emptyName.status, 400);
  assert.equal(emptyName.body.code, 'invalid_argument');

  const refused = await postJson('/jobs', { sourceName: 'route-b', explode: true });
  assert.equal(refused.status, 503, 'a start callback can refuse with its own status');
  assert.equal(refused.body.code, 'engine_unavailable');

  const tooBig = await call('/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sourceName: 'x'.repeat(17 * 1024) }),
  });
  assert.equal(tooBig.status, 413);
  assert.equal(tooBig.body.code, 'body_too_large');

  // ── the mount does not answer outside its base path ──────────────────────
  const outside = await fetch(`http://127.0.0.1:${address.port}/api/media-job/other/jobs`);
  assert.equal(outside.status, 404, 'another mount path is not this plugin');

  console.log('media-job routes: 202/GET/wait/DELETE over HTTP, coded refusals, body cap: OK');
} finally {
  queue.reset();
  await new Promise<void>((resolve) => { server.close(() => resolve()); });
  await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
}
