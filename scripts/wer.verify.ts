// The WER tool's own suite: the numbers a human counter would produce, reproduced.
//
//   npx tsx scripts/wer.verify.ts
//
// What this pins down:
//   1. identical text is 0% and normalization does not invent a difference;
//   2. one substitution, one deletion, one insertion each count as exactly one and
//      land in the right bucket — the three buckets are what makes a WER number
//      actionable ("the model drops words" vs "the model adds words");
//   3. punctuation, case and full-width forms are NOT errors (the normalization is
//      the contract, and a counter who disagrees must be able to read it);
//   4. an invented sound label counts as insertions instead of being hidden (D3a
//      ledger note A3: over VAD-misdetected audio the pipeline may keep labels, and
//      the metric must show it);
//   5. an empty reference is `null`, never 0% or 100%;
//   6. the CLI computes the same number from a file and from a D3a artifact.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatWer, normalizeWords, wordErrorRate } from '../shared/wer.ts';

const reference = 'Hello there, brave new world.';

{
  const counts = wordErrorRate(reference, 'hello there brave new world');
  assert.deepEqual(
    { s: counts.substitutions, d: counts.deletions, i: counts.insertions, wer: counts.wer },
    { s: 0, d: 0, i: 0, wer: 0 },
    'case and punctuation are not errors',
  );
  assert.equal(counts.referenceWords, 5);
}

{
  // "brave" → "bold": one substitution.
  const counts = wordErrorRate(reference, 'hello there bold new world');
  assert.deepEqual([counts.substitutions, counts.deletions, counts.insertions], [1, 0, 0]);
  assert.equal(counts.wer, 0.2);
}

{
  // "brave" missing: one deletion.
  const counts = wordErrorRate(reference, 'hello there new world');
  assert.deepEqual([counts.substitutions, counts.deletions, counts.insertions], [0, 1, 0]);
  assert.equal(counts.wer, 0.2);
}

{
  // An extra word: one insertion.
  const counts = wordErrorRate(reference, 'hello there brave new big world');
  assert.deepEqual([counts.substitutions, counts.deletions, counts.insertions], [0, 0, 1]);
  assert.equal(counts.wer, 0.2);
}

{
  // Full-width forms and NFKC: "ＷＯＲＬＤ" is "world".
  const counts = wordErrorRate('world', 'ＷＯＲＬＤ');
  assert.equal(counts.wer, 0, 'NFKC folds full-width forms before comparing');
}

{
  // Apostrophes survive inside a word, are trimmed at the edges.
  assert.deepEqual(normalizeWords(`don't  'quoted'`), ["don't", 'quoted']);
}

{
  // A sound label the model invented is an INSERTION, not silence.
  const counts = wordErrorRate('hello there', 'hello there [Music]');
  assert.equal(counts.insertions, 1);
  assert.equal(counts.wer, 0.5, 'two reference words, one invented label → 50%');
}

{
  // Empty reference: no ratio exists.
  const counts = wordErrorRate('   ', 'anything at all');
  assert.equal(counts.wer, null);
  assert.equal(counts.referenceWords, 0);
  assert.match(formatWer(counts), /n\/a/);
}

{
  // The CLI, on a plain-text hypothesis and on a D3a artifact.
  const dir = mkdtempSync(join(tmpdir(), 'vidlab-wer-'));
  try {
    const refPath = join(dir, 'ref.txt');
    const hypPath = join(dir, 'hyp.txt');
    const artifactPath = join(dir, 'artifact.json');
    writeFileSync(refPath, reference);
    writeFileSync(hypPath, 'hello there bold new world');
    writeFileSync(artifactPath, JSON.stringify({
      version: 1,
      source: { name: 'clip.mp4', revision: 'r1' },
      words: [
        { text: 'Hello', start: 0, end: 400 },
        { text: 'there,', start: 400, end: 800 },
        { text: 'brave', start: 800, end: 1200 },
        { text: 'new', start: 1200, end: 1600 },
        { text: 'world.', start: 1600, end: 2000 },
      ],
    }));
    const cli = fileURLToPath(new URL('./wer.ts', import.meta.url));
    const fromText = execFileSync(process.execPath, ['--import', 'tsx', cli, '--reference', refPath, '--hypothesis', hypPath, '--json'], { encoding: 'utf8' });
    const parsedText = JSON.parse(fromText) as { wer: number; substitutions: number };
    assert.equal(parsedText.wer, 0.2);
    assert.equal(parsedText.substitutions, 1);

    const fromArtifact = execFileSync(process.execPath, ['--import', 'tsx', cli, '--reference', refPath, '--hypothesis', artifactPath, '--json'], { encoding: 'utf8' });
    const parsedArtifact = JSON.parse(fromArtifact) as { wer: number; referenceWords: number; hypothesisWords: number };
    assert.equal(parsedArtifact.wer, 0, 'a perfect artifact reads as 0% — the words are joined in order');
    assert.equal(parsedArtifact.referenceWords, 5);
    assert.equal(parsedArtifact.hypothesisWords, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('wer.verify: normalization, S/D/I buckets, sound labels, empty reference, CLI on text and artifact — OK');
