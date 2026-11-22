// D4's four server surfaces: persist an analysis, read it back, serve the model,
// and forget one.
//
// Why a plain route pair rather than the media-job transport: the analyze pass runs
// in the renderer, because the MediaPipe runtime needs a DOM canvas and Node has
// none (probe and reasoning in docs/d-job-implementation.md §D4). What the server
// owns is the ARTIFACT — the same per-source directory, namer and URL shape D1 and
// D3a use — so this route is a writer for that directory, not a job.
//
// The route is narrow on purpose, like the derived read route beside it:
//
//   * the source is named by its media-pool upload name, never a path;
//   * the body is capped before it is parsed, so a bad caller cannot allocate;
//   * every refusal is `{error, code}` with a status, so a caller never parses prose;
//   * reads and writes require the local editor credential (a derived artifact is
//     the user's footage).
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin, ViteDevServer } from 'vite';
import { editorCredentialAuthorized } from '../editor-auth.ts';
import {
  FaceAnalysisError,
  readFaceAnalysis,
  removeFaceAnalysisFiles,
  writeFaceAnalysis,
  type FaceAnalysisIdentity,
} from '../face-analysis.ts';
import { ensureFaceModel, FACE_MODEL_FILE } from '../face-model.ts';
import { resolveUploadFile } from '../media-dir.ts';

export const FACE_ANALYSIS_MOUNT = '/api/media-job/face-analysis';
export const FACE_MODEL_MOUNT = '/api/media-job/face-model';

/**
 * Body cap. A 65-sample track is ~4 KB and a 1024x1152 grayscale PNG is well under
 * 2 MB; base64 inflates by a third. 24 MB accepts every honest payload and refuses
 * a caller that is not sending an atlas at all.
 */
const MAX_BODY_BYTES = 24 * 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let refused = false;
    req.on('data', (chunk: Buffer) => {
      if (refused) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        refused = true;
        chunks.length = 0;
        reject(new FaceAnalysisError('request body too large', 'body_too_large', 413));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!refused) resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

/** The analysis identity from a query string or a body; refusals are explicit. */
function identityOf(input: Record<string, unknown>): FaceAnalysisIdentity {
  const sourceName = String(input.sourceName ?? '').trim();
  if (!sourceName) {
    throw new FaceAnalysisError('sourceName is required (the upload name of the source clip)', 'invalid_argument');
  }
  const analysisFps = Number(input.analysisFps);
  if (!Number.isFinite(analysisFps) || analysisFps <= 0 || analysisFps > 60) {
    throw new FaceAnalysisError('analysisFps must be a positive number of samples per second', 'invalid_argument');
  }
  const cell = Number(input.cell);
  if (!Number.isFinite(cell) || cell < 8 || cell > 512) {
    throw new FaceAnalysisError('cell must be the atlas cell edge in pixels (8..512)', 'invalid_argument');
  }
  const revision = input.revision === undefined || input.revision === null || input.revision === ''
    ? undefined
    : String(input.revision);
  return { sourceName, analysisFps, cell, ...(revision === undefined ? {} : { revision }) };
}

/** Refuse a source that is not in the media pool: the artifact is keyed by it. */
function requirePoolSource(sourceName: string): void {
  if (!resolveUploadFile(sourceName)) {
    throw new FaceAnalysisError(`source not found in the media pool: ${sourceName}`, 'source_not_found', 404);
  }
}

async function handleAnalysis(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!editorCredentialAuthorized(req, req.method === 'POST' || req.method === 'DELETE')) {
    req.resume();
    sendJson(res, 403, { error: 'local editor request required', code: 'forbidden' });
    return;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'GET') {
    const identity = identityOf(Object.fromEntries(url.searchParams.entries()));
    const artifacts = await readFaceAnalysis(identity);
    if (!artifacts) {
      sendJson(res, 404, {
        error: 'no face analysis is cached for this source and these options',
        code: 'face_analysis_absent',
      });
      return;
    }
    sendJson(res, 200, { ok: true, ...artifacts });
    return;
  }
  if (req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}') as Record<string, unknown>;
    const identity = identityOf(body);
    requirePoolSource(identity.sourceName);
    const atlasBase64 = String(body.atlasPng ?? '');
    if (!atlasBase64) {
      throw new FaceAnalysisError('atlasPng is required (base64 of the skin-mask atlas)', 'invalid_argument');
    }
    const artifacts = await writeFaceAnalysis({
      identity,
      track: body.track,
      atlasPng: Buffer.from(atlasBase64, 'base64'),
    });
    sendJson(res, 200, { ok: true, ...artifacts });
    return;
  }
  if (req.method === 'DELETE') {
    const identity = identityOf(Object.fromEntries(url.searchParams.entries()));
    await removeFaceAnalysisFiles(identity);
    sendJson(res, 200, { ok: true, removed: true });
    return;
  }
  sendJson(res, 405, { error: `unsupported face analysis route: ${req.method}`, code: 'route_not_supported' });
}

async function handleModel(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'method not allowed', code: 'route_not_supported' });
    return;
  }
  if (!editorCredentialAuthorized(req, false)) {
    req.resume();
    sendJson(res, 403, { error: 'local editor request required', code: 'forbidden' });
    return;
  }
  const location = await ensureFaceModel();
  const { readFile } = await import('node:fs/promises');
  const bytes = await readFile(location.file);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(bytes.length));
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('X-Model-File', FACE_MODEL_FILE);
  res.setHeader('X-Model-Sha256', location.sha256);
  if (req.method === 'HEAD') res.end();
  else res.end(bytes);
}

function mount(server: ViteDevServer, path: string, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>): void {
  server.middlewares.use(path, (req, res) => {
    void handler(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof FaceAnalysisError ? error.code : 'face_analysis_failed';
      const status = error instanceof FaceAnalysisError ? error.status : 500;
      if (status >= 500) server.config.logger.error(`[face-analysis] ${message}`);
      if (!res.headersSent) sendJson(res, status, { error: message, code });
      else res.end();
    });
  });
}

export function mediaJobFacePlugin(): Plugin {
  return {
    name: 'openchatcut-media-job-face',
    configureServer(server) {
      mount(server, FACE_ANALYSIS_MOUNT, handleAnalysis);
      mount(server, FACE_MODEL_MOUNT, handleModel);
    },
  };
}
