// D6's one server surface: the voice-isolation job route pair.
//
// This replaces `/api/isolate-voice`, which is deleted rather than fenced. That route
// was an FFmpeg `afftdn` spectral gate — the same idea as D2's chain but weaker, with
// no model, and it wrote its artifact into `media/uploads` under a name of its own
// invention. Three things made it the wrong thing to keep:
//
//   * it could not meet the D6 exit test (a spectral gate does not separate music from
//     speech, it attenuates a band), so keeping it would have left two features called
//     "isolate voice" with different quality claims;
//   * it spawned FFmpeg from the request handler, so a cancelled request left an
//     orphaned child — the defect class this slice closes;
//   * it wrote the same clip slot with different semantics, so the inspector had two
//     engines writing `denoisedSrc` and no way to say which one produced the file.
//
// There is deliberately no second `/media/derived` mount here: the read route belongs
// to the derived AREA, not to a feature, and D1's plugin already serves every artifact
// under it.
//
// The source is named by its media-pool upload name, never by a path (same rule as D1
// and D2): a caller cannot point the engine at an arbitrary file on disk.
import type { Plugin } from 'vite';
import { resolveUploadFile } from '../media-dir.ts';
import { startVoiceIsolationMediaJob } from '../media-job-voice-isolation.ts';
import { MediaJobRouteError, registerMediaJobRoutes } from '../media-job-routes.ts';

export const VOICE_ISOLATION_MOUNT = '/api/media-job/voice-isolation';

/**
 * Validate the body and enqueue the job.
 *
 * `sourceName` is required and must resolve inside the media pool. `revision` is
 * optional and only affects the artifact name (a re-import must not hit a stale cache),
 * so it is passed through as a string when present.
 */
export function startVoiceIsolationJobFromBody(body: Record<string, unknown>): {
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
  return startVoiceIsolationMediaJob({
    sourceName,
    sourceFile,
    ...(revision === undefined ? {} : { revision }),
  });
}

export function mediaJobVoiceIsolationPlugin(): Plugin {
  return {
    name: 'openchatcut-media-job-voice-isolation',
    configureServer(server) {
      registerMediaJobRoutes(server, {
        mountPath: VOICE_ISOLATION_MOUNT,
        start: startVoiceIsolationJobFromBody,
      });
    },
  };
}
