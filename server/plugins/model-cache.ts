import type { Plugin } from 'vite';
import { migrateLegacyModelCache } from '../model-cache.ts';

/**
 * One-time cold copy of the pre-I5 model cache into the data directory (H3).
 *
 * Runs at server start, before the first request, and never blocks startup on a
 * failure: a cache that cannot be copied is re-downloaded on demand, while a
 * server that refuses to start is a daily driver that does not open.
 */
export function modelCachePlugin(): Plugin {
  return {
    name: 'openchatcut-model-cache',
    async configureServer() {
      try {
        await migrateLegacyModelCache();
      } catch (error) {
        console.warn(
          '[model-cache] legacy migration skipped:',
          error instanceof Error ? error.message : error,
        );
      }
    },
  };
}
