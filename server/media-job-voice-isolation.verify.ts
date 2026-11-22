// D6 · the voice-isolation engine: separation, the D2 chain, and the defect class the
// legacy route left open.
//
// The kit's exit test is "a clip with music under speech: the processed track has
// audibly reduced music; both files remain; processing time recorded". This file proves
// the engine half of it on a SYNTHETIC fixture (D-7: no owner data in tests).
//
// The fixture is a chord of four music tones (196/247/294/392 Hz) under a GATED
// BROADBAND "voice", and the metric is the music's SHARE of the total energy:
//
//   musicShare = mean(dB of the four tones) - rms(dB of the whole signal)
//
// A share, not an absolute level, because the chain ends with a linear loudness gain:
// an absolute measurement would move by the gain and prove nothing about separation.
//
// Why the voice is broadband noise and not a tone — measured, not assumed. A pure tone
// is not speech, and Spleeter says so: on a tonal fixture (a 1 kHz "voice" over the same
// chord) the vocals stem comes back at -105.8 dB RMS, i.e. EMPTY, and the artifact with
// it. A reduction assertion on an empty artifact passes vacuously — it would hold even
// if the engine deleted everything. A gated broadband voice survives the separation
// (stem -30.1 dB RMS) while the chord is rejected (-145 dB), so the reduction is
// measured against a stem that actually has content.
//
// What this fixture CANNOT prove is speech preservation: RNNoise's voice-activity model
// is trained on real speech, and no synthetic signal is speech. That claim is proven by
// the exit test on a real recording (docs/d-job-implementation.md §D6), exactly as D2's
// verify states for its own chain.
//
// Also proven here, on this engine's own job rather than on a synthetic one:
//
//   * requiredBytes is the measured constant, below the admission floor, above the
//     re-measured child peak;
//   * a forced-low memory reading DEFERS the job (a wait, not an error) and it runs
//     when the gate lifts;
//   * a repeat run is a cache hit with no child spawned;
//   * cancel SIGKILLs the real child pid, leaves no artifact and no intermediate;
//   * the kill wiring is load-bearing (stubbed out, the child survives);
//   * the source file is byte-identical before and after (I4: the source is untouched).
//
// Run: npx tsx server/media-job-voice-isolation.verify.ts
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { HEAVY_JOB_MIN_WORKING_SET_BYTES } from '../shared/heavy-job-admission.ts';
import { sha256File } from '../shared/node-content-hash.ts';
import { isolateVerifyHome } from '../shared/verify-home.ts';
import { ffmpegBin } from './media-binaries.ts';
import { MediaJobQueue, type MediaJobSnapshot } from './media-job.ts';

const realHome = homedir();
// The environment as the machine had it, captured BEFORE the hermetic redirect: the
// configured data dir (and any model-cache override) is resolved from THIS.
const realEnv = { ...process.env };
const fixture = await mkdtemp(join(tmpdir(), 'vidlab-voice-isolation-'));
const restoreHome = isolateVerifyHome(join(fixture, 'home'));
const dataDir = join(fixture, 'vidlab-data');
process.env.OPENCHATCUT_DATA_DIR = dataDir;

// Imported AFTER the redirect: server/runtime-profile.ts resolves the active profile
// once, at module load, so a static import would resolve the real checkout's media dir.
const {
  VOICE_ISOLATION_JOB_REQUIRED_BYTES,
  VOICE_ISOLATION_THREADS,
  startVoiceIsolationMediaJob,
  voiceIsolationArtifactLocation,
  voiceIsolationMixPath,
  voiceIsolationModelPaths,
  voiceIsolationStemPath,
} = await import('./media-job-voice-isolation.ts');
const { mediaJobDerivedRoot } = await import('./media-job-artifact.ts');
const { SPLEETER_MODEL, SPLEETER_MODEL_DIR, VOICE_ISOLATION_ENGINE_VERSION, verifySpleeterFile } = await import('./spleeter-model.ts');
const { RNNOISE_MODEL, RNNOISE_MODEL_DIR, ensureRnnoiseModel, verifyRnnoiseModelFile } = await import('./rnnoise-model.ts');
const { probeAudio, voiceCleanupPartialPath, voiceCleanupStage1Path } = await import('./media-job-voice-cleanup.ts');
// The chain module is the shared surface; D2 re-exports the helpers it always had, but
// the entry point is imported from its own module so the dependency is visible.
const { runVoiceCleanupChain } = await import('./voice-cleanup-chain.ts');
const { SPLEETER_SAMPLE_RATE } = await import('./spleeter-spectrogram.ts');
const { resolveModelCacheDir } = await import('../shared/model-cache-path.ts');
const { resolveRuntimeProfile } = await import('./runtime-profile.ts');

const GIB = 1024 ** 3;
const ROOMY = (): number => 8 * GIB;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });
const DERIVED_URL = /^\/media\/derived\/([^/?#]+)\/([^/?#]+)$/;

/** The music chord of the fixture. */
const MUSIC_HZ = [196, 247, 294, 392] as const;

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

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every descendant of `pid`, read from the process table.
 *
 * The orphaned-child class the legacy route created is closed by the claim "the
 * separation child spawns nothing". That is a claim about code shape, and code shape
 * is not evidence — a helper that shells out tomorrow would keep this file green. So
 * the claim is checked against the OS: the child's whole subtree is enumerated while
 * it runs, and again after the cancel.
 *
 * Windows has no cheap `ps`; `Get-CimInstance Win32_Process` is the supported one.
 * Elsewhere `ps -eo pid,ppid` is. Both return pid/parent pairs and the walk is shared.
 */
function processTree(): { pid: number; parent: number }[] {
  if (process.platform === 'win32') {
    const result = spawnSync(
      'powershell',
      ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
    );
    if (result.status !== 0) throw new Error(`could not read the process table: ${String(result.stderr)}`);
    const parsed = JSON.parse(result.stdout || '[]') as unknown;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map((row) => {
      const entry = row as { ProcessId?: number; ParentProcessId?: number };
      return { pid: Number(entry.ProcessId), parent: Number(entry.ParentProcessId) };
    });
  }
  const result = spawnSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`could not read the process table: ${String(result.stderr)}`);
  return result.stdout.trim().split('\n').map((line) => {
    const [pid, parent] = line.trim().split(/\s+/).map(Number);
    return { pid: pid ?? 0, parent: parent ?? 0 };
  });
}

/** The live descendants of `pid`, breadth-first over the process table. */
function descendantsOf(pid: number): number[] {
  const table = processTree();
  const found: number[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const row of table) {
      if (row.parent !== parent || row.pid === pid || found.includes(row.pid)) continue;
      found.push(row.pid);
      queue.push(row.pid);
    }
  }
  return found;
}

/**
 * Wait for a file to disappear.
 *
 * A cancelled job reports `cancelled` the instant the broker aborts (media-job.ts
 * documents why: a cancelled job must never be able to report success afterwards), so
 * the engine's own cleanup runs AFTER the terminal status is visible. The absence of an
 * intermediate is therefore a settled fact, not an instant one — asserted with a
 * deadline rather than by sleeping a guessed amount.
 */
async function waitForAbsent(file: string, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (existsSync(file) && Date.now() < deadline) await sleep(50);
  return !existsSync(file);
}

/** Decode a file to mono f32 at the separation rate, so measurements are in samples. */
function decodeMono(file: string): Float32Array {
  const result = spawnSync(
    ffmpegBin(),
    ['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', String(SPLEETER_SAMPLE_RATE), '-f', 'f32le', '-'],
    { maxBuffer: 512 * 1024 * 1024 },
  );
  assert.equal(result.status, 0, `could not decode ${file}: ${String(result.stderr)}`);
  const buffer = result.stdout as Buffer;
  const copy = new ArrayBuffer(buffer.byteLength - (buffer.byteLength % 4));
  new Uint8Array(copy).set(buffer.subarray(0, copy.byteLength));
  return new Float32Array(copy);
}

/** Energy at one frequency over a window, by a single-bin DFT. */
function toneDb(samples: Float32Array, hz: number, from: number, to: number): number {
  const start = Math.max(0, from);
  const end = Math.min(samples.length, to);
  const count = end - start;
  if (count <= 0) return -Infinity;
  const w = (2 * Math.PI * hz) / SPLEETER_SAMPLE_RATE;
  let re = 0;
  let im = 0;
  for (let i = 0; i < count; i += 1) {
    const s = samples[start + i]!;
    re += s * Math.cos(w * i);
    im -= s * Math.sin(w * i);
  }
  return 20 * Math.log10(Math.hypot(re, im) / count + 1e-12);
}

/** RMS of a window in dBFS. */
function rmsDb(samples: Float32Array, from: number, to: number): number {
  const start = Math.max(0, from);
  const end = Math.min(samples.length, to);
  if (end <= start) return -Infinity;
  let total = 0;
  for (let i = start; i < end; i += 1) total += samples[i]! * samples[i]!;
  return 20 * Math.log10(Math.sqrt(total / (end - start)) + 1e-12);
}

/**
 * The music's share of the total energy, in dB, over one window.
 *
 * The music level is the mean of the four chord tones; the total is the RMS of the
 * same window of the same signal. Both move together under any single gain, so the
 * chain's linear loudness stage cancels out of the difference and what is left is the
 * separation's own work.
 */
function musicShareDb(samples: Float32Array, from: number, to: number): number {
  const music = MUSIC_HZ.map((hz) => toneDb(samples, hz, from, to));
  const meanMusic = music.reduce((sum, value) => sum + value, 0) / music.length;
  return meanMusic - rmsDb(samples, from, to);
}

try {
  // ── 1. the engine contract, without running anything ──────────────────────
  assert.equal(VOICE_ISOLATION_JOB_REQUIRED_BYTES, 1024 * 1024 * 1024,
    'requiredBytes is the measured constant rounded to a power of two, not a guess');
  assert.notEqual(VOICE_ISOLATION_JOB_REQUIRED_BYTES, HEAVY_JOB_MIN_WORKING_SET_BYTES,
    'C2: the engine passes its own measurement, never the 1.5 GiB admission floor');
  assert.ok(VOICE_ISOLATION_JOB_REQUIRED_BYTES < HEAVY_JOB_MIN_WORKING_SET_BYTES,
    'the measured working set is below the floor, which is why passing the floor would over-refuse');
  assert.ok(VOICE_ISOLATION_JOB_REQUIRED_BYTES > 556_085_248,
    'and it is above the largest re-measured child peak (530.3 MiB), so the headroom is real');
  assert.equal(VOICE_ISOLATION_THREADS, 6, 'the physical cores of the target machine');

  const request = { sourceName: 'clip.mp4', sourceFile: join(fixture, 'clip.mp4'), revision: 'r1' };
  const location = voiceIsolationArtifactLocation(request);
  assert.match(location.url, DERIVED_URL, 'C1: the artifact url is /media/derived/<sourceKey>/<name>');
  assert.equal(location.url, `/media/derived/${location.sourceKey}/${encodeURIComponent(location.name)}`);
  assert.ok(location.dir.startsWith(mediaJobDerivedRoot()), 'artifacts live under the derived root');
  assert.equal(dirname(location.file), location.dir, 'the artifact sits directly in its per-source directory');
  assert.ok(location.name.includes(VOICE_ISOLATION_ENGINE_VERSION), 'the engine version is part of the identity');
  assert.ok(location.name.includes('isolated'), 'the feature marker is part of the name');
  assert.ok(location.name.endsWith('.wav'), 'an isolated track is a WAV: no second lossy generation');
  assert.ok(!location.name.includes('voice-v'), 'the name cannot collide with D2\'s cleaned track for the same source');
  const other = voiceIsolationArtifactLocation({ ...request, sourceName: 'other.mp4' });
  assert.notEqual(other.dir, location.dir, 'two sources never share a directory');
  const cased = voiceIsolationArtifactLocation({ ...request, sourceName: 'Clip.mp4' });
  assert.notEqual(cased.sourceKey, location.sourceKey, 'clip.mp4 and Clip.mp4 must not merge on NTFS');
  const revised = voiceIsolationArtifactLocation({ ...request, revision: 'r2' });
  assert.notEqual(revised.name, location.name, 'a new source revision is a new artifact, not a stale hit');

  // Cleanup-under-abort: every intermediate is co-resident and unmistakable.
  assert.equal(dirname(voiceIsolationMixPath(location.file)), location.dir, 'the decoded mix lives beside its final name');
  assert.ok(voiceIsolationMixPath(location.file).endsWith('.mix.f32'), 'a decoded mix is identifiable');
  assert.ok(voiceIsolationStemPath(location.file).endsWith('.vocals.wav'), 'the raw stem is identifiable');
  assert.ok(voiceCleanupPartialPath(location.file).endsWith('.partial.wav'), 'and the chain keeps its own partial');
  assert.ok(voiceCleanupStage1Path(location.file).endsWith('.stage1.wav'));

  // The model paths are derived from the pins, never hand-typed.
  const modelPaths = voiceIsolationModelPaths();
  assert.ok(modelPaths.vocals.endsWith(join(SPLEETER_MODEL_DIR, SPLEETER_MODEL.vocals.fileName)));
  assert.ok(modelPaths.accompaniment.endsWith(join(SPLEETER_MODEL_DIR, SPLEETER_MODEL.accompaniment.fileName)));
  assert.ok(modelPaths.cleanup.endsWith(join(RNNOISE_MODEL_DIR, RNNOISE_MODEL.fileName)));
  for (const path of Object.values(modelPaths)) {
    assert.ok(path.startsWith(dataDir), `the weights resolve inside the data directory: ${path}`);
  }

  // ── 2. keyed dedupe: a double click cannot queue the same separation twice ──
  {
    const queue = new MediaJobQueue({ freeMemoryBytes: ROOMY });
    const dedupeRequest = { ...request, sourceName: 'dedupe.mp4' };
    const first = startVoiceIsolationMediaJob(dedupeRequest, queue);
    const second = startVoiceIsolationMediaJob(dedupeRequest, queue);
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

  // ── 3. the weights: copy the pinned pair in, verify the pins ──────────────
  const inheritedCacheDir = resolveModelCacheDir(
    resolveRuntimeProfile(realEnv, { homeDir: realHome }),
    realEnv,
  );
  const separationReady = await provisionPair(inheritedCacheDir, modelPaths);
  const cleanupReady = await provisionCleanup(inheritedCacheDir, modelPaths.cleanup);

  if (!separationReady || !cleanupReady) {
    console.log('voice isolation: SKIPPED the engine-run half - the pinned weights are not available on this machine.');
    console.log(`  separation: ${SPLEETER_MODEL.modelId} (${SPLEETER_MODEL.vocals.fileName} + ${SPLEETER_MODEL.accompaniment.fileName})`);
    console.log(`  clean-up:   ${RNNOISE_MODEL.fileName} (sha256 ${RNNOISE_MODEL.sha256})`);
    console.log('voice isolation: contract, identity, placement, model paths and dedupe verified: OK (engine run skipped)');
  } else {
    // ── 4. the fixture: music under a voice ─────────────────────────────────
    // 2 s. The voice is white noise gated to 0.3..1.7 s (broadband, so the separator
    // keeps it in the vocals stem — see the header for the measured reason a tonal
    // "voice" would make this test vacuous). The music is a four-note chord at a level
    // that is clearly measurable. Both are synthesized: no owner data (D-7).
    const sourceFile = join(fixture, 'music-under-speech.wav');
    execFileSync(
      ffmpegBin(),
      ['-v', 'error',
        '-f', 'lavfi', '-i', 'anoisesrc=d=2:c=white:a=0.3:r=44100:seed=11',
        '-f', 'lavfi', '-i', 'sine=frequency=196:sample_rate=44100:duration=2',
        '-f', 'lavfi', '-i', 'sine=frequency=247:sample_rate=44100:duration=2',
        '-f', 'lavfi', '-i', 'sine=frequency=294:sample_rate=44100:duration=2',
        '-f', 'lavfi', '-i', 'sine=frequency=392:sample_rate=44100:duration=2',
        '-filter_complex',
        "[0:a]volume='if(between(t,0.3,1.7),1,0)':eval=frame[voice];"
        + '[1:a]volume=0.18[m1];[2:a]volume=0.18[m2];[3:a]volume=0.18[m3];[4:a]volume=0.18[m4];'
        + '[m1][m2][m3][m4]amix=inputs=4:normalize=0[music];'
        + '[voice][music]amix=inputs=2:duration=first:normalize=0[out]',
        '-map', '[out]', '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', '-y', sourceFile],
      { stdio: 'pipe' },
    );
    assert.ok(existsSync(sourceFile), 'the music-under-speech fixture must exist');
    const sourceHash = await sha256File(sourceFile);
    const sourceSamples = decodeMono(sourceFile);
    const voiceFrom = Math.round(0.4 * SPLEETER_SAMPLE_RATE);
    const voiceTo = Math.round(1.6 * SPLEETER_SAMPLE_RATE);
    const sourceShare = musicShareDb(sourceSamples, voiceFrom, voiceTo);
    // The CONTROL: the measurement must see the music in the source. Without it, "the
    // share dropped" could just mean this meter cannot see these tones at all.
    assert.ok(sourceShare > -40,
      `the CONTROL: the fixture's music must be measurable before processing `
      + `(music share ${sourceShare.toFixed(1)} dB)`);
    const probe = await probeAudio(sourceFile);
    assert.equal(probe.channels, 2, 'the fixture is stereo');
    assert.ok(Math.abs(probe.duration - 2) < 0.05, `the fixture is 2 s (probed ${probe.duration})`);

    const queue = new MediaJobQueue({ freeMemoryBytes: ROOMY });

    // ── 4b. a short machine DEFERS this engine's job; it is a wait, never an error ──
    {
      const gateRequest = { sourceName: 'music-under-speech.wav', sourceFile, revision: 'gate' };
      const freeMemory = { value: 0 };
      const gated = new MediaJobQueue({ freeMemoryBytes: () => freeMemory.value, gateRecheckMs: 30 });
      const started = startVoiceIsolationMediaJob(gateRequest, gated);
      const deferred = await waitFor(gated, started.jobId, (snapshot) => snapshot.status === 'deferred', 30_000);
      assert.equal(deferred.deferred, true, 'the job is deferred, not started');
      assert.equal(deferred.code, 'ram_below_gate', 'a defer names its reason in the code');
      assert.equal(deferred.error, null, 'a defer is not an error the owner has to read');
      assert.equal(terminal(deferred), false, 'a deferred job is still alive, not failed');
      assert.equal(deferred.progress, 0, 'nothing ran while the gate was closed');
      assert.equal(pidOf(deferred), undefined, 'no engine child was spawned while the gate was closed');

      freeMemory.value = 8 * GIB;
      const lifted = await waitFor(gated, started.jobId, terminal, 300_000);
      assert.equal(lifted.status, 'completed', `the job runs once the gate lifts: ${JSON.stringify(lifted)}`);
      assert.ok(lifted.artifact && lifted.artifact.bytes > 0, 'and it produces its artifact');
      gated.reset();
      console.log('voice isolation: a forced-low memory reading deferred the job and it ran when the gate lifted');
    }

    // ── 5. the exit test: reduced music, both tones measured ────────────────
    {
      const runRequest = { sourceName: 'music-under-speech.wav', sourceFile, revision: 'r1' };
      const runLocation = voiceIsolationArtifactLocation(runRequest);
      const startedAt = Date.now();
      const started = startVoiceIsolationMediaJob(runRequest, queue);
      const completed = await waitFor(queue, started.jobId, terminal, 300_000);
      const elapsedMs = Date.now() - startedAt;
      assert.equal(completed.status, 'completed', `the job must complete: ${JSON.stringify(completed)}`);
      assert.equal(completed.code, null);
      assert.equal(completed.progress, 1);
      assert.ok(completed.artifact, 'a completed job reports its artifact');
      assert.equal(completed.artifact.file, runLocation.file);
      assert.match(completed.artifact.url, DERIVED_URL);
      assert.ok(completed.artifact.bytes > 0, 'the artifact is non-empty');
      assert.equal((await stat(runLocation.file)).size, completed.artifact.bytes);
      assert.ok(pidOf(completed) !== undefined, 'the engine reported the child pid it spawned');
      assert.equal(completed.detail?.cached, undefined, 'a first run is not a cache hit');

      const artifactSamples = decodeMono(runLocation.file);
      const artifactShare = musicShareDb(artifactSamples, voiceFrom, voiceTo);
      const reduction = sourceShare - artifactShare;
      assert.ok(reduction >= 10,
        `the processed track must have audibly less music: music share of the voice `
        + `window ${sourceShare.toFixed(1)} -> ${artifactShare.toFixed(1)} dB `
        + `(${reduction.toFixed(1)} dB reduction)`);
      // The anti-vacuity guard: a separator that outputs silence (or a stem with no
      // voice in it) would satisfy the reduction assertion trivially. The artifact must
      // still carry energy in the voice window.
      const artifactVoiceRms = rmsDb(artifactSamples, voiceFrom, voiceTo);
      assert.ok(artifactVoiceRms > -60,
        `the voice must survive: the artifact is not silent in the voice window `
        + `(${artifactVoiceRms.toFixed(1)} dB RMS)`);

      // The CONTROL, permanent (the F1a falsifier): the same fixture through the D2
      // chain with NO separation must not reproduce the reduction. Without it, a future
      // change to the chain's EQ could inflate the number while the model does less work,
      // and every assertion above would stay green. Measured on the exit-test fixture:
      // the chain alone accounts for 4.4 dB of the pipeline's 22.2 dB.
      {
        const chainOnly = join(fixture, 'chain-only.wav');
        const models = voiceIsolationModelPaths();
        await runVoiceCleanupChain({
          inputFile: sourceFile,
          outputFile: chainOnly,
          modelFile: models.cleanup,
          channels: 2,
          duration: probe.duration,
        });
        const chainShare = musicShareDb(decodeMono(chainOnly), voiceFrom, voiceTo);
        const chainReduction = sourceShare - chainShare;
        assert.ok(chainReduction < reduction / 2,
          `the chain alone must not explain the reduction: chain-only ${chainReduction.toFixed(1)} dB `
          + `against the full pipeline's ${reduction.toFixed(1)} dB`);
        console.log(`voice isolation: the chain alone accounts for ${chainReduction.toFixed(1)} dB of the `
          + `${reduction.toFixed(1)} dB, so the model is doing the work`);
      }

      // I4: the source is untouched, byte for byte.
      assert.equal(await sha256File(sourceFile), sourceHash, 'I4: the source file is byte-identical after processing');

      // Both files remain: the source and the processed artifact.
      assert.ok(existsSync(sourceFile), 'the original file is still there');
      assert.ok(existsSync(runLocation.file), 'and the processed file is there too');

      // A finished job leaves no intermediate behind.
      assert.equal(existsSync(voiceIsolationMixPath(runLocation.file)), false, 'no decoded mix left behind');
      assert.equal(existsSync(voiceIsolationStemPath(runLocation.file)), false, 'no raw stem left behind');
      assert.equal(existsSync(voiceCleanupPartialPath(runLocation.file)), false, 'no partial left behind');
      assert.equal(existsSync(voiceCleanupStage1Path(runLocation.file)), false, 'no stage-1 track left behind');

      console.log(`voice isolation: music share ${sourceShare.toFixed(1)} -> ${artifactShare.toFixed(1)} dB `
        + `(${reduction.toFixed(1)} dB reduction), voice window RMS ${artifactVoiceRms.toFixed(1)} dB, `
        + `${elapsedMs} ms for 2 s of audio`);

      // ── 6. a repeat run is a cache hit, with no child spawned ─────────────
      const cachedAt = Date.now();
      const cached = await waitFor(queue, startVoiceIsolationMediaJob(runRequest, queue).jobId, terminal);
      const cachedMs = Date.now() - cachedAt;
      assert.equal(cached.status, 'completed');
      assert.equal(cached.detail?.cached, 1, 'the second run reports a cache hit');
      assert.equal(pidOf(cached), undefined, 'a cache hit spawns no engine child');
      assert.ok(cachedMs < 2_000, `a cache hit is instant (took ${cachedMs} ms)`);
      assert.equal(cached.artifact?.bytes, completed.artifact.bytes);
    }

    // ── 7. cancel kills the real child and leaves nothing behind ────────────
    {
      // A long fixture, so the separation is certainly still running when cancelled.
      const longFile = join(fixture, 'music-under-speech-long.wav');
      execFileSync(
        ffmpegBin(),
        ['-v', 'error',
          '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=44100:duration=120',
          '-f', 'lavfi', '-i', 'sine=frequency=196:sample_rate=44100:duration=120',
          '-filter_complex', '[0:a]volume=0.10[v];[1:a]volume=0.09[m];[v][m]amix=inputs=2:duration=first:normalize=0[out]',
          '-map', '[out]', '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', '-y', longFile],
        { stdio: 'pipe' },
      );
      const cancelRequest = { sourceName: 'music-under-speech-long.wav', sourceFile: longFile, revision: 'r1' };
      const cancelLocation = voiceIsolationArtifactLocation(cancelRequest);
      const started = startVoiceIsolationMediaJob(cancelRequest, queue);
      const running = await waitFor(queue, started.jobId, (snapshot) => pidOf(snapshot) !== undefined, 120_000);
      const pid = pidOf(running);
      assert.ok(pid !== undefined, 'the engine must report the child pid while it runs');
      assert.equal(processAlive(pid), true, 'the child is alive before the cancel');

      // F4: the child spawns NOTHING, and nothing outlives the cancel. The legacy
      // route's defect was a child the broker could not reach; "this child has no
      // children" is what makes that class unreachable here, so it is read off the
      // process table rather than asserted from the source.
      const subtree = descendantsOf(pid);
      assert.deepEqual(subtree, [], 'the separation child spawns no grandchild');
      console.log(`voice isolation: the running child (pid ${pid}) has ${subtree.length} descendant(s) in the process table`);

      queue.cancel(started.jobId);
      const cancelled = await waitFor(queue, started.jobId, terminal, 30_000);
      assert.equal(cancelled.status, 'cancelled');
      assert.equal(cancelled.code, 'job_cancelled');
      assert.equal(cancelled.artifact, null, 'a cancelled job has no artifact');
      const deadline = Date.now() + 10_000;
      while (processAlive(pid) && Date.now() < deadline) await sleep(50);
      assert.equal(processAlive(pid), false, 'the SIGKILL reached the separation child');
      // The other half of F4: whatever the child DID have (nothing, per the check
      // above) must be gone too — polled for ten seconds, because a kill is not
      // instantaneous and a survivor that dies in 200 ms is not a defect.
      const orphanDeadline = Date.now() + 10_000;
      let survivors = subtree.filter((child) => processAlive(child));
      while (survivors.length > 0 && Date.now() < orphanDeadline) {
        await sleep(100);
        survivors = subtree.filter((child) => processAlive(child));
      }
      assert.deepEqual(survivors, [], 'no descendant of the cancelled child survives it');
      console.log('voice isolation: after the cancel the child and its whole subtree are gone from the process table');
      assert.equal(existsSync(cancelLocation.file), false, 'a cancelled job leaves no artifact');
      assert.ok(await waitForAbsent(voiceIsolationMixPath(cancelLocation.file)), 'and no decoded mix');
      assert.ok(await waitForAbsent(voiceIsolationStemPath(cancelLocation.file)), 'and no raw stem');

      // ── 8. the kill wiring is load-bearing ───────────────────────────────
      // With the kill hook stubbed out the same assertion must FAIL, which is the only
      // way "cancel kills the child" is a checked claim rather than a hope.
      const stubRequest = { sourceName: 'music-under-speech-long.wav', sourceFile: longFile, revision: 'r2', kill: () => undefined };
      const stubLocation = voiceIsolationArtifactLocation(stubRequest);
      const stubbed = startVoiceIsolationMediaJob(stubRequest, queue);
      const stubRunning = await waitFor(queue, stubbed.jobId, (snapshot) => pidOf(snapshot) !== undefined, 120_000);
      const stubPid = pidOf(stubRunning);
      assert.ok(stubPid !== undefined);
      queue.cancel(stubbed.jobId);
      await waitFor(queue, stubbed.jobId, terminal, 30_000);
      const stubDeadline = Date.now() + 3_000;
      while (!processAlive(stubPid) && Date.now() < stubDeadline) await sleep(50);
      assert.equal(processAlive(stubPid), true,
        'with the kill hook stubbed out the child survives, so the real hook is what kills it');
      // Clean up the survivor so the verify leaves no process behind.
      try {
        process.kill(stubPid, 'SIGKILL');
      } catch {
        // already gone
      }
      const stubDeadline2 = Date.now() + 10_000;
      while (processAlive(stubPid) && Date.now() < stubDeadline2) await sleep(50);
      await rm(stubLocation.file, { force: true });
    }

    queue.reset();

    // ── 9. the route body: its two refusals and the revision passthrough ─────
    // This is the D6 surface an HTTP caller actually reaches, so its refusals are the
    // contract's first line: each is a `{error, code}` a client branches on, not a
    // stack trace. The route starts on the GLOBAL queue (it has no queue argument), so
    // the two starts below are cancelled through that queue rather than left running.
    {
      const { startVoiceIsolationJobFromBody } = await import('./plugins/media-job-voice-isolation.ts');
      const { MediaJobRouteError } = await import('./media-job-routes.ts');
      const { mediaJobs } = await import('./media-job.ts');
      const { uploadDir } = await import('./media-dir.ts');

      // The route names its source by media-pool upload name, so the fixture has to be
      // IN the pool for the passthrough case; the refusals below need no file at all.
      const poolName = 'route-refusal-fixture.wav';
      const poolFile = join(uploadDir(), poolName);
      await mkdir(uploadDir(), { recursive: true });
      await copyFile(sourceFile, poolFile);

      assert.throws(
        () => startVoiceIsolationJobFromBody({}),
        (error: unknown) => error instanceof MediaJobRouteError
          && error.code === 'invalid_argument'
          && error.status === 400,
        'a body with no sourceName is refused as invalid_argument',
      );
      assert.throws(
        () => startVoiceIsolationJobFromBody({ sourceName: 'not-in-the-pool.wav' }),
        (error: unknown) => error instanceof MediaJobRouteError
          && error.code === 'source_not_found'
          && error.status === 404,
        'a source outside the media pool is refused as source_not_found',
      );

      // The revision must reach the artifact identity: that is what stops a re-imported
      // source from hitting the previous import's cache. The job key IS the artifact
      // path, so a job id carrying the revision is the passthrough, observed.
      const first = startVoiceIsolationJobFromBody({ sourceName: poolName, revision: 'revA' });
      const second = startVoiceIsolationJobFromBody({ sourceName: poolName, revision: 'revB' });
      assert.notEqual(first.jobId, second.jobId, 'two revisions are two artifacts, not one cache entry');
      // The job KEY is the artifact path, so the key carrying the revision is the
      // passthrough observed rather than inferred from the job id being different.
      const firstKey = mediaJobs.poll(first.jobId)?.key ?? '';
      const secondKey = mediaJobs.poll(second.jobId)?.key ?? '';
      assert.ok(firstKey.includes('revA'), `the revision reaches the artifact identity (${firstKey})`);
      assert.ok(secondKey.includes('revB'), `the revision reaches the artifact identity (${secondKey})`);
      const again = startVoiceIsolationJobFromBody({ sourceName: poolName, revision: 'revA' });
      assert.equal(again.jobId, first.jobId, 'the same revision is the same job');
      assert.equal(again.deduped, true, 'and it is deduped rather than separated twice');
      mediaJobs.cancel(first.jobId);
      mediaJobs.cancel(second.jobId);
      await waitFor(mediaJobs, first.jobId, terminal, 30_000);
      await waitFor(mediaJobs, second.jobId, terminal, 30_000);
      await rm(poolFile, { force: true });
    }

    console.log('media-job voice isolation: separation, reduction, both files, cache hit, defer, cancel and kill wiring: OK');
  }
} finally {
  restoreHome();
  await rm(fixture, { recursive: true, force: true });
}

/** Copy the pinned Spleeter pair into the throwaway cache, or download it once. */
async function provisionPair(
  inheritedCacheDir: string,
  paths: { vocals: string; accompaniment: string },
): Promise<boolean> {
  const candidates = [
    realEnv.VIDLAB_SPLEETER_MODELS,
    join(inheritedCacheDir, SPLEETER_MODEL_DIR),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const dir of candidates) {
    try {
      await mkdir(dirname(paths.vocals), { recursive: true });
      await copyFile(join(dir, SPLEETER_MODEL.vocals.fileName), paths.vocals);
      await copyFile(join(dir, SPLEETER_MODEL.accompaniment.fileName), paths.accompaniment);
      await verifySpleeterFile(paths.vocals, SPLEETER_MODEL.vocals);
      await verifySpleeterFile(paths.accompaniment, SPLEETER_MODEL.accompaniment);
      console.log(`voice isolation: separation weights from ${dir} (pinned sha256 verified)`);
      return true;
    } catch {
      await rm(paths.vocals, { force: true });
      await rm(paths.accompaniment, { force: true });
    }
  }
  try {
    const { ensureSpleeterModels } = await import('./spleeter-model.ts');
    const resolved = await ensureSpleeterModels();
    console.log(`voice isolation: separation weights downloaded once (${resolved.bytes} bytes, pinned sha256 verified)`);
    return true;
  } catch (error) {
    console.log(`voice isolation: could not obtain the separation weights (${error instanceof Error ? error.message : String(error)})`);
    return false;
  }
}

/** Copy the pinned RNNoise model into the throwaway cache, or download it once. */
async function provisionCleanup(inheritedCacheDir: string, target: string): Promise<boolean> {
  const candidates = [
    realEnv.VIDLAB_RNNOISE_MODEL,
    join(inheritedCacheDir, RNNOISE_MODEL_DIR, RNNOISE_MODEL.fileName),
  ].filter((candidate): candidate is string => Boolean(candidate) && existsSync(candidate as string));
  for (const candidate of candidates) {
    try {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(candidate, target);
      await verifyRnnoiseModelFile(target, RNNOISE_MODEL);
      console.log(`voice isolation: clean-up weights from ${candidate} (pinned sha256 verified)`);
      return true;
    } catch {
      await rm(target, { force: true });
    }
  }
  try {
    const resolved = await ensureRnnoiseModel();
    console.log(`voice isolation: clean-up weights downloaded once (${resolved.bytes} bytes, pinned sha256 verified)`);
    return true;
  } catch (error) {
    console.log(`voice isolation: could not obtain the clean-up weights (${error instanceof Error ? error.message : String(error)})`);
    return false;
  }
}
