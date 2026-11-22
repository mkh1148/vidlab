// The D job transport: one route pair every D plugin reuses.
//
// Why server-side and not through the browser bridge: start_job and poll_job are
// SESSIONLESS media operations. Routing them through the editor would make the
// browser a fragility point for work that does not need it — a closed tab would
// strand a running matte — and the browser bridge already caps every call at
// 180 s by construction (broker.ts), so a long synchronous call cannot work
// anyway. The async 202/GET/DELETE shape is the one scene-detection already runs
// in production (server/plugins/scene-detection.ts), so this helper is that
// pattern extracted, not a new protocol.
//
// Only apply_artifact goes through the command core, because only apply_artifact
// mutates the project.
//
// Every response is `{error, code}` on failure (D-job contract, S1): a caller
// never has to parse prose to branch.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ViteDevServer } from 'vite';
import {
  mediaJobs,
  type MediaJobQueue,
  type MediaJobSnapshot,
} from './media-job.ts';

const MAX_JSON = 16 * 1024;

/**
 * Wait clamp for the poll route. Far below the broker's 180 s call cap and the
 * 45 s MCP wait clamp: a poll is a short call, and a caller that needs longer
 * re-issues.
 */
export const MEDIA_JOB_WAIT_CLAMP_MS = 20_000;

export interface MediaJobRouteStartResult {
  readonly jobId: string;
  readonly deduped: boolean;
}

export interface MediaJobRouteOptions {
  /** Mount path, e.g. `/api/media-job/synthetic`. No trailing slash. */
  readonly mountPath: string;
  /** Validate the body and enqueue the job; throw `MediaJobRouteError` to refuse. */
  readonly start: (body: Record<string, unknown>) => MediaJobRouteStartResult | Promise<MediaJobRouteStartResult>;
  /**
   * Registry to read and cancel through. Defaults to the process-wide queue; a
   * caller injects one only when it needs an isolated registry (the transport
   * verify does, because the RAM gate reads the real machine).
   */
  readonly queue?: MediaJobQueue;
}

/** A refusal a route can translate into `{error, code}` with a status. */
export class MediaJobRouteError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status = 400) {
    super(message);
    this.name = 'MediaJobRouteError';
    this.code = code;
    this.status = status;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      // Drain and discard the rest of an oversized body instead of destroying the
      // socket: a destroyed socket reaches the caller as a transport error, and
      // the whole point of {error, code} is that a refusal is readable.
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_JSON) {
        tooLarge = true;
        chunks.length = 0;
        reject(new MediaJobRouteError('request body too large', 'body_too_large', 413));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : {});
      } catch {
        reject(new MediaJobRouteError('request body is not JSON', 'invalid_json', 400));
      }
    });
    req.on('error', reject);
  });
}

/** A snapshot as a route returns it: the job fields plus `ok`. */
export function mediaJobPayload(snapshot: MediaJobSnapshot): Record<string, unknown> {
  return { ok: snapshot.status !== 'failed', ...snapshot };
}

/** 404 body for an unknown job id, shared by every D route. */
export function mediaJobNotFound(jobId: string): { error: string; code: string } {
  return { error: `media job not found: ${jobId}`, code: 'job_not_found' };
}

/**
 * Mount `<mountPath>/jobs` (POST), `<mountPath>/jobs/<id>` (GET, DELETE) and
 * `<mountPath>/jobs/<id>/wait` (GET).
 */
export function registerMediaJobRoutes(server: ViteDevServer, options: MediaJobRouteOptions): void {
  const base = options.mountPath.replace(/\/+$/, '');
  server.middlewares.use(base, (req, res) => {
    void handle(req, res, options).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof MediaJobRouteError ? error.code : 'job_route_failed';
      const status = error instanceof MediaJobRouteError ? error.status : 500;
      if (status >= 500) server.config.logger.error(`[media-job] ${message}`);
      if (!res.headersSent) sendJson(res, status, { error: message, code });
      else res.end();
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  options: MediaJobRouteOptions,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const method = (req.method ?? 'GET').toUpperCase();
  const queue = options.queue ?? mediaJobs;

  if (pathname === '/jobs' && method === 'POST') {
    const body = await readJson(req);
    const started = await options.start(body);
    const snapshot = queue.poll(started.jobId);
    sendJson(res, 202, {
      ok: true,
      jobId: started.jobId,
      deduped: started.deduped,
      status: snapshot?.status ?? 'queued',
    });
    return;
  }

  const waitMatch = pathname.match(/^\/jobs\/([^/]+)\/wait$/);
  if (waitMatch && method === 'GET') {
    const jobId = decodeURIComponent(waitMatch[1]!);
    const requested = Number(url.searchParams.get('timeoutMs'));
    const timeoutMs = Number.isFinite(requested) && requested > 0
      ? Math.min(MEDIA_JOB_WAIT_CLAMP_MS, requested)
      : MEDIA_JOB_WAIT_CLAMP_MS;
    const snapshot = await queue.wait(jobId, timeoutMs);
    if (!snapshot) {
      sendJson(res, 404, mediaJobNotFound(jobId));
      return;
    }
    sendJson(res, 200, mediaJobPayload(snapshot));
    return;
  }

  const jobMatch = pathname.match(/^\/jobs\/([^/]+)$/);
  if (jobMatch && (method === 'GET' || method === 'DELETE')) {
    const jobId = decodeURIComponent(jobMatch[1]!);
    const snapshot = method === 'DELETE' ? queue.cancel(jobId) : queue.poll(jobId);
    if (!snapshot) {
      sendJson(res, 404, mediaJobNotFound(jobId));
      return;
    }
    sendJson(res, 200, mediaJobPayload(snapshot));
    return;
  }

  sendJson(res, 405, {
    error: `unsupported media job route: ${method} ${pathname}`,
    code: 'route_not_supported',
  });
}
