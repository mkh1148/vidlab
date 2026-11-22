// D2: the denoise model is one pinned file, resolved inside the data directory,
// verified by size AND hash on every use.
//
// Everything here is hermetic: a throwaway home, a throwaway data directory, and an
// injected download. The verify never touches the network, the real ~/.openchatcut
// tree, or the real vidlab-data. The 297 KB weights are replaced by a three-byte
// descriptor so the reuse/refuse logic is provable in milliseconds.
//
// The licence assertion is deliberate and it is not decoration: the kit's D2
// requirement is a model "whose licence allows bundling", so the descriptor's
// licence text is part of the contract this file checks. The pinned sha256 is
// checked too — a silent model swap changes the output of every clean-up job and
// would otherwise be invisible.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { sha256File } from '../shared/node-content-hash.ts';
import { isolateVerifyHome } from '../shared/verify-home.ts';
import { assertModelCacheUnderDataDir, modelCacheDir } from './model-cache.ts';
import {
  RNNOISE_MODEL,
  RNNOISE_MODEL_DIR,
  RnnoiseModelError,
  VOICE_CLEANUP_ENGINE_VERSION,
  ensureRnnoiseModel,
  rnnoiseModelPath,
  verifyRnnoiseModelFile,
  type RnnoiseDownload,
  type RnnoiseModelDescriptor,
} from './rnnoise-model.ts';
import { resolveRuntimeProfile } from './runtime-profile.ts';

const fixture = await mkdtemp(join(tmpdir(), 'openchatcut-rnnoise-model-'));
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
  assert.equal(VOICE_CLEANUP_ENGINE_VERSION, 'rnnoise-sh-v1', 'the engine version names the model AND the recipe');
  assert.equal(RNNOISE_MODEL.id, 'sh');
  assert.equal(RNNOISE_MODEL.fileName, 'sh.rnnn');
  assert.equal(RNNOISE_MODEL.bytes, 297_646, 'the pinned size is the one the distributor serves');
  assert.equal(
    RNNOISE_MODEL.sha256,
    '70bb6685eb0c2a1d18e2918dca3fbfbd39317010b1802eb1b6ea73a92f3fdec0',
    'the pin is the sha256 measured from the downloaded file',
  );
  assert.match(RNNOISE_MODEL.sha256, /^[0-9a-f]{64}$/, 'the pin is a full sha256');
  assert.match(RNNOISE_MODEL.url, /^https:\/\/raw\.githubusercontent\.com\//, 'the pin is one https URL');
  assert.ok(RNNOISE_MODEL.url.endsWith(`/${RNNOISE_MODEL.fileName}`), 'the URL serves exactly the pinned file name');
  assert.match(RNNOISE_MODEL.licence, /subject to copyright/, 'the licence is the distributor\'s own dedication, quoted');
  assert.match(RNNOISE_MODEL.licence, /BSD-3-Clause/, 'the code licence is recorded next to the weights licence');
  assert.match(RNNOISE_MODEL.licence, /Not an SPDX identifier/, 'the licence is not dressed up as an SPDX id');
  assert.match(RNNOISE_MODEL.provenance, /recording noise/i, 'the provenance records what the model was trained for');
  assert.match(RNNOISE_MODEL.provenance, /arnndn/, 'the provenance records why this distributor');

  // ── 2. the resolved path lives inside the data directory (I5 + D-entry) ───
  const cacheDir = modelCacheDir(profile, {});
  assert.equal(cacheDir, join(dataDir, 'models'));
  const modelPath = rnnoiseModelPath(profile);
  assert.equal(modelPath, join(cacheDir, RNNOISE_MODEL_DIR, RNNOISE_MODEL.fileName));
  assert.ok(modelPath.startsWith(dataDir), 'the weights land in the data directory, not a hidden home path');
  assert.equal(assertModelCacheUnderDataDir(dirname(modelPath), profile, {}), dirname(modelPath));
  assert.throws(
    () => assertModelCacheUnderDataDir(join(fixture, 'elsewhere', 'models', 'rnnoise'), profile, {}),
    /must live inside the data directory/,
    'a model directory outside the data directory must fail the D-entry guard',
  );

  // ── 3. verifyRnnoiseModelFile: size first, then hash, both coded ──────────
  const fakeDir = join(fixture, 'fake-models');
  await mkdir(fakeDir, { recursive: true });
  const fakeFile = join(fakeDir, 'fake.rnnn');
  await writeFile(fakeFile, 'abc');
  const fake: RnnoiseModelDescriptor = {
    ...RNNOISE_MODEL,
    fileName: 'fake.rnnn',
    bytes: 3,
    sha256: await sha256File(fakeFile),
  };
  assert.deepEqual(await verifyRnnoiseModelFile(fakeFile, fake), { bytes: 3, sha256: fake.sha256 });

  await assert.rejects(
    () => verifyRnnoiseModelFile(fakeFile, { ...fake, bytes: 4 }),
    (error: unknown) => error instanceof RnnoiseModelError
      && error.code === 'model_size_mismatch'
      && /has 3 bytes, expected 4/.test(error.message),
    'a truncated file is a size mismatch',
  );
  await assert.rejects(
    () => verifyRnnoiseModelFile(join(fakeDir, 'absent.rnnn'), fake),
    (error: unknown) => error instanceof RnnoiseModelError && error.code === 'model_size_mismatch',
    'a missing file is a size mismatch, not a crash',
  );
  const wrongBytes = join(fakeDir, 'wrong.rnnn');
  await writeFile(wrongBytes, 'abd');
  await assert.rejects(
    () => verifyRnnoiseModelFile(wrongBytes, fake),
    (error: unknown) => error instanceof RnnoiseModelError
      && error.code === 'model_hash_mismatch'
      && /hash is/.test(error.message),
    'right size, wrong bytes: the hash is the only thing that catches a swapped model',
  );

  // ── 4. ensureRnnoiseModel: download once, reuse after, refuse a bad landing ─
  let downloads = 0;
  let lastUrl = '';
  let lastExpected: { bytes?: number; sha256?: string } = {};
  const writeCorrect: RnnoiseDownload = async (url, destination, options) => {
    downloads += 1;
    lastUrl = url;
    lastExpected = { bytes: options.expectedBytes, sha256: options.expectedSha256 };
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, 'abc');
  };

  const first = await ensureRnnoiseModel({ profile, model: fake, download: writeCorrect });
  assert.equal(first.downloaded, true, 'an absent model is downloaded once');
  assert.equal(first.engineVersion, VOICE_CLEANUP_ENGINE_VERSION);
  assert.equal(first.bytes, 3);
  assert.equal(first.file, join(cacheDir, RNNOISE_MODEL_DIR, 'fake.rnnn'), 'the model lands in the data-directory cache');
  assert.equal(downloads, 1);
  assert.equal(lastUrl, RNNOISE_MODEL.url, 'the downloader is handed the pinned URL');
  assert.deepEqual(lastExpected, { bytes: 3, sha256: fake.sha256 }, 'the downloader is told what to expect');

  const second = await ensureRnnoiseModel({ profile, model: fake, download: writeCorrect });
  assert.equal(second.downloaded, false, 'a verified model is reused, never re-fetched');
  assert.equal(downloads, 1, 'the second resolve performed no download');

  // A present-but-corrupt file is re-fetched rather than trusted.
  await writeFile(first.file, 'abd');
  const repaired = await ensureRnnoiseModel({ profile, model: fake, download: writeCorrect });
  assert.equal(repaired.downloaded, true, 'a corrupt cache entry is replaced');
  assert.equal(downloads, 2);

  // A download that lands the wrong bytes is refused, not accepted.
  const writesGarbage: RnnoiseDownload = async (_url, destination) => {
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, 'abd');
  };
  await rm(first.file, { force: true });
  await assert.rejects(
    () => ensureRnnoiseModel({ profile, model: fake, download: writesGarbage }),
    (error: unknown) => error instanceof RnnoiseModelError && error.code === 'model_hash_mismatch',
    'a download that lands wrong must fail loudly',
  );

  const fails: RnnoiseDownload = async () => {
    throw new Error('curl exited 22');
  };
  await assert.rejects(
    () => ensureRnnoiseModel({ profile, model: fake, download: fails }),
    (error: unknown) => error instanceof RnnoiseModelError
      && error.code === 'model_download_failed'
      && /curl exited 22/.test(error.message),
    'a transport failure is a coded refusal',
  );

  // ── 5. the default model is the pinned RNNoise file, not the fixture ──────
  let defaultUrl = '';
  const recordOnly: RnnoiseDownload = async (url) => {
    defaultUrl = url;
    throw new Error('offline');
  };
  await assert.rejects(
    () => ensureRnnoiseModel({ profile, download: recordOnly }),
    (error: unknown) => error instanceof RnnoiseModelError && error.code === 'model_download_failed',
  );
  assert.equal(defaultUrl, RNNOISE_MODEL.url, 'the default resolve targets the pinned RNNoise weights');
  assert.equal(await stat(modelPath).catch(() => null), null,
    'the real 297 KB weights were never written by this verify');

  console.log('rnnoise model: pinned descriptor + licence, data-dir path, size+hash verification, download-once reuse, corrupt-cache repair, bad-landing refusal: OK');
} finally {
  if (previousOverride === undefined) delete process.env.OPENCHATCUT_MODEL_CACHE_DIR;
  else process.env.OPENCHATCUT_MODEL_CACHE_DIR = previousOverride;
  restoreHome();
  await rm(fixture, { recursive: true, force: true });
}
