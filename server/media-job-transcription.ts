// The D3a local transcription engine, mounted on the D-job module exactly as the
// contract demands: `run(signal, onProgress)` and nothing else.
//
// `server/media-job.ts` is consumed UNCHANGED — the D-job contract's own acceptance
// criterion, and D3a is the third real consumer that proves it (D1b matting, D2
// voice clean-up, D3a transcription). Everything this engine needs lives on this
// side of the boundary.
//
// The pipeline is the kit's recipe, in the kit's order, and every step is a measured
// claim rather than a comment:
//
//   1. PROBE the first audio stream (D2's exported helper, not a second probe).
//   2. DECODE once to the speech model's input format: 16 kHz mono PCM WAV. whisper
//      resamples internally, but the VAD below reads these exact samples, so the
//      decode is explicit and the chunker and the model see the same audio.
//   3. VAD: frame energies with an adaptive noise floor (server/transcript-vad.ts).
//      The regions it finds are the ONLY evidence of speech this feature has.
//   4. CHUNK at pauses, capped below whisper's 30 s window, so no chunk contains a
//      silence long enough for the model to fill with invented text.
//   5. TRANSCRIBE each chunk on its own through the WARM whisper.cpp server
//      (server/whisper-runtime.ts), one HTTP call per chunk, model loaded once.
//   6. SHIFT each chunk's word times back to source time, then DISCARD text that
//      lands outside detected speech and CLAMP kept words into their region (P6).
//   7. WRITE the transcript as one JSON artifact under the per-source derived
//      directory, named by the H2 namer, so a re-run is a cache hit.
//
// What this engine deliberately does NOT do: build a caption track (D3b), touch the
// timeline (jobs are sessionless; only apply_artifact goes through the command
// core), or call any cloud transcription provider (D-8: loopback only, and
// server/plugins/transcription-providers.ts is untouched).
//
// Cache identity: the artifact name carries the source revision, the engine version
// (the whisper.cpp binary), and the options that change the output — the model tier,
// the VAD recipe version and the language. A model change therefore produces a new
// name and a new transcript, and the old one stays on disk as the record of what the
// old model said.
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { ffmpegBin } from './media-binaries.ts';
import { mediaJobArtifactLocation, type MediaJobArtifactLocation } from './media-job-artifact.ts';
import { mediaJobs, type MediaJobQueue, type MediaJobStartResult } from './media-job.ts';
import { runJobProcess } from './media-job-process.ts';
import { probeAudio } from './media-job-voice-cleanup.ts';
import {
  chunkSpeechRegions,
  decodeWavPcm16Mono,
  shiftAndFilterWords,
  vadSpeechRegions,
  type SpeechChunk,
  type SpeechRegion,
  type TimedWord,
} from './transcript-vad.ts';
import {
  DEFAULT_TRANSCRIPTION_MODEL_TIER,
  TRANSCRIPTION_ENGINE_VERSION,
  TRANSCRIPTION_VAD_VERSION,
  ensureWhisperModel,
  transcriptionRequiredBytes,
} from './whisper-model.ts';
import {
  stopWarmWhisperServer,
  transcribeSpeechChunk,
  whisperWarmState,
  type TranscribeChunkResult,
} from './whisper-runtime.ts';

/** The model's input format: 16 kHz mono, which is what whisper.cpp consumes. */
export const TRANSCRIPTION_SAMPLE_RATE = 16_000;

/**
 * Working set this engine needs, MEASURED for the default tier (the D1b C2 rule:
 * never the 1.5 GiB floor). See `transcriptionRequiredBytes` for the derivation of
 * the other tiers.
 */
export const TRANSCRIPTION_JOB_REQUIRED_BYTES = transcriptionRequiredBytes(
  DEFAULT_TRANSCRIPTION_MODEL_TIER,
);

/** Progress split: decode, then chunks, then the finalize check. */
const DECODE_END = 0.12;
const CHUNKS_END = 0.98;

export interface TranscriptionJobRequest {
  /** Mutation seam for the kill wiring, same shape as the other engines'. */
  readonly kill?: (child: import('node:child_process').ChildProcess) => void;
  /**
   * Transcription seam. Production omits it and gets the warm whisper.cpp server
   * (`server/whisper-runtime.ts`); the verify injects a stand-in to prove the shift,
   * clamp and discard rules THROUGH the real decode, VAD and chunk cuts without a
   * model in the loop.
   */
  readonly transcribe?: (
    modelFile: string,
    wavPath: string,
    options: { readonly signal?: AbortSignal; readonly language?: string },
  ) => Promise<TranscribeChunkResult>;
  /** Upload name of the source, e.g. `clip.mp4`. */
  readonly sourceName: string;
  /** Absolute path of the source on disk. */
  readonly sourceFile: string;
  /** Source revision, so a re-import produces a new artifact instead of a stale hit. */
  readonly revision?: string | number;
  /** Catalog tier; defaults to `base` (multilingual, measured). */
  readonly tier?: string;
  /** ISO-639-1 code, or 'auto'. Part of the cache identity. */
  readonly language?: string;
}

/** One word of a stored transcript, milliseconds on the SOURCE timeline. */
export interface TranscriptArtifactWord {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** The artifact this engine writes: the transcript, plus how it was produced. */
export interface TranscriptArtifact {
  readonly version: 1;
  readonly source: { readonly name: string; readonly revision: string | null };
  readonly engine: {
    readonly id: 'whisper-cpp';
    readonly version: string;
    readonly backend: 'server' | 'cli';
    readonly model: string;
    readonly modelTier: string;
    readonly modelSha256: string;
    readonly vad: string;
    readonly language: string;
    readonly sampleRate: number;
  };
  readonly durationMs: number;
  /** The detected speech regions the words were filtered against (P6 evidence). */
  readonly speech: readonly SpeechRegion[];
  readonly text: string;
  readonly words: readonly TranscriptArtifactWord[];
  readonly stats: {
    readonly chunks: number;
    readonly words: number;
    readonly discardedOutsideSpeech: number;
    readonly discardedHallucination: number;
    /** Chunks whose whole output was a line the model invented (P6 evidence). */
    readonly discardedChunks: number;
    readonly processingMs: number;
    readonly cached: boolean;
  };
}

/** Where the transcript for this source would land. Pure path arithmetic. */
export function transcriptionArtifactLocation(
  request: TranscriptionJobRequest,
): MediaJobArtifactLocation {
  return mediaJobArtifactLocation({
    sourceName: request.sourceName,
    segments: ['transcript'],
    ...(request.revision === undefined ? {} : { revision: request.revision }),
    engineVersion: TRANSCRIPTION_ENGINE_VERSION,
    options: {
      model: request.tier ?? DEFAULT_TRANSCRIPTION_MODEL_TIER,
      vad: TRANSCRIPTION_VAD_VERSION,
      lang: (request.language ?? 'auto').trim() || 'auto',
    },
    extension: 'json',
  });
}

/** The decoded speech-format WAV, beside the artifact and removed when the job ends. */
export function transcriptionSpeechAudioPath(file: string): string {
  return `${file}.speech.wav`;
}

/** One chunk's cut file. */
export function transcriptionChunkAudioPath(file: string, index: number): string {
  return `${file}.chunk${index}.wav`;
}

/** The transcript JSON before it is renamed to the artifact name. */
export function transcriptionPartialPath(file: string): string {
  return `${file}.partial.json`;
}

async function bytesOf(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

async function removeQuietly(file: string): Promise<void> {
  await unlink(file).catch(() => undefined);
}

/** `out_time_us=` from FFmpeg's `-progress` line protocol, in seconds. */
function progressSeconds(line: string): number | null {
  const match = /^out_time_us=(\d+)$/.exec(line);
  if (!match) return null;
  const micros = Number(match[1]);
  return Number.isFinite(micros) ? micros / 1_000_000 : null;
}

/** Decode the source to the speech model's input format. */
async function decodeSpeechAudio(
  sourceFile: string,
  destination: string,
  durationSeconds: number,
  signal: AbortSignal,
  onProgress: (fraction: number, seconds: number) => void,
  onSpawn: (pid: number | undefined) => void,
  kill?: TranscriptionJobRequest['kill'],
): Promise<void> {
  await runJobProcess(
    ffmpegBin(),
    [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-i', sourceFile,
      '-vn', '-map', '0:a:0?',
      '-ac', '1',
      '-ar', String(TRANSCRIPTION_SAMPLE_RATE),
      '-c:a', 'pcm_s16le',
      '-progress', 'pipe:1', '-nostats',
      destination,
    ],
    {
      signal,
      ...(kill ? { kill } : {}),
      onSpawn,
      onStdoutLine(line) {
        const seconds = progressSeconds(line);
        if (seconds === null || durationSeconds <= 0) return;
        onProgress(Math.max(0, Math.min(1, seconds / durationSeconds)), seconds);
      },
    },
  );
}

/** Cut one chunk out of the decoded audio, re-encoding the same format. */
async function cutChunk(
  speechAudio: string,
  destination: string,
  chunk: SpeechChunk,
  signal: AbortSignal,
  onSpawn: (pid: number | undefined) => void,
  kill?: TranscriptionJobRequest['kill'],
): Promise<void> {
  const startSeconds = chunk.startMs / 1000;
  const durationSeconds = Math.max(0.05, (chunk.endMs - chunk.startMs) / 1000);
  await runJobProcess(
    ffmpegBin(),
    [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', startSeconds.toFixed(3),
      '-t', durationSeconds.toFixed(3),
      '-i', speechAudio,
      '-ac', '1',
      '-ar', String(TRANSCRIPTION_SAMPLE_RATE),
      '-c:a', 'pcm_s16le',
      destination,
    ],
    { signal, onSpawn, ...(kill ? { kill } : {}) },
  );
}

/** Joined text of the kept words, with punctuation spacing repaired like the cloud path. */
export function transcriptText(words: readonly TimedWord[]): string {
  return words
    .map((word) => word.text)
    .join(' ')
    .replace(/\s+([,.;:!?，。；：！？])/gu, '$1')
    .replace(/([（(])\s+/gu, '$1')
    .trim();
}

/**
 * Start one transcription job.
 *
 * The key is the artifact path, so a second click while the first job is in flight
 * reuses it (keyed dedup) instead of transcribing the same source twice.
 */
export function startTranscriptionMediaJob(
  request: TranscriptionJobRequest,
  queue: MediaJobQueue = mediaJobs,
): MediaJobStartResult {
  const location = transcriptionArtifactLocation(request);
  const tier = request.tier ?? DEFAULT_TRANSCRIPTION_MODEL_TIER;
  const language = (request.language ?? 'auto').trim() || 'auto';
  return queue.start({
    key: `transcription:${location.file}`,
    target: { file: location.file, url: location.url },
    requiredBytes: transcriptionRequiredBytes(tier),
    run: async (signal, onProgress) => {
      signal.throwIfAborted();
      await mkdir(location.dir, { recursive: true });

      // 0.00: cache hit. The artifact identity is revision + engine version + the
      // options that change the output, so a non-empty file at this exact path IS
      // this derivation — the JSON is renamed into place only after it parsed.
      const cachedBytes = await bytesOf(location.file);
      if (cachedBytes > 0) {
        const cached = await readFile(location.file, 'utf8').then(
          (text) => JSON.parse(text) as TranscriptArtifact,
          () => null,
        );
        if (cached) {
          onProgress({
            progress: 1,
            phase: 'done',
            detail: { cached: 1, words: cached.words.length, chunks: cached.stats.chunks },
          });
          return {
            artifact: { file: location.file, url: location.url, bytes: cachedBytes },
            intermediate: [],
          };
        }
        // A file that is not a transcript is not this artifact; re-derive it.
        await removeQuietly(location.file);
      }

      const startedAt = Date.now();
      // 0.00: probe, BEFORE the model download and before any decode, so a source
      // with no audio costs nothing.
      const probe = await probeAudio(request.sourceFile, signal);
      onProgress({
        progress: 0,
        phase: 'probed',
        detail: {
          sampleRate: probe.sampleRate,
          channels: probe.channels,
          seconds: Math.round(probe.duration * 100) / 100,
        },
      });

      // 0.00-0.02: provisioning. A cache hit is instant; the first run pays the
      // pinned download once and never again.
      onProgress({ progress: 0.02, phase: 'provisioning' });
      const model = await ensureWhisperModel({
        tier,
        signal,
        onProgress: (bytes) => onProgress({
          progress: 0.02,
          phase: 'provisioning',
          detail: { modelBytes: bytes },
        }),
      });
      signal.throwIfAborted();

      const speechAudio = transcriptionSpeechAudioPath(location.file);
      const partial = transcriptionPartialPath(location.file);
      const chunkFiles: string[] = [];
      try {
        // ── 1. decode to the model's input format ────────────────────────────
        onProgress({ progress: 0.02, phase: 'decoding' });
        await decodeSpeechAudio(
          request.sourceFile,
          speechAudio,
          probe.duration,
          signal,
          (fraction, seconds) => onProgress({
            progress: 0.02 + fraction * (DECODE_END - 0.02),
            phase: 'decoding',
            detail: { seconds: Math.round(seconds * 10) / 10 },
          }),
          (pid) => {
            if (pid !== undefined) onProgress({ progress: 0.02, phase: 'decoding', detail: { pid } });
          },
          request.kill,
        );
        signal.throwIfAborted();

        // ── 2. VAD + chunking at pauses ──────────────────────────────────────
        onProgress({ progress: DECODE_END, phase: 'detecting_speech' });
        const { samples, sampleRate } = decodeWavPcm16Mono(await readFile(speechAudio));
        const regions = vadSpeechRegions(samples, sampleRate);
        const chunks = chunkSpeechRegions(regions);
        const speechMs = regions.reduce((total, region) => total + (region.endMs - region.startMs), 0);
        onProgress({
          progress: DECODE_END,
          phase: 'detecting_speech',
          detail: {
            regions: regions.length,
            chunks: chunks.length,
            speechSeconds: Math.round(speechMs / 100) / 10,
          },
        });
        signal.throwIfAborted();

        // ── 3. per-chunk transcription, times shifted back, P6 filters ───────
        const words: TimedWord[] = [];
        let discardedOutsideSpeech = 0;
        let discardedHallucination = 0;
        let discardedChunks = 0;
        let backend: 'server' | 'cli' = 'server';
        for (const [index, chunk] of chunks.entries()) {
          signal.throwIfAborted();
          const chunkFile = transcriptionChunkAudioPath(location.file, index);
          chunkFiles.push(chunkFile);
          await cutChunk(speechAudio, chunkFile, chunk, signal, (pid) => {
            if (pid !== undefined) onProgress({ progress: DECODE_END, phase: 'transcribing', detail: { pid } });
          }, request.kill);
          const transcribe = request.transcribe ?? transcribeSpeechChunk;
          const result = await transcribe(model.file, chunkFile, { signal, language });
          backend = result.backend;
          const filtered = shiftAndFilterWords(result.words, chunk, regions, { text: result.text });
          words.push(...filtered.words);
          discardedOutsideSpeech += filtered.discardedOutsideSpeech;
          discardedHallucination += filtered.discardedHallucination;
          if (filtered.invented) discardedChunks += 1;
          await removeQuietly(chunkFile);
          const fraction = (index + 1) / chunks.length;
          onProgress({
            progress: DECODE_END + fraction * (CHUNKS_END - DECODE_END),
            phase: 'transcribing',
            detail: {
              chunk: index + 1,
              chunks: chunks.length,
              words: words.length,
              backend,
              warm: whisperWarmState().warm ? 1 : 0,
            },
          });
        }
        signal.throwIfAborted();

        // ── 4. the artifact ─────────────────────────────────────────────────
        const artifact: TranscriptArtifact = {
          version: 1,
          source: {
            name: request.sourceName,
            revision: request.revision === undefined ? null : String(request.revision),
          },
          engine: {
            id: 'whisper-cpp',
            version: TRANSCRIPTION_ENGINE_VERSION,
            backend,
            model: model.file.split(/[\\/]/).pop() ?? model.file,
            modelTier: model.tier,
            modelSha256: model.sha256,
            vad: TRANSCRIPTION_VAD_VERSION,
            language,
            sampleRate: TRANSCRIPTION_SAMPLE_RATE,
          },
          durationMs: Math.round(probe.duration * 1000),
          speech: regions,
          text: transcriptText(words),
          words,
          stats: {
            chunks: chunks.length,
            words: words.length,
            discardedOutsideSpeech,
            discardedHallucination,
            discardedChunks,
            processingMs: Date.now() - startedAt,
            cached: false,
          },
        };
        await writeFile(partial, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
        // The rename is the commit point: a `.partial` name means "not finished".
        await unlink(location.file).catch(() => undefined);
        await rename(partial, location.file);
      } catch (error) {
        // Cleanup under abort, parent side: the child was SIGKILLed and could not run
        // a handler, so its partials are removed here. The final file is removed by
        // the job module itself (it owns `target`).
        await removeQuietly(partial);
        await removeQuietly(speechAudio);
        for (const file of chunkFiles) await removeQuietly(file);
        await removeQuietly(location.file);
        // A cancelled job must stop burning CPU: the warm server is this job's child.
        if (signal.aborted) stopWarmWhisperServer();
        throw error;
      }

      await removeQuietly(speechAudio);
      const bytes = await bytesOf(location.file);
      if (bytes <= 0) throw new Error('the transcription engine wrote no artifact');
      onProgress({ progress: 1, phase: 'done' });
      return {
        artifact: { file: location.file, url: location.url, bytes },
        intermediate: [],
      };
    },
  });
}

/** The model path the engine will load; exported for the verify and docs. */
export { whisperModelPath } from './whisper-model.ts';

/** Re-exported so a route can report the tier list without importing the model module. */
export { TRANSCRIPTION_MODEL_TIERS, isTranscriptionModelTier } from './whisper-model.ts';
