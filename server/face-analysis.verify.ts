// D4 · the face artifacts on disk: placement, naming, cache identity, refusals,
// clean-up, and the model cache's home.
//
// What this pins down:
//
//   1. both artifacts land in the per-source derived directory under the DATA
//      directory, named by the H2 namer (revision + engine version + options), so
//      they obey the same rules as the matte, the voice copy and the transcript;
//   2. the cache hit needs BOTH files: a track without its atlas is a miss, because
//      a track alone would promise a mask that is not there;
//   3. cache identity moves with the revision, the sampling rate and the engine
//      version — a model change produces a new file instead of overwriting the old
//      measurement;
//   4. a malformed track, a track that disagrees with the requested options, a
//      non-PNG atlas and an empty atlas are refused with `{error, code}` rather
//      than written;
//   5. media clean-up removes the whole per-source directory, so the atlas cannot
//      outlive its source (the kit's "the atlas is an effect asset");
//   6. the Face Landmarker weights resolve INSIDE the data directory, and the pin is
//      enforced by size AND hash — a wrong-size or wrong-hash file is re-fetched, and
//      a download that does not match the pin is refused instead of installed.
//
// Hermetic: throwaway home, throwaway data directory, injected download. The real
// 3.6 MB weights are never fetched here (the exit test fetches them once, for real).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isolateVerifyHome } from '../shared/verify-home.ts';
import {
  FACE_ANALYSIS_ENGINE_VERSION,
  FACE_MODEL_BYTES,
  FACE_MODEL_FILE,
  FACE_MODEL_SHA256,
  FACE_MODEL_URL,
  ensureFaceModel,
  faceModelLocation,
} from './face-model.ts';
import {
  FACE_ATLAS_SEGMENT,
  FACE_TRACK_SEGMENT,
  FaceAnalysisError,
  faceAnalysisLocations,
  readFaceAnalysis,
  removeDerivedSource,
  removeFaceAnalysisFiles,
  writeFaceAnalysis,
  type FaceAnalysisIdentity,
} from './face-analysis.ts';
import { assertModelCacheUnderDataDir } from './model-cache.ts';
import { resolveRuntimeProfile } from './runtime-profile.ts';

const fixture = await mkdtemp(join(tmpdir(), 'vidlab-face-analysis-'));
const homeDir = join(fixture, 'home');
const dataDir = join(fixture, 'vidlab-data');
const restoreHome = isolateVerifyHome(homeDir);
const previousModelCacheOverride = process.env.OPENCHATCUT_MODEL_CACHE_DIR;
// The override would move the resolver out of the data directory; this suite proves
// the data-directory path, so the override is removed for the run.
delete process.env.OPENCHATCUT_MODEL_CACHE_DIR;

// A minimal but valid PNG header plus payload: the writer checks the signature only,
// because decoding the atlas is the renderer's job.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const IDENTITY: FaceAnalysisIdentity = {
  sourceName: 'talking-head.mp4',
  revision: 'source-v1-abc',
  analysisFps: 5,
  cell: 128,
};
const TRACK = {
  version: 1,
  sourceFps: 30,
  sourceFrames: 390,
  analysisFps: 5,
  cols: 9,
  rows: 8,
  cell: 128,
  samples: [
    { f: 0, box: { x: 0.3, y: 0.2, w: 0.3, h: 0.4 }, c: 1 },
    { f: 6, box: { x: 0.31, y: 0.2, w: 0.3, h: 0.4 }, c: 1 },
  ],
};

try {
  const profile = resolveRuntimeProfile({ OPENCHATCUT_DATA_DIR: dataDir }, { homeDir, cwd: fixture });

  // ── 1. placement and naming ───────────────────────────────────────────────
  const locations = faceAnalysisLocations(IDENTITY, profile);
  assert.equal(locations.track.dir, join(dataDir, 'media', 'derived', locations.sourceKey),
    `the track must live in the per-source derived area under the data directory (got ${locations.track.dir})`);
  assert.equal(locations.atlas.dir, locations.track.dir, 'both artifacts share the per-source directory');
  assert.equal(locations.track.url, `/media/derived/${locations.sourceKey}/${locations.track.name}`);
  assert.equal(locations.atlas.url, `/media/derived/${locations.sourceKey}/${locations.atlas.name}`);
  assert.ok(locations.track.name.includes(FACE_TRACK_SEGMENT), `track name carries its kind (${locations.track.name})`);
  assert.ok(locations.atlas.name.includes(FACE_ATLAS_SEGMENT), `atlas name carries its kind (${locations.atlas.name})`);
  assert.ok(locations.track.name.includes(IDENTITY.revision!), 'the revision is part of the name');
  assert.ok(locations.track.name.includes(FACE_ANALYSIS_ENGINE_VERSION), 'the engine version is part of the name');
  assert.ok(locations.track.name.includes('fps-5') && locations.track.name.includes('cell-128'),
    `the options that change the bytes are part of the name (${locations.track.name})`);
  assert.ok(locations.track.name.endsWith('.json') && locations.atlas.name.endsWith('.png'));

  // ── 2. write, then hit ────────────────────────────────────────────────────
  assert.equal(await readFaceAnalysis(IDENTITY, profile), null, 'nothing is cached before the first write');
  const written = await writeFaceAnalysis({ identity: IDENTITY, track: TRACK, atlasPng: PNG, profile });
  assert.equal(written.cached, false);
  assert.ok(written.trackBytes > 0 && written.atlasBytes === PNG.length);
  assert.equal(written.engine, FACE_ANALYSIS_ENGINE_VERSION);
  assert.ok(existsSync(locations.track.file) && existsSync(locations.atlas.file), 'both files exist after the write');
  assert.equal((await stat(locations.atlas.file)).size, PNG.length, 'the atlas is written byte-for-byte');
  const hit = await readFaceAnalysis(IDENTITY, profile);
  assert.ok(hit, 'a written analysis is a cache hit');
  assert.equal(hit.trackUrl, written.trackUrl);
  assert.equal(hit.atlasUrl, written.atlasUrl);
  assert.equal(hit.cached, true);

  // A track without its atlas is NOT a hit: the pair is the artifact.
  await rm(locations.atlas.file);
  assert.equal(await readFaceAnalysis(IDENTITY, profile), null, 'a track without an atlas is a cache miss');
  await rm(locations.track.file);
  assert.equal(await readFaceAnalysis(IDENTITY, profile), null, 'an atlas without a track is a cache miss');
  await writeFaceAnalysis({ identity: IDENTITY, track: TRACK, atlasPng: PNG, profile });

  // ── 3. cache identity moves ───────────────────────────────────────────────
  const otherRevision = faceAnalysisLocations({ ...IDENTITY, revision: 'source-v1-def' }, profile);
  assert.notEqual(otherRevision.track.file, locations.track.file, 'a new source revision is a new artifact');
  const otherFps = faceAnalysisLocations({ ...IDENTITY, analysisFps: 10 }, profile);
  assert.notEqual(otherFps.track.file, locations.track.file, 'a different sampling rate is a new artifact');
  const otherCell = faceAnalysisLocations({ ...IDENTITY, cell: 64 }, profile);
  assert.notEqual(otherCell.atlas.file, locations.atlas.file, 'a different atlas cell size is a new artifact');
  assert.equal(otherRevision.sourceKey, locations.sourceKey, 'the source key is stable across revisions');

  // ── 4. refusals ───────────────────────────────────────────────────────────
  const refuses = async (code: string, input: Parameters<typeof writeFaceAnalysis>[0], why: string) => {
    await assert.rejects(
      writeFaceAnalysis({ ...input, profile }),
      (error: unknown) => error instanceof FaceAnalysisError && error.code === code,
      why,
    );
  };
  await refuses('invalid_face_track',
    { identity: IDENTITY, track: { ...TRACK, version: 99 }, atlasPng: PNG }, 'a future track version is refused');
  await refuses('invalid_face_track',
    { identity: IDENTITY, track: { ...TRACK, samples: [] }, atlasPng: PNG }, 'an empty track is refused');
  await refuses('invalid_face_track',
    { identity: IDENTITY, track: { ...TRACK, samples: [{ f: 6, box: TRACK.samples[0]!.box, c: 1 }, { f: 0, box: TRACK.samples[1]!.box, c: 1 }] }, atlasPng: PNG },
    'out-of-order samples are refused');
  await refuses('face_track_options_mismatch',
    { identity: IDENTITY, track: { ...TRACK, analysisFps: 10 }, atlasPng: PNG },
    'a track that disagrees with the requested sampling rate is refused');
  await refuses('face_atlas_not_png',
    { identity: IDENTITY, track: TRACK, atlasPng: new Uint8Array([1, 2, 3]) }, 'a non-PNG atlas is refused');
  await refuses('empty_face_atlas',
    { identity: IDENTITY, track: TRACK, atlasPng: new Uint8Array(0) }, 'an empty atlas is refused');
  // A refusal must not damage what is already on disk.
  assert.ok(await readFaceAnalysis(IDENTITY, profile), 'refusals leave the previous artifacts intact');

  // ── 5. clean-up takes the atlas with the source ───────────────────────────
  const before = await readdir(locations.track.dir);
  assert.equal(before.length, 2, `the per-source directory holds exactly the pair (got ${before.join(', ')})`);
  const removed = await removeDerivedSource(IDENTITY.sourceName, profile);
  assert.equal(removed, 2, `clean-up reports what it removed (got ${removed})`);
  assert.equal(existsSync(locations.track.dir), false, 'the whole per-source directory is gone');
  assert.equal(await readFaceAnalysis(IDENTITY, profile), null, 'and the cache is a miss again');
  assert.equal(await removeDerivedSource(IDENTITY.sourceName, profile), 0, 'a second clean-up is a no-op');
  // Restore (the inspector's "remove analysis") is narrower: it drops the pair only.
  await writeFaceAnalysis({ identity: IDENTITY, track: TRACK, atlasPng: PNG, profile });
  await removeFaceAnalysisFiles(IDENTITY, profile);
  assert.equal(existsSync(locations.track.file), false);
  assert.equal(existsSync(locations.atlas.file), false);
  assert.equal(existsSync(locations.track.dir), true, 'restore leaves the directory for the other artifacts');

  // ── 6. the model cache lives in the data directory, and the pin is enforced ──
  const model = faceModelLocation(profile);
  assert.equal(model.file, join(dataDir, 'models', 'mediapipe', FACE_MODEL_FILE));
  assert.equal(model.bytes, FACE_MODEL_BYTES);
  assert.equal(model.sha256, FACE_MODEL_SHA256);
  assert.match(model.sha256, /^[0-9a-f]{64}$/);
  assert.match(FACE_MODEL_URL, /^https:\/\/storage\.googleapis\.com\/mediapipe-models\/face_landmarker\//,
    'the provenance URL is the model card\'s own download');
  assertModelCacheUnderDataDir(dirname(model.file), profile);
  assert.throws(
    () => assertModelCacheUnderDataDir(join(fixture, 'elsewhere', 'models'), profile),
    /must live inside the data directory/,
    'a model cache outside the data directory is refused',
  );

  // A wrong-size file is not a hit: the download runs, and a body that does not match
  // the pin is refused instead of installed.
  await mkdir(dirname(model.file), { recursive: true });
  await writeFile(model.file, new Uint8Array(16));
  let downloads = 0;
  await assert.rejects(
    ensureFaceModel({
      profile,
      fetchImpl: (async () => {
        downloads += 1;
        return new Response(new Uint8Array(64), { status: 200 });
      }) as unknown as typeof fetch,
    }),
    /integrity mismatch/,
    'a download that does not match the pin is refused',
  );
  assert.equal(downloads, 1, 'a wrong-size file triggers a re-download');
  assert.equal((await stat(model.file)).size, 16, 'the refused download did not replace the file');

  // A right-size file with the wrong hash is also not a hit — the hash check is real,
  // not a size check wearing a hash's name.
  await writeFile(model.file, new Uint8Array(FACE_MODEL_BYTES));
  downloads = 0;
  await assert.rejects(
    ensureFaceModel({
      profile,
      fetchImpl: (async () => {
        downloads += 1;
        return new Response(null, { status: 502 });
      }) as unknown as typeof fetch,
    }),
    /HTTP 502/,
  );
  assert.equal(downloads, 1, 'a right-size, wrong-hash file triggers a re-download');

  console.log('face-analysis.verify: placement, pair-cache, identity, refusals, clean-up and the model pin all hold');
} finally {
  restoreHome();
  if (previousModelCacheOverride === undefined) delete process.env.OPENCHATCUT_MODEL_CACHE_DIR;
  else process.env.OPENCHATCUT_MODEL_CACHE_DIR = previousModelCacheOverride;
  await rm(fixture, { recursive: true, force: true });
}
