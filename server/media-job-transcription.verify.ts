// D3a · the local transcription engine, plugged into the D-job module with NO module
// changes, proven on generated audio.
//
// What this pins down:
//
//   1. the engine fits `run(signal, onProgress)` — server/media-job.ts is consumed
//      unchanged, and this suite would not compile against a different shape;
//   2. P6, the pitfall this slice exists for: a recording with silence in the MIDDLE
//      and at the END produces no word over either silence. Proven twice — once
//      through the real decode + VAD + chunk cuts with an injected transcriber (so the
//      claim is deterministic and does not depend on what a model says), and once with
//      the real whisper.cpp model on the same fixture;
//   3. the shift is real: a chunk-relative word time comes back as a source time, and
//      a word that hangs over a pause is CLAMPED into the region it belongs to;
//   4. text the model invents over non-speech is DISCARDED, not stored — measured on
//      the model's own output for a tone, which is the hazard the kit names;
//   5. a repeat run is a cache hit, with no child spawned and no model load;
//   6. `requiredBytes` is the measured 256 MiB, not the 1.5 GiB floor, and a forced-low
//      memory reading DEFERS the job (a wait, never an error) and releases it;
//   7. cancel reaches the real children (the FFmpeg child and the warm whisper server),
//      they die, and neither the artifact nor its `.partial.json` / `.speech.wav` /
//      `.chunk0.wav` is left behind;
//   8. the warm server is reused ACROSS jobs (the same pid serves the second job), which
//      is what "keep the server warm between jobs" means concretely;
//   9. the CLI fallback is a routing decision, not a comment: with the server binary
//      absent the engine reports `backend: 'cli'`.
//
// The 57 MB weights come from PORTABLE sources only: VIDLAB_WHISPER_MODEL, or the
// configured data directory's own model cache composed by the app's resolver — never a
// bench path or a hard-coded drive. When neither has them the app's download-once path
// fetches them into THIS verify's throwaway data dir, which is what a cold machine does.
// The pinned sha256 is checked either way, and the engine-run half skips LOUDLY if the
// weights cannot be obtained. It never writes outside its throwaway data directory, and
// it never touches the owner's files.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { HEAVY_JOB_MIN_WORKING_SET_BYTES } from '../shared/heavy-job-admission.ts';
import { isolateVerifyHome } from '../shared/verify-home.ts';
import { ffmpegBin } from './media-binaries.ts';
import type { MediaJobSnapshot } from './media-job.ts';

const realHome = homedir();
// The environment as the machine had it, captured BEFORE the hermetic redirect: the
// configured data dir (and any model-cache override) is resolved from THIS.
const realEnv = { ...process.env };
const fixture = await mkdtemp(join(tmpdir(), 'vidlab-transcription-'));
const restoreHome = isolateVerifyHome(join(fixture, 'home'));
const dataDir = join(fixture, 'vidlab-data');
process.env.OPENCHATCUT_DATA_DIR = dataDir;

// Imported AFTER the redirect: server/runtime-profile.ts resolves the active profile
// once, at module load, so a static import would resolve the real checkout's media
// directory.
const {
  TRANSCRIPTION_JOB_REQUIRED_BYTES,
  TRANSCRIPTION_SAMPLE_RATE,
  startTranscriptionMediaJob,
  transcriptText,
  transcriptionArtifactLocation,
  transcriptionChunkAudioPath,
  transcriptionPartialPath,
  transcriptionSpeechAudioPath,
} = await import('./media-job-transcription.ts');
const { mediaJobDerivedRoot } = await import('./media-job-artifact.ts');
const { MediaJobQueue } = await import('./media-job.ts');
const {
  TRANSCRIPTION_ENGINE_VERSION,
  TRANSCRIPTION_VAD_VERSION,
  ensureWhisperModel,
  verifyWhisperModelFile,
  whisperModelDescriptor,
  whisperModelPath,
  transcriptionRequiredBytes,
} = await import('./whisper-model.ts');
const { stopWarmWhisperServer, transcribeSpeechChunk, whisperServerAvailable, whisperWarmState } =
  await import('./whisper-runtime.ts');
const { classifyHallucination, decodeWavPcm16Mono, vadSpeechRegions } = await import('./transcript-vad.ts');
const { resolveModelCacheDir } = await import('../shared/model-cache-path.ts');
const { resolveRuntimeProfile } = await import('./runtime-profile.ts');

const GIB = 1024 ** 3;
const ROOMY = (): number => 8 * GIB;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });
const DERIVED_URL = /^\/media\/derived\/([^/?#]+)\/([^/?#]+)$/;

interface Pause { startMs: number; endMs: number }
interface Word { text: string; start: number; end: number }

const terminal = (snapshot: MediaJobSnapshot): boolean => (
  snapshot.status === 'completed' || snapshot.status === 'failed' || snapshot.status === 'cancelled'
);

async function waitFor(
  queue: MediaJobQueue,
  jobId: string,
  predicate: (snapshot: MediaJobSnapshot) => boolean,
  timeoutMs = 300_000,
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

/** The pauses between detected regions, plus the tail after the last one. */
function pausesOf(regions: readonly { startMs: number; endMs: number }[], durationMs: number): Pause[] {
  const pauses: Pause[] = [];
  for (let index = 1; index < regions.length; index += 1) {
    pauses.push({ startMs: regions[index - 1]!.endMs, endMs: regions[index]!.startMs });
  }
  const last = regions[regions.length - 1];
  if (last) pauses.push({ startMs: last.endMs, endMs: durationMs });
  return pauses;
}

/**
 * P6 as an assertion: every kept word lies inside a detected speech region, and no
 * word overlaps a pause between regions or the silence after the last one.
 */
function assertNoWordOverSilence(
  words: readonly Word[],
  regions: readonly { startMs: number; endMs: number }[],
  pauses: readonly Pause[],
  label: string,
): void {
  for (const word of words) {
    const region = regions.find((candidate) => word.start >= candidate.startMs && word.end <= candidate.endMs);
    assert.ok(
      region,
      `${label}: word ${JSON.stringify(word)} must lie inside a detected speech region, regions ${JSON.stringify(regions)}`,
    );
    for (const pause of pauses) {
      assert.ok(
        word.end <= pause.startMs || word.start >= pause.endMs,
        `${label}: word ${JSON.stringify(word)} overlaps the silence ${pause.startMs}-${pause.endMs} ms`,
      );
    }
    assert.ok(word.end >= word.start, `${label}: a word cannot end before it starts (${JSON.stringify(word)})`);
  }
}

try {
  // ── 1. identity, placement and the budget, without running anything ──────
  assert.equal(TRANSCRIPTION_JOB_REQUIRED_BYTES, 256 * 1024 * 1024, 'requiredBytes is the measured 256 MiB, not a guess');
  assert.notEqual(
    TRANSCRIPTION_JOB_REQUIRED_BYTES,
    HEAVY_JOB_MIN_WORKING_SET_BYTES,
    'C2: the engine passes its own measurement, never the 1.5 GiB admission floor',
  );
  assert.ok(
    TRANSCRIPTION_JOB_REQUIRED_BYTES < HEAVY_JOB_MIN_WORKING_SET_BYTES,
    'the measured working set is below the floor, which is why passing the floor would over-refuse',
  );
  assert.equal(TRANSCRIPTION_SAMPLE_RATE, 16_000, 'the speech model consumes 16 kHz mono');

  const request = { sourceName: 'clip.mp4', sourceFile: join(fixture, 'clip.mp4'), revision: 'r1' };
  const location = transcriptionArtifactLocation(request);
  assert.match(location.url, DERIVED_URL, 'C1: the artifact url is /media/derived/<sourceKey>/<name>');
  assert.equal(location.url, `/media/derived/${location.sourceKey}/${encodeURIComponent(location.name)}`);
  assert.ok(location.dir.startsWith(mediaJobDerivedRoot()), 'artifacts live under the derived root');
  assert.equal(dirname(location.file), location.dir, 'the artifact sits directly in its per-source directory');
  assert.ok(location.name.includes(TRANSCRIPTION_ENGINE_VERSION), 'the engine version is part of the cache identity');
  assert.ok(location.name.includes('transcript'), 'the feature marker is part of the name');
  assert.ok(location.name.endsWith('.json'), 'a transcript is JSON: it carries word times, not just text');
  // Cache identity = source revision + engine version + the options that change output.
  assert.ok(location.name.includes('model-base'), 'the model tier is part of the identity');
  assert.ok(location.name.includes(TRANSCRIPTION_VAD_VERSION), 'the VAD recipe version is part of the identity');
  assert.ok(location.name.includes('lang-auto'), 'the language is part of the identity');
  const otherTier = transcriptionArtifactLocation({ ...request, tier: 'small' });
  assert.notEqual(otherTier.name, location.name, 'a model change invalidates the cache: a different model is a different transcript');
  assert.notEqual(
    transcriptionArtifactLocation({ ...request, language: 'en' }).name,
    location.name,
    'a language change is a different derivation',
  );
  assert.notEqual(
    transcriptionArtifactLocation({ ...request, revision: 'r2' }).name,
    location.name,
    'a new source revision is a new artifact, not a stale hit',
  );
  assert.notEqual(
    transcriptionArtifactLocation({ ...request, revision: undefined }).name,
    location.name,
    'an unknown revision is its own identity too',
  );
  assert.notEqual(
    transcriptionArtifactLocation({ ...request, sourceName: 'other.mp4' }).dir,
    location.dir,
    'two sources never share a directory',
  );
  assert.notEqual(
    transcriptionArtifactLocation({ ...request, sourceName: 'Clip.mp4' }).sourceKey,
    location.sourceKey,
    'clip.mp4 and Clip.mp4 must not merge on NTFS',
  );
  assert.equal(transcriptionRequiredBytes('base'), TRANSCRIPTION_JOB_REQUIRED_BYTES, 'base is the measured tier');

  // Cleanup-under-abort: every intermediate is co-resident and unmistakable.
  assert.equal(dirname(transcriptionPartialPath(location.file)), location.dir, 'the partial lives beside its final name');
  assert.ok(transcriptionPartialPath(location.file).endsWith('.partial.json'), 'a partial can never be mistaken for finished work');
  assert.ok(transcriptionSpeechAudioPath(location.file).endsWith('.speech.wav'), 'the decoded speech audio is identifiable');
  assert.ok(transcriptionChunkAudioPath(location.file, 0).endsWith('.chunk0.wav'), 'and so is each chunk');
  assert.equal(
    transcriptText([{ text: 'hello', start: 0, end: 1 }, { text: ',', start: 1, end: 2 }, { text: 'world', start: 2, end: 3 }]),
    'hello, world',
    'the stored text is the kept words with punctuation spacing repaired',
  );

  // ── 2. keyed dedupe: a double click cannot queue the same transcript twice ──
  {
    const queue = new MediaJobQueue({ freeMemoryBytes: ROOMY });
    const missing = { sourceName: 'missing.mp4', sourceFile: join(fixture, 'missing.mp4'), revision: 'r1' };
    const first = startTranscriptionMediaJob(missing, queue);
    const second = startTranscriptionMediaJob(missing, queue);
    assert.equal(second.jobId, first.jobId, 'the same key reuses the in-flight job');
    assert.equal(second.deduped, true);
    assert.equal(first.deduped, false);
    const settled = await waitFor(queue, first.jobId, terminal, 60_000);
    assert.equal(settled.status, 'failed', 'a source with no audio fails rather than producing an empty transcript');
    assert.equal(settled.code, 'engine_failed', 'the module codes an engine failure');
    assert.equal(settled.artifact, null, 'a failure has no artifact');
    assert.equal(queue.snapshot().length, 1, 'a deduped start created no second job');
    assert.equal(existsSync(transcriptionArtifactLocation(missing).file), false, 'and nothing was written');
    queue.reset();
    console.log('transcription: a double click dedupes, and a missing source fails before any download');
  }

  // ── 3. the weights: copy once into the data directory, verify the pin ─────
  const descriptor = whisperModelDescriptor('base');
  const inheritedCacheDir = resolveModelCacheDir(
    resolveRuntimeProfile(realEnv, { homeDir: realHome }),
    realEnv,
  );
  const modelCandidates = [
    realEnv.VIDLAB_WHISPER_MODEL,
    join(inheritedCacheDir, 'ggml', descriptor.fileName),
  ].filter((candidate): candidate is string => Boolean(candidate) && existsSync(candidate as string));
  const modelPath = whisperModelPath('base');
  let modelReady = false;
  for (const candidate of modelCandidates) {
    try {
      await mkdir(dirname(modelPath), { recursive: true });
      await copyFile(candidate, modelPath);
      await verifyWhisperModelFile(modelPath, descriptor);
      modelReady = true;
      console.log(`transcription: weights from ${candidate} (pinned sha256 verified)`);
      break;
    } catch (error) {
      await rm(modelPath, { force: true });
      console.log(`transcription: ${candidate} is not the pinned model (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  if (!modelReady) {
    try {
      const resolved = await ensureWhisperModel({ tier: 'base' });
      modelReady = true;
      console.log(`transcription: weights downloaded once into the data-dir cache (${resolved.bytes} bytes, pinned sha256 verified)`);
    } catch (error) {
      console.log(`transcription: could not obtain the weights (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  if (!modelReady) {
    console.log('transcription: SKIPPED the engine-run half - no pinned speech model on this machine and no network.');
    console.log(`  set VIDLAB_WHISPER_MODEL to ${descriptor.fileName} (sha256 ${descriptor.sha256}) to run it.`);
    console.log('transcription: identity, placement, budget and dedupe verified: OK (engine run skipped)');
  } else {
    // ── 4. the fixture: speech-like tone, silence in the MIDDLE, silence at the END ──
    // 0-2 s tone, 2-5 s silence, 5-7 s tone, 7-11 s silence. The two silences are the
    // P6 regression: the middle one is where a chunker that ignores pauses invents
    // text, and the tail one is where whisper prints its sign-off.
    const silenceFile = join(fixture, 'synthetic-silence.wav');
    execFileSync(
      ffmpegBin(),
      ['-v', 'error',
        '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=16000:duration=11',
        '-af', "volume='if(between(t,0,2)+between(t,5,7),1,0)':eval=frame",
        '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', silenceFile],
      { stdio: 'pipe' },
    );
    const fixtureBytes = await readFile(silenceFile);
    const fixtureAudio = decodeWavPcm16Mono(fixtureBytes);
    assert.equal(fixtureAudio.sampleRate, 16_000, 'the fixture is already in the model input format');
    assert.equal(fixtureAudio.samples.length, 11 * 16_000, 'the fixture is exactly 11 s');
    const silent = (fromSeconds: number, toSeconds: number): boolean => {
      for (let index = fromSeconds * 16_000; index < toSeconds * 16_000; index += 1) {
        if (fixtureAudio.samples[index] !== 0) return false;
      }
      return true;
    };
    assert.ok(silent(2.05, 4.95), 'the fixture really is silent in the middle');
    assert.ok(silent(7.05, 11), 'and silent at the end');
    assert.ok(!silent(0.2, 1.8), 'and it really carries a tone where the speech is');

    const regions = vadSpeechRegions(fixtureAudio.samples, fixtureAudio.sampleRate);
    assert.equal(regions.length, 2, `the VAD finds two speech regions, got ${JSON.stringify(regions)}`);
    const durationMs = 11_000;
    const pauses = pausesOf(regions, durationMs);
    assert.equal(pauses.length, 2, 'two pauses: the middle silence and the tail silence');
    assert.ok(pauses[0]!.endMs - pauses[0]!.startMs > 2_000, `the middle pause is seconds long (${JSON.stringify(pauses[0])})`);
    assert.ok(pauses[1]!.endMs - pauses[1]!.startMs > 3_000, `the tail pause is seconds long (${JSON.stringify(pauses[1])})`);
    console.log(`transcription: fixture regions ${JSON.stringify(regions)}, pauses ${JSON.stringify(pauses)}`);

    // ── 5. P6 through the REAL decode, VAD and chunk cuts, injected transcriber ──
    // The transcriber is a seam, not a stub of the pipeline: the engine still decodes
    // the source, cuts each chunk with FFmpeg, shifts the times back and applies both
    // filters. What the seam replaces is only the model, so the P6 claim is
    // deterministic instead of depending on what whisper says about a tone.
    {
      const queue = new MediaJobQueue({ freeMemoryBytes: ROOMY });
      const seamRequest = { sourceName: 'synthetic-silence.wav', sourceFile: silenceFile, revision: 'seam' };
      const seamLocation = transcriptionArtifactLocation(seamRequest);
      const chunkDurations: number[] = [];
      const started = startTranscriptionMediaJob({
        ...seamRequest,
        async transcribe(_modelFile, wavPath) {
          const chunkAudio = decodeWavPcm16Mono(await readFile(wavPath));
          chunkDurations.push(chunkAudio.samples.length / chunkAudio.sampleRate);
          // Times are relative to the CHUNK, as the model reports them. The first word
          // is entirely before the chunk (outside speech), the second straddles the
          // chunk start (kept, clamped to the region start), the third runs past the
          // chunk end into the pause (discarded).
          return {
            backend: 'server' as const,
            text: 'before clamp after',
            words: [
              { text: 'before', start: -600, end: -300 },
              { text: 'clamp', start: -100, end: 600 },
              { text: 'after', start: 2_300, end: 2_800 },
            ],
          };
        },
      }, queue);
      const completed = await waitFor(queue, started.jobId, terminal);
      assert.equal(completed.status, 'completed', `the seam run must complete: ${JSON.stringify(completed)}`);
      const artifact = JSON.parse(await readFile(seamLocation.file, 'utf8')) as {
        version: number;
        durationMs: number;
        speech: readonly Pause[];
        words: readonly Word[];
        text: string;
        stats: { chunks: number; words: number; discardedOutsideSpeech: number; discardedHallucination: number };
      };
      assert.equal(artifact.version, 1);
      assert.equal(artifact.durationMs, durationMs, 'the artifact records the source duration');
      assert.deepEqual(artifact.speech, regions, 'the artifact carries the regions the words were filtered against');
      assert.equal(artifact.stats.chunks, 2, 'two chunks: one per pause-separated region');
      assert.equal(chunkDurations.length, 2, 'the model was asked exactly twice');
      for (const [index, seconds] of chunkDurations.entries()) {
        const region = regions[index]!;
        assert.ok(
          Math.abs(seconds * 1000 - (region.endMs - region.startMs)) <= 20,
          `chunk ${index} is exactly its region (${Math.round(seconds * 1000)} ms vs ${region.endMs - region.startMs} ms): `
          + 'the model never sees the silence, only the speech plus the 120 ms pad',
        );
      }
      assert.equal(artifact.stats.words, 2, `one kept word per chunk, got ${JSON.stringify(artifact.words)}`);
      assert.equal(artifact.stats.discardedOutsideSpeech, 4, 'the word before and the word after each chunk are discarded');
      assert.equal(artifact.text, 'clamp clamp', 'only the words inside speech survive');
      assertNoWordOverSilence(artifact.words, regions, pauses, 'injected');
      // The shift is a real arithmetic fact, not a claim: the straddling word started at
      // -100 ms inside the chunk and comes back clamped to its region's first sample.
      for (const word of artifact.words) {
        assert.equal(word.text, 'clamp');
        const region = regions.find((candidate) => word.start >= candidate.startMs && word.end <= candidate.endMs);
        assert.ok(region, `the kept word must sit in a region: ${JSON.stringify(word)}`);
        assert.equal(word.start, region.startMs, 'a word that hangs before the region is clamped into it');
      }
      assert.equal(existsSync(transcriptionPartialPath(seamLocation.file)), false, 'a finished job leaves no partial');
      assert.equal(existsSync(transcriptionSpeechAudioPath(seamLocation.file)), false, 'and no decoded speech audio');
      assert.equal(existsSync(transcriptionChunkAudioPath(seamLocation.file, 0)), false, 'and no chunk files');
      queue.reset();
      console.log('transcription: P6 through real decode/VAD/cuts - shift, clamp and discard all measured');
    }

    // ── 6. the model on a tone: the hazard is real, and the filter catches it ──
    const probeChunk = join(fixture, 'probe-chunk.wav');
    execFileSync(
      ffmpegBin(),
      ['-v', 'error', '-ss', '0', '-t', '2.12', '-i', silenceFile, '-ac', '1', '-ar', '16000',
        '-c:a', 'pcm_s16le', '-y', probeChunk],
      { stdio: 'pipe' },
    );
    {
      assert.equal(whisperServerAvailable(), true, 'this machine has the provisioned whisper server binary');
      const coldAt = Date.now();
      const cold = await transcribeSpeechChunk(modelPath, probeChunk);
      const coldMs = Date.now() - coldAt;
      const warmAt = Date.now();
      const warm = await transcribeSpeechChunk(modelPath, probeChunk);
      const warmMs = Date.now() - warmAt;
      const warmState = whisperWarmState();
      assert.equal(warmState.warm, true, 'the server stays up between chunks');
      assert.ok(warmState.pid !== undefined, 'and it is a real child process');
      assert.equal(cold.backend, 'server', 'the warm server is the engine');
      assert.equal(warm.backend, 'server');
      console.log(`transcription: first chunk ${coldMs} ms (cold: model load + spawn), second ${warmMs} ms (warm)`);
      assert.ok(warmMs < coldMs, `a warm chunk costs less than a cold one (${warmMs} ms vs ${coldMs} ms)`);
      // The hazard P6 names, measured on this machine: whisper produces text for audio
      // nobody spoke over. It is NOT asserted as a certainty, because it is not one —
      // measured here, a pure tone yields `[Music]`/`(gentle music)` on some runs and an
      // empty result on others (whisper-server carries its prompt across requests, so a
      // second identical request on a tone flips to empty; real speech is stable and
      // correct across repeats). What must hold either way is that WHEN the model emits
      // text over non-speech, the filter classifies it as invented.
      console.log(`transcription: the model said ${JSON.stringify(cold.text)} over a pure tone`);
      if (cold.text.trim()) {
        assert.notEqual(
          classifyHallucination(cold.text, { speechMs: 2_120 }),
          null,
          `text produced over non-speech must be classified as invented (got ${JSON.stringify(cold.text)})`,
        );
      } else {
        console.log('transcription: this run the model returned no text for the tone; the injected half carries the deterministic proof');
      }
    }

    // ── 7. the real engine run on the silence fixture ──────────────────────
    const queue = new MediaJobQueue({ freeMemoryBytes: ROOMY });
    const runRequest = { sourceName: 'synthetic-silence.wav', sourceFile: silenceFile, revision: 'r1' };
    const runLocation = transcriptionArtifactLocation(runRequest);
    const warmBefore = whisperWarmState();
    let runMs = 0;
    {
      const startedAt = Date.now();
      const started = startTranscriptionMediaJob(runRequest, queue);
      const completed = await waitFor(queue, started.jobId, terminal);
      runMs = Date.now() - startedAt;
      assert.equal(completed.status, 'completed', `the run must complete: ${JSON.stringify(completed)}`);
      assert.equal(completed.code, null);
      assert.equal(completed.progress, 1);
      assert.ok(completed.artifact, 'a completed job reports its artifact');
      assert.equal(completed.artifact.file, runLocation.file);
      assert.match(completed.artifact.url, DERIVED_URL);
      assert.ok(completed.artifact.bytes > 0);
      assert.equal((await stat(runLocation.file)).size, completed.artifact.bytes);
      assert.equal(completed.detail?.cached, undefined, 'a first run is not a cache hit');
      assert.equal(completed.detail?.backend, 'server', 'the job reports which backend ran');
      // "Warm between jobs": the server the probe warmed is the one that served the job.
      assert.equal(whisperWarmState().pid, warmBefore.pid, 'the same warm server served the job: no second model load');

      const artifact = JSON.parse(await readFile(runLocation.file, 'utf8')) as {
        version: number;
        source: { name: string; revision: string | null };
        engine: {
          id: string; version: string; backend: string; model: string; modelTier: string;
          modelSha256: string; vad: string; language: string; sampleRate: number;
        };
        durationMs: number;
        speech: readonly Pause[];
        text: string;
        words: readonly Word[];
        stats: {
          chunks: number; words: number; discardedOutsideSpeech: number; discardedHallucination: number;
          discardedChunks: number; cached: boolean;
        };
      };
      assert.equal(artifact.version, 1);
      assert.deepEqual(artifact.source, { name: 'synthetic-silence.wav', revision: 'r1' });
      assert.equal(artifact.engine.id, 'whisper-cpp');
      assert.equal(artifact.engine.version, TRANSCRIPTION_ENGINE_VERSION);
      assert.equal(artifact.engine.backend, 'server');
      assert.equal(artifact.engine.model, descriptor.fileName, 'the artifact names the file it was made with');
      assert.equal(artifact.engine.modelTier, 'base');
      assert.equal(artifact.engine.modelSha256, descriptor.sha256, 'and pins its hash, so a model change is visible');
      assert.equal(artifact.engine.vad, TRANSCRIPTION_VAD_VERSION);
      assert.equal(artifact.engine.language, 'auto');
      assert.equal(artifact.engine.sampleRate, 16_000);
      assert.equal(artifact.durationMs, durationMs);
      assert.deepEqual(artifact.speech, regions, 'the artifact records the speech regions it filtered against');
      assert.equal(artifact.stats.chunks, 2);
      assert.equal(artifact.stats.cached, false);

      // P6 on the real model: nothing survives over either silence. A tone is not
      // speech, so the honest expectation is ZERO kept words — any kept word would be
      // text the model invented over audio nobody spoke.
      console.log(`transcription: real-model stats ${JSON.stringify(artifact.stats)} text ${JSON.stringify(artifact.text)}`);
      assertNoWordOverSilence(artifact.words, regions, pauses, 'real model');
      assert.equal(artifact.words.length, 0,
        `no text may survive over non-speech, got ${JSON.stringify(artifact.words)} (text ${JSON.stringify(artifact.text)})`);
      assert.equal(artifact.stats.words, 0);
      // The chunk-level counter is evidence, not a claim: when the model emitted an
      // annotation over the tone this run, it is counted as a discarded chunk; when it
      // emitted nothing, there is nothing to count. Either way nothing reached the
      // transcript, which is the assertion above.
      assert.ok(artifact.stats.discardedChunks <= artifact.stats.chunks);
      console.log(`transcription: real model on the silence fixture - ${runMs} ms for 11 s, `
        + `chunks ${artifact.stats.chunks}, kept ${artifact.stats.words}, `
        + `discarded ${artifact.stats.discardedHallucination} hallucination / ${artifact.stats.discardedOutsideSpeech} outside speech`);
    }

    // ── 8. a repeat run is a cache hit, with no child spawned ──────────────
    {
      const cachedAt = Date.now();
      const cached = await waitFor(queue, startTranscriptionMediaJob(runRequest, queue).jobId, terminal);
      const cachedMs = Date.now() - cachedAt;
      assert.equal(cached.status, 'completed');
      assert.equal(cached.detail?.cached, 1, 'the second run reports a cache hit');
      assert.equal(pidOf(cached), undefined, 'a cache hit spawns no engine child');
      assert.ok(cachedMs < 2_000, `a cache hit is instant (took ${cachedMs} ms)`);
      console.log(`transcription: cache hit in ${cachedMs} ms, no child spawned`);
    }

    // ── 9. a short machine DEFERS this engine's job; it is a wait, never an error ──
    {
      const freeMemory = { value: 0 };
      const gated = new MediaJobQueue({ freeMemoryBytes: () => freeMemory.value, gateRecheckMs: 30 });
      const started = startTranscriptionMediaJob(runRequest, gated);
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
      assert.equal(lifted.deferred, false);
      assert.ok(lifted.artifact && lifted.artifact.bytes > 0, 'and it produces its artifact');
      gated.reset();
      console.log('transcription: a forced-low memory reading deferred the job and it ran when the gate lifted');
    }

    // ── 10. cancel kills the real children and leaves nothing behind ───────
    {
      // A long fixture, so the job is certainly still working when cancelled.
      const longFile = join(fixture, 'synthetic-long.wav');
      execFileSync(
        ffmpegBin(),
        ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=16000:duration=60',
          '-af', "volume='if(between(t,0,20)+between(t,22,40)+between(t,42,60),1,0)':eval=frame",
          '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', longFile],
        { stdio: 'pipe' },
      );
      const cancelRequest = { sourceName: 'synthetic-long.wav', sourceFile: longFile, revision: 'r1' };
      const cancelLocation = transcriptionArtifactLocation(cancelRequest);
      const serverPid = whisperWarmState().pid;
      assert.ok(serverPid !== undefined, 'there is a warm server to kill');
      const started = startTranscriptionMediaJob(cancelRequest, queue);
      const running = await waitFor(queue, started.jobId, (snapshot) => pidOf(snapshot) !== undefined, 120_000);
      const pid = pidOf(running);
      assert.ok(pid !== undefined, 'the engine reports the child pid it spawned');
      assert.equal(processAlive(pid), true, 'the child is alive before the cancel');

      queue.cancel(started.jobId);
      const cancelled = await waitFor(queue, started.jobId, terminal, 60_000);
      assert.equal(cancelled.status, 'cancelled');
      assert.equal(cancelled.code, 'job_cancelled', 'a cancel carries a machine-parseable code');
      assert.equal(cancelled.artifact, null, 'a cancelled job has no artifact');
      const deadline = Date.now() + 10_000;
      while (processAlive(pid) && Date.now() < deadline) await sleep(50);
      assert.equal(processAlive(pid), false, 'the SIGKILL reached the FFmpeg child');
      const serverDeadline = Date.now() + 10_000;
      while (processAlive(serverPid) && Date.now() < serverDeadline) await sleep(50);
      assert.equal(processAlive(serverPid), false, 'and the warm server: a cancelled job must stop burning CPU');
      assert.equal(whisperWarmState().warm, false, 'the runtime agrees it is cold');
      assert.equal(existsSync(cancelLocation.file), false, 'a cancelled job leaves no artifact');
      assert.equal(existsSync(transcriptionPartialPath(cancelLocation.file)), false, 'and no partial');
      assert.equal(existsSync(transcriptionSpeechAudioPath(cancelLocation.file)), false, 'and no decoded speech audio');
      assert.equal(existsSync(transcriptionChunkAudioPath(cancelLocation.file, 0)), false, 'and no chunk files');
      console.log('transcription: cancel killed the FFmpeg child and the warm server, and left no intermediates');
    }

    queue.reset();
  }

  // ── 11. the CLI fallback is a routing decision, not a comment ─────────────
  // With no server binary to find, the engine must choose `whisper-cli` instead of
  // failing: a machine whose archive lacks the server binary still gets a transcript.
  {
    const previous = process.env.OPENCHATCUT_WHISPER_SERVER;
    process.env.OPENCHATCUT_WHISPER_SERVER = join(fixture, 'no-such-whisper-server.exe');
    try {
      assert.equal(whisperServerAvailable(), false, 'the override hides the server binary');
      assert.equal(whisperWarmState().backend, 'cli', 'so the runtime routes to the CLI fallback');
    } finally {
      if (previous === undefined) delete process.env.OPENCHATCUT_WHISPER_SERVER;
      else process.env.OPENCHATCUT_WHISPER_SERVER = previous;
    }
    assert.equal(whisperServerAvailable(), true, 'and the real binary is back');
    console.log('transcription: the CLI fallback is chosen by routing, not by a comment');
  }

  console.log('media-job transcription: contract, P6 (injected and real model), cache hit, defer, cancel and routing: OK');
} finally {
  // A warm server is this verify's child: it must not outlive the suite.
  stopWarmWhisperServer();
  restoreHome();
  await rm(fixture, { recursive: true, force: true });
}
