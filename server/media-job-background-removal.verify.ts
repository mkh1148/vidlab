// D1b · the real matting engine, plugged into the D-job module with NO module
// changes, proven end to end on this machine.
//
// What this pins down:
//
//   1. the engine fits `run(signal, onProgress)`: server/media-job.ts is consumed
//      unchanged, and this suite would not compile against a different shape;
//   2. reviewer condition C2: `requiredBytes` is the MEASURED working set of the
//      engine child, not the 1.5 GiB admission floor, and a forced-low memory
//      reading DEFERS the job (a wait, never an error);
//   3. the artifact is a real VP9-with-alpha WebM: the container advertises alpha,
//      the libvpx decoder sees a `yuva` pixel format, and a frame decodes with a
//      fourth channel (the native vp9 decoder silently drops alpha, so the check
//      names its decoder on purpose);
//   4. a synthetic clip with no person keeps the ORIGINAL picture fully opaque —
//      transparency there would export black and look like a bug;
//   5. a repeat run is a cache hit (instant, no child spawned);
//   6. cancel reaches the real spawned child (pid), the child dies, and neither
//      the artifact nor its `.partial.webm` is left behind;
//   7. the kill wiring is load-bearing: with the kill hook stubbed out, the same
//      assertion catches the surviving child.
//
// The 15 MB weights come from PORTABLE sources only (reviewer condition C2):
// VIDLAB_RVM_MODEL, or the configured data directory's model cache composed by
// the app's own resolver — never a bench path or a hard-coded drive. When
// neither has them the app's download-once path fetches them into THIS verify's
// throwaway data dir, which is what a cold machine does. The pinned sha256 is
// checked either way, and the engine-run half skips LOUDLY if the download
// cannot happen. It never writes outside its throwaway data directory.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { HEAVY_JOB_MIN_WORKING_SET_BYTES } from '../shared/heavy-job-admission.ts';
import { isolateVerifyHome } from '../shared/verify-home.ts';
import { ffmpegBin, ffprobeBin } from './media-binaries.ts';
import { MediaJobQueue, type MediaJobSnapshot } from './media-job.ts';

const realHome = homedir();
// The environment as the machine had it, captured BEFORE the hermetic redirect:
// the configured data dir (and any model-cache override) is resolved from THIS,
// not from the throwaway fixture.
const realEnv = { ...process.env };
const fixture = await mkdtemp(join(tmpdir(), 'vidlab-rvm-job-'));
const restoreHome = isolateVerifyHome(join(fixture, 'home'));
const dataDir = join(fixture, 'vidlab-data');
process.env.OPENCHATCUT_DATA_DIR = dataDir;

// Imported AFTER the redirect: server/runtime-profile.ts resolves the active
// profile once, at module load, so a static import would resolve the real
// checkout's media directory.
const {
  RVM_DEFAULT_DOWNSAMPLE_RATIO,
  RVM_JOB_REQUIRED_BYTES,
  backgroundRemovalArtifactLocation,
  backgroundRemovalModelPath,
  rvmPartialPath,
  startBackgroundRemovalMediaJob,
} = await import('./media-job-background-removal.ts');
const { mediaJobDerivedRoot } = await import('./media-job-artifact.ts');
const { RVM_ENGINE_VERSION, RVM_MODEL, RVM_MODEL_DIR, ensureRvmModel, verifyModelFile } = await import('./rvm-model.ts');
const { resolveModelCacheDir } = await import('../shared/model-cache-path.ts');
const { resolveRuntimeProfile } = await import('./runtime-profile.ts');

const GIB = 1024 ** 3;
const ROOMY = (): number => 8 * GIB;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });
const DERIVED_URL = /^\/media\/derived\/([^/?#]+)\/([^/?#]+)$/;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const terminal = (snapshot: MediaJobSnapshot): boolean => (
  snapshot.status === 'completed' || snapshot.status === 'failed' || snapshot.status === 'cancelled'
);

async function waitFor(
  queue: MediaJobQueue,
  jobId: string,
  predicate: (snapshot: MediaJobSnapshot) => boolean,
  timeoutMs = 180_000,
): Promise<MediaJobSnapshot> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = queue.poll(jobId);
    assert.ok(snapshot, `job ${jobId} must stay pollable`);
    if (predicate(snapshot)) return snapshot;
    if (Date.now() > deadline) {
      throw new Error(`job ${jobId} never reached the expected state: ${JSON.stringify(snapshot)}`);
    }
    await sleep(25);
  }
}

function pidOf(snapshot: MediaJobSnapshot): number | undefined {
  const raw = snapshot.detail?.pid;
  return typeof raw === 'number' ? raw : undefined;
}

function probe(file: string, extra: readonly string[] = []): Record<string, unknown> {
  const stdout = execFileSync(
    ffprobeBin(),
    ['-v', 'error', ...extra, '-select_streams', 'v:0', '-show_streams', '-of', 'json', file],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout) as { streams?: Array<Record<string, unknown>> };
  const stream = parsed.streams?.[0];
  assert.ok(stream, `ffprobe found no video stream in ${file}`);
  return stream;
}

try {
  // ── 1. the engine contract, without running anything ──────────────────────
  assert.equal(RVM_JOB_REQUIRED_BYTES, 384 * 1024 * 1024, 'requiredBytes is the measured 384 MiB, not a guess');
  assert.notEqual(
    RVM_JOB_REQUIRED_BYTES,
    HEAVY_JOB_MIN_WORKING_SET_BYTES,
    'C2: the engine passes its own measurement, never the 1.5 GiB admission floor',
  );
  assert.ok(
    RVM_JOB_REQUIRED_BYTES < HEAVY_JOB_MIN_WORKING_SET_BYTES,
    'the measured working set is below the floor, which is why passing the floor would over-refuse',
  );
  assert.ok(
    RVM_JOB_REQUIRED_BYTES > 292 * 1024 * 1024,
    'and it is above the 292.5 MiB sample, so the headroom for the two FFmpeg children is real',
  );
  assert.match(backgroundRemovalModelPath(), /^.*models[\\/]rvm[\\/]rvm_mobilenetv3_fp32\.onnx$/, 'H3 resolver path');
  assert.ok(backgroundRemovalModelPath().startsWith(dataDir), 'the weights resolve inside the data directory');

  const request = { sourceName: 'clip.mp4', sourceFile: join(fixture, 'clip.mp4'), revision: 'r1' };
  const location = backgroundRemovalArtifactLocation(request);
  assert.match(location.url, DERIVED_URL, 'C1: the artifact url is /media/derived/<sourceKey>/<name>');
  assert.equal(location.url, `/media/derived/${location.sourceKey}/${encodeURIComponent(location.name)}`);
  assert.ok(location.dir.startsWith(mediaJobDerivedRoot()), 'artifacts live under the derived root');
  assert.equal(dirname(location.file), location.dir, 'the artifact sits directly in its per-source directory');
  assert.ok(location.name.includes(RVM_ENGINE_VERSION), 'the engine version is part of the artifact identity');
  assert.ok(
    location.name.includes(String(RVM_DEFAULT_DOWNSAMPLE_RATIO)),
    'the downsample ratio changes the output, so it is part of the identity too',
  );
  assert.ok(location.name.endsWith('.webm'), 'VP9 alpha is a WebM container');

  // Per-source placement, and the NTFS case-merge class stays closed.
  const other = backgroundRemovalArtifactLocation({ ...request, sourceName: 'other.mp4' });
  assert.notEqual(other.dir, location.dir, 'two sources never share a directory');
  const cased = backgroundRemovalArtifactLocation({ ...request, sourceName: 'Clip.mp4' });
  assert.notEqual(cased.sourceKey, location.sourceKey, 'clip.mp4 and Clip.mp4 must not merge on NTFS');
  const revised = backgroundRemovalArtifactLocation({ ...request, revision: 'r2' });
  assert.notEqual(revised.name, location.name, 'a new source revision is a new artifact, not a stale hit');
  const reratioed = backgroundRemovalArtifactLocation({ ...request, ratio: 0.25 });
  assert.notEqual(reratioed.name, location.name, 'a different ratio is a different artifact');

  // Cleanup-under-abort: the partial is co-resident and unmistakable.
  assert.equal(dirname(rvmPartialPath(location.file)), location.dir, 'the partial lives beside its final name');
  assert.ok(rvmPartialPath(location.file).endsWith('.partial.webm'), 'a partial can never be mistaken for finished work');

  // ── 2. keyed dedupe: a double click cannot queue the same matte twice ─────
  {
    const queue = new MediaJobQueue({ freeMemoryBytes: ROOMY });
    const dedupeRequest = { ...request, sourceName: 'dedupe.mp4' };
    const first = startBackgroundRemovalMediaJob(dedupeRequest, queue);
    const second = startBackgroundRemovalMediaJob(dedupeRequest, queue);
    assert.equal(second.jobId, first.jobId, 'the same key reuses the in-flight job');
    assert.equal(second.deduped, true);
    assert.equal(first.deduped, false);
    queue.cancel(first.jobId);
    const settled = await waitFor(queue, first.jobId, terminal, 30_000);
    assert.equal(settled.status, 'cancelled');
    assert.equal(settled.code, 'job_cancelled', 'a cancel carries a machine-parseable code');
    assert.equal(settled.artifact, null);
    assert.equal(queue.snapshot().length, 1, 'a deduped start created no second job');
    queue.reset();
  }

  // ── 3. the weights: copy once into the data directory, verify the pin ─────
  // Portable sources only (C2): the explicit override, then the model cache of
  // the data directory the machine is actually configured with — composed by the
  // same resolver the app uses, so no drive path is baked into a verify.
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
      console.log(`media-job background removal: weights from ${candidate} (pinned sha256 verified)`);
      break;
    } catch (error) {
      await rm(modelPath, { force: true });
      console.log(`media-job background removal: ${candidate} is not the pinned model (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  if (!modelReady) {
    // Neither portable source had them, so do what the app does on a cold
    // machine: download ONCE into this verify's data-dir cache, pinned by size
    // and sha256. A machine with no network still skips, loudly.
    try {
      const resolved = await ensureRvmModel();
      modelReady = true;
      console.log(`media-job background removal: weights downloaded once into the data-dir cache (${resolved.bytes} bytes, pinned sha256 verified)`);
    } catch (error) {
      console.log(`media-job background removal: could not obtain the weights (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  if (!modelReady) {
    console.log('media-job background removal: SKIPPED the engine-run half - no pinned RVM weights on this machine.');
    console.log('  set VIDLAB_RVM_MODEL to rvm_mobilenetv3_fp32.onnx (sha256 ' + RVM_MODEL.sha256 + ') to run it.');
    console.log('media-job background removal: contract, identity, placement and dedupe verified: OK (engine run skipped)');
  } else {
    // ── 4. a tiny synthetic clip with nothing in it ──────────────────────────
    // A flat grey frame is the honest no-person fixture: RVM finds no person, so
    // the engine must keep the ORIGINAL picture. (A test pattern is NOT a valid
    // fixture here — the model hallucinates a person in `smptebars` and returns a
    // nearly-empty matte, which would test the model's out-of-distribution
    // behaviour instead of the rule.)
    const sourceFile = join(fixture, 'synthetic-no-person.mp4');
    execFileSync(
      ffmpegBin(),
      ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x303030:size=128x128:rate=30', '-frames:v', '10',
        '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', '30', '-y', sourceFile],
      { stdio: 'pipe' },
    );
    assert.ok(existsSync(sourceFile), 'the synthetic source clip must exist');

    const queue = new MediaJobQueue({ freeMemoryBytes: ROOMY });
    const runRequest = { sourceName: 'synthetic-no-person.mp4', sourceFile, revision: 'r1' };
    const runLocation = backgroundRemovalArtifactLocation(runRequest);

    // ── 5. the real run ─────────────────────────────────────────────────────
    const startedAt = Date.now();
    const started = startBackgroundRemovalMediaJob(runRequest, queue);
    const completed = await waitFor(queue, started.jobId, terminal);
    const elapsedMs = Date.now() - startedAt;
    assert.equal(completed.status, 'completed', `the matte must complete: ${JSON.stringify(completed)}`);
    assert.equal(completed.code, null);
    assert.equal(completed.progress, 1);
    assert.ok(completed.artifact, 'a completed job reports its artifact');
    assert.equal(completed.artifact.file, runLocation.file);
    assert.match(completed.artifact.url, DERIVED_URL);
    assert.ok(completed.artifact.bytes > 0, 'the artifact is non-empty');
    assert.equal((await stat(runLocation.file)).size, completed.artifact.bytes);
    assert.equal(existsSync(rvmPartialPath(runLocation.file)), false, 'a finished job leaves no partial behind');
    assert.ok(pidOf(completed) !== undefined, 'the engine reported the child pid it spawned');
    assert.ok(Number(completed.detail?.frame) > 0, 'the child reported frame progress');
    assert.ok(completed.detail?.cached === undefined, 'a first run is not a cache hit');

    // ── 6. the artifact really carries alpha ────────────────────────────────
    const nativeProbe = probe(runLocation.file);
    assert.equal(nativeProbe.codec_name, 'vp9');
    assert.equal(String((nativeProbe.tags as Record<string, unknown> | undefined)?.alpha_mode), '1',
      'the container advertises an alpha channel');
    const width = Number(nativeProbe.width);
    const height = Number(nativeProbe.height);
    assert.equal(width, 128);
    assert.equal(height, 128);

    // The decode names its decoder: the native vp9 decoder silently drops the
    // alpha plane, so `libvpx-vp9` is the only honest reader. ffmpeg reports the
    // pixel format it actually opened, and the raw frame proves the channel.
    const decoded = spawnSync(
      ffmpegBin(),
      ['-v', 'info', '-c:v', 'libvpx-vp9', '-i', runLocation.file, '-frames:v', '1',
        '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(decoded.status, 0, `the artifact must decode: ${String(decoded.stderr)}`);
    assert.match(String(decoded.stderr), /yuva420p/, 'the libvpx decoder opened a pixel format WITH alpha');
    const rgba = decoded.stdout;
    assert.equal(rgba.length, width * height * 4, 'the decoded frame has a fourth (alpha) channel');
    let transparent = 0;
    let red = 0;
    let green = 0;
    let blue = 0;
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      if (rgba[pixel * 4 + 3] !== 255) transparent += 1;
      red += rgba[pixel * 4]!;
      green += rgba[pixel * 4 + 1]!;
      blue += rgba[pixel * 4 + 2]!;
    }
    assert.equal(transparent, 0,
      'no person in the frame: the ORIGINAL picture is kept fully opaque (transparency would export black)');
    const pixels = width * height;
    for (const [channel, total] of [['red', red], ['green', green], ['blue', blue]] as const) {
      const mean = total / pixels;
      assert.ok(Math.abs(mean - 0x30) <= 12,
        `the kept picture is the source grey, not black (${channel} mean ${mean.toFixed(1)} vs 48)`);
    }

    // ── 7. a repeat run is a cache hit, with no child spawned ───────────────
    const cachedAt = Date.now();
    const cached = await waitFor(queue, startBackgroundRemovalMediaJob(runRequest, queue).jobId, terminal);
    const cachedMs = Date.now() - cachedAt;
    assert.equal(cached.status, 'completed');
    assert.equal(cached.detail?.cached, 1, 'the second run reports a cache hit');
    assert.equal(pidOf(cached), undefined, 'a cache hit spawns no engine child');
    assert.ok(cachedMs < 2_000, `a cache hit is instant (took ${cachedMs} ms)`);
    assert.equal(cached.artifact?.bytes, completed.artifact.bytes);
    console.log(`media-job background removal: 10 frames of 128x128 matted in ${elapsedMs} ms `
      + `(${(elapsedMs / (10 / 30) / 1_000).toFixed(2)} s per video second); cache hit in ${cachedMs} ms`);

    // ── 8. C2: a forced-low reading DEFERS, and the job runs when it lifts ──
    {
      const freeMemory = { value: 0 };
      const gated = new MediaJobQueue({ freeMemoryBytes: () => freeMemory.value, gateRecheckMs: 30 });
      const deferredRequest = { ...runRequest, sourceName: 'deferred.mp4' };
      const deferredStart = startBackgroundRemovalMediaJob(deferredRequest, gated);
      const deferred = await waitFor(gated, deferredStart.jobId, (snapshot) => snapshot.status === 'deferred', 10_000);
      assert.equal(deferred.deferred, true);
      assert.equal(deferred.code, 'ram_below_gate', 'a defer names its reason in the code');
      assert.equal(deferred.error, null, 'a defer is not an error the owner has to read');
      assert.equal(deferred.progress, 0, 'nothing ran while the gate was closed');
      assert.equal(terminal(deferred), false, 'a deferred job is still alive');
      assert.equal(existsSync(backgroundRemovalArtifactLocation(deferredRequest).file), false,
        'a deferred job has not written anything');

      freeMemory.value = 8 * GIB;
      const lifted = await waitFor(gated, deferredStart.jobId, terminal);
      assert.equal(lifted.status, 'completed', 'the job runs once the gate lifts');
      assert.equal(lifted.deferred, false);
      assert.ok(existsSync(backgroundRemovalArtifactLocation(deferredRequest).file));
      gated.reset();
    }

    // ── 9. cancel kills the REAL child and leaves nothing ───────────────────
    async function assertCancelKillsChild(kill?: (child: import('node:child_process').ChildProcess) => void) {
      const cancelRequest = {
        ...runRequest,
        sourceName: kill ? 'cancel-mutant.mp4' : 'cancel.mp4',
        ...(kill ? { kill } : {}),
      };
      const cancelLocation = backgroundRemovalArtifactLocation(cancelRequest);
      const cancelStart = startBackgroundRemovalMediaJob(cancelRequest, queue);
      const running = await waitFor(queue, cancelStart.jobId, (snapshot) => (
        snapshot.status === 'running' && pidOf(snapshot) !== undefined
      ), 60_000);
      const pid = pidOf(running);
      assert.ok(pid, 'the engine must report the child pid it spawned');
      assert.equal(processAlive(pid), true, 'the child is alive while the job runs');
      assert.equal(existsSync(cancelLocation.dir), true, 'the engine created the per-source directory');

      const cancelled = queue.cancel(cancelStart.jobId);
      assert.equal(cancelled?.status, 'cancelled', 'cancel reports cancelled immediately');
      assert.equal(cancelled?.code, 'job_cancelled');
      assert.equal(cancelled?.error, 'media job cancelled');
      await sleep(400);
      const alive = processAlive(pid);
      if (!kill) {
        assert.equal(alive, false, 'the spawned child must be dead after a cancel (SIGKILL, no SIGTERM first)');
        const settled = await waitFor(queue, cancelStart.jobId, terminal, 30_000);
        assert.equal(settled.status, 'cancelled');
        assert.equal(settled.artifact, null, 'a cancelled job reports no artifact');
        assert.equal(existsSync(cancelLocation.file), false, 'a cancelled job leaves no artifact');
        assert.equal(existsSync(rvmPartialPath(cancelLocation.file)), false, 'and no partial either');
        const leftovers = (await readdir(cancelLocation.dir).catch(() => [] as string[]))
          .filter((name) => name.includes('.partial'));
        assert.deepEqual(leftovers, [], 'the per-source directory holds no partial after a cancel');
        return { pid, alive };
      }
      // Mutation: the kill hook is stubbed out, so the same check must catch it.
      return { pid, alive };
    }

    await assertCancelKillsChild();
    console.log('media-job background removal: cancel reached the real RVM child and left no artifact or partial');

    const mutant = await assertCancelKillsChild(() => undefined);
    assert.equal(mutant.alive, true, 'with the kill wiring stubbed out the child survives - the assertion is load-bearing');
    process.kill(mutant.pid, 'SIGKILL');
    await sleep(300);
    assert.equal(processAlive(mutant.pid), false, 'the mutant child is cleaned up by the verify itself');
    queue.reset();

    console.log('media-job background removal: engine contract, C2 gate, alpha artifact, no-person rule, cache hit, cancel: OK');
  }
} finally {
  restoreHome();
  await rm(fixture, { recursive: true, force: true });
}
