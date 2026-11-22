// D1's two server surfaces: the matting job route pair, and the read route that
// makes a derived artifact playable.
//
// Why the read route exists at all: a matte is the clip's PICTURE, and the render
// stack loads pictures through a media URL (`/media/derived/...`). Without a
// server route the browser would have to read the file itself, which it cannot —
// the artifact lives in the data directory, not under the Vite public root.
//
// The route is deliberately narrow (reviewer condition C1):
//
//   * exactly two path segments, `<sourceKey>/<encodeURIComponent(name)>`, which
//     is the only shape `mediaJobArtifactLocation` ever produces;
//   * the resolved path must stay strictly inside `mediaJobDerivedRoot`, so a
//     `..` or an encoded separator cannot walk out;
//   * no listing: a directory request is a 404, never an index;
//   * the same local-editor read gate as `/media/uploads` (loopback + local Host),
//     because a derived artifact is the user's footage.
import { stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { editorCredentialAuthorized } from '../editor-auth.ts';
import { mediaJobDerivedRoot } from '../media-job-artifact.ts';
import {
  MEDIA_JOB_DERIVED_URL_PREFIX,
} from '../media-job-artifact.ts';
import {
  MediaJobRouteError,
  registerMediaJobRoutes,
} from '../media-job-routes.ts';
import { startBackgroundRemovalMediaJob } from '../media-job-background-removal.ts';
import { resolveUploadFile } from '../media-dir.ts';
import { serveDiskFile } from '../media-dir.ts';

export const BACKGROUND_REMOVAL_MOUNT = '/api/media-job/background-removal';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

/**
 * Validate the body and enqueue the job. The source is named by its media-pool
 * upload name — never by a path, so a caller cannot point the engine at an
 * arbitrary file on disk.
 */
export function startBackgroundRemovalJobFromBody(body: Record<string, unknown>): {
  jobId: string;
  deduped: boolean;
} {
  const sourceName = String(body.sourceName ?? '').trim();
  if (!sourceName) {
    throw new MediaJobRouteError('sourceName is required (the upload name of the source clip)', 'invalid_argument');
  }
  const sourceFile = resolveUploadFile(sourceName);
  if (!sourceFile) {
    throw new MediaJobRouteError(
      `source not found in the media pool: ${sourceName}`,
      'source_not_found',
      404,
    );
  }
  const revision = body.revision === undefined || body.revision === null
    ? undefined
    : String(body.revision);
  const ratioRaw = Number(body.ratio);
  const ratio = Number.isFinite(ratioRaw) && ratioRaw > 0 && ratioRaw <= 1 ? ratioRaw : undefined;
  return startBackgroundRemovalMediaJob({
    sourceName,
    sourceFile,
    ...(revision === undefined ? {} : { revision }),
    ...(ratio === undefined ? {} : { ratio }),
  });
}

/**
 * Serve `/media/derived/<sourceKey>/<name>`.
 *
 * The two-segment rule is the whole guard: `mediaJobArtifactLocation` produces
 * exactly that shape, so anything else is a request the app never makes.
 */
async function handleDerivedRead(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    next();
    return;
  }
  if (!editorCredentialAuthorized(req, false)) {
    req.resume();
    sendJson(res, 403, { error: 'local editor request required', code: 'forbidden' });
    return;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  const raw = url.pathname.split('/').filter((part) => part.length > 0);
  let segments: string[];
  try {
    segments = raw.map((part) => decodeURIComponent(part));
  } catch {
    sendJson(res, 400, { error: 'artifact path is not valid percent-encoding', code: 'invalid_artifact_url' });
    return;
  }
  if (segments.length !== 2) {
    // No listing, and no deeper tree: the layout is exactly one directory deep.
    sendJson(res, 404, {
      error: 'derived artifacts live at /media/derived/<sourceKey>/<name>',
      code: 'invalid_artifact_url',
    });
    return;
  }
  const [sourceKey, name] = segments as [string, string];
  if (!sourceKey || !name || sourceKey === '.' || sourceKey === '..' || name === '.' || name === '..'
    || sourceKey.includes('/') || sourceKey.includes('\\') || name.includes('/') || name.includes('\\')) {
    sendJson(res, 400, { error: 'artifact path is not a plain file name', code: 'invalid_artifact_url' });
    return;
  }
  const root = resolve(mediaJobDerivedRoot());
  const file = resolve(root, sourceKey, name);
  if (!file.startsWith(`${root}${sep}`)) {
    sendJson(res, 400, { error: 'artifact path escapes the derived media area', code: 'invalid_artifact_url' });
    return;
  }
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) {
    sendJson(res, 404, { error: `derived artifact not found: ${sourceKey}/${name}`, code: 'artifact_not_found' });
    return;
  }
  await serveDiskFile(req, res, file);
}

export function mediaJobBackgroundRemovalPlugin(): Plugin {
  return {
    name: 'openchatcut-media-job-background-removal',
    configureServer(server) {
      registerMediaJobRoutes(server, {
        mountPath: BACKGROUND_REMOVAL_MOUNT,
        start: startBackgroundRemovalJobFromBody,
      });
      server.middlewares.use(MEDIA_JOB_DERIVED_URL_PREFIX, (req, res, next) => {
        void handleDerivedRead(req, res, next).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[media-derived] ${message}`);
          if (!res.headersSent) sendJson(res, 500, { error: 'derived media read failed', code: 'read_failed' });
          else res.end();
        });
      });
    },
  };
}
