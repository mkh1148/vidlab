import type { Plugin } from 'vite';
import {
  cleanupStaleExportFiles,
  EXPORT_JOB_RETENTION_MS,
  exportJobResultName,
  unlinkWithRetry,
} from './export-runtime.ts';
import {
  registerGenerationCleanupPolicy,
  registerGenerationRetentionGuard,
} from './generation-jobs.ts';
import { getStoredEntry } from './project-store.ts';
import { isUnresolvedExportRecovery } from './project-store-export-recovery.ts';
import { resolveUploadFile, uploadDir } from '../media-dir.ts';
import { mediaJobDerivedRoot } from '../media-job-artifact.ts';
import { setDerivedDirProvider, setUploadsDirProvider } from './export-rendering.ts';
import {
  registerRenderClipRoute,
  registerRenderStillRoute,
} from './export-render-routes.ts';
import {
  registerExportJobRoute,
  registerExportRoute,
} from './export-job-routes.ts';

export { EXPORT_FPS_OPTIONS, EXPORT_RESOLUTIONS, exportScale, validateVideoParams } from './export-plan.ts';
export type { ExportResolution } from './export-plan.ts';

async function retainUnresolvedExportRecovery(renderId: string): Promise<boolean> {
  const stored = await getStoredEntry(`export-recovery:${renderId}`);
  return stored.found && isUnresolvedExportRecovery(stored.value, renderId);
}

export function exportPlugin(): Plugin {
  registerGenerationCleanupPolicy('server-export', async (result) => {
    const name = exportJobResultName(result.path, result.assetId);
    if (!name) throw new Error(`refusing to clean invalid server export result ${result.path}`);
    const file = resolveUploadFile(name);
    if (file) await unlinkWithRetry(file);
  });
  registerGenerationRetentionGuard('server-export', retainUnresolvedExportRecovery);
  return {
    name: 'openchatcut-export',
    configureServer(server) {
      setUploadsDirProvider(uploadDir);
      // D1: the render page loads a clip's derived picture from the same
      // root-absolute URL the app serves, so the serve bundle needs the derived
      // root linked beside uploads (remotion/serve-bundle.mjs).
      setDerivedDirProvider(mediaJobDerivedRoot);
      const cleanStaleExports = () => cleanupStaleExportFiles(uploadDir(), {
          shouldRetain: retainUnresolvedExportRecovery,
          onError: (path, error) => server.config.logger.warn(
            `[export] failed to clean stale artifact ${path}: ${error instanceof Error ? error.message : String(error)}`,
          ),
        }).then((removed) => {
          if (removed > 0) server.config.logger.info(`[export] removed ${removed} stale export artifact(s)`);
        }).catch((error) => {
          server.config.logger.warn(`[export] stale artifact scan failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      void cleanStaleExports();
      const cleanupTimer = setInterval(() => { void cleanStaleExports(); }, EXPORT_JOB_RETENTION_MS);
      cleanupTimer.unref?.();
      server.httpServer?.once('close', () => clearInterval(cleanupTimer));

      registerRenderStillRoute(server);
      registerRenderClipRoute(server);
      registerExportJobRoute(server);
      registerExportRoute(server);
    },
  };
}
