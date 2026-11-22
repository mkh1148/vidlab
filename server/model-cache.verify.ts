// I5 regression: the downloaded model cache lives in the data directory, and
// the pre-I5 tree is cold-copied once (audit H3).
//
// Everything here runs against synthetic locations: a throwaway "home" and a
// throwaway data directory. The real ~/.openchatcut tree is never read, written
// or migrated by this verify.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { legacyModelCachePath, modelCacheDirIn, resolveModelCacheDir } from '../shared/model-cache-path.ts';
import {
  assertModelCacheUnderDataDir,
  migrateLegacyModelCache,
  modelCacheDir,
} from './model-cache.ts';
import { resolveRuntimeProfile } from './runtime-profile.ts';

const fixture = await mkdtemp(join(tmpdir(), 'openchatcut-model-cache-'));
const homeDir = join(fixture, 'home');
const dataDir = join(fixture, 'vidlab-data');
const cwd = join(fixture, 'checkout');

try {
  // ── 1. the default root is the data directory ─────────────────────────────
  const profile = resolveRuntimeProfile(
    { OPENCHATCUT_DATA_DIR: dataDir },
    { homeDir, cwd },
  );
  assert.equal(profile.rootDir, dataDir, 'the profile root IS the configured data directory');
  const cacheDir = modelCacheDir(profile, {});
  assert.equal(cacheDir, join(dataDir, 'models'));
  assert.ok(cacheDir.startsWith(dataDir), 'the model cache must start with the data directory');
  assert.equal(modelCacheDirIn(dataDir), cacheDir, 'one namer for the cache root');

  // Without a configured data dir the cache still follows the profile root
  // instead of a hidden home side channel of its own.
  const defaultProfile = resolveRuntimeProfile({}, { homeDir, cwd });
  assert.equal(modelCacheDir(defaultProfile, {}), join(homeDir, '.openchatcut', 'models'));
  assert.notEqual(
    modelCacheDir(defaultProfile, {}),
    legacyModelCachePath(homeDir),
    'the legacy asr-models directory is no longer the cache root',
  );

  // ── 2. the explicit override wins, and must be absolute ───────────────────
  const pinned = join(fixture, 'pinned-models');
  assert.equal(modelCacheDir(profile, { OPENCHATCUT_MODEL_CACHE_DIR: pinned }), pinned);
  assert.equal(modelCacheDir(profile, { OPENCHATCUT_MODEL_CACHE_DIR: `  ${pinned}  ` }), pinned);
  assert.equal(modelCacheDir(profile, { OPENCHATCUT_MODEL_CACHE_DIR: '' }), cacheDir, 'an empty override is not an override');
  assert.throws(
    () => resolveModelCacheDir(profile, { OPENCHATCUT_MODEL_CACHE_DIR: 'relative/models' }),
    /must be an absolute path/,
    'a relative override must fail loudly rather than land somewhere unintended',
  );

  // ── 3. the D-entry assertion helper ───────────────────────────────────────
  assert.equal(assertModelCacheUnderDataDir(cacheDir, profile, {}), cacheDir);
  assert.throws(
    () => assertModelCacheUnderDataDir(join(fixture, 'elsewhere', 'models'), profile, {}),
    /must live inside the data directory/,
    'a cache outside the data directory must fail the D-entry guard',
  );
  assert.throws(
    () => assertModelCacheUnderDataDir(join(dataDir, '..', 'sibling', 'models'), profile, {}),
    /must live inside the data directory/,
    'a sibling of the data directory is not inside it',
  );
  assert.equal(
    assertModelCacheUnderDataDir(pinned, profile, { OPENCHATCUT_MODEL_CACHE_DIR: pinned }),
    pinned,
    'the documented override is accepted by the guard',
  );

  // ── 4. the one-time legacy migration ──────────────────────────────────────
  const legacy = legacyModelCachePath(homeDir);
  await mkdir(join(legacy, 'ggerganov', 'whisper.cpp'), { recursive: true });
  await mkdir(join(legacy, 'ggml'), { recursive: true });
  await writeFile(join(legacy, 'ggml', 'ggml-base.bin'), 'base-model-bytes');
  await writeFile(join(legacy, 'ggerganov', 'whisper.cpp', 'config.json'), '{"a":1}');
  await writeFile(join(legacy, 'top-level.bin'), 'top');

  const logs: string[] = [];
  const first = await migrateLegacyModelCache({
    legacyDir: legacy,
    targetDir: cacheDir,
    log: (message) => logs.push(message),
  });
  assert.equal(first.reason, undefined, 'a non-empty legacy tree is migrated');
  assert.deepEqual([...first.copied].sort(), [
    join('ggml', 'ggml-base.bin'),
    join('ggerganov', 'whisper.cpp', 'config.json'),
    'top-level.bin',
  ].sort());
  assert.deepEqual(first.skipped, []);
  assert.equal(logs.length, 1, 'the migration logs once');
  assert.match(logs[0]!, /cold-copied 3 file\(s\)/);
  assert.match(logs[0]!, /left untouched/);

  // Cold copy: contents arrive AND the source is still there, byte for byte.
  assert.equal(await readFile(join(cacheDir, 'ggml', 'ggml-base.bin'), 'utf8'), 'base-model-bytes');
  assert.equal(await readFile(join(cacheDir, 'ggerganov', 'whisper.cpp', 'config.json'), 'utf8'), '{"a":1}');
  assert.equal(await readFile(join(legacy, 'ggml', 'ggml-base.bin'), 'utf8'), 'base-model-bytes');
  assert.equal(await readFile(join(legacy, 'top-level.bin'), 'utf8'), 'top');

  // Idempotent: a second start copies nothing and overwrites nothing.
  const second = await migrateLegacyModelCache({
    legacyDir: legacy,
    targetDir: cacheDir,
    log: (message) => logs.push(message),
  });
  assert.deepEqual(second.copied, [], 'a second run must copy nothing');
  assert.equal(second.skipped.length, 3, 'every file already exists at the target');
  assert.equal(logs.length, 1, 'a no-op run does not log');

  // The target is the authority: an existing file is never replaced by the copy.
  await writeFile(join(cacheDir, 'top-level.bin'), 'newer-download');
  const third = await migrateLegacyModelCache({
    legacyDir: legacy,
    targetDir: cacheDir,
    log: (message) => logs.push(message),
  });
  assert.deepEqual(third.copied, []);
  assert.equal(await readFile(join(cacheDir, 'top-level.bin'), 'utf8'), 'newer-download');

  // Nothing to do is reported, not guessed at.
  const absent = await migrateLegacyModelCache({
    legacyDir: join(fixture, 'no-such-legacy'),
    targetDir: cacheDir,
    log: (message) => logs.push(message),
  });
  assert.equal(absent.reason, 'absent');
  assert.deepEqual(absent.copied, []);
  const emptyLegacy = join(fixture, 'empty-legacy');
  await mkdir(emptyLegacy, { recursive: true });
  const empty = await migrateLegacyModelCache({
    legacyDir: emptyLegacy,
    targetDir: cacheDir,
    log: (message) => logs.push(message),
  });
  assert.equal(empty.reason, 'empty');
  const same = await migrateLegacyModelCache({
    legacyDir: cacheDir,
    targetDir: cacheDir,
    log: (message) => logs.push(message),
  });
  assert.equal(same.reason, 'same-directory', 'an override pointing at the legacy tree must not copy onto itself');

  // ── 5. the migration only ever writes inside the resolved cache root ──────
  // A data dir that does not exist yet is created by the copy, not required.
  const freshDataDir = join(fixture, 'fresh-data');
  const freshProfile = resolveRuntimeProfile(
    { OPENCHATCUT_DATA_DIR: freshDataDir },
    { homeDir, cwd },
  );
  const freshTarget = modelCacheDir(freshProfile, {});
  await assert.rejects(stat(freshTarget), { code: 'ENOENT' });
  const fresh = await migrateLegacyModelCache({
    legacyDir: legacy,
    targetDir: freshTarget,
    log: (message) => logs.push(message),
  });
  assert.equal(fresh.copied.length, 3);
  assert.equal(await readFile(join(freshTarget, 'ggml', 'ggml-base.bin'), 'utf8'), 'base-model-bytes');
} finally {
  await rm(fixture, { recursive: true, force: true });
}

console.log('model cache checks passed');
