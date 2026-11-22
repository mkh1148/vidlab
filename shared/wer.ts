// Word error rate — the kit's D3 exit test, as code instead of a spreadsheet.
//
// The kit asks for "word error rate on a real recording in the owner's language,
// counted by hand against a reference transcript, plus processing time". Counting
// by hand is the owner's job; this module is the machine half: it turns the
// pipeline's words and a reference transcript into the same three numbers a human
// counter produces (substitutions, deletions, insertions) and their sum over the
// reference length.
//
// NORMALIZATION (the standard one, stated so two counters can agree):
//   1. Unicode NFKC, so full-width and compatibility forms compare equal;
//   2. lowercase;
//   3. every character that is not a letter, a digit or an apostrophe becomes a
//      space — punctuation is not a word and must not count as a substitution;
//   4. tokens are whitespace-separated; a leading/trailing apostrophe is trimmed
//      ("'hello'" → "hello") and tokens that are empty after that are dropped.
// Nothing else is normalised: no stemming, no number spelling, no filler removal.
// A sound label the model invented ("[Music]", "(applause)") therefore counts as
// words in the HYPOTHESIS and shows up as insertions — which is the honest reading
// of the D3a ledger note A3: captions over VAD-misdetected audio may contain sound
// labels, and that is an owner judgment call, not something to hide inside the
// metric.
//
// Pure: no I/O, no clock, no environment. The CLI in scripts/wer.ts is the wrapper.

export interface WerCounts {
  /** Words in the reference after normalization. The denominator. */
  readonly referenceWords: number;
  /** Words in the hypothesis after normalization. */
  readonly hypothesisWords: number;
  readonly substitutions: number;
  readonly deletions: number;
  readonly insertions: number;
  /** (S + D + I) / referenceWords. `null` when the reference has no words — a
   *  ratio against zero is not a measurement, and reporting 0 or 100 would lie. */
  readonly wer: number | null;
}

const APOSTROPHES = /^'+|'+$/g;

/** Split text into comparable word tokens (see the normalization list above). */
export function normalizeWords(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}']/gu, ' ')
    .split(/\s+/)
    .map((token) => token.replace(APOSTROPHES, ''))
    .filter((token) => token.length > 0);
}

/** Join a word list (a transcript's `words[].text`) into the reference/hypothesis
 *  string the same way the model's own `text` field is built. */
export function textOfWords(words: readonly { text: string }[]): string {
  return words.map((word) => word.text).join(' ');
}

/**
 * Levenshtein distance over word tokens, with the three counts kept separately so
 * the report says WHY the number is what it is. Tie-break order is substitution,
 * then deletion, then insertion — the conventional choice, and the one a human
 * counter makes when a word is replaced rather than dropped and re-added.
 */
export function wordErrorRate(reference: string, hypothesis: string): WerCounts {
  const ref = normalizeWords(reference);
  const hyp = normalizeWords(hypothesis);
  const n = ref.length;
  const m = hyp.length;

  // dp[i][j] over ref[0..i) × hyp[0..j); each cell carries the counts that reach it.
  let previous: Array<{ cost: number; s: number; d: number; i: number }> = [];
  for (let j = 0; j <= m; j++) previous.push({ cost: j, s: 0, d: 0, i: j });
  for (let i = 1; i <= n; i++) {
    const current: Array<{ cost: number; s: number; d: number; i: number }> = [{ cost: i, s: 0, d: i, i: 0 }];
    for (let j = 1; j <= m; j++) {
      if (ref[i - 1] === hyp[j - 1]) {
        current.push(previous[j - 1]!);
        continue;
      }
      const sub = previous[j - 1]!;
      const del = previous[j]!;
      const ins = current[j - 1]!;
      // Strict `<` with this order implements the tie-break: sub wins ties.
      let best = { cost: sub.cost + 1, s: sub.s + 1, d: sub.d, i: sub.i };
      if (del.cost + 1 < best.cost) best = { cost: del.cost + 1, s: del.s, d: del.d + 1, i: del.i };
      if (ins.cost + 1 < best.cost) best = { cost: ins.cost + 1, s: ins.s, d: ins.d, i: ins.i + 1 };
      current.push(best);
    }
    previous = current;
  }

  const final = previous[m]!;
  return {
    referenceWords: n,
    hypothesisWords: m,
    substitutions: final.s,
    deletions: final.d,
    insertions: final.i,
    wer: n === 0 ? null : final.cost / n,
  };
}

/** One-line report, the shape the doc and the CLI both print. */
export function formatWer(counts: WerCounts): string {
  const percent = counts.wer === null ? 'n/a (empty reference)' : `${(counts.wer * 100).toFixed(1)}%`;
  return `WER ${percent} — ${counts.substitutions} sub / ${counts.deletions} del / ${counts.insertions} ins`
    + ` over ${counts.referenceWords} reference words (hypothesis ${counts.hypothesisWords})`;
}
