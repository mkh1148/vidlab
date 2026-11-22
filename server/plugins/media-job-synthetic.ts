// The synthetic D engine, mounted on the shared job transport.
//
// D1a ships this instead of a real matting engine so the job contract is proven
// end to end through the same route pair D1b will use. D1b replaces the engine
// (RVM matting) and keeps `registerMediaJobRoutes` untouched — that is the whole
// point of the scaffold.
import type { Plugin } from 'vite';
import { registerMediaJobRoutes, MediaJobRouteError } from '../media-job-routes.ts';
import { startSyntheticMediaJob, type SyntheticEngine } from '../media-job-synthetic-engine.ts';

export const SYNTHETIC_MEDIA_JOB_MOUNT = '/api/media-job/synthetic';

const ENGINES: readonly SyntheticEngine[] = ['sleep', 'multi-step'];

function numberField(body: Record<string, unknown>, name: string, fallback: number): number {
  const raw = body[name];
  if (raw === undefined || raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new MediaJobRouteError(`${name} must be a non-negative number`, 'invalid_argument');
  }
  return value;
}

/** Validate the body once, here, so the engine never parses untrusted input. */
export function startSyntheticJobFromBody(body: Record<string, unknown>): {
  jobId: string;
  deduped: boolean;
} {
  const sourceName = String(body.sourceName ?? '').trim();
  if (!sourceName) {
    throw new MediaJobRouteError('sourceName is required', 'invalid_argument');
  }
  const engine = String(body.engine ?? 'sleep') as SyntheticEngine;
  if (!ENGINES.includes(engine)) {
    throw new MediaJobRouteError(
      `engine must be one of ${ENGINES.join(', ')}`,
      'invalid_argument',
    );
  }
  return startSyntheticMediaJob({
    sourceName,
    engine,
    steps: numberField(body, 'steps', 4),
    stepMs: numberField(body, 'stepMs', 150),
    crashAfter: numberField(body, 'crashAfter', 0),
  });
}

export function mediaJobSyntheticPlugin(): Plugin {
  return {
    name: 'openchatcut-media-job-synthetic',
    configureServer(server) {
      registerMediaJobRoutes(server, {
        mountPath: SYNTHETIC_MEDIA_JOB_MOUNT,
        start: startSyntheticJobFromBody,
      });
    },
  };
}
