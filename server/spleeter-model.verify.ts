// D6 · the separation models are two pinned files, resolved inside the data
// directory, verified by size AND hash on every use.
//
// The kit's D6 line names Spleeter 2stems; the ONNX export of those weights is
// two UNets, so "the model" is a PAIR and a half-downloaded pair is the failure
// this file exists to make impossible: the vocals file present and the
// accompaniment file missing would produce an artifact that is half a mix.
//
// Everything here is hermetic: a throwaway home, a throwaway data directory, and
// an injected download. The verify never touches the network, the real
// ~/.openchatcut tree, or the real vidlab-data. The 78 MB of weights are replaced
// by three-byte descriptors so the reuse/refuse logic is provable in milliseconds.
//
// The licence chain is asserted too, because it is a decision and not a comment:
// the WEIGHTS are MIT (deezer/spleeter 2stems), the ONNX EXPORT is Apache-2.0
// (k2-fsa/sherpa-onnx), and the hosting repository has no licence card at all —
// recorded as a claim rather than smoothed over, the same way RVM's mirror row is.
//
// Run: npx tsx server/spleeter-model.verify.ts
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { sha256File } from '../shared/node-content-hash.ts';
import { isolateVerifyHome } from '../shared/verify-home.ts';
import { assertModelCacheUnderDataDir, modelCacheDir } from './model-cache.ts';
import type { downloadModelFile } from './plugins/hf-proxy.ts';
import { resolveRuntimeProfile } from './runtime-profile.ts';
import {
  SPLEETER_MODEL,
  SPLEETER_MODEL_DIR,
  SpleeterModelError,
  VOICE_ISOLATION_ENGINE_VERSION,
  ensureSpleeterModels,
  spleeterModelPath,
  spleeterModelTarget,
  verifySpleeterFile,
  type SpleeterModelDescriptor,
} from './spleeter-model.ts';

const fixture = await mkdtemp(join(tmpdir(), 'vidlab-spleeter-model-'));
const homeDir = join(fixture, 'home');
const dataDir = join(fixture, 'vidlab-data');
const restoreHome = isolateVerifyHome(homeDir);
const previousOverride = process.env.OPENCHATCUT_MODEL_CACHE_DIR;
// The cache override would move the resolver out of the data directory; this
// suite proves the data-directory path, so the override is removed for the run.
delete process.env.OPENCHATCUT_MODEL_CACHE_DIR;

try {
  const profile = resolveRuntimeProfile({ OPENCHATCUT_DATA_DIR: dataDir }, { homeDir, cwd: fixture });

  // ── 1. the pinned pair is a contract, not a comment ───────────────────────
  assert.equal(VOICE_ISOLATION_ENGINE_VERSION, 'spleeter-2stems-onnx-v1',
    'the engine version names the model AND the recipe');
  assert.equal(SPLEETER_MODEL.modelId, 'csukuangfj/sherpa-onnx-spleeter-2stems');
  assert.equal(SPLEETER_MODEL.vocals.fileName, 'vocals.onnx');
  assert.equal(SPLEETER_MODEL.accompaniment.fileName, 'accompaniment.onnx');
  for (const file of [SPLEETER_MODEL.vocals, SPLEETER_MODEL.accompaniment]) {
    assert.ok(file.bytes > 30_000_000, `${file.fileName} is a real UNet, not a placeholder`);
    assert.match(file.sha256, /^[0-9a-f]{64}$/, `${file.fileName} is pinned by a full sha256`);
  }
  assert.notEqual(SPLEETER_MODEL.vocals.sha256, SPLEETER_MODEL.accompaniment.sha256,
    'the two stems are different weights, so they cannot share a pin');
  assert.equal(SPLEETER_MODEL.input, 'x');
  assert.equal(SPLEETER_MODEL.output, 'y');
  assert.equal(SPLEETER_MODEL.licence, 'MIT', 'the weights are MIT upstream');
  assert.match(SPLEETER_MODEL.upstream, /deezer\/spleeter/, 'the weights are named, not implied');
  assert.match(SPLEETER_MODEL.converter, /sherpa-onnx/, 'the ONNX export is named');
  assert.match(SPLEETER_MODEL.hostLicenceClaim, /no licence card/,
    'the hosting repository claims nothing, and that is recorded as a claim');
  assert.deepEqual(spleeterModelTarget(SPLEETER_MODEL.vocals), {
    modelId: SPLEETER_MODEL.modelId,
    revision: SPLEETER_MODEL.revision,
    filePath: 'vocals.onnx',
  }, 'the download target is derived from the pin, never hand-typed');

  // ── 2. the resolved paths live inside the data directory (I5 + D-entry) ───
  const cacheDir = modelCacheDir(profile, {});
  assert.equal(cacheDir, join(dataDir, 'models'));
  const vocalsPath = spleeterModelPath(SPLEETER_MODEL.vocals, profile);
  const accompanimentPath = spleeterModelPath(SPLEETER_MODEL.accompaniment, profile);
  assert.equal(vocalsPath, join(cacheDir, SPLEETER_MODEL_DIR, 'vocals.onnx'));
  assert.equal(accompanimentPath, join(cacheDir, SPLEETER_MODEL_DIR, 'accompaniment.onnx'));
  assert.ok(vocalsPath.startsWith(dataDir), 'the weights land in the data directory, not a hidden home path');
  assert.equal(assertModelCacheUnderDataDir(dirname(vocalsPath), profile, {}), dirname(vocalsPath));
  assert.throws(
    () => assertModelCacheUnderDataDir(join(fixture, 'elsewhere', 'models', 'spleeter'), profile, {}),
    /must live inside the data directory/,
    'a model directory outside the data directory must fail the D-entry guard',
  );

  // ── 3. verifySpleeterFile: size first, then hash, both coded ──────────────
  const fakeDir = join(fixture, 'fake-models');
  await mkdir(fakeDir, { recursive: true });
  const fakeVocals = join(fakeDir, 'vocals.bin');
  const fakeAccompaniment = join(fakeDir, 'accompaniment.bin');
  await writeFile(fakeVocals, 'abc');
  await writeFile(fakeAccompaniment, 'abd');
  const fake: SpleeterModelDescriptor = {
    ...SPLEETER_MODEL,
    vocals: { fileName: 'vocals.bin', bytes: 3, sha256: await sha256File(fakeVocals) },
    accompaniment: {
      fileName: 'accompaniment.bin',
      bytes: 3,
      sha256: await sha256File(fakeAccompaniment),
    },
  };
  assert.deepEqual(await verifySpleeterFile(fakeVocals, fake.vocals), {
    bytes: 3,
    sha256: fake.vocals.sha256,
  });
  await assert.rejects(
    () => verifySpleeterFile(fakeVocals, { ...fake.vocals, bytes: 4 }),
    (error: unknown) => error instanceof SpleeterModelError
      && error.code === 'model_size_mismatch'
      && /has 3 bytes, expected 4/.test(error.message),
    'a truncated file is a size mismatch',
  );
  await assert.rejects(
    () => verifySpleeterFile(join(fakeDir, 'absent.bin'), fake.vocals),
    (error: unknown) => error instanceof SpleeterModelError && error.code === 'model_size_mismatch',
    'a missing file is a size mismatch, not a crash',
  );
  await assert.rejects(
    () => verifySpleeterFile(fakeAccompaniment, fake.vocals),
    (error: unknown) => error instanceof SpleeterModelError
      && error.code === 'model_hash_mismatch'
      && /hash is/.test(error.message),
    'right size, wrong bytes: the hash is the only thing that catches a swapped model',
  );

  // ── 4. ensureSpleeterModels: both files, once, verified on every resolve ──
  let downloads = 0;
  let received = 0;
  const targets: string[] = [];
  const expectations: Array<{ bytes?: number; sha256?: string }> = [];
  const writeCorrect: typeof downloadModelFile = async (
    target: { modelId: string; revision: string; filePath: string },
    destinationPath?: string,
    options?: { expectedBytes?: number; expectedSha256?: string; onProgress?: (bytes: number) => void },
  ) => {
    downloads += 1;
    targets.push(target.filePath);
    expectations.push({ bytes: options?.expectedBytes, sha256: options?.expectedSha256 });
    await mkdir(dirname(destinationPath!), { recursive: true });
    await writeFile(destinationPath!, target.filePath === 'vocals.bin' ? 'abc' : 'abd');
    options?.onProgress?.(3);
    return destinationPath!;
  };

  const first = await ensureSpleeterModels({
    profile,
    model: fake,
    download: writeCorrect,
    onProgress: (bytes) => { received = bytes; },
  });
  assert.equal(first.downloaded, true, 'an absent pair is downloaded once');
  assert.equal(downloads, 2, 'BOTH files are fetched — half a pair is not a model');
  assert.deepEqual(targets, ['vocals.bin', 'accompaniment.bin']);
  assert.deepEqual(expectations, [
    { bytes: 3, sha256: fake.vocals.sha256 },
    { bytes: 3, sha256: fake.accompaniment.sha256 },
  ], 'the fetcher is told what to expect, per file');
  assert.equal(received, 6, 'progress is cumulative across both files');
  assert.equal(first.vocals, join(cacheDir, SPLEETER_MODEL_DIR, 'vocals.bin'));
  assert.equal(first.accompaniment, join(cacheDir, SPLEETER_MODEL_DIR, 'accompaniment.bin'));
  assert.equal(first.bytes, 6);
  assert.equal(first.engineVersion, VOICE_ISOLATION_ENGINE_VERSION);

  const second = await ensureSpleeterModels({ profile, model: fake, download: writeCorrect });
  assert.equal(second.downloaded, false, 'a verified pair is reused, never re-fetched');
  assert.equal(downloads, 2, 'the second resolve performed no download');

  // One corrupt half is repaired without re-fetching the good half.
  await writeFile(first.accompaniment, 'abc');
  const repaired = await ensureSpleeterModels({ profile, model: fake, download: writeCorrect });
  assert.equal(repaired.downloaded, true, 'a corrupt cache entry is replaced');
  assert.equal(downloads, 3, 'only the corrupt file was fetched again');
  assert.deepEqual(targets.slice(2), ['accompaniment.bin']);

  // A download that lands the wrong bytes is refused, not accepted.
  const writesGarbage: typeof downloadModelFile = async (_target, destinationPath) => {
    await mkdir(dirname(destinationPath!), { recursive: true });
    await writeFile(destinationPath!, 'zzz');
    return destinationPath!;
  };
  await rm(first.vocals, { force: true });
  await assert.rejects(
    () => ensureSpleeterModels({ profile, model: fake, download: writesGarbage }),
    (error: unknown) => error instanceof SpleeterModelError && error.code === 'model_hash_mismatch',
    'a download that lands wrong must fail loudly',
  );

  const fails: typeof downloadModelFile = async () => {
    throw new Error('curl exited 22');
  };
  await rm(first.vocals, { force: true });
  await assert.rejects(
    () => ensureSpleeterModels({ profile, model: fake, download: fails }),
    (error: unknown) => error instanceof SpleeterModelError
      && error.code === 'model_download_failed'
      && /curl exited 22/.test(error.message),
    'a failed download is a coded refusal a route can report as {error, code}',
  );

  // An aborted job must not keep downloading. The signal is handed to the
  // transport (the same one the ASR/RVM/D2 downloads use), so the wrapper's job is
  // to report the cancellation as a coded refusal rather than an unhandled abort.
  const controller = new AbortController();
  controller.abort();
  const honoursSignal: typeof downloadModelFile = async (_target, _destinationPath, options) => {
    if (options?.signal?.aborted) {
      const error = new Error('the download was cancelled');
      error.name = 'AbortError';
      throw error;
    }
    throw new Error('the transport must not start after an abort');
  };
  await rm(first.vocals, { force: true });
  await assert.rejects(
    () => ensureSpleeterModels({ profile, model: fake, download: honoursSignal, signal: controller.signal }),
    (error: unknown) => error instanceof SpleeterModelError
      && error.code === 'model_download_failed'
      && /cancelled/.test(error.message),
    'an aborted job stops the model download and reports it as a coded refusal',
  );

  console.log('spleeter model: two pinned files, MIT weights through an Apache-2.0 export, '
    + 'verified by size and hash inside the data directory: OK');
} finally {
  if (previousOverride === undefined) delete process.env.OPENCHATCUT_MODEL_CACHE_DIR;
  else process.env.OPENCHATCUT_MODEL_CACHE_DIR = previousOverride;
  restoreHome();
  await rm(fixture, { recursive: true, force: true });
}
