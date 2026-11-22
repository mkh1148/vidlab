// The WER measurement tool — the machine half of the kit's D3 exit test.
//
//   npx tsx scripts/wer.ts --reference ref.txt --hypothesis artifact.json
//   npx tsx scripts/wer.ts --reference ref.txt --hypothesis hyp.txt --json
//   npx tsx scripts/wer.ts --reference ref.txt --hypothesis artifact.json --label "cold run"
//
// --hypothesis accepts either a plain text file or a transcription artifact
// (`TranscriptArtifact` v1, the JSON the D3a engine writes): when the file parses as
// JSON with a `words` array, the words are joined in order, so the number is computed
// from the same tokens the captions will show.
//
// The reference is ALWAYS a file the owner supplies. This tool refuses to invent one:
// there is no default, no bundled sample, and no "use the hypothesis as reference"
// mode — that would report 0% for a pipeline that understood nothing.
//
// Exit codes: 0 measured, 1 usage or I/O error, 2 the reference has no usable words.
import { readFileSync } from 'node:fs';
import { formatWer, normalizeWords, textOfWords, wordErrorRate } from '../shared/wer.ts';

interface ArtifactShape {
  words?: Array<{ text?: unknown }>;
}

function usage(message: string): never {
  console.error(`wer: ${message}`);
  console.error('usage: npx tsx scripts/wer.ts --reference <file> --hypothesis <file|artifact.json> [--json] [--label <text>]');
  process.exit(1);
}

function readWords(path: string): string {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (cause) {
    usage(`cannot read ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as ArtifactShape;
      if (Array.isArray(parsed.words)) {
        const words = parsed.words
          .map((word) => (typeof word?.text === 'string' ? word.text : ''))
          .filter((text) => text.length > 0);
        return textOfWords(words.map((text) => ({ text })));
      }
    } catch {
      // Not JSON after all — fall through and treat it as plain text.
    }
  }
  return raw;
}

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const referencePath = option('reference');
const hypothesisPath = option('hypothesis');
const label = option('label');
const asJson = args.includes('--json');
if (!referencePath) usage('--reference is required (a transcript the owner supplies; this tool never invents one)');
if (!hypothesisPath) usage('--hypothesis is required (a transcription artifact or a plain text file)');

const reference = readWords(referencePath);
const hypothesis = readWords(hypothesisPath);
if (normalizeWords(reference).length === 0) {
  console.error(`wer: the reference ${referencePath} has no words after normalization — nothing to measure against`);
  process.exit(2);
}

const counts = wordErrorRate(reference, hypothesis);
if (asJson) {
  console.log(JSON.stringify({ label: label ?? null, reference: referencePath, hypothesis: hypothesisPath, ...counts }, null, 2));
} else {
  if (label) console.log(`${label}:`);
  console.log(formatWer(counts));
}
