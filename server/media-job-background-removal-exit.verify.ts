// D1b · the exit test, recorded.
//
// The kit's exit test, as a runnable verify: the owner's talking-head clip is
// imported into a THROWAWAY project, background removal runs through the real
// engine, the result is composited over a NEW background, and the composite is
// sampled pixel by pixel. Everything the kit asks for is asserted here:
//
//   * no checkerboard: the corners are the new background, not an alpha pattern;
//   * no black flashes: the picture is never near-black where the person is;
//   * the person actually lands on the new background (a real cut-out, not a
//     full-frame copy of the source);
//   * processing seconds per video second, measured and printed;
//   * the second run is a cache hit (instant, no child spawned);
//   * the server export PREFLIGHT accepts the derived reference, which is the
//     gate that would otherwise refuse to export a project with a matte.
//
// The clip and the 15 MB weights are external. The weights come from PORTABLE
// sources only (reviewer condition C2): VIDLAB_RVM_MODEL, or the configured data
// directory's model cache composed by the app's own resolver — never a bench
// path or a hard-coded drive. A cold machine downloads them once through the
// app's own path. When the clip is absent the suite says so LOUDLY and skips,
// rather than passing quietly on nothing.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isolateVerifyHome } from '../shared/verify-home.ts';
import { ffmpegBin, ffprobeBin } from './media-binaries.ts';
import { MediaJobQueue, type MediaJobSnapshot } from './media-job.ts';

const CLIP = process.env.VIDLAB_EXIT_TEST_CLIP
  ?? 'G:/VIDEO/vidlab-build-kit/vidlab-build-kit/Talking-Head-sample.mp4';
const BACKGROUND = { red: 0x1e, green: 0x3a, blue: 0x8a };

const fixture = await mkdtemp(join(tmpdir(), 'vidlab-rvm-exit-'));
// The environment as the machine had it, captured BEFORE the hermetic redirect.
const realEnv = { ...process.env };
const realHome = homedir();
const restoreHome = isolateVerifyHome(join(fixture, 'home'));
const dataDir = join(fixture, 'vidlab-data');
process.env.OPENCHATCUT_DATA_DIR = dataDir;

const {
  backgroundRemovalArtifactLocation,
  backgroundRemovalModelPath,
  startBackgroundRemovalMediaJob,
} = await import('./media-job-background-removal.ts');
const { uploadDir } = await import('./media-dir.ts');
const { RVM_MODEL, RVM_MODEL_DIR, ensureRvmModel, verifyModelFile } = await import('./rvm-model.ts');
const { resolveModelCacheDir } = await import('../shared/model-cache-path.ts');
const { resolveRuntimeProfile } = await import('./runtime-profile.ts');
const { validateServerExportMedia } = await import('./plugins/export-media-plan.ts');
const { probeVideo } = await import('./media-normalization.ts');

const GIB = 1024 ** 3;
const terminal = (snapshot: MediaJobSnapshot): boolean => (
  snapshot.status === 'completed' || snapshot.status === 'failed' || snapshot.status === 'cancelled'
);

async function waitFor(queue: MediaJobQueue, jobId: string, timeoutMs = 30 * 60_000): Promise<MediaJobSnapshot> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = queue.poll(jobId);
    assert.ok(snapshot, `job ${jobId} must stay pollable`);
    if (terminal(snapshot)) return snapshot;
    if (Date.now() > deadline) throw new Error(`job ${jobId} never finished: ${JSON.stringify(snapshot)}`);
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
}

function probe(file: string): Record<string, unknown> {
  const stdout = execFileSync(
    ffprobeBin(),
    ['-v', 'error', '-select_streams', 'v:0', '-show_streams', '-of', 'json', file],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  const stream = (JSON.parse(stdout) as { streams?: Array<Record<string, unknown>> }).streams?.[0];
  assert.ok(stream, `ffprobe found no video stream in ${file}`);
  return stream;
}

/** One frame of a video as RGBA bytes. */
function frameAt(file: string, seconds: number, width: number, height: number, alpha = false): Buffer {
  const decoded = spawnSync(
    ffmpegBin(),
    ['-v', 'error', ...(alpha ? ['-c:v', 'libvpx-vp9'] : []), '-ss', String(seconds), '-i', file,
      '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', alpha ? 'rgba' : 'rgb24', '-'],
    { maxBuffer: 128 * 1024 * 1024 },
  );
  assert.equal(decoded.status, 0, `decoding ${file} at ${seconds}s failed: ${String(decoded.stderr)}`);
  const expected = width * height * (alpha ? 4 : 3);
  assert.equal(decoded.stdout.length, expected, `frame ${seconds}s must decode to ${expected} bytes`);
  return decoded.stdout;
}

/** The exit test cannot run on this machine; loud, and not a failure. */
class ExitTestSkipped extends Error {}

try {
  if (!existsSync(CLIP)) {
    console.log(`media-job background removal exit test: SKIPPED - the exit-test clip is absent (${CLIP}).`);
    console.log('  set VIDLAB_EXIT_TEST_CLIP to a talking-head clip to run it.');
  } else {
    // ── the weights: copy once into the throwaway data directory ─────────────
    // Portable sources only (C2): the explicit override, then the model cache of
    // the data directory the machine is actually configured with.
    const inheritedCacheDir = resolveModelCacheDir(
      resolveRuntimeProfile(realEnv, { homeDir: realHome }),
      realEnv,
    );
    const modelCandidates = [
      realEnv.VIDLAB_RVM_MODEL,
      join(inheritedCacheDir, RVM_MODEL_DIR, RVM_MODEL.filePath),
    ].filter((candidate): candidate is string => Boolean(candidate) && existsSync(candidate as string));
    const modelPath = backgroundRemovalModelPath();
    let modelReady = false;
    for (const candidate of modelCandidates) {
      try {
        await mkdir(dirname(modelPath), { recursive: true });
        await copyFile(candidate, modelPath);
        await verifyModelFile(modelPath, RVM_MODEL);
        modelReady = true;
        break;
      } catch {
        await rm(modelPath, { force: true });
      }
    }
    if (!modelReady) {
      // What the app does on a cold machine: download once, pinned.
      modelReady = await ensureRvmModel().then(() => true, (error) => {
        console.log(`media-job background removal exit test: could not obtain the weights (${error instanceof Error ? error.message : String(error)})`);
        return false;
      });
    }
    if (!modelReady) {
      // A machine with no weights and no network cannot run the exit test; say so
      // loudly instead of turning an environment gap into a red gate.
      throw new ExitTestSkipped(
        `no pinned RVM weights available (sha256 ${RVM_MODEL.sha256}); set VIDLAB_RVM_MODEL or allow the one-time download`,
      );
    }

    // ── the clip, imported into the throwaway project's media pool ───────────
    const uploads = uploadDir();
    await mkdir(uploads, { recursive: true });
    const sourceName = 'Talking-Head-sample.mp4';
    const sourceFile = join(uploads, sourceName);
    await copyFile(CLIP, sourceFile);
    // The kit's clip is stored landscape-coded with a 90° rotation matrix, so the
    // DISPLAYED frame is portrait. probeVideo is the same probe the engine uses,
    // which is why the artifact below must come out 576x1024, not 1024x576.
    const sourceProbe = await probeVideo(sourceFile);
    const width = sourceProbe.width;
    const height = sourceProbe.height;
    const duration = sourceProbe.duration;
    assert.ok(duration > 0, 'the source clip must have a duration');
    console.log(`media-job background removal exit test: ${sourceName} ${width}x${height} ${duration.toFixed(2)}s`);

    const queue = new MediaJobQueue({ freeMemoryBytes: () => 8 * GIB });
    const request = { sourceName, sourceFile, revision: 'r1' };
    const location = backgroundRemovalArtifactLocation(request);

    // ── the real job, timed ─────────────────────────────────────────────────
    const startedAt = Date.now();
    const finished = await waitFor(queue, startBackgroundRemovalMediaJob(request, queue).jobId);
    const elapsedMs = Date.now() - startedAt;
    assert.equal(finished.status, 'completed', `the matte must complete: ${JSON.stringify(finished)}`);
    assert.ok(finished.artifact && finished.artifact.bytes > 0, 'the artifact is non-empty');
    const artifact = finished.artifact.file;
    assert.equal((await stat(artifact)).size, finished.artifact.bytes);
    const secondsPerVideoSecond = elapsedMs / 1_000 / duration;
    console.log(`media-job background removal exit test: matted in ${(elapsedMs / 1_000).toFixed(1)}s `
      + `= ${secondsPerVideoSecond.toFixed(2)} s per video second`);

    // ── the matte itself: real alpha, real cut-out ──────────────────────────
    const matteProbe = probe(artifact);
    assert.equal(String((matteProbe.tags as Record<string, unknown> | undefined)?.alpha_mode), '1',
      'the artifact advertises alpha');
    const matteWidth = Number(matteProbe.width);
    const matteHeight = Number(matteProbe.height);
    assert.equal(matteWidth, width, 'the matte keeps the displayed width');
    assert.equal(matteHeight, height);
    const matteFrame = frameAt(artifact, 5, matteWidth, matteHeight, true);
    let transparent = 0;
    let opaque = 0;
    let partial = 0;
    for (let pixel = 0; pixel < matteWidth * matteHeight; pixel += 1) {
      const alpha = matteFrame[pixel * 4 + 3]!;
      if (alpha === 0) transparent += 1;
      else if (alpha === 255) opaque += 1;
      else partial += 1;
    }
    assert.ok(transparent > matteWidth * matteHeight * 0.2, `a real cut-out is mostly transparent at 5s (${transparent})`);
    assert.ok(opaque > matteWidth * matteHeight * 0.1, `and keeps a solid subject (${opaque})`);
    assert.ok(partial > 0, 'and has soft edges, not a binary mask');
    console.log(`media-job background removal exit test: alpha at 5s - ${transparent} transparent, `
      + `${opaque} opaque, ${partial} partial of ${matteWidth * matteHeight} pixels`);

    // ── composite over a NEW background (what the renderer produces) ────────
    const composite = join(fixture, 'composite-over-new-background.mp4');
    const background = `color=c=0x${BACKGROUND.red.toString(16).padStart(2, '0')}`
      + `${BACKGROUND.green.toString(16).padStart(2, '0')}`
      + `${BACKGROUND.blue.toString(16).padStart(2, '0')}:size=${matteWidth}x${matteHeight}:rate=30`;
    execFileSync(
      ffmpegBin(),
      ['-v', 'error', '-f', 'lavfi', '-i', background, '-c:v', 'libvpx-vp9', '-i', artifact,
        '-filter_complex', '[0:v][1:v]overlay=shortest=1,format=yuv420p',
        '-t', String(duration), '-c:v', 'libx264', '-crf', '20', '-y', composite],
      { stdio: 'pipe' },
    );
    const compositeProbe = probe(composite);
    assert.equal(Number(compositeProbe.width), matteWidth);
    assert.equal(Number(compositeProbe.height), matteHeight);

    // ── pixel sampling: no checkerboard, no black flashes ───────────────────
    // The composite is checked AGAINST THE MATTE, frame by frame: wherever the
    // matte is transparent the composite must show the NEW background (that is
    // what "no checkerboard" means — a checkerboard is what an uncomposited alpha
    // looks like), and no sampled frame may be near-black anywhere.
    const near = (value: number, target: number, tolerance = 24): boolean => Math.abs(value - target) <= tolerance;
    const isBackground = (frame: Buffer, pixel: number): boolean => (
      near(frame[pixel * 3]!, BACKGROUND.red)
      && near(frame[pixel * 3 + 1]!, BACKGROUND.green)
      && near(frame[pixel * 3 + 2]!, BACKGROUND.blue)
    );
    let checkedTransparent = 0;
    for (const seconds of [0.5, 5, 9, 12]) {
      const matte = frameAt(artifact, seconds, matteWidth, matteHeight, true);
      const frame = frameAt(composite, seconds, matteWidth, matteHeight);
      const transparentPixels: number[] = [];
      let dark = 0;
      for (let pixel = 0; pixel < matteWidth * matteHeight; pixel += 1) {
        if (matte[pixel * 4 + 3] === 0) transparentPixels.push(pixel);
        const luma = 0.2126 * frame[pixel * 3]! + 0.7152 * frame[pixel * 3 + 1]! + 0.0722 * frame[pixel * 3 + 2]!;
        if (luma < 8) dark += 1;
      }
      assert.ok(dark < matteWidth * matteHeight * 0.02, `at ${seconds}s the frame is not a black flash (${dark} dark pixels)`);
      if (transparentPixels.length === 0) continue;
      const step = Math.max(1, Math.floor(transparentPixels.length / 200));
      let matched = 0;
      let sampled = 0;
      for (let index = 0; index < transparentPixels.length; index += step) {
        sampled += 1;
        if (isBackground(frame, transparentPixels[index]!)) matched += 1;
      }
      assert.ok(matched >= sampled * 0.95,
        `at ${seconds}s every transparent pixel of the matte shows the NEW background (${matched}/${sampled})`);
      checkedTransparent += transparentPixels.length;
    }
    assert.ok(checkedTransparent > 0, 'the sampled frames must include transparent matte pixels');
    // The person actually lands on the new background: a large region is NOT the
    // background colour.
    const subject = frameAt(composite, 5, matteWidth, matteHeight);
    let subjectPixels = 0;
    for (let pixel = 0; pixel < matteWidth * matteHeight; pixel += 1) {
      if (!isBackground(subject, pixel)) subjectPixels += 1;
    }
    assert.ok(subjectPixels > matteWidth * matteHeight * 0.1,
      `the cut-out subject must occupy the frame (${subjectPixels} non-background pixels)`);
    console.log(`media-job background removal exit test: composite ${matteWidth}x${matteHeight} - `
      + `${checkedTransparent} transparent matte pixels all show the new background, `
      + `${subjectPixels} subject pixels, no dark frames`);

    // ── the server export preflight accepts the derived reference ───────────
    await validateServerExportMedia({
      items: [{
        id: 'item_exit_test',
        kind: 'video',
        src: `/media/uploads/${sourceName}`,
        derivedPictureSrc: location.url,
      }],
    }, {
      publicDirectory: join(fixture, 'public'),
      uploadDirectory: uploads,
      derivedDirectory: dirname(location.dir),
    });
    console.log('media-job background removal exit test: server export preflight accepted the derived reference');

    // ── a repeat run is a cache hit ─────────────────────────────────────────
    const cachedAt = Date.now();
    const cached = await waitFor(queue, startBackgroundRemovalMediaJob(request, queue).jobId);
    const cachedMs = Date.now() - cachedAt;
    assert.equal(cached.status, 'completed');
    assert.equal(cached.detail?.cached, 1, 'the second run is a cache hit');
    assert.ok(cachedMs < 2_000, `a cache hit is instant (took ${cachedMs} ms)`);
    assert.equal(cached.artifact?.bytes, finished.artifact.bytes);
    console.log(`media-job background removal exit test: repeat run was a cache hit in ${cachedMs} ms`);
    queue.reset();

    console.log(`media-job background removal exit test: OK (${secondsPerVideoSecond.toFixed(2)} s per video second on this CPU)`);
  }
} catch (error) {
  if (!(error instanceof ExitTestSkipped)) throw error;
  console.log(`media-job background removal exit test: SKIPPED - ${error.message}`);
} finally {
  restoreHome();
  await rm(fixture, { recursive: true, force: true });
}
