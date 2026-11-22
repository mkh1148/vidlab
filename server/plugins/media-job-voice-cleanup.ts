// D2's one server surface: the voice-clean-up job route pair.
//
// There is deliberately no second `/media/derived` mount here. The read route is a
// property of the DERIVED AREA, not of a feature, so D1's plugin already serves every
// artifact under it — including this feature's `<sourceKey>/<name>.wav`. Mounting it
// twice would register two middlewares for one URL prefix and the second would never
// run; worse, it would look like the D2 artifact needed its own reader, which would
// invite a second path guard to drift from the first.
//
// The source is named by its media-pool upload name, never by a path (same rule as D1):
// a caller cannot point the engine at an arbitrary file on disk.
import type { Plugin } from 'vite';
import { startVoiceCleanupMediaJob } from '../media-job-voice-cleanup.ts';
import { MediaJobRouteError, registerMediaJobRoutes } from '../media-job-routes.ts';
import { resolveUploadFile } from '../media-dir.ts';

export const VOICE_CLEANUP_MOUNT = '/api/media-job/voice-cleanup';

/**
 * Validate the body and enqueue the job.
 *
 * `sourceName` is required and must resolve inside the media pool. `revision` is
 * optional and only affects the artifact name (a re-import must not hit a stale cache),
 * so it is passed through as a string when present.
 */
export function startVoiceCleanupJobFromBody(body: Record<string, unknown>): {
  jobId: string;
  deduped: boolean;
} {
  const sourceName = String(body.sourceName ?? '').trim();
  if (!sourceName) {
    throw new MediaJobRouteError(
      'sourceName is required (the upload name of the source clip)',
      'invalid_argument',
    );
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
  return startVoiceCleanupMediaJob({
    sourceName,
    sourceFile,
    ...(revision === undefined ? {} : { revision }),
  });
}

export function mediaJobVoiceCleanupPlugin(): Plugin {
  return {
    name: 'openchatcut-media-job-voice-cleanup',
    configureServer(server) {
      registerMediaJobRoutes(server, {
        mountPath: VOICE_CLEANUP_MOUNT,
        start: startVoiceCleanupJobFromBody,
      });
    },
  };
}
