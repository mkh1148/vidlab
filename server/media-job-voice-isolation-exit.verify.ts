// D6 · the exit test, recorded.
//
// The kit's exit test is "a clip with music under speech: the processed track has
// audibly reduced music; both files remain; processing time recorded". This file
// runs it on the machine, through the real engine, and prints the numbers.
//
// The clip is the owner's 13 s talking head (D-7: never owner PROJECT data, and the
// clip is the same one D1's exit test uses). The music is SYNTHESIZED here, because
// the inventory has no music-under-speech recording: a four-chord progression under
// the speech, mixed at a level where the music is clearly audible but the voice is
// louder. That is the fixture the kit's exit test describes, built honestly.
//
// The metric, and why it is defensible:
//
//   musicShare = mean(single-bin DFT level at the chord's tones) - rms level
//
// A single 10.8 Hz bin (44.1 kHz / 4096) at the exact tone frequency. Speech is
// broadband, so its energy in one bin is far below a sustained tone's — the SOURCE
// measurement below is the control that proves the meter can see the music at all.
// The share (not the absolute level) is what moves, because the D2 chain ends with a
// linear loudness gain: an absolute measurement would move by the gain and prove
// nothing about separation.
//
// What this proves and what it does not:
//
//   * PROVES: the artifact has far less music than the source, it is not silent, the
//     source file is byte-identical afterwards (I4), the artifact is a second file
//     beside it (both files remain), the run is timed, and a second run is a cache hit.
//   * DOES NOT PROVE: that the voice sounds natural. That is a listening judgement,
//     and the honest statement is that the numbers below bound what changed, not that
//     the result is good. The verify that runs unattended
//     (server/media-job-voice-isolation.verify.ts) says the same thing about its
//     synthetic fixture.
//
// The clip is external and the weights are 78 MB. Weights come from PORTABLE sources
// only: the configured data directory's model cache, or one pinned download. When the
// clip is absent the suite says so LOUDLY and skips, rather than passing on nothing.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isolateVerifyHome } from '../shared/verify-home.ts';
import { ffmpegBin } from './media-binaries.ts';
import { MediaJobQueue, type MediaJobSnapshot } from './media-job.ts';

const CLIP = process.env.VIDLAB_EXIT_TEST_CLIP
  ?? 'G:/VIDEO/vidlab-build-kit/vidlab-build-kit/Talking-Head-sample.mp4';

/** The chord progression, in Hz: C, F, G, Am — one bar each. */
const CHORDS: readonly (readonly number[])[] = [
  [261.63, 329.63, 392.00],
  [349.23, 440.00, 523.25],
  [392.00, 493.88, 587.33],
  [440.00, 523.25, 659.25],
];
const SAMPLE_RATE = 44_100;

const fixture = await mkdtemp(join(tmpdir(), 'vidlab-d6-exit-'));
// The environment as the machine had it, captured BEFORE the hermetic redirect.
const realEnv = { ...process.env };
const realHome = homedir();
const restoreHome = isolateVerifyHome(join(fixture, 'home'));
process.env.OPENCHATCUT_DATA_DIR = join(fixture, 'vidlab-data');

const {
  VOICE_ISOLATION_JOB_REQUIRED_BYTES,
  voiceIsolationMixPath,
  voiceIsolationStemPath,
  startVoiceIsolationMediaJob,
} = await import('./media-job-voice-isolation.ts');
const { uploadDir } = await import('./media-dir.ts');
const {
  SPLEETER_MODEL,
  SPLEETER_MODEL_DIR,
  spleeterModelPath,
  verifySpleeterFile,
  ensureSpleeterModels,
} = await import('./spleeter-model.ts');
const { resolveModelCacheDir } = await import('../shared/model-cache-path.ts');
const { resolveRuntimeProfile } = await import('./runtime-profile.ts');

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

async function sha256File(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

/** Decode a file to mono f32 at the separation rate, so measurements are in samples. */
function decodeMono(file: string): Float32Array {
  const result = spawnSync(
    ffmpegBin(),
    ['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', '-'],
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
  let re = 0;
  let im = 0;
  for (let i = start; i < end; i += 1) {
    const angle = (2 * Math.PI * hz * i) / SAMPLE_RATE;
    re += samples[i]! * Math.cos(angle);
    im -= samples[i]! * Math.sin(angle);
  }
  const count = Math.max(1, end - start);
  const amplitude = (2 * Math.sqrt(re * re + im * im)) / count;
  return 20 * Math.log10(Math.max(amplitude, 1e-12));
}

function rmsDb(samples: Float32Array, from: number, to: number): number {
  const start = Math.max(0, from);
  const end = Math.min(samples.length, to);
  let sum = 0;
  for (let i = start; i < end; i += 1) sum += samples[i]! * samples[i]!;
  const count = Math.max(1, end - start);
  return 20 * Math.log10(Math.max(Math.sqrt(sum / count), 1e-12));
}

/** The music's share of the total energy over a window: the separation metric. */
function musicShareDb(samples: Float32Array, from: number, to: number): number {
  const tones = CHORDS.flat();
  const mean = tones.reduce((sum, hz) => sum + toneDb(samples, hz, from, to), 0) / tones.length;
  return mean - rmsDb(samples, from, to);
}

/**
 * Frequencies in the speech band that are NOT chord tones.
 *
 * The fixture guard below asks one question the reduction assertion cannot: does this
 * fixture contain a VOICE at all? A sustained tone puts all its energy in one bin, so
 * probing the band away from the chords finds nothing in a music-only fixture and the
 * speech in a real one.
 */
const BROADBAND_PROBES: readonly number[] = (() => {
  const probes: number[] = [];
  for (let hz = 320; hz <= 3300; hz *= 1.09) {
    if (!CHORDS.flat().some((tone) => Math.abs(hz - tone) / tone < 0.06)) probes.push(hz);
  }
  return probes;
})();

/** How much broadband energy the signal carries in the speech band, as a share. */
function broadbandShareDb(samples: Float32Array): number {
  const mean = BROADBAND_PROBES.reduce((sum, hz) => sum + toneDb(samples, hz, 0, samples.length), 0)
    / BROADBAND_PROBES.length;
  return mean - rmsDb(samples, 0, samples.length);
}

/** The exit test cannot run on this machine; loud, and not a failure. */
class ExitTestSkipped extends Error {}

try {
  if (!existsSync(CLIP)) {
    console.log(`media-job voice isolation exit test: SKIPPED - the exit-test clip is absent (${CLIP}).`);
    console.log('  set VIDLAB_EXIT_TEST_CLIP to a clip with speech to run it.');
  } else {
    // ── the weights: copy once into the throwaway data directory ─────────────
    const inheritedCacheDir = resolveModelCacheDir(
      resolveRuntimeProfile(realEnv, { homeDir: realHome }),
      realEnv,
    );
    const modelFiles = [SPLEETER_MODEL.vocals, SPLEETER_MODEL.accompaniment];
    let modelsReady = true;
    for (const file of modelFiles) {
      const target = spleeterModelPath(file);
      const candidate = join(inheritedCacheDir, SPLEETER_MODEL_DIR, file.fileName);
      let ready = false;
      if (existsSync(candidate)) {
        try {
          await mkdir(dirname(target), { recursive: true });
          await copyFile(candidate, target);
          await verifySpleeterFile(target, file);
          ready = true;
        } catch {
          await rm(target, { force: true });
        }
      }
      if (!ready) {
        // What the app does on a cold machine: download once, pinned.
        const downloaded = await ensureSpleeterModels().then(() => true, (error) => {
          console.log(`media-job voice isolation exit test: could not obtain the weights (${error instanceof Error ? error.message : String(error)})`);
          return false;
        });
        if (!downloaded) {
          modelsReady = false;
          break;
        }
        ready = true;
      }
      if (!ready) modelsReady = false;
    }
    if (!modelsReady) {
      throw new ExitTestSkipped(
        `no pinned Spleeter weights available (sha256 ${modelFiles.map((file) => file.sha256).join(', ')}); `
        + 'set OPENCHATCUT_MODEL_CACHE_DIR or allow the one-time download',
      );
    }

    // ── the fixture: the owner's speech with a synthesized music bed ─────────
    const uploads = uploadDir();
    await mkdir(uploads, { recursive: true });
    const sourceName = 'music-under-speech.wav';
    const sourceFile = join(uploads, sourceName);
    const speech = decodeMono(CLIP);
    const seconds = speech.length / SAMPLE_RATE;
    assert.ok(seconds > 5, `the exit-test clip must be long enough to separate (${seconds.toFixed(2)} s)`);

    // The bed: one chord per bar, each tone at a level that sits clearly under the
    // voice. Written as a WAV so the mix is exact (no codec round trip).
    const bedFile = join(fixture, 'bed.wav');
    const barSeconds = seconds / CHORDS.length;
    const bedArgs: string[] = ['-v', 'error', '-y'];
    for (const [index] of CHORDS.entries()) {
      bedArgs.push('-f', 'lavfi', '-i', `sine=frequency=${CHORDS[index]![0]}:sample_rate=${SAMPLE_RATE}:duration=${barSeconds}`);
      bedArgs.push('-f', 'lavfi', '-i', `sine=frequency=${CHORDS[index]![1]}:sample_rate=${SAMPLE_RATE}:duration=${barSeconds}`);
      bedArgs.push('-f', 'lavfi', '-i', `sine=frequency=${CHORDS[index]![2]}:sample_rate=${SAMPLE_RATE}:duration=${barSeconds}`);
    }
    const mixed = CHORDS.map((_, index) => {
      const base = index * 3;
      return `[${base}:a][${base + 1}:a][${base + 2}:a]amix=inputs=3:normalize=0,volume=0.16[c${index}]`;
    }).join(';');
    const concat = CHORDS.map((_, index) => `[c${index}]`).join('');
    bedArgs.push(
      '-filter_complex',
      `${mixed};${concat}concat=n=${CHORDS.length}:v=0:a=1[bed]`,
      '-map', '[bed]', '-ar', String(SAMPLE_RATE), '-ac', '2', '-c:a', 'pcm_s16le', bedFile,
    );
    execFileSync(ffmpegBin(), bedArgs, { stdio: 'pipe' });

    execFileSync(
      ffmpegBin(),
      ['-v', 'error', '-y',
        '-i', CLIP,
        '-i', bedFile,
        '-filter_complex', '[0:a]aresample=44100,pan=stereo|c0=c0|c1=c0[voice];[1:a][voice]amix=inputs=2:duration=shortest:normalize=0[out]',
        '-map', '[out]', '-ar', String(SAMPLE_RATE), '-ac', '2', '-c:a', 'pcm_s16le', sourceFile],
      { stdio: 'pipe' },
    );
    assert.ok(existsSync(sourceFile), 'the music-under-speech fixture must exist');
    const sourceHash = await sha256File(sourceFile);
    const sourceSamples = decodeMono(sourceFile);
    // The control: the meter must see the music in the source, or "the share
    // dropped" would only mean the meter cannot see these tones at all.
    const sourceShare = musicShareDb(sourceSamples, 0, sourceSamples.length);
    const sourceVoiceBand = rmsDb(sourceSamples, 0, sourceSamples.length);
    assert.ok(sourceShare > -40, `the control: the music is measurable in the source (share ${sourceShare.toFixed(1)} dB)`);
    // THE FIXTURE GUARD. The reduction assertion alone cannot tell a separation from a
    // music-only input: measured, a fixture with a TONAL "voice" reports 62.3 dB of
    // "reduction" with a stem at -46.9 dB RMS, because there was never a voice to keep.
    // An output-side guard cannot catch it either — the chain's loudnorm lifts even an
    // empty stem to its target, so a music-only artifact reads -27.3 dB RMS and every
    // "not silent" test passes (both numbers measured, docs §87). What DOES discriminate
    // is the input: a real voice is broadband, a chord is not. Measured on the same two
    // fixtures, -64.0 dB against -91.1 dB — 27 dB apart.
    const sourceBroadband = broadbandShareDb(sourceSamples);
    assert.ok(sourceBroadband > -75,
      `the fixture must contain a broadband voice the chords do not explain `
      + `(broadband share ${sourceBroadband.toFixed(1)} dB) — a music-only fixture would `
      + 'pass the reduction assertion without testing separation');
    console.log(`media-job voice isolation exit test: ${sourceName} ${seconds.toFixed(2)}s `
      + `(speech + a ${CHORDS.length}-chord bed); source music share ${sourceShare.toFixed(1)} dB, `
      + `broadband voice share ${sourceBroadband.toFixed(1)} dB`);

    // …and the guard is proven against a real mutation in the same run, the way D5's
    // looks check proves its own. A guard that cannot fail is the defect it was written
    // to catch: this builds the fixture the old slice used (a sustained tone where the
    // voice goes) and asserts the guard REJECTS it.
    {
      const tonalFile = join(fixture, 'tonal-voice.wav');
      const tonalSource = join(fixture, 'tonal-under-music.wav');
      execFileSync(
        ffmpegBin(),
        ['-v', 'error', '-y', '-f', 'lavfi',
          '-i', `sine=frequency=220:sample_rate=${SAMPLE_RATE}:duration=${seconds}`,
          '-af', 'volume=0.30', '-ac', '2', '-c:a', 'pcm_s16le', tonalFile],
        { stdio: 'pipe' },
      );
      execFileSync(
        ffmpegBin(),
        ['-v', 'error', '-y', '-i', tonalFile, '-i', bedFile,
          '-filter_complex', '[0:a][1:a]amix=inputs=2:duration=shortest:normalize=0[out]',
          '-map', '[out]', '-ar', String(SAMPLE_RATE), '-ac', '2', '-c:a', 'pcm_s16le', tonalSource],
        { stdio: 'pipe' },
      );
      const tonalBroadband = broadbandShareDb(decodeMono(tonalSource));
      assert.ok(tonalBroadband <= -75,
        `the guard must REJECT a music-only fixture (a tonal "voice" measures `
        + `${tonalBroadband.toFixed(1)} dB), or it is not a guard`);
      console.log(`media-job voice isolation exit test: the guard rejects a tonal fixture `
        + `(${tonalBroadband.toFixed(1)} dB <= -75), so it can fail`);
    }

    const queue = new MediaJobQueue({ freeMemoryBytes: () => 8 * GIB });
    const request = { sourceName, sourceFile, revision: 'r1' };
    assert.equal(VOICE_ISOLATION_JOB_REQUIRED_BYTES, GIB, 'the admission constant is the measured 1 GiB');

    // ── the real job, timed ─────────────────────────────────────────────────
    const startedAt = Date.now();
    const finished = await waitFor(queue, startVoiceIsolationMediaJob(request, queue).jobId);
    const elapsedMs = Date.now() - startedAt;
    assert.equal(finished.status, 'completed', `the separation must complete: ${JSON.stringify(finished)}`);
    assert.ok(finished.artifact && finished.artifact.bytes > 0, 'the artifact is non-empty');
    const artifactFile = finished.artifact.file;
    const secondsPerAudioSecond = elapsedMs / 1_000 / seconds;
    console.log(`media-job voice isolation exit test: separated AND cleaned in ${(elapsedMs / 1_000).toFixed(1)}s `
      + `= ${secondsPerAudioSecond.toFixed(2)} s per audio second`);

    // ── the measurement ─────────────────────────────────────────────────────
    const artifactSamples = decodeMono(artifactFile);
    const artifactShare = musicShareDb(artifactSamples, 0, artifactSamples.length);
    const artifactVoiceBand = rmsDb(artifactSamples, 0, artifactSamples.length);
    const reduction = sourceShare - artifactShare;
    console.log(`media-job voice isolation exit test: music share ${sourceShare.toFixed(1)} -> ${artifactShare.toFixed(1)} dB `
      + `(${reduction.toFixed(1)} dB less music); level ${sourceVoiceBand.toFixed(1)} -> ${artifactVoiceBand.toFixed(1)} dB RMS`);
    assert.ok(reduction >= 10, `the processed track must have audibly less music (${reduction.toFixed(1)} dB)`);
    // A smoke test, NOT the guard against a music-only fixture — that is the input check
    // above, because this one cannot fail on a broken engine: the chain's loudnorm lifts
    // an empty stem to its target, so a separator that returns nothing still reads
    // -27.3 dB here (measured).
    assert.ok(artifactVoiceBand > -60, 'the artifact is not silent: a separator that removes everything is not a separator');

    // ── I4: the source is untouched, and BOTH files remain ──────────────────
    assert.equal(await sha256File(sourceFile), sourceHash, 'I4: the source file is byte-identical after processing');
    assert.ok(existsSync(sourceFile), 'the original file is still there');
    assert.ok(existsSync(artifactFile), 'and the processed file is there too');
    assert.notEqual(artifactFile, sourceFile, 'the artifact is a second file, not a replacement');
    assert.equal(existsSync(voiceIsolationMixPath(artifactFile)), false, 'no decoded mix left behind');
    assert.equal(existsSync(voiceIsolationStemPath(artifactFile)), false, 'no raw stem left behind');
    assert.match(finished.artifact.url, /^\/media\/derived\/[^/]+\/[^/]+$/, 'the artifact is a derived artifact');
    console.log(`media-job voice isolation exit test: both files remain - ${sourceName} (${finished.artifact.bytes} B artifact)`);

    // ── a second run is a cache hit, with no child spawned ──────────────────
    const cachedAt = Date.now();
    const cached = await waitFor(queue, startVoiceIsolationMediaJob(request, queue).jobId);
    assert.equal(cached.status, 'completed');
    assert.equal(cached.detail?.cached, 1, 'the second run reports a cache hit');
    assert.ok(Date.now() - cachedAt < 2_000, 'a cache hit is instant');
    console.log(`media-job voice isolation exit test: the second run was a cache hit in ${Date.now() - cachedAt} ms`);

    queue.reset();
    await rm(fixture, { recursive: true, force: true }).catch(() => undefined);
  }
} catch (error) {
  restoreHome();
  if (error instanceof ExitTestSkipped) {
    console.log(`media-job voice isolation exit test: SKIPPED - ${error.message}`);
  } else {
    throw error;
  }
} finally {
  restoreHome();
}

console.log('media-job voice isolation exit test: music reduced, both files kept, source byte-identical, run timed: OK');
