// D3a · the P6 machinery, proven without a model, a codec or a network.
// `npx tsx server/transcript-vad.verify.ts`
//
// P6 is "Whisper invents sentences in silence", and its fix has four moving parts
// that are all pure functions: the voice-activity detector, the chunker that cuts at
// pauses, the shift that puts word times back on the source timeline, and the two
// discards (outside detected speech, known invented lines). This suite pins each of
// them on synthetic samples with a KNOWN speech/silence layout, so a regression shows
// up as a wrong number rather than as a transcript that reads plausibly.
//
// The end-to-end half of the P6 regression — a real recording with silence in the
// middle and at the end, through the real model — lives in
// server/media-job-transcription.verify.ts. This file is the part that must never be
// allowed to depend on a download.
import assert from 'node:assert/strict';
import {
  chunkSpeechRegions,
  classifyHallucination,
  decodeWavPcm16Mono,
  isKnownHallucination,
  shiftAndFilterWords,
  vadSpeechRegions,
  type SpeechRegion,
  type TimedWord,
} from './transcript-vad.ts';

const SAMPLE_RATE = 16_000;

/** A tone burst: what a VAD sees as "speech" in a fixture with no voice in it. */
function tone(durationMs: number, frequency = 220, amplitude = 0.3): Float32Array {
  const count = Math.round((durationMs / 1000) * SAMPLE_RATE);
  const samples = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    samples[index] = amplitude * Math.sin((2 * Math.PI * frequency * index) / SAMPLE_RATE);
  }
  return samples;
}

/** Digital silence, with the dither a real decoder leaves behind. */
function silence(durationMs: number): Float32Array {
  const count = Math.round((durationMs / 1000) * SAMPLE_RATE);
  const samples = new Float32Array(count);
  for (let index = 0; index < count; index += 1) samples[index] = (index % 2 === 0 ? 1 : -1) * 1e-5;
  return samples;
}

function concat(parts: readonly Float32Array[]): Float32Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** The fixture layout every assertion below refers to, in milliseconds. */
const LAYOUT = {
  speech1: { startMs: 0, endMs: 2000 },
  silence1: { startMs: 2000, endMs: 5000 },
  speech2: { startMs: 5000, endMs: 7000 },
  silence2: { startMs: 7000, endMs: 11_000 },
} as const;

const fixture = concat([
  tone(2000),
  silence(3000),
  tone(2000, 330),
  silence(4000),
]);

// ── 1. the WAV reader reads what FFmpeg writes ──────────────────────────────
{
  const samples = tone(50, 440, 0.5);
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) bytes[offset + index] = text.charCodeAt(index);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(44 + index * 2, Math.round(samples[index]! * 32767), true);
  }
  const decoded = decodeWavPcm16Mono(bytes);
  assert.equal(decoded.sampleRate, SAMPLE_RATE, 'the reader takes the rate from the fmt chunk');
  assert.equal(decoded.samples.length, samples.length, 'every sample survives the round trip');
  assert.ok(Math.abs(decoded.samples[10]! - samples[10]!) < 1e-4, 'sample values are the written ones');

  assert.throws(() => decodeWavPcm16Mono(new Uint8Array(44)), /not a RIFF\/WAVE file/,
    'a non-WAV is refused, never guessed at');
  const stereo = bytes.slice();
  new DataView(stereo.buffer).setUint16(22, 2, true);
  assert.throws(() => decodeWavPcm16Mono(stereo), /16-bit mono/, 'a stereo file is refused by name');
  console.log('transcript-vad: the WAV reader reads what FFmpeg writes and refuses what it does not');
}

// ── 2. the VAD finds the speech and nothing else ────────────────────────────
const regions = vadSpeechRegions(fixture, SAMPLE_RATE);
{
  assert.equal(regions.length, 2, `two speech runs, found ${regions.length}: ${JSON.stringify(regions)}`);
  const [first, second] = regions as [SpeechRegion, SpeechRegion];
  // The pad is the only licence to cross into a pause, and it is 120 ms by default.
  const PAD = 120;
  assert.ok(first.startMs <= LAYOUT.speech1.startMs + PAD, `first region starts at speech (${first.startMs})`);
  assert.ok(first.endMs <= LAYOUT.speech1.endMs + PAD, `first region ends at speech (${first.endMs})`);
  assert.ok(second.startMs <= LAYOUT.speech2.startMs + PAD, `second region starts at speech (${second.startMs})`);
  assert.ok(second.endMs <= LAYOUT.speech2.endMs + PAD, `second region ends at speech (${second.endMs})`);

  // The P6 property, stated as an interval test: no region covers more than the pad
  // of either silence.
  for (const pause of [LAYOUT.silence1, LAYOUT.silence2]) {
    const overlap = regions.reduce(
      (total, region) => total + Math.max(0, Math.min(region.endMs, pause.endMs) - Math.max(region.startMs, pause.startMs)),
      0,
    );
    assert.ok(overlap <= 2 * PAD, `a ${pause.endMs - pause.startMs} ms pause is covered by ${overlap} ms of speech at most (2x pad)`);
  }

  // A silent file produces no regions at all: the absolute floor is what stops a VAD
  // from turning dither into speech.
  assert.deepEqual(vadSpeechRegions(silence(3000), SAMPLE_RATE), [], 'a silent file has no speech regions');
  assert.deepEqual(vadSpeechRegions(new Float32Array(0), SAMPLE_RATE), [], 'an empty file has no speech regions');
  console.log(`transcript-vad: VAD found ${regions.length} regions for the fixture layout, none over the pauses`);
}

// ── 3. the chunker cuts at pauses and never past the model's window ─────────
{
  const chunks = chunkSpeechRegions(regions);
  assert.equal(chunks.length, 2, 'a 3 s pause splits the two runs into two chunks');
  assert.ok(chunks[0]!.endMs <= LAYOUT.speech1.endMs + 120, 'the first chunk ends inside the first run');
  assert.ok(chunks[1]!.startMs >= LAYOUT.speech2.startMs - 120, 'the second chunk starts at the second run');

  // A short pause does NOT split: the model gets a whole phrase, not a fragment.
  const close: SpeechRegion[] = [
    { startMs: 0, endMs: 1000 },
    { startMs: 1200, endMs: 2000 },
  ];
  assert.equal(chunkSpeechRegions(close).length, 1, 'a 200 ms gap is inside one chunk, not a cut');
  assert.equal(chunkSpeechRegions(close, { minPauseMs: 150 }).length, 2, 'the pause threshold is the one asked for');

  // A region longer than the cap is split on the cap, never dropped and never left
  // to whisper's own window.
  const long: SpeechRegion[] = [{ startMs: 0, endMs: 60_000 }];
  const longChunks = chunkSpeechRegions(long, { maxChunkMs: 25_000 });
  assert.deepEqual(
    longChunks,
    [{ startMs: 0, endMs: 25_000 }, { startMs: 25_000, endMs: 50_000 }, { startMs: 50_000, endMs: 60_000 }],
    'a 60 s run becomes three chunks of at most 25 s',
  );
  assert.deepEqual(chunkSpeechRegions([]), [], 'no speech means no chunks');
  console.log('transcript-vad: chunker cuts at pauses, keeps short gaps whole, bounds a long run');
}

// ── 4. times shift back to the source, and text leaves the pauses ───────────
{
  // A chunk that starts at 5 s, and words reported relative to it.
  const chunk = { startMs: 5000, endMs: 7000 };
  const words: TimedWord[] = [
    { text: 'hello', start: 0, end: 300 },
    { text: 'there', start: 300, end: 700 },
    // This one lands in the pause AFTER the chunk: the model invented it.
    { text: 'invented', start: 2100, end: 2400 },
  ];
  const filtered = shiftAndFilterWords(words, chunk, regions);
  assert.deepEqual(
    filtered.words.map((word) => word.text),
    ['hello', 'there'],
    'a word whose midpoint is outside detected speech is discarded',
  );
  assert.equal(filtered.words[0]!.start, 5000, 'the first word is shifted to the chunk start');
  assert.equal(filtered.words[1]!.end, 5700, 'the second word keeps its offset from the chunk start');
  assert.equal(filtered.discardedOutsideSpeech, 1, 'the discard is counted, not silent');

  // A word that starts before the region is clamped into it, so a caption can never
  // hang over the pause before it.
  const straddling: TimedWord[] = [{ text: 'straddle', start: -500, end: 200 }];
  const clamped = shiftAndFilterWords(straddling, { startMs: 5000, endMs: 7000 }, regions);
  assert.equal(clamped.words.length, 1, 'a straddling word is kept');
  assert.equal(clamped.words[0]!.start, regions[1]!.startMs, 'and its start is clamped to the region');

  // The whole-chunk discards.
  assert.equal(classifyHallucination('(gentle music)', { speechMs: 5000 }), 'annotation',
    'a bracketed sound label is discarded however much speech the chunk holds');
  assert.equal(classifyHallucination('[BLANK_AUDIO]', { speechMs: 5000 }), 'annotation');
  assert.equal(classifyHallucination('Thank you for watching.', { speechMs: 300 }), 'outro',
    'a known sign-off over almost no speech is invented');
  assert.equal(classifyHallucination('Thank you for watching.', { speechMs: 4000 }), null,
    'the same line inside a real chunk is kept: a speaker may say it');
  assert.equal(classifyHallucination('thanks for watching the show last night', { speechMs: 200 }), null,
    'the patterns are anchored: a real sentence that contains the words is kept');
  assert.equal(isKnownHallucination('hello there', { speechMs: 100 }), false);

  const invented = shiftAndFilterWords(
    [{ text: '(gentle', start: 0, end: 500 }, { text: 'music)', start: 500, end: 900 }],
    { startMs: 0, endMs: 2000 },
    [{ startMs: 0, endMs: 2000 }],
  );
  assert.deepEqual(invented.words, [], 'an invented annotation is dropped whole');
  assert.equal(invented.discardedHallucination, 2, 'and both words are counted');
  console.log('transcript-vad: times shift to the source, silence text is discarded, kept words are clamped');
}

// ── 5. the regression, stated as a property over the fixture ────────────────
{
  // Every chunk of the fixture, with a word placed at the START and END of each chunk
  // (the two places a model's times run over a pause), then filtered.
  const chunks = chunkSpeechRegions(regions);
  const words: TimedWord[] = chunks.flatMap((chunk) => [
    { text: 'first', start: 0, end: 200 },
    { text: 'last', start: chunk.endMs - chunk.startMs - 200, end: chunk.endMs - chunk.startMs },
  ]);
  const kept = chunks.flatMap((chunk, index) => shiftAndFilterWords(
    [words[index * 2]!, words[index * 2 + 1]!],
    chunk,
    regions,
  ).words);
  assert.ok(kept.length > 0, 'the fixture keeps words where there is speech');
  for (const word of kept) {
    for (const pause of [LAYOUT.silence1, LAYOUT.silence2]) {
      const overlap = Math.max(0, Math.min(word.end, pause.endMs) - Math.max(word.start, pause.startMs));
      assert.ok(overlap <= 120, `word "${word.text}" overlaps a pause by ${overlap} ms (at most the 120 ms pad)`);
    }
  }
  console.log(`transcript-vad: ${kept.length} kept words, none over a pause beyond the VAD pad`);
}

console.log('transcript-vad.verify: ok (WAV reader, VAD regions, pause chunking, source-time shift, P6 discards, no-word-over-silence)');
