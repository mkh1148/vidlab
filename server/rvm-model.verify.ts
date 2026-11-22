// D1b: the matting model is one pinned file, resolved inside the data directory,
// verified by size AND hash on every use.
//
// Everything here is hermetic: a throwaway home, a throwaway data directory, and
// an injected download. The verify never touches the network, the real
// ~/.openchatcut tree, or the real vidlab-data. The 15 MB weights are replaced by
// a three-byte descriptor so the reuse/refuse logic is provable in milliseconds.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { sha256File } from '../shared/node-content-hash.ts';
import { isolateVerifyHome } from '../shared/verify-home.ts';
import { assertModelCacheUnderDataDir, modelCacheDir } from './model-cache.ts';
import {
  RVM_ENGINE_VERSION,
  RVM_MODEL,
  RVM_MODEL_DIR,
  RvmModelError,
  ensureRvmModel,
  rvmModelPath,
  rvmModelTarget,
  verifyModelFile,
  type RvmModelDescriptor,
} from './rvm-model.ts';
import { resolveRuntimeProfile } from './runtime-profile.ts';
import type { downloadModelFile } from './plugins/hf-proxy.ts';

const fixture = await mkdtemp(join(tmpdir(), 'openchatcut-rvm-model-'));
const homeDir = join(fixture, 'home');
const dataDir = join(fixture, 'vidlab-data');
const restoreHome = isolateVerifyHome(homeDir);
const previousOverride = process.env.OPENCHATCUT_MODEL_CACHE_DIR;
// The cache override would move the resolver out of the data directory; this
// suite proves the data-directory path, so the override is removed for the run.
delete process.env.OPENCHATCUT_MODEL_CACHE_DIR;

try {
  const profile = resolveRuntimeProfile({ OPENCHATCUT_DATA_DIR: dataDir }, { homeDir, cwd: fixture });

  // ── 1. the pinned descriptor is a contract, not a comment ─────────────────
  assert.equal(RVM_ENGINE_VERSION, 'rvm-mobilenetv3-v1', 'the engine version names the model AND the recipe');
  assert.equal(RVM_MODEL.filePath, 'rvm_mobilenetv3_fp32.onnx');
  assert.equal(RVM_MODEL.bytes, 14_975_696, 'the pinned size is the one the mirror serves');
  assert.match(RVM_MODEL.sha256, /^[0-9a-f]{64}$/, 'the pin is a full sha256');
  assert.equal(RVM_MODEL.licence, 'GPL-3.0', 'the weights are GPL-3.0 upstream (the mirror card is not authoritative)');
  assert.match(RVM_MODEL.mirrorLicenceClaim, /not authoritative/, 'the mirror claim is recorded as a claim');
  assert.deepEqual(
    [...RVM_MODEL.inputs],
    ['src', 'r1i', 'r2i', 'r3i', 'r4i', 'downsample_ratio'],
    'RVM is recurrent: four state inputs plus the frame and the ratio',
  );
  assert.deepEqual([...RVM_MODEL.outputs], ['fgr', 'pha', 'r1o', 'r2o', 'r3o', 'r4o']);
  assert.deepEqual(rvmModelTarget(), {
    modelId: RVM_MODEL.modelId,
    revision: RVM_MODEL.revision,
    filePath: RVM_MODEL.filePath,
  }, 'the download target is derived from the pin, never hand-typed');

  // ── 2. the resolved path lives inside the data directory (I5 + D-entry) ───
  const cacheDir = modelCacheDir(profile, {});
  assert.equal(cacheDir, join(dataDir, 'models'));
  const modelPath = rvmModelPath(profile);
  assert.equal(modelPath, join(cacheDir, RVM_MODEL_DIR, RVM_MODEL.filePath));
  assert.ok(modelPath.startsWith(dataDir), 'the weights land in the data directory, not a hidden home path');
  assert.equal(assertModelCacheUnderDataDir(dirname(modelPath), profile, {}), dirname(modelPath));
  assert.throws(
    () => assertModelCacheUnderDataDir(join(fixture, 'elsewhere', 'models', 'rvm'), profile, {}),
    /must live inside the data directory/,
    'a model directory outside the data directory must fail the D-entry guard',
  );

  // ── 3. verifyModelFile: size first, then hash, both coded ─────────────────
  const fakeDir = join(fixture, 'fake-models');
  await mkdir(fakeDir, { recursive: true });
  const fakeFile = join(fakeDir, 'fake.bin');
  await writeFile(fakeFile, 'abc');
  const fake: RvmModelDescriptor = {
    ...RVM_MODEL,
    filePath: 'fake.bin',
    bytes: 3,
    sha256: await sha256File(fakeFile),
  };
  assert.deepEqual(await verifyModelFile(fakeFile, fake), { bytes: 3, sha256: fake.sha256 });

  await assert.rejects(
    () => verifyModelFile(fakeFile, { ...fake, bytes: 4 }),
    (error: unknown) => error instanceof RvmModelError
      && error.code === 'model_size_mismatch'
      && /has 3 bytes, expected 4/.test(error.message),
    'a truncated file is a size mismatch',
  );
  await assert.rejects(
    () => verifyModelFile(join(fakeDir, 'absent.bin'), fake),
    (error: unknown) => error instanceof RvmModelError && error.code === 'model_size_mismatch',
    'a missing file is a size mismatch, not a crash',
  );
  const wrongBytes = join(fakeDir, 'wrong.bin');
  await writeFile(wrongBytes, 'abd');
  await assert.rejects(
    () => verifyModelFile(wrongBytes, fake),
    (error: unknown) => error instanceof RvmModelError
      && error.code === 'model_hash_mismatch'
      && /hash is/.test(error.message),
    'right size, wrong bytes: the hash is the only thing that catches a swapped model',
  );

  // ── 4. ensureRvmModel: download once, reuse after, refuse a bad landing ───
  let downloads = 0;
  let lastTarget: { modelId?: string; filePath?: string } = {};
  let lastExpected: { bytes?: number; sha256?: string } = {};
  const writeCorrect: typeof downloadModelFile = async (
    target: { modelId: string; revision: string; filePath: string },
    destinationPath?: string,
    options?: { expectedBytes?: number; expectedSha256?: string },
  ) => {
    downloads += 1;
    lastTarget = target;
    lastExpected = { bytes: options?.expectedBytes, sha256: options?.expectedSha256 };
    await mkdir(dirname(destinationPath!), { recursive: true });
    await writeFile(destinationPath!, 'abc');
    return destinationPath!;
  };

  const first = await ensureRvmModel({ profile, model: fake, download: writeCorrect });
  assert.equal(first.downloaded, true, 'an absent model is downloaded once');
  assert.equal(first.engineVersion, RVM_ENGINE_VERSION);
  assert.equal(first.bytes, 3);
  assert.equal(first.file, join(cacheDir, RVM_MODEL_DIR, 'fake.bin'), 'the model lands in the data-directory cache');
  assert.equal(downloads, 1);
  assert.deepEqual(lastTarget, { modelId: RVM_MODEL.modelId, revision: RVM_MODEL.revision, filePath: 'fake.bin' });
  assert.deepEqual(lastExpected, { bytes: 3, sha256: fake.sha256 }, 'the fetcher is told what to expect');

  const second = await ensureRvmModel({ profile, model: fake, download: writeCorrect });
  assert.equal(second.downloaded, false, 'a verified model is reused, never re-fetched');
  assert.equal(downloads, 1, 'the second resolve performed no download');

  // A present-but-corrupt file is re-fetched rather than trusted.
  await writeFile(first.file, 'abd');
  const repaired = await ensureRvmModel({ profile, model: fake, download: writeCorrect });
  assert.equal(repaired.downloaded, true, 'a corrupt cache entry is replaced');
  assert.equal(downloads, 2);

  // A download that lands the wrong bytes is refused, not accepted.
  const writesGarbage: typeof downloadModelFile = async (_target, destinationPath) => {
    await mkdir(dirname(destinationPath!), { recursive: true });
    await writeFile(destinationPath!, 'abd');
    return destinationPath!;
  };
  await rm(first.file, { force: true });
  await assert.rejects(
    () => ensureRvmModel({ profile, model: fake, download: writesGarbage }),
    (error: unknown) => error instanceof RvmModelError && error.code === 'model_hash_mismatch',
    'a download that lands wrong must fail loudly',
  );

  const fails: typeof downloadModelFile = async () => {
    throw new Error('curl exited 22');
  };
  await assert.rejects(
    () => ensureRvmModel({ profile, model: fake, download: fails }),
    (error: unknown) => error instanceof RvmModelError
      && error.code === 'model_download_failed'
      && /curl exited 22/.test(error.message),
    'a transport failure is a coded refusal',
  );

  // ── 5. the default model is the pinned RVM file, not the fixture ──────────
  let defaultTarget: { filePath?: string } = {};
  const recordOnly: typeof downloadModelFile = async (
    target: { filePath: string },
    _destinationPath?: string,
    _options?: unknown,
  ) => {
    defaultTarget = target;
    throw new Error('offline');
  };
  await assert.rejects(
    () => ensureRvmModel({ profile, download: recordOnly }),
    (error: unknown) => error instanceof RvmModelError && error.code === 'model_download_failed',
  );
  assert.equal(defaultTarget.filePath, RVM_MODEL.filePath, 'the default resolve targets the pinned RVM weights');
  assert.equal(await stat(modelPath).catch(() => null), null,
    'the real 15 MB weights were never written by this verify');

  console.log('rvm model: pinned descriptor, data-dir path, size+hash verification, download-once reuse: OK');
} finally {
  if (previousOverride === undefined) delete process.env.OPENCHATCUT_MODEL_CACHE_DIR;
  else process.env.OPENCHATCUT_MODEL_CACHE_DIR = previousOverride;
  restoreHome();
  await rm(fixture, { recursive: true, force: true });
}
