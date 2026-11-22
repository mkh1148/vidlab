// A13 is the one i18n rule whose scope is a NAME list, so the doc is the only
// place a reviewer can apply it from. That makes the doc and the rules file a
// pair that must not drift: a name added to `INDEX_TABLES` and not documented
// (or the reverse) leaves a reviewer applying a rule the check no longer uses.
//
// This compares the two directions:
//   * the regex quoted in docs/i18n-allowlist.md is byte-identical to
//     `INDEX_TABLES.source`, and
//   * the A13 row of the rules table names exactly the same exact-name class and
//     the same suffix class as the regex.
//
// node scripts/i18n-allowlist-doc.verify.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INDEX_TABLES } from './i18n-allowlist-rules.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// Normalised: the doc is checked in with CRLF on this checkout, and every match
// below is anchored on a newline.
const doc = readFileSync(join(root, 'docs', 'i18n-allowlist.md'), 'utf8').replace(/\r\n/g, '\n');

const sectionStart = doc.indexOf('### A13 in full');
assert.ok(sectionStart >= 0, 'docs/i18n-allowlist.md must keep the "### A13 in full" section');
const sectionEnd = doc.indexOf('\n## ', sectionStart);
const section = doc.slice(sectionStart, sectionEnd > 0 ? sectionEnd : undefined);
assert.ok(section.length > 200, 'the A13 section must actually explain the rule');

// ── the regex, verbatim ─────────────────────────────────────────────────────
const quoted = section.match(/```\n(\/.*\/)\n```/)?.[1];
assert.ok(quoted, 'the A13 section must quote the regex in a fenced block');
assert.equal(quoted, `/${INDEX_TABLES.source}/`, 'the documented regex must be the one the check uses');

// ── the two exempt classes, parsed from the regex itself ────────────────────
const exactClass = INDEX_TABLES.source.match(/^\^\(([^)]+)\)\$/)?.[1];
assert.ok(exactClass, 'INDEX_TABLES must keep the exact-name alternation first');
const exactNames = exactClass.split('|');
const suffixClass = INDEX_TABLES.source.match(/\((_[A-Z]+(?:\|_[A-Z]+)*)\)\$$/)?.[1];
assert.ok(suffixClass, 'INDEX_TABLES must keep the suffix alternation last');
const suffixes = suffixClass.split('|');
assert.ok(exactNames.length > 5 && suffixes.length > 2, 'both classes must stay populated');

for (const name of exactNames) {
  assert.ok(
    new RegExp(`\\b${name}\\b`).test(section),
    `the A13 section must document the exact name ${name}`,
  );
}
for (const suffix of suffixes) {
  assert.ok(section.includes(suffix), `the A13 section must document the suffix ${suffix}`);
}

// ── the rules-table row names the same classes ──────────────────────────────
const row = doc.split('\n').find((line) => line.startsWith('| A13 |'));
assert.ok(row, 'docs/i18n-allowlist.md must keep the A13 row in the rules table');
const backticked = [...row.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
const documentedNames = backticked
  .filter((token) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(token) && token !== 'INDEX_TABLES')
  .sort();
const documentedSuffixes = backticked
  .filter((token) => /^\*_[A-Z]+$/.test(token))
  .map((token) => token.slice(1))
  .sort();
assert.deepEqual(documentedNames, [...exactNames].sort(), 'the A13 row must name every exact class');
assert.deepEqual(documentedSuffixes, [...suffixes].sort(), 'the A13 row must name every suffix class');

console.log(
  `i18n allow-list doc checks passed (${exactNames.length} exact names, ${suffixes.length} suffixes)`,
);
