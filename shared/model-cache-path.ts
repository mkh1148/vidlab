// I5 · downloaded models are data, not code.
//
// They belong in the storage root the runtime profile resolves — the directory
// `OPENCHATCUT_DATA_DIR` (or the settings pointer file) names — next to the
// projects and the media, so a new build never touches them and the disk budget
// is spent where the owner chose. Before this module the cache was a hidden
// home-directory side channel (`~/.openchatcut/asr-models`) that no data-dir
// setting could redirect; the audit's H3 finding.
//
// Node-only (node:path), like shared/asr-ggml-cache.ts. Keep the resolution
// pure: the profile and the environment are arguments, so a verify can prove
// the behaviour without touching the real home directory.
import { isAbsolute, join, resolve } from 'node:path';

/** Explicit override, for a launch script that pins the cache elsewhere. */
export const MODEL_CACHE_DIR_ENV = 'OPENCHATCUT_MODEL_CACHE_DIR';

/** Directory name inside the storage root. */
export const MODEL_CACHE_DIR_NAME = 'models';

/**
 * Pre-I5 location, kept as a NAME only: `server/model-cache.ts` cold-copies it
 * once on start and then never reads it again. Nothing new may write here.
 */
export function legacyModelCachePath(home: string): string {
  return join(home, '.openchatcut', 'asr-models');
}

/** Model cache inside a storage root (the resolved data directory). */
export function modelCacheDirIn(rootDir: string): string {
  return join(rootDir, MODEL_CACHE_DIR_NAME);
}

/**
 * Resolution order: the explicit environment override, then `<storage root>/models`.
 *
 * The override is deliberately strict (absolute only, no `~` expansion): it is
 * a launch-script decision, and a typo must fail loudly rather than silently
 * land the multi-gigabyte cache somewhere unintended.
 */
export function resolveModelCacheDir(
  profile: { readonly rootDir: string },
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const raw = env[MODEL_CACHE_DIR_ENV]?.trim();
  if (!raw) return modelCacheDirIn(profile.rootDir);
  if (!isAbsolute(raw)) {
    throw new Error(`${MODEL_CACHE_DIR_ENV} must be an absolute path (got: ${raw})`);
  }
  return resolve(raw);
}
