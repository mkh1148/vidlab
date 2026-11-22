// D3a's one server surface: the transcription job route pair.
//
// Same shape as D1's and D2's, and deliberately no second `/media/derived` mount:
// the read route is a property of the DERIVED AREA, so D1's plugin already serves
// this feature's `<sourceKey>/<name>.json`. That matters for apply_artifact, which
// fetches the transcript back through that URL rather than through a private route.
//
// The source is named by its media-pool upload name, never by a path (same rule as
// D1 and D2): a caller cannot point the engine at an arbitrary file on disk.
//
// D-8: this route never consults a cloud provider. `server/plugins/transcription.ts`
// and `transcription-providers.ts` are the base's cloud path and stay untouched; this
// is the local engine's own mount.
import type { Plugin } from 'vite';
import { startTranscriptionMediaJob, isTranscriptionModelTier, TRANSCRIPTION_MODEL_TIERS } from '../media-job-transcription.ts';
import { MediaJobRouteError, registerMediaJobRoutes } from '../media-job-routes.ts';
import { resolveUploadFile } from '../media-dir.ts';

export const TRANSCRIPTION_MOUNT = '/api/media-job/transcription';

/** ISO-639-1 (optionally regioned) or `auto` — the same grammar the cloud route uses. */
const LANGUAGE = /^(?:auto|[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/;

/**
 * Validate the body and enqueue the job.
 *
 * `model` is a catalog tier, not a path and not a free string: a caller that asked
 * for `small` and silently got `base` would get a transcript whose accuracy it
 * cannot reason about. `language` is part of the cache identity, so `auto` and `en`
 * are two artifacts, not one.
 */
export function startTranscriptionJobFromBody(body: Record<string, unknown>): {
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
  const model = body.model === undefined || body.model === null || body.model === ''
    ? undefined
    : String(body.model);
  if (model !== undefined && !isTranscriptionModelTier(model)) {
    throw new MediaJobRouteError(
      `unknown transcription model ${model} (use ${TRANSCRIPTION_MODEL_TIERS.join(', ')})`,
      'unknown_model_tier',
    );
  }
  const language = body.language === undefined || body.language === null || body.language === ''
    ? undefined
    : String(body.language).trim();
  if (language !== undefined && !LANGUAGE.test(language)) {
    throw new MediaJobRouteError(
      'language must be an ISO language code or auto',
      'invalid_language',
    );
  }
  return startTranscriptionMediaJob({
    sourceName,
    sourceFile,
    ...(revision === undefined ? {} : { revision }),
    ...(model === undefined ? {} : { tier: model }),
    ...(language === undefined ? {} : { language }),
  });
}

export function mediaJobTranscriptionPlugin(): Plugin {
  return {
    name: 'openchatcut-media-job-transcription',
    configureServer(server) {
      registerMediaJobRoutes(server, {
        mountPath: TRANSCRIPTION_MOUNT,
        start: startTranscriptionJobFromBody,
      });
    },
  };
}
