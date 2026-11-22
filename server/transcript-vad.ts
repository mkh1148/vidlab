// P6, as code: the voice-activity detector that sits IN FRONT of the speech model,
// the chunker that cuts at pauses, and the two filters that keep invented text out
// of a transcript.
//
// The pitfall is specific and it is not theoretical: whisper always produces text
// for the audio it is given, so a file with silence in it comes back with greetings,
// "(gentle music)" or "thanks for watching" printed over the silence, and a long
// file loses sentences where the model's fixed window cuts. Measured on this repo's
// own spike: a 3 s pure tone, fed to whisper.cpp `base` as one file, came back as
// " (gentle music)" — text nobody said, over audio nobody spoke.
//
// So the recipe the kit asks for is implemented here, in this order:
//
//   1. `vadSpeechRegions` — frame energies, an adaptive noise floor, hysteresis, and
//      a minimum speech run. The output is the only evidence of "speech" this
//      feature has; nothing downstream may invent a region.
//   2. `chunkSpeechRegions` — group regions into chunks that END IN A PAUSE, capped
//      so no chunk outlives whisper's own 30 s window. A chunk never contains a
//      silence longer than the pause threshold, which is what keeps the model from
//      filling a pause with text.
//   3. `shiftAndFilterWords` — the model's word times are relative to the chunk, so
//      they are shifted back to source time, then (a) a word whose midpoint falls
//      outside every detected speech region is DISCARDED, (b) a kept word's times are
//      CLAMPED into its region so no caption can hang over a pause, and (c) a chunk
//      whose WHOLE text is an invented line is discarded: a bracketed sound label
//      (`(gentle music)`) always, a known sign-off only when the chunk holds almost
//      no speech (`classifyHallucination`).
//
// Everything here is pure and host-agnostic (no node: imports, no I/O): the engine
// passes samples in and gets regions, chunks and words out, and the verify proves
// the P6 regression on a decoded fixture without a model in the loop.
//
// Why an energy VAD and not Silero: the repo's only VAD (`src/audio/silero-vad.ts`)
// is an ONNX model on onnxruntime-web, i.e. it runs in the BROWSER, and a
// transcription job is sessionless and server-side by contract — a closed tab must
// not stop a job, so the chunker cannot be a browser call. whisper.cpp's own
// `--vad` would need a second pinned model and would hide the chunk boundaries
// inside the binary, which is precisely the thing the P6 regression has to be able
// to assert. An energy VAD with an adaptive floor is measurable against this
// material (the owner's clip), and its failure mode — a loud music bed read as
// speech — is bounded by the chunker and by the model's own no-speech probability,
// not by the VAD alone.

/** One span of detected speech, in source milliseconds. */
export interface SpeechRegion {
  readonly startMs: number;
  readonly endMs: number;
}

/** One piece of audio to hand the model, in source milliseconds. */
export interface SpeechChunk {
  readonly startMs: number;
  readonly endMs: number;
}

/** A word on the source timeline, milliseconds (the app's transcript unit). */
export interface TimedWord {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export interface VadOptions {
  /** Analysis frame. 20 ms resolves a pause without smearing a plosive. */
  readonly frameMs?: number;
  /** Which frame-energy percentile is the noise floor (0.2 = the quiet fifth). */
  readonly noiseFloorPercentile?: number;
  /** How far above the noise floor a frame must sit to open speech. */
  readonly speechAboveNoiseDb?: number;
  /** How far below that it must fall to close speech (hysteresis). */
  readonly hysteresisDb?: number;
  /** A run shorter than this is a click, not a word. */
  readonly minSpeechMs?: number;
  /** Quiet this long closes a region. */
  readonly minSilenceMs?: number;
  /** Regions closer than this are one region. */
  readonly mergeGapMs?: number;
  /** Symmetric padding, so a clipped consonant is not lost. */
  readonly padMs?: number;
  /** Nothing quieter than this is ever speech, whatever the noise floor says. */
  readonly absoluteFloorDb?: number;
}

const VAD_DEFAULTS = {
  frameMs: 20,
  noiseFloorPercentile: 0.2,
  speechAboveNoiseDb: 8,
  hysteresisDb: 4,
  minSpeechMs: 250,
  minSilenceMs: 300,
  mergeGapMs: 300,
  padMs: 120,
  absoluteFloorDb: -60,
} as const;

/** dBFS of one frame, floored so digital silence is finite. */
function frameDb(samples: Float32Array, from: number, to: number): number {
  let sum = 0;
  for (let index = from; index < to; index += 1) {
    const value = samples[index]!;
    sum += value * value;
  }
  const rms = Math.sqrt(sum / Math.max(1, to - from));
  return 20 * Math.log10(Math.max(rms, 1e-7));
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return -140;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(fraction * (sorted.length - 1))));
  return sorted[index]!;
}

/**
 * Detected speech regions, in source order, non-overlapping.
 *
 * The noise floor is a percentile rather than a mean so a file that is mostly
 * speech still gets a floor from its quiet frames, and the threshold has an
 * absolute floor so a silent file cannot produce regions out of dither.
 */
export function vadSpeechRegions(
  samples: Float32Array,
  sampleRate: number,
  options: VadOptions = {},
): SpeechRegion[] {
  const settings = { ...VAD_DEFAULTS, ...options };
  if (!(sampleRate > 0) || samples.length === 0) return [];
  const frameSamples = Math.max(1, Math.round((settings.frameMs / 1000) * sampleRate));
  const frameCount = Math.floor(samples.length / frameSamples);
  if (frameCount === 0) return [];

  const energies: number[] = [];
  for (let frame = 0; frame < frameCount; frame += 1) {
    energies.push(frameDb(samples, frame * frameSamples, (frame + 1) * frameSamples));
  }
  const noiseFloor = percentile(energies, settings.noiseFloorPercentile);
  const openThreshold = Math.max(noiseFloor + settings.speechAboveNoiseDb, settings.absoluteFloorDb);
  const closeThreshold = openThreshold - settings.hysteresisDb;

  const frameMs = settings.frameMs;
  const raw: Array<{ startMs: number; endMs: number }> = [];
  let openAt: number | null = null;
  let quietFrames = 0;
  const silenceFramesToClose = Math.max(1, Math.round(settings.minSilenceMs / frameMs));

  for (let frame = 0; frame < frameCount; frame += 1) {
    const db = energies[frame]!;
    if (openAt === null) {
      if (db >= openThreshold) {
        openAt = frame * frameMs;
        quietFrames = 0;
      }
      continue;
    }
    if (db <= closeThreshold) {
      quietFrames += 1;
      if (quietFrames >= silenceFramesToClose) {
        // Close the region where the quiet started, not where it was noticed.
        const endMs = (frame - quietFrames + 1) * frameMs;
        raw.push({ startMs: openAt, endMs: Math.max(openAt, endMs) });
        openAt = null;
        quietFrames = 0;
      }
      continue;
    }
    quietFrames = 0;
  }
  if (openAt !== null) raw.push({ startMs: openAt, endMs: frameCount * frameMs });

  const merged: Array<{ startMs: number; endMs: number }> = [];
  for (const region of raw) {
    const previous = merged[merged.length - 1];
    if (previous && region.startMs - previous.endMs < settings.mergeGapMs) {
      previous.endMs = Math.max(previous.endMs, region.endMs);
      continue;
    }
    merged.push({ ...region });
  }

  const durationMs = (samples.length / sampleRate) * 1000;
  return merged
    .filter((region) => region.endMs - region.startMs >= settings.minSpeechMs)
    .map((region) => ({
      startMs: Math.max(0, Math.round(region.startMs - settings.padMs)),
      endMs: Math.min(Math.round(durationMs), Math.round(region.endMs + settings.padMs)),
    }));
}

export interface ChunkOptions {
  /** A pause at least this long ends a chunk (the kit's "chunks that end in pauses"). */
  readonly minPauseMs?: number;
  /** Hard cap, below whisper's own 30 s window so the model never splits a chunk. */
  readonly maxChunkMs?: number;
}

const CHUNK_DEFAULTS = { minPauseMs: 400, maxChunkMs: 25_000 } as const;

/**
 * Group speech regions into chunks that end in a pause.
 *
 * Two rules, both deliberate: a chunk is closed when the next region starts after a
 * pause of at least `minPauseMs`, and a chunk never exceeds `maxChunkMs` (a region
 * longer than that is split on the cap, because whisper's window would otherwise
 * cut it somewhere the VAD did not choose). A chunk therefore contains no silence
 * longer than `minPauseMs`, which is the structural half of the P6 fix.
 */
export function chunkSpeechRegions(
  regions: readonly SpeechRegion[],
  options: ChunkOptions = {},
): SpeechChunk[] {
  const settings = { ...CHUNK_DEFAULTS, ...options };
  const chunks: SpeechChunk[] = [];
  let current: { startMs: number; endMs: number } | null = null;

  const close = (): void => {
    if (current && current.endMs > current.startMs) chunks.push({ ...current });
    current = null;
  };

  for (const region of regions) {
    if (region.endMs <= region.startMs) continue;
    if (current && region.startMs - current.endMs >= settings.minPauseMs) close();
    if (current && region.endMs - current.startMs > settings.maxChunkMs) close();
    if (!current) {
      current = { startMs: region.startMs, endMs: region.endMs };
      continue;
    }
    current.endMs = Math.max(current.endMs, region.endMs);
  }
  close();

  // A single region longer than the cap is split on the cap, never dropped.
  const bounded: SpeechChunk[] = [];
  for (const chunk of chunks) {
    let start = chunk.startMs;
    while (chunk.endMs - start > settings.maxChunkMs) {
      bounded.push({ startMs: start, endMs: start + settings.maxChunkMs });
      start += settings.maxChunkMs;
    }
    if (chunk.endMs > start) bounded.push({ startMs: start, endMs: chunk.endMs });
  }
  return bounded;
}

/**
 * Outros whisper.cpp is known to invent. Every pattern is ANCHORED: a match means
 * the whole chunk's text is the invented line, never that a real sentence contains
 * it. That is what keeps a genuine "thanks for watching" outro in a speaker's own
 * words while removing the same line printed over a hum.
 */
const KNOWN_HALLUCINATIONS: readonly RegExp[] = [
  /^(gentle|soft|calm|upbeat|dramatic|sad|happy)?\s*(music|piano|instrumental|applause|laughter|silence|noise)$/iu,
  /^(blank_?audio|inaudible|silence)$/iu,
  /^thanks? (you )?for watching[.!]?$/iu,
  /^please (like and )?subscribe[.!]?$/iu,
  /^subtitles? (by|created by) .+$/iu,
  /^amara\.org$/iu,
  /^transcri(bed|ption) by .+$/iu,
  /^you$/iu,
  /^(bye|goodbye)[.!]?$/iu,
];

/** A bracketed annotation, e.g. `(gentle music)` or `[BLANK_AUDIO]`. Never dialogue. */
const ANNOTATION = /^(?:\(|\[)[^)\]]*(?:\)|\])$/u;

export type HallucinationKind = 'annotation' | 'outro';

export interface HallucinationOptions {
  /** Detected speech in the chunk; a short chunk's whole text is suspect. */
  readonly speechMs: number;
  /** Below this much speech, a whole-chunk outro match is treated as invented. */
  readonly minSpeechMs?: number;
}

/**
 * Is this chunk's whole text something the model invented?
 *
 * Two independent tests, and the difference between them is the point:
 *
 *   * `annotation` — the text is a bracketed sound label. Nobody speaks a bracket,
 *     so it is discarded however much speech the chunk holds;
 *   * `outro` — the text is a known sign-off AND the chunk holds less than
 *     `minSpeechMs` of speech. A real speaker's sign-off sits in a normal chunk and
 *     survives; the same line printed over a click does not.
 */
export function classifyHallucination(
  text: string,
  options: HallucinationOptions,
): HallucinationKind | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (ANNOTATION.test(trimmed)) return 'annotation';
  const minSpeechMs = options.minSpeechMs ?? 1000;
  if (options.speechMs < minSpeechMs && KNOWN_HALLUCINATIONS.some((pattern) => pattern.test(trimmed))) {
    return 'outro';
  }
  return null;
}

/** Convenience predicate for callers that only need the boolean. */
export function isKnownHallucination(text: string, options: HallucinationOptions): boolean {
  return classifyHallucination(text, options) !== null;
}

export interface FilterOptions {
  /** How far outside a region a word's midpoint may still count as inside. */
  readonly toleranceMs?: number;
  /** Below this much detected speech, a whole-chunk outro match is invented. */
  readonly hallucinationMinSpeechMs?: number;
  /**
   * The chunk's text as the model reported it.
   *
   * Used only when the model gave no word times: whisper.cpp prints annotations such
   * as `[Music]` with an empty word array, and a chunk whose whole text is invented
   * must still be recognisable as invented rather than indistinguishable from a chunk
   * that held nothing.
   */
  readonly text?: string;
}

export interface FilterResult {
  readonly words: TimedWord[];
  /** Words dropped because they landed outside every detected speech region. */
  readonly discardedOutsideSpeech: number;
  /** Words dropped because a very short chunk produced a known invented line. */
  readonly discardedHallucination: number;
  /** True when this chunk's whole output was a line the model invented. */
  readonly invented: boolean;
}

/**
 * Shift chunk-relative word times to source time, then apply the P6 filters.
 *
 * `chunk` is the chunk the words came from: its `startMs` is the shift, and its
 * detected speech is what a word must land in. A word is kept only when its midpoint
 * is inside a region (within `toleranceMs`), and a kept word is clamped into that
 * region so its caption cannot extend over a pause.
 */
export function shiftAndFilterWords(
  words: readonly TimedWord[],
  chunk: SpeechChunk,
  regions: readonly SpeechRegion[],
  options: FilterOptions = {},
): FilterResult {
  const tolerance = options.toleranceMs ?? 120;
  const inChunk = regions.filter((region) => region.endMs > chunk.startMs && region.startMs < chunk.endMs);
  const speechMs = inChunk.reduce(
    (total, region) => total + (Math.min(region.endMs, chunk.endMs) - Math.max(region.startMs, chunk.startMs)),
    0,
  );
  const spoken = words.map((word) => word.text).join(' ') || (options.text ?? '');
  const invented = classifyHallucination(spoken, {
    speechMs,
    ...(options.hallucinationMinSpeechMs === undefined
      ? {}
      : { minSpeechMs: options.hallucinationMinSpeechMs }),
  });
  if (invented) {
    return { words: [], discardedOutsideSpeech: 0, discardedHallucination: words.length, invented: true };
  }

  const kept: TimedWord[] = [];
  let discardedOutsideSpeech = 0;
  for (const word of words) {
    const start = chunk.startMs + word.start;
    const end = chunk.startMs + Math.max(word.end, word.start);
    const midpoint = (start + end) / 2;
    const region = inChunk.find(
      (candidate) => midpoint >= candidate.startMs - tolerance && midpoint <= candidate.endMs + tolerance,
    );
    if (!region) {
      discardedOutsideSpeech += 1;
      continue;
    }
    const clampedStart = Math.max(region.startMs, Math.min(region.endMs, start));
    const clampedEnd = Math.max(clampedStart, Math.min(region.endMs, end));
    kept.push({ text: word.text, start: Math.round(clampedStart), end: Math.round(clampedEnd) });
  }
  return { words: kept, discardedOutsideSpeech, discardedHallucination: 0, invented: false };
}

/**
 * Sample values of a RIFF/WAVE file holding 16-bit mono PCM.
 *
 * Only the shape this feature writes is supported (FFmpeg, `pcm_s16le`, mono), and
 * an unsupported file is refused rather than guessed at: a mis-read header would
 * become a wrong noise floor, and a wrong noise floor is a wrong transcript.
 */
export function decodeWavPcm16Mono(bytes: Uint8Array): { samples: Float32Array; sampleRate: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number): string =>
    String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
  if (bytes.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
    throw new Error('the decoded audio is not a RIFF/WAVE file');
  }
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let dataOffset = -1;
  let dataBytes = 0;
  while (offset + 8 <= bytes.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      dataOffset = body;
      dataBytes = Math.min(size, bytes.byteLength - body);
    }
    offset = body + size + (size % 2);
  }
  if (dataOffset < 0 || sampleRate <= 0) throw new Error('the decoded audio has no data or no format chunk');
  if (channels !== 1 || bits !== 16) {
    throw new Error(`the decoded audio must be 16-bit mono, found ${bits}-bit ${channels}-channel`);
  }
  const count = Math.floor(dataBytes / 2);
  const samples = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    samples[index] = view.getInt16(dataOffset + index * 2, true) / 32768;
  }
  return { samples, sampleRate };
}
