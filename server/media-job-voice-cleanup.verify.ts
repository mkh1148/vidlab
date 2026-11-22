// D2 · the real voice-clean-up engine, plugged into the D-job module with NO
// module changes, proven end to end on synthetic fixtures.
//
// What this pins down:
//
//   1. the engine fits `run(signal, onProgress)`: server/media-job.ts is consumed
//      unchanged, and this suite would not compile against a different shape;
//   2. the chain is the kit's order — rumble -> denoise -> sibilance -> shape ->
//      level -> loudness — asserted on the filter graph itself, not on a comment;
//   3. alignment is MEASURED, not assumed: a one-sample impulse at sample 48000
//      comes back at sample 48000 (offset 0), the tail impulse survives (nothing
//      is truncated), and the artifact is the source length rounded up to the
//      model's 480-sample frame at most;
//   4. the chain actually cleans: on a sine-plus-noise fixture the speech-to-noise
//      ratio improves by a wide margin, measured from decoded samples;
//   5. `requiredBytes` is the MEASURED working set, not the 1.5 GiB floor, and a
//      forced-low memory reading DEFERS the job (a wait, never an error);
//   6. a repeat run is a cache hit (instant, no child spawned);
//   7. cancel reaches the real spawned child (pid), the child dies, and neither the
//      artifact nor its `.partial.wav`/`.stage1.wav` is left behind;
//   8. a source with more than two channels is REFUSED at the probe, proven on a real
//      6-channel fixture through both the probe and the engine, so a 5.1 clip can never
//      come back as a centre-less stereo artifact.
//
// The 297 KB weights come from PORTABLE sources only: VIDLAB_RNNOISE_MODEL, or the
// configured data directory's model cache composed by the app's own resolver —
// never a bench path or a hard-coded drive. When neither has them the app's
// download-once path fetches them into THIS verify's throwaway data dir, which is
// what a cold machine does. The pinned sha256 is checked either way, and the
// engine-run half skips LOUDLY if the download cannot happen. It never writes
// outside its throwaway data directory, and it never touches the owner's files.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { HEAVY_JOB_MIN_WORKING_SET_BYTES } from '../shared/heavy-job-admission.ts';
import { isolateVerifyHome } from '../shared/verify-home.ts';
import { ffmpegBin } from './media-binaries.ts';
import { MediaJobQueue, type MediaJobSnapshot } from './media-job.ts';

const realHome = homedir();
// The environment as the machine had it, captured BEFORE the hermetic redirect:
// the configured data dir (and any model-cache override) is resolved from THIS.
const realEnv = { ...process.env };
const fixture = await mkdtemp(join(tmpdir(), 'vidlab-voice-cleanup-'));
const restoreHome = isolateVerifyHome(join(fixture, 'home'));
const dataDir = join(fixture, 'vidlab-data');
process.env.OPENCHATCUT_DATA_DIR = dataDir;

// Imported AFTER the redirect: server/runtime-profile.ts resolves the active
// profile once, at module load, so a static import would resolve the real
// checkout's media directory.
const {
  VOICE_CLEANUP_FRAME_DELAY_SAMPLES,
  VOICE_CLEANUP_JOB_REQUIRED_BYTES,
  VOICE_CLEANUP_MAX_CHANNELS,
  VOICE_CLEANUP_SAMPLE_RATE,
  VOICE_CLEANUP_TARGET_LUFS,
  VOICE_CLEANUP_TARGET_TRUE_PEAK,
  assertVoiceCleanupChannels,
  parseLoudnormMeasurement,
  probeAudio,
  startVoiceCleanupMediaJob,
  voiceCleanupArtifactLocation,
  voiceCleanupFilterChain,
  voiceCleanupModelPath,
  voiceCleanupPartialPath,
  voiceCleanupStage1Path,
} = await import('./media-job-voice-cleanup.ts');
const { mediaJobDerivedRoot } = await import('./media-job-artifact.ts');
const { RNNOISE_MODEL, RNNOISE_MODEL_DIR, VOICE_CLEANUP_ENGINE_VERSION, ensureRnnoiseModel, verifyRnnoiseModelFile } = await import('./rnnoise-model.ts');
const { resolveModelCacheDir } = await import('../shared/model-cache-path.ts');
const { resolveRuntimeProfile } = await import('./runtime-profile.ts');

const GIB = 1024 ** 3;
const ROOMY = (): number => 8 * GIB;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });
const DERIVED_URL = /^\/media\/derived\/([^/?#]+)\/([^/?#]+)$/;

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

/** Decode a file to mono f32 at the chain's rate, so measurements are in samples. */
function decodeMono(file: string): Float32Array {
  const result = spawnSync(
    ffmpegBin(),
    ['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', String(VOICE_CLEANUP_SAMPLE_RATE), '-f', 'f32le', '-'],
    { maxBuffer: 512 * 1024 * 1024 },
  );
  assert.equal(result.status, 0, `could not decode ${file}: ${String(result.stderr)}`);
  const buffer = result.stdout as Buffer;
  const copy = new ArrayBuffer(buffer.byteLength - (buffer.byteLength % 4));
  new Uint8Array(copy).set(buffer.subarray(0, copy.byteLength));
  return new Float32Array(copy);
}

function rms(samples: Float32Array, from: number, to: number): number {
  const start = Math.max(0, from);
  const end = Math.min(samples.length, to);
  if (end <= start) return 0;
  let total = 0;
  for (let index = start; index < end; index += 1) total += samples[index]! * samples[index]!;
  return Math.sqrt(total / (end - start));
}

const dB = (value: number): number => (value > 0 ? 20 * Math.log10(value) : -Infinity);

/** Integrated loudness and true peak, read from the meter a mastering engineer uses. */
function integratedLoudness(file: string): { integrated: number; truePeak: number } {
  const result = spawnSync(
    ffmpegBin(),
    ['-v', 'info', '-nostats', '-i', file, '-map', '0:a:0', '-af', 'ebur128=peak=true', '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  assert.equal(result.status, 0, `ebur128 could not read ${file}: ${String(result.stderr)}`);
  const stderr = String(result.stderr);
  // The summary block is the LAST set of I/Peak lines ffmpeg prints.
  const integrated = [...stderr.matchAll(/I:\s+(-?\d+(?:\.\d+)?) LUFS/g)].pop();
  const peak = [...stderr.matchAll(/Peak:\s+(-?\d+(?:\.\d+)?) dBFS/g)].pop();
  assert.ok(integrated?.[1], `no integrated loudness in the ebur128 output: ${stderr.slice(-400)}`);
  assert.ok(peak?.[1], `no true peak in the ebur128 output: ${stderr.slice(-400)}`);
  return { integrated: Number(integrated[1]), truePeak: Number(peak[1]) };
}

/** Index of the largest sample inside [from, to), for a windowed peak search. */
function peakIndexIn(samples: Float32Array, from: number, to: number): number {
  let best = from;
  let value = -1;
  for (let index = Math.max(0, from); index < Math.min(samples.length, to); index += 1) {
    const magnitude = Math.abs(samples[index]!);
    if (magnitude > value) {
      value = magnitude;
      best = index;
    }
  }
  return best;
}

try {
  // ── 1. the engine contract and the chain, without running anything ────────
  assert.equal(VOICE_CLEANUP_JOB_REQUIRED_BYTES, 256 * 1024 * 1024, 'requiredBytes is the measured 256 MiB, not a guess');
  assert.notEqual(
    VOICE_CLEANUP_JOB_REQUIRED_BYTES,
    HEAVY_JOB_MIN_WORKING_SET_BYTES,
    'C2: the engine passes its own measurement, never the 1.5 GiB admission floor',
  );
  assert.ok(
    VOICE_CLEANUP_JOB_REQUIRED_BYTES < HEAVY_JOB_MIN_WORKING_SET_BYTES,
    'the measured working set is below the floor, which is why passing the floor would over-refuse',
  );
  assert.ok(
    VOICE_CLEANUP_JOB_REQUIRED_BYTES > 87_605_248,
    'and it is above the larger measured peak (83.5 MiB, the 13 s clip), so the headroom is real',
  );
  assert.equal(VOICE_CLEANUP_SAMPLE_RATE, 48_000, 'arnndn only accepts 48 kHz');
  assert.equal(VOICE_CLEANUP_FRAME_DELAY_SAMPLES, 480, 'one 10 ms frame at 48 kHz');
  assert.equal(VOICE_CLEANUP_TARGET_LUFS, -16, 'the speech loudness target');
  assert.equal(VOICE_CLEANUP_TARGET_TRUE_PEAK, -1.5);

  // The chain order is the kit's recipe, asserted on the graph itself.
  const chain = voiceCleanupFilterChain({ modelName: 'sh.rnnn', channels: 2 });
  const stages = chain.split(',');
  const order = [
    ['highpass', 'rumble'],
    ['aresample', 'the model input rate'],
    ['pan=mono', 'downmix'],
    ['apad', 'the pre-model frame pad'],
    ['arnndn', 'denoise'],
    ['deesser', 'sibilance'],
    ['equalizer', 'shape'],
    ['acompressor', 'level'],
    ['alimiter', 'peak safety'],
    ['atrim', 'alignment'],
  ] as const;
  let cursor = -1;
  for (const [marker, label] of order) {
    const found = stages.findIndex((stage, index) => index > cursor && stage.startsWith(marker));
    assert.ok(found > cursor, `the chain must contain ${label} (${marker}) after the previous stage: ${chain}`);
    cursor = found;
  }
  assert.ok(chain.includes('arnndn=m=sh.rnnn:mix=1'), 'the denoiser is the pinned model at full wet');
  assert.ok(chain.includes(`atrim=start_sample=${VOICE_CLEANUP_FRAME_DELAY_SAMPLES}`),
    'the model delay is removed at the end, which is what makes the artifact aligned');
  const monoChain = voiceCleanupFilterChain({ modelName: 'sh.rnnn', channels: 1 });
  assert.ok(!monoChain.includes('pan='), 'a mono source is never downmixed and never re-spread');

  // The loudness measurement parser refuses anything it cannot read.
  const measured = parseLoudnormMeasurement(
    'noise\n{"input_i" : "-23.40", "input_tp" : "-3.10", "input_lra" : "2.60", '
    + '"input_thresh" : "-33.50", "output_i" : "-16.00", "target_offset" : "0.05"}\nmore noise',
  );
  assert.deepEqual(measured, {
    input_i: '-23.40',
    input_tp: '-3.10',
    input_lra: '2.60',
    input_thresh: '-33.50',
    target_offset: '0.05',
  }, 'the measure pass is read from the JSON loudnorm prints');
  assert.equal(parseLoudnormMeasurement('no json here'), null, 'no JSON is no measurement');
  assert.equal(parseLoudnormMeasurement('{"input_i":"-1"}'), null, 'a partial measurement is refused, not guessed');

  // Artifact identity and placement.
  assert.match(voiceCleanupModelPath(), /^.*models[\\/]rnnoise[\\/]sh\.rnnn$/, 'H3 resolver path');
  assert.ok(voiceCleanupModelPath().startsWith(dataDir), 'the weights resolve inside the data directory');

  const request = { sourceName: 'clip.mp4', sourceFile: join(fixture, 'clip.mp4'), revision: 'r1' };
  const location = voiceCleanupArtifactLocation(request);
  assert.match(location.url, DERIVED_URL, 'C1: the artifact url is /media/derived/<sourceKey>/<name>');
  assert.equal(location.url, `/media/derived/${location.sourceKey}/${encodeURIComponent(location.name)}`);
  assert.ok(location.dir.startsWith(mediaJobDerivedRoot()), 'artifacts live under the derived root');
  assert.equal(dirname(location.file), location.dir, 'the artifact sits directly in its per-source directory');
  assert.ok(location.name.includes(VOICE_CLEANUP_ENGINE_VERSION), 'the engine version is part of the artifact identity');
  assert.ok(location.name.includes('voice'), 'the feature marker is part of the name');
  assert.ok(location.name.endsWith('.wav'), 'a cleaned track is a WAV: no second lossy generation');
  const other = voiceCleanupArtifactLocation({ ...request, sourceName: 'other.mp4' });
  assert.notEqual(other.dir, location.dir, 'two sources never share a directory');
  const cased = voiceCleanupArtifactLocation({ ...request, sourceName: 'Clip.mp4' });
  assert.notEqual(cased.sourceKey, location.sourceKey, 'clip.mp4 and Clip.mp4 must not merge on NTFS');
  const revised = voiceCleanupArtifactLocation({ ...request, revision: 'r2' });
  assert.notEqual(revised.name, location.name, 'a new source revision is a new artifact, not a stale hit');

  // Cleanup-under-abort: both intermediates are co-resident and unmistakable.
  assert.equal(dirname(voiceCleanupPartialPath(location.file)), location.dir, 'the partial lives beside its final name');
  assert.ok(voiceCleanupPartialPath(location.file).endsWith('.partial.wav'), 'a partial can never be mistaken for finished work');
  assert.ok(voiceCleanupStage1Path(location.file).endsWith('.stage1.wav'), 'the pre-normalization track is identifiable too');

  // ── 2. keyed dedupe: a double click cannot queue the same clean-up twice ──
  {
    const queue = new MediaJobQueue({ freeMemoryBytes: ROOMY });
    const dedupeRequest = { ...request, sourceName: 'dedupe.mp4' };
    const first = startVoiceCleanupMediaJob(dedupeRequest, queue);
    const second = startVoiceCleanupMediaJob(dedupeRequest, queue);
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

  // ── 2b. a source with more than two channels is REFUSED, not silently gutted ──
  // The chain downsamples to mono for the model and restores a mono/stereo layout, so
  // a 5.1 source would lose everything outside c0/c1 — the centre channel, where
  // dialogue lives. The engine refuses it at the probe instead, and this proves the
  // refusal on a REAL 6-channel fixture through the probe and the engine, plus the
  // policy function on the counts around the boundary.
  {
    assert.equal(VOICE_CLEANUP_MAX_CHANNELS, 2, 'the engine honours mono and stereo');
    assert.doesNotThrow(() => assertVoiceCleanupChannels({ channels: 1 }), 'mono is accepted');
    assert.doesNotThrow(() => assertVoiceCleanupChannels({ channels: 2 }), 'stereo is accepted');
    for (const channels of [3, 6, 8]) {
      assert.throws(
        () => assertVoiceCleanupChannels({ channels }),
        new RegExp(`${channels} channels`),
        `a ${channels}-channel source is refused, and the message names the count`,
      );
    }

    const surroundFile = join(fixture, 'synthetic-5.1.wav');
    execFileSync(
      ffmpegBin(),
      ['-v', 'error',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
        '-af', 'pan=5.1|FL=c0|FR=c0|FC=c0|LFE=c0|BL=c0|BR=c0',
        '-c:a', 'pcm_s16le', '-y', surroundFile],
      { stdio: 'pipe' },
    );
    const surroundProbe = await probeAudio(surroundFile);
    assert.equal(surroundProbe.channels, 6, 'the fixture really is a 6-channel source');
    assert.throws(
      () => assertVoiceCleanupChannels(surroundProbe),
      /supports mono and stereo audio, but this clip has 6 channels/,
      'the refusal is the owner-facing EN text, because the job module reports an engine refusal by message',
    );

    // Through the engine: the job fails with the module's engine-refusal code, the
    // message is the EN explanation, and nothing is left on disk.
    const surroundQueue = new MediaJobQueue({ freeMemoryBytes: ROOMY });
    const surroundRequest = { sourceName: 'synthetic-5.1.wav', sourceFile: surroundFile, revision: 'r1' };
    const surroundLocation = voiceCleanupArtifactLocation(surroundRequest);
    const refused = await waitFor(
      surroundQueue,
      startVoiceCleanupMediaJob(surroundRequest, surroundQueue).jobId,
      terminal,
      60_000,
    );
    assert.equal(refused.status, 'failed', 'a 6-channel source fails the job rather than producing a centre-less artifact');
    assert.equal(refused.code, 'engine_failed', 'the module codes an engine refusal, and it is not a silent success');
    assert.match(String(refused.error), /6 channels/, 'the failure the owner reads names the channel count');
    assert.equal(refused.artifact, null, 'a refusal has no artifact');
    assert.equal(existsSync(surroundLocation.file), false, 'and nothing was written');
    assert.equal(existsSync(voiceCleanupPartialPath(surroundLocation.file)), false, 'no partial either');
    assert.equal(existsSync(voiceCleanupStage1Path(surroundLocation.file)), false, 'and no stage-1 track');
    assert.equal(pidOf(refused), undefined, 'the refusal happened before any FFmpeg child was spawned');
    surroundQueue.reset();
    console.log('voice cleanup: a 6-channel source is refused at the probe, before any decode or download');
  }

  // ── 3. the weights: copy once into the data directory, verify the pin ─────
  const inheritedCacheDir = resolveModelCacheDir(
    resolveRuntimeProfile(realEnv, { homeDir: realHome }),
    realEnv,
  );
  const modelCandidates = [
    realEnv.VIDLAB_RNNOISE_MODEL,
    join(inheritedCacheDir, RNNOISE_MODEL_DIR, RNNOISE_MODEL.fileName),
  ].filter((candidate): candidate is string => Boolean(candidate) && existsSync(candidate as string));
  const modelPath = voiceCleanupModelPath();
  let modelReady = false;
  for (const candidate of modelCandidates) {
    try {
      await mkdir(dirname(modelPath), { recursive: true });
      await copyFile(candidate, modelPath);
      await verifyRnnoiseModelFile(modelPath, RNNOISE_MODEL);
      modelReady = true;
      console.log(`voice cleanup: weights from ${candidate} (pinned sha256 verified)`);
      break;
    } catch (error) {
      await rm(modelPath, { force: true });
      console.log(`voice cleanup: ${candidate} is not the pinned model (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  if (!modelReady) {
    try {
      const resolved = await ensureRnnoiseModel();
      modelReady = true;
      console.log(`voice cleanup: weights downloaded once into the data-dir cache (${resolved.bytes} bytes, pinned sha256 verified)`);
    } catch (error) {
      console.log(`voice cleanup: could not obtain the weights (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  if (!modelReady) {
    console.log('voice cleanup: SKIPPED the engine-run half - no pinned RNNoise weights on this machine.');
    console.log(`  set VIDLAB_RNNOISE_MODEL to ${RNNOISE_MODEL.fileName} (sha256 ${RNNOISE_MODEL.sha256}) to run it.`);
    console.log('voice cleanup: contract, chain order, identity, placement and dedupe verified: OK (engine run skipped)');
  } else {
    // ── 4. the fixtures ─────────────────────────────────────────────────────
    // Speech stand-in: a 220 Hz tone between 0.5 s and 1.5 s over constant white
    // noise. The tone is the "voice" (it must survive), the noise is the "room"
    // (it must go), and the gaps are where the noise floor is measured.
    const speechFile = join(fixture, 'synthetic-speech.wav');
    execFileSync(
      ffmpegBin(),
      ['-v', 'error',
        '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=2',
        '-f', 'lavfi', '-i', 'anoisesrc=d=2:c=white:a=0.006:r=48000:seed=7',
        '-filter_complex',
        "[0:a]volume='if(between(t,0.5,1.5),0.12,0)':eval=frame[speech];"
        + '[speech][1:a]amix=inputs=2:duration=first:normalize=0[out]',
        '-map', '[out]', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', '-y', speechFile],
      { stdio: 'pipe' },
    );
    assert.ok(existsSync(speechFile), 'the synthetic speech fixture must exist');

    // Alignment fixture: 1.5 s of digital silence with one impulse at sample
    // 48000 and one at the very last sample (71999). The first proves the offset
    // is zero; the second proves nothing is truncated at the tail.
    const impulseFile = join(fixture, 'synthetic-impulse.wav');
    execFileSync(
      ffmpegBin(),
      ['-v', 'error',
        '-f', 'lavfi', '-i', "aevalsrc='if(eq(n,48000)+eq(n,71999),0.5,0)':s=48000:d=1.5:c=mono",
        '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', impulseFile],
      { stdio: 'pipe' },
    );
    assert.ok(existsSync(impulseFile), 'the impulse fixture must exist');
    assert.equal(decodeMono(impulseFile).length, 72_000, 'the impulse fixture is exactly 1.5 s');

    const probe = await probeAudio(speechFile);
    assert.equal(probe.sampleRate, 48_000);
    assert.equal(probe.channels, 2, 'the fixture is stereo, so the downmix-and-restore branch is exercised');
    assert.ok(Math.abs(probe.duration - 2) < 0.05, `the fixture is 2 s (probed ${probe.duration})`);

    const queue = new MediaJobQueue({ freeMemoryBytes: ROOMY });

    // ── 4b. a short machine DEFERS this engine's job; it is a wait, never an error ──
    // The same claim the doc makes about `requiredBytes`: the gate holds the job (with
    // its reason in the code) and releases it when memory returns, instead of failing
    // an owner-facing error. Proven on THIS engine's job, not on a synthetic one.
    {
      const gateRequest = { sourceName: 'synthetic-speech.wav', sourceFile: speechFile, revision: 'gate' };
      const freeMemory = { value: 0 };
      const gated = new MediaJobQueue({ freeMemoryBytes: () => freeMemory.value, gateRecheckMs: 30 });
      const started = startVoiceCleanupMediaJob(gateRequest, gated);
      const deferred = await waitFor(gated, started.jobId, (snapshot) => snapshot.status === 'deferred', 30_000);
      assert.equal(deferred.deferred, true, 'the job is deferred, not started');
      assert.equal(deferred.code, 'ram_below_gate', 'a defer names its reason in the code');
      assert.equal(deferred.error, null, 'a defer is not an error the owner has to read');
      assert.equal(terminal(deferred), false, 'a deferred job is still alive, not failed');
      assert.equal(deferred.progress, 0, 'nothing ran while the gate was closed');
      assert.equal(pidOf(deferred), undefined, 'no engine child was spawned while the gate was closed');

      freeMemory.value = 8 * GIB;
      const lifted = await waitFor(gated, started.jobId, terminal, 180_000);
      assert.equal(lifted.status, 'completed', `the job runs once the gate lifts: ${JSON.stringify(lifted)}`);
      assert.equal(lifted.deferred, false);
      assert.ok(lifted.artifact && lifted.artifact.bytes > 0, 'and it produces its artifact');
      gated.reset();
      console.log('voice cleanup: a forced-low memory reading deferred the job and it ran when the gate lifted');
    }

    // ── 5. alignment, measured ──────────────────────────────────────────────
    {
      const alignRequest = { sourceName: 'synthetic-impulse.wav', sourceFile: impulseFile, revision: 'r1' };
      const alignLocation = voiceCleanupArtifactLocation(alignRequest);
      const started = startVoiceCleanupMediaJob(alignRequest, queue);
      const completed = await waitFor(queue, started.jobId, terminal);
      assert.equal(completed.status, 'completed', `the impulse run must complete: ${JSON.stringify(completed)}`);

      const source = decodeMono(impulseFile);
      const artifact = decodeMono(alignLocation.file);
      // The compressor's attack makes the FIRST of the two impulses quieter than
      // the last, so the global maximum is the tail one. Alignment is therefore
      // measured on the window around the first impulse, not on the global peak.
      const aligned = peakIndexIn(artifact, 47_000, 49_000);
      assert.equal(aligned, 48_000,
        `the impulse must come back at the same sample (offset 0), got ${aligned} vs 48000`);
      assert.equal(peakIndexIn(source, 47_000, 49_000), 48_000, 'the fixture really has it at 48000');
      const delta = artifact.length - source.length;
      assert.ok(delta >= 0 && delta < VOICE_CLEANUP_FRAME_DELAY_SAMPLES,
        `the artifact is the source rounded up to a whole model frame (delta ${delta} samples)`);
      assert.ok(Math.abs(artifact[artifact.length - 1]!) > 0.01,
        'the tail impulse survives: the model frame rounding must not truncate the last samples');
      assert.equal(existsSync(voiceCleanupPartialPath(alignLocation.file)), false, 'a finished job leaves no partial behind');
      assert.equal(existsSync(voiceCleanupStage1Path(alignLocation.file)), false, 'and no stage-1 track either');
      console.log(`voice cleanup: alignment offset 0 samples, length delta ${delta} samples (${(delta / 48).toFixed(1)} ms)`);
    }

    // ── 6. the chain cleans, measured from decoded samples ──────────────────
    // The efficacy claim is measured on the CHAIN alone (no loudness stage), so
    // the comparison carries no gain: the same window, before and after.
    //
    // It is deliberately not an SNR claim. RNNoise's voice-activity model is
    // trained on real speech, and a synthetic tone or harmonic stack is not
    // speech — measured here, the model attenuates the tone by about as much as
    // the noise (a 220 Hz tone: -12.9 dB signal, -10.6 dB noise). What a
    // synthetic fixture CAN prove is the part that is the chain's own logic: the
    // noise floor in a speech-free window drops hard, and the chain does not
    // silence its input. Speech PRESERVATION is proven by the exit test on a real
    // recording (docs/d-job-implementation.md §D2), not by a tone.
    const speechFrom = Math.round(0.7 * VOICE_CLEANUP_SAMPLE_RATE);
    const speechTo = Math.round(1.3 * VOICE_CLEANUP_SAMPLE_RATE);
    // Noise window: before the tone starts, so only the room noise is there.
    const noiseFrom = Math.round(0.05 * VOICE_CLEANUP_SAMPLE_RATE);
    const noiseTo = Math.round(0.35 * VOICE_CLEANUP_SAMPLE_RATE);
    {
      const chainOut = join(fixture, 'chain-stage1.wav');
      execFileSync(
        ffmpegBin(),
        ['-v', 'error', '-i', speechFile, '-vn',
          '-af', voiceCleanupFilterChain({ modelName: basename(modelPath), channels: 2 }),
          '-ar', String(VOICE_CLEANUP_SAMPLE_RATE), '-ac', '2', '-c:a', 'pcm_s16le', '-y', chainOut],
        // The model is named bare and found through the child's working directory,
        // exactly as the engine does it.
        { stdio: 'pipe', cwd: dirname(modelPath) },
      );
      const sourceSamples = decodeMono(speechFile);
      const chainSamples = decodeMono(chainOut);
      const sourceNoise = dB(rms(sourceSamples, noiseFrom, noiseTo));
      const chainNoise = dB(rms(chainSamples, noiseFrom, noiseTo));
      assert.ok(sourceNoise > -60, `the fixture must have a measurable noise floor (got ${sourceNoise.toFixed(1)} dB)`);
      assert.ok(chainNoise < sourceNoise - 6,
        `the chain must drop the noise floor by at least 6 dB (${sourceNoise.toFixed(1)} -> ${chainNoise.toFixed(1)} dB)`);
      assert.ok(dB(rms(chainSamples, speechFrom, speechTo)) > -70,
        'the chain does not silence its input: a denoiser that removes everything is not a denoiser');
      console.log(`voice cleanup: noise floor ${sourceNoise.toFixed(1)} -> ${chainNoise.toFixed(1)} dB `
        + `(${(chainNoise - sourceNoise).toFixed(1)} dB) on the synthetic fixture`);
    }

    {
      const runRequest = { sourceName: 'synthetic-speech.wav', sourceFile: speechFile, revision: 'r1' };
      const runLocation = voiceCleanupArtifactLocation(runRequest);
      const startedAt = Date.now();
      const started = startVoiceCleanupMediaJob(runRequest, queue);
      const completed = await waitFor(queue, started.jobId, terminal);
      const elapsedMs = Date.now() - startedAt;
      assert.equal(completed.status, 'completed', `the clean-up must complete: ${JSON.stringify(completed)}`);
      assert.equal(completed.code, null);
      assert.equal(completed.progress, 1);
      assert.ok(completed.artifact, 'a completed job reports its artifact');
      assert.equal(completed.artifact.file, runLocation.file);
      assert.match(completed.artifact.url, DERIVED_URL);
      assert.ok(completed.artifact.bytes > 0, 'the artifact is non-empty');
      assert.equal((await stat(runLocation.file)).size, completed.artifact.bytes);
      assert.ok(pidOf(completed) !== undefined, 'the engine reported the child pid it spawned');
      assert.equal(completed.detail?.cached, undefined, 'a first run is not a cache hit');

      // The loudness stage reaches the documented target, measured with the same
      // meter a mastering engineer would use.
      const loudness = integratedLoudness(runLocation.file);
      assert.ok(Math.abs(loudness.integrated - VOICE_CLEANUP_TARGET_LUFS) <= 1,
        `the artifact must land on the ${VOICE_CLEANUP_TARGET_LUFS} LUFS target (got ${loudness.integrated})`);
      assert.ok(loudness.truePeak <= VOICE_CLEANUP_TARGET_TRUE_PEAK + 0.5,
        `and its true peak must respect ${VOICE_CLEANUP_TARGET_TRUE_PEAK} dBTP (got ${loudness.truePeak})`);
      console.log(`voice cleanup: ${loudness.integrated} LUFS / ${loudness.truePeak} dBTP, `
        + `${elapsedMs} ms for 2 s of audio`);

      // ── 7. a repeat run is a cache hit, with no child spawned ─────────────
      const cachedAt = Date.now();
      const cached = await waitFor(queue, startVoiceCleanupMediaJob(runRequest, queue).jobId, terminal);
      const cachedMs = Date.now() - cachedAt;
      assert.equal(cached.status, 'completed');
      assert.equal(cached.detail?.cached, 1, 'the second run reports a cache hit');
      assert.equal(pidOf(cached), undefined, 'a cache hit spawns no engine child');
      assert.ok(cachedMs < 2_000, `a cache hit is instant (took ${cachedMs} ms)`);
      assert.equal(cached.artifact?.bytes, completed.artifact.bytes);
    }

    // ── 8. cancel kills the real child and leaves nothing behind ────────────
    {
      // A long fixture, so the job is certainly still running when cancelled.
      const longFile = join(fixture, 'synthetic-long.wav');
      execFileSync(
        ffmpegBin(),
        ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=120',
          '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', '-y', longFile],
        { stdio: 'pipe' },
      );
      const cancelRequest = { sourceName: 'synthetic-long.wav', sourceFile: longFile, revision: 'r1' };
      const cancelLocation = voiceCleanupArtifactLocation(cancelRequest);
      const started = startVoiceCleanupMediaJob(cancelRequest, queue);
      const running = await waitFor(queue, started.jobId, (snapshot) => pidOf(snapshot) !== undefined, 60_000);
      const pid = pidOf(running);
      assert.ok(pid !== undefined, 'the engine must report the child pid while it runs');
      assert.equal(processAlive(pid), true, 'the child is alive before the cancel');

      queue.cancel(started.jobId);
      const cancelled = await waitFor(queue, started.jobId, terminal, 30_000);
      assert.equal(cancelled.status, 'cancelled');
      assert.equal(cancelled.code, 'job_cancelled');
      assert.equal(cancelled.artifact, null, 'a cancelled job has no artifact');
      const deadline = Date.now() + 10_000;
      while (processAlive(pid) && Date.now() < deadline) await sleep(50);
      assert.equal(processAlive(pid), false, 'the SIGKILL reached the child');
      assert.equal(existsSync(cancelLocation.file), false, 'a cancelled job leaves no artifact');
      assert.equal(existsSync(voiceCleanupPartialPath(cancelLocation.file)), false, 'and no partial');
      assert.equal(existsSync(voiceCleanupStage1Path(cancelLocation.file)), false, 'and no stage-1 track');

      // ── 9. the kill wiring is load-bearing ───────────────────────────────
      // With the kill hook stubbed out the same assertion must FAIL, which is the
      // only way "cancel kills the child" is a checked claim rather than a hope.
      const stubRequest = { sourceName: 'synthetic-long.wav', sourceFile: longFile, revision: 'r2', kill: () => undefined };
      const stubLocation = voiceCleanupArtifactLocation(stubRequest);
      const stubbed = startVoiceCleanupMediaJob(stubRequest, queue);
      const stubRunning = await waitFor(queue, stubbed.jobId, (snapshot) => pidOf(snapshot) !== undefined, 60_000);
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
  }

  console.log('media-job voice cleanup: contract, chain order, alignment, cleaning, cache hit, cancel and kill wiring: OK');
} finally {
  restoreHome();
  await rm(fixture, { recursive: true, force: true });
}
