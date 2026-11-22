// I5 plumbing for the downloaded model cache (audit H3).
//
// Two jobs, both small:
//   1. one resolver, so every reader (hf-proxy, asr-models, model-packs) agrees
//      on a location inside the storage root instead of a hidden home path;
//   2. a one-time cold copy of the pre-I5 tree, so an install that already
//      downloaded gigabytes does not have to download them again.
//
// The copy is deliberately not a move: the source is the only copy of data the
// owner already paid bandwidth for, and a migration that fails halfway must
// leave it untouched. Idempotence comes from "skip what already exists", so a
// second start copies nothing.
import { constants } from 'node:fs';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import {
  MODEL_CACHE_DIR_ENV,
  legacyModelCachePath,
  resolveModelCacheDir,
} from '../shared/model-cache-path.ts';
import { runtimeProfile, type RuntimeProfile } from './runtime-profile.ts';

/** The model cache root: `<storage root>/models`, or the explicit override. */
export function modelCacheDir(
  profile: RuntimeProfile = runtimeProfile(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return resolveModelCacheDir(profile, env);
}

export type ModelCacheMigrationReason = 'absent' | 'empty' | 'same-directory';

export interface ModelCacheMigration {
  readonly source: string;
  readonly target: string;
  /** Paths relative to the cache root that this run copied. */
  readonly copied: readonly string[];
  /** Paths relative to the cache root that already existed at the target. */
  readonly skipped: readonly string[];
  /** Set when there was nothing to do, so a caller can tell "no-op" from "done". */
  readonly reason?: ModelCacheMigrationReason;
}

/** Every file under `root`, relative to it; null when the directory is absent. */
async function listFiles(root: string): Promise<string[] | null> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await listFiles(full);
      if (nested) files.push(...nested.map((file) => join(entry.name, file)));
      continue;
    }
    if (entry.isFile()) files.push(entry.name);
  }
  return files;
}

/**
 * Copy the pre-I5 model cache into the resolved cache root, once.
 *
 * Copy, never move: the legacy directory is left exactly as it was found. Files
 * that already exist at the target are skipped, never overwritten — the target
 * is the authority, and a half-finished download there must not be replaced by
 * an older copy. Running it twice copies nothing the second time.
 */
export async function migrateLegacyModelCache(options: {
  readonly legacyDir?: string;
  readonly targetDir?: string;
  readonly log?: (message: string) => void;
} = {}): Promise<ModelCacheMigration> {
  const source = options.legacyDir ?? legacyModelCachePath(homedir());
  const target = options.targetDir ?? modelCacheDir();
  const log = options.log ?? ((message: string) => console.log(message));
  const empty = { source, target, copied: [], skipped: [] } as const;
  if (resolve(source) === resolve(target)) return { ...empty, reason: 'same-directory' };

  const files = await listFiles(source);
  if (files === null) return { ...empty, reason: 'absent' };
  if (files.length === 0) return { ...empty, reason: 'empty' };

  const copied: string[] = [];
  const skipped: string[] = [];
  for (const relativePath of files) {
    const destination = join(target, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    try {
      // EXCL: a file that appeared between the listing and the copy is a
      // concurrent download at the target, which wins. Never overwrite.
      await copyFile(join(source, relativePath), destination, constants.COPYFILE_EXCL);
      copied.push(relativePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        skipped.push(relativePath);
        continue;
      }
      throw error;
    }
  }
  if (copied.length > 0) {
    log(
      `[model-cache] cold-copied ${copied.length} file(s) from ${source} to ${target}; `
      + 'the legacy directory is left untouched',
    );
  }
  return { source, target, copied, skipped };
}

/**
 * D-entry guard: the model cache must live inside the configured data
 * directory, so the 5 GB model budget lands where the owner pointed it.
 *
 * An explicit `OPENCHATCUT_MODEL_CACHE_DIR` is the documented escape hatch and
 * is accepted as-is (already validated as absolute by the resolver). A D verify
 * calls this with no arguments and fails loudly on a regression.
 */
export function assertModelCacheUnderDataDir(
  dir: string = modelCacheDir(),
  profile: RuntimeProfile = runtimeProfile(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (env[MODEL_CACHE_DIR_ENV]?.trim()) return dir;
  const root = resolve(profile.rootDir);
  const inside = resolve(dir) === root || resolve(dir).startsWith(`${root}${sep}`);
  if (!inside) {
    throw new Error(
      `the model cache must live inside the data directory (${root}), found ${dir}`,
    );
  }
  return dir;
}
