// D3a · the speech model is one pinned multilingual file, resolved inside the data
// directory, verified by size AND hash on every use, downloaded once.
// `npx tsx server/whisper-model.verify.ts`
//
// Everything here is hermetic: a throwaway home, a throwaway data directory, and an
// injected download. The verify never touches the network, the real ~/.openchatcut
// tree, or the real vidlab-data. The 57 MB weights are replaced by a three-byte
// descriptor so the reuse/repair/refuse logic is provable in milliseconds.
//
// The pin assertions are not decoration. `shared/asr-models.ts` is the catalog the
// settings pane downloads through, and this engine reads the SAME bytes: if the
// catalog's pin and this engine's expectation ever disagree, one of them is wrong and
// a transcript silently comes from a different model than the one it names.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256File } from '../shared/node-content-hash.ts';
import { isolateVerifyHome } from '../shared/verify-home.ts';
import { assertModelCacheUnderDataDir, modelCacheDir } from './model-cache.ts';
import { resolveRuntimeProfile } from './runtime-profile.ts';
import {
  DEFAULT_TRANSCRIPTION_MODEL_TIER,
  TRANSCRIPTION_BASE_JOB_REQUIRED_BYTES,
  TRANSCRIPTION_ENGINE_VERSION,
  TRANSCRIPTION_MODEL_TIERS,
  TRANSCRIPTION_VAD_VERSION,
  WhisperModelError,
  ensureWhisperModel,
  transcriptionRequiredBytes,
  verifyWhisperModelFile,
  whisperModelDescriptor,
  whisperModelPath,
  type WhisperModelDescriptor,
  type WhisperModelDownload,
} from './whisper-model.ts';

const fixture = await mkdtemp(join(tmpdir(), 'openchatcut-whisper-model-'));
const homeDir = join(fixture, 'home');
const dataDir = join(fixture, 'vidlab-data');
const restoreHome = isolateVerifyHome(homeDir);
const previousOverride = process.env.OPENCHATCUT_MODEL_CACHE_DIR;
// The cache override would move the resolver out of the data directory; this suite
// proves the data-directory path, so the override is removed for the run.
delete process.env.OPENCHATCUT_MODEL_CACHE_DIR;

try {
  const profile = resolveRuntimeProfile({ OPENCHATCUT_DATA_DIR: dataDir }, { homeDir, cwd: fixture });

  // ── 1. the pinned descriptor is a contract, not a comment ─────────────────
  {
    assert.equal(TRANSCRIPTION_ENGINE_VERSION, 'whisper-cpp-v1.9.2', 'the engine version names the binary');
    assert.equal(TRANSCRIPTION_VAD_VERSION, 'vad-e1', 'the VAD recipe version is part of the cache key');
    assert.equal(DEFAULT_TRANSCRIPTION_MODEL_TIER, 'base', 'the default tier is the measured one');

    const base = whisperModelDescriptor('base');
    assert.equal(base.fileName, 'ggml-base-q5_1.bin');
    assert.equal(base.bytes, 59_707_625, 'the pinned size is the one the catalog pins');
    assert.equal(
      base.sha256,
      '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898',
      'the pin is the sha256 measured from the downloaded file',
    );
    assert.match(base.sha256, /^[0-9a-f]{64}$/, 'the pin is a full sha256');
    assert.equal(base.revision, '5359861c739e955e79d9a303bcbc70fb988958b1', 'the HF revision is pinned');
    assert.equal(
      base.url,
      'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base-q5_1.bin',
      'the provenance URL is the pinned revision, not a moving branch',
    );
    assert.match(base.licence, /MIT/, 'the weights licence is recorded');
    assert.match(base.licence, /whisper\.cpp/, 'the distributor licence is recorded next to it');
    assert.match(base.provenance, /OpenAI/, 'the provenance names the upstream model');

    // Multilingual, which is what the kit asks for: no `.en` checkpoint is listed.
    for (const tier of TRANSCRIPTION_MODEL_TIERS) {
      const descriptor = whisperModelDescriptor(tier);
      assert.doesNotMatch(descriptor.fileName, /\.en\./, `${tier} is a multilingual checkpoint`);
      assert.match(descriptor.fileName, /^ggml-.*\.bin$/, `${tier} names a GGML file`);
    }
    assert.deepEqual(
      [...TRANSCRIPTION_MODEL_TIERS],
      ['tiny', 'base', 'small', 'medium', 'large-v3-turbo'],
      'every catalog tier that ships a GGML companion is reachable',
    );
    assert.throws(
      () => whisperModelDescriptor('base.en'),
      (error: unknown) => error instanceof WhisperModelError && error.code === 'unknown_model_tier',
      'an unknown tier is refused by code, never silently replaced by the default',
    );
    console.log('whisper-model: the pin, the licence, the provenance and the tier list are contracts');
  }

  // ── 2. the model lives inside the data directory (I5/H3) ──────────────────
  {
    const path = whisperModelPath('base', profile);
    assert.ok(path.startsWith(dataDir), `the model resolves under the data dir (${path})`);
    assert.equal(assertModelCacheUnderDataDir(modelCacheDir(profile), profile), modelCacheDir(profile));
    assert.throws(
      () => assertModelCacheUnderDataDir(join(fixture, 'elsewhere'), profile),
      /must live inside the data directory/,
      'a cache outside the data directory is refused',
    );
    console.log('whisper-model: the model resolves inside the data directory and a stray cache is refused');
  }

  // ── 3. requiredBytes is a measured budget, per tier ───────────────────────
  {
    assert.equal(TRANSCRIPTION_BASE_JOB_REQUIRED_BYTES, 256 * 1024 * 1024,
      'the base tier declares the measured 256 MiB, not the 1.5 GiB floor');
    assert.equal(transcriptionRequiredBytes('base'), 256 * 1024 * 1024, 'base is the measured constant');
    for (const tier of TRANSCRIPTION_MODEL_TIERS) {
      const bytes = transcriptionRequiredBytes(tier);
      assert.ok(bytes >= TRANSCRIPTION_BASE_JOB_REQUIRED_BYTES, `${tier} never declares less than base`);
      assert.equal(bytes & (bytes - 1), 0, `${tier} declares a power of two`);
      assert.ok(bytes >= whisperModelDescriptor(tier).bytes, `${tier} declares at least its own model size`);
    }
    assert.ok(
      transcriptionRequiredBytes('large-v3-turbo') > 1024 * 1024 * 1024,
      'the largest tier declares more than a gigabyte, so it cannot be admitted on a machine that cannot hold it',
    );
    console.log('whisper-model: requiredBytes is the measured base figure and a conservative per-tier derivation');
  }

  // ── 4. download once, verify always, repair a corrupt entry ───────────────
  {
    const payload = new TextEncoder().encode('abc');
    const sha256 = await sha256File(await (async () => {
      const probe = join(fixture, 'abc.bin');
      await writeFile(probe, payload);
      return probe;
    })());
    const descriptor: WhisperModelDescriptor = {
      tier: 'test',
      fileName: 'ggml-test-q5_1.bin',
      bytes: payload.length,
      sha256,
      revision: 'r1',
      url: 'https://example.invalid/ggml-test-q5_1.bin',
      upstream: 'test/model',
      licence: 'test licence',
      provenance: 'test provenance',
    };

    let downloads = 0;
    const download: WhisperModelDownload = async (_target, destination) => {
      downloads += 1;
      await mkdir(join(destination, '..'), { recursive: true });
      await writeFile(destination, payload);
      return destination;
    };

    const first = await ensureWhisperModel({ descriptor, profile, download });
    assert.equal(first.downloaded, true, 'the first resolve downloads');
    assert.equal(downloads, 1);
    assert.equal((await readFile(first.file)).toString('utf8'), 'abc', 'the file on disk is the pinned bytes');

    const second = await ensureWhisperModel({ descriptor, profile, download });
    assert.equal(second.downloaded, false, 'the second resolve is a cache hit');
    assert.equal(downloads, 1, 'and it does not download again');

    // A corrupt entry is repaired, not trusted: a wrong model produces a transcript
    // that reads plausibly and is wrong.
    await writeFile(first.file, new TextEncoder().encode('xyz'));
    const repaired = await ensureWhisperModel({ descriptor, profile, download });
    assert.equal(repaired.downloaded, true, 'a corrupt cache entry is re-fetched');
    assert.equal(downloads, 2);
    assert.equal((await readFile(repaired.file)).toString('utf8'), 'abc');

    // A download that lands the wrong bytes is refused, and the bad file does not
    // survive to be trusted by the next run.
    await rm(repaired.file, { force: true });
    const landingWrong: WhisperModelDownload = async (_target, destination) => {
      await writeFile(destination, new TextEncoder().encode('bad'));
      return destination;
    };
    await assert.rejects(
      () => ensureWhisperModel({ descriptor, profile, download: landingWrong }),
      (error: unknown) => error instanceof WhisperModelError && error.code === 'model_hash_mismatch',
      'a download that lands wrong is refused by code',
    );

    // A transport failure is a code too.
    const failing: WhisperModelDownload = async () => {
      throw new Error('ECONNREFUSED');
    };
    await assert.rejects(
      () => ensureWhisperModel({ descriptor, profile, download: failing }),
      (error: unknown) => error instanceof WhisperModelError && error.code === 'model_download_failed',
      'a failed download is a machine-parseable refusal',
    );

    // verifyWhisperModelFile refuses a size mismatch by name, before hashing.
    await writeFile(repaired.file, new TextEncoder().encode('abcd'));
    await assert.rejects(
      () => verifyWhisperModelFile(repaired.file, descriptor),
      (error: unknown) => error instanceof WhisperModelError && error.code === 'model_size_mismatch',
    );
    const info = await stat(repaired.file);
    assert.equal(info.size, 4, 'the fixture really holds the wrong size');
    console.log('whisper-model: download once, cache hit, corrupt repair, wrong landing refused, size refused');
  }
} finally {
  if (previousOverride !== undefined) process.env.OPENCHATCUT_MODEL_CACHE_DIR = previousOverride;
  restoreHome();
  await rm(fixture, { recursive: true, force: true }).catch(() => undefined);
}

console.log('whisper-model.verify: ok (pin, licence, data-dir path, per-tier budget, download-once, repair, refusals)');
