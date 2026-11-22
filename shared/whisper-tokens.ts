// whisper.cpp emits BPE tokens, not words. This is the ONE place that turns them
// into word spans, shared by the two consumers of the same binary:
//
//   * the desktop native-ASR worker (`desktop/native-asr-utils.ts`), which wraps
//     these functions into its `DesktopAsrChunk` contract;
//   * the server transcription engine (D3a, `server/media-job-transcription.ts`),
//     which needs source-time word spans to store on a clip.
//
// Two mergers would be two answers to "where does a word start", and the caption
// track D3b builds reads word times — so the rule lives here once.
//
// The rule: only a token whose raw text begins with whitespace opens a new word
// (" Привет"), and the pieces that follow continue it ("тест" + "ов" + "ая" =
// "тестовая"); punctuation belongs to the word it trails. Scripts written without
// spaces (Han/kana, Thai, Lao, Myanmar, Khmer) carry no such whitespace, so each
// token opens a word; transformers.js splits the browser ONNX path the same way
// for its space-less language list (Chinese, Japanese, Thai, Lao, Myanmar). Korean
// uses spaces (whisper.cpp splits 안녕하세요 into 안녕 + 하세요), so Hangul joins
// like Russian instead of fragmenting.
//
// Host-agnostic on purpose (no node: imports): the desktop worker, the server and
// a verify all import it.

export interface WhisperWordToken {
  readonly text?: string;
  readonly offsets?: { from: number; to: number };
}

export interface WhisperJsonSegment {
  readonly text?: string;
  readonly tokens?: readonly WhisperWordToken[];
}

export interface WhisperJson {
  readonly transcription?: readonly WhisperJsonSegment[];
}

/** One word on the source timeline. Milliseconds, like every transcript in the app. */
export interface WhisperWordSpan {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

const NO_SPACE_SCRIPT_TOKEN =
  /[\u0E00-\u0E7F\u0E80-\u0EFF\u1000-\u109F\u1780-\u17FF\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\u{20000}-\u{2FA1F}]/u;

interface MutableSpan {
  text: string;
  start: number;
  end: number;
}

/**
 * Append one whisper token to the word being built: only a token that opens a
 * word (leading whitespace, or the first character of a script that does not use
 * spaces) starts a new span; continuations and trailing punctuation extend the
 * word before them.
 */
function appendWhisperToken(spans: MutableSpan[], rawText: string, start: number, end: number): void {
  const text = rawText.trim();
  if (!text) return;
  const previous = spans[spans.length - 1];
  // `text[0]` tears surrogate pairs, and the CJK extension ranges are astral:
  // test the first code point.
  const first = String.fromCodePoint(text.codePointAt(0)!);
  if (!previous || /^\s/.test(rawText) || NO_SPACE_SCRIPT_TOKEN.test(first)) {
    spans.push({ text, start, end });
    return;
  }
  previous.text += text;
  previous.end = Math.max(previous.end, end);
}

/** True for a special/annotation token such as `[BLANK_AUDIO]` or `[_BEG_]`. */
function isAnnotationToken(text: string): boolean {
  return text.startsWith('[') || text.endsWith(']');
}

/**
 * Project whisper.cpp `-ojf` token output (`transcription[].tokens[].offsets`,
 * in milliseconds) into word spans.
 */
export function whisperTokensToWordSpans(
  transcription: readonly WhisperJsonSegment[] | undefined,
): { text: string; words: WhisperWordSpan[] } {
  const spans: MutableSpan[] = [];
  let text = '';
  for (const segment of transcription ?? []) {
    const segmentText = (segment.text ?? '').trim();
    if (segmentText) text = text ? `${text}\n${segmentText}` : segmentText;
    for (const token of segment.tokens ?? []) {
      const tokenText = (token.text ?? '').trim();
      const offsets = token.offsets;
      if (!tokenText || !offsets
        || typeof offsets.from !== 'number' || typeof offsets.to !== 'number') continue;
      if (isAnnotationToken(tokenText)) continue;
      appendWhisperToken(spans, token.text ?? '', Math.round(offsets.from), Math.round(offsets.to));
    }
  }
  return { text, words: spans };
}

/**
 * Project whisper-server `verbose_json` words (BPE tokens with seconds) into word
 * spans. Seconds become milliseconds here, once.
 */
export function whisperWordsToWordSpans(
  words: readonly { word?: string; start?: number; end?: number }[] | undefined,
): WhisperWordSpan[] {
  const spans: MutableSpan[] = [];
  for (const word of words ?? []) {
    const text = (word.word ?? '').trim();
    if (!text || typeof word.start !== 'number' || typeof word.end !== 'number') continue;
    if (isAnnotationToken(text)) continue;
    appendWhisperToken(spans, word.word ?? '', Math.round(word.start * 1000), Math.round(word.end * 1000));
  }
  return spans;
}
