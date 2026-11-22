// Milestone B · the static half of the English-coverage check.
//
// The base's own scripts/check-i18n.mjs already refuses a Chinese literal that is
// rendered raw in src/ and a t('…') key the English dictionary does not have. It
// cannot see three things this check is about:
//
//   1. keys the OTHER locales translate and English does not. The dictionary is
//      keyed by the Chinese original and t() falls back to that key, so a missing
//      English entry renders Chinese — the one failure mode the interface must not
//      have. A key can also be an ORPHAN (the Chinese source text changed after the
//      translation landed); an orphan leaks nothing, so it is counted, not failed.
//   2. tData() keys, which read a separate table (en/templates-data.ts).
//   3. t()/tData() outside src/ — server/, shared/, cli/, desktop/ — and the
//      non-literal calls whose key is a constant in the same file.
//
// Plus the dictionary's own hygiene: no empty value, placeholders preserved, and
// no Chinese left in an English value.
//
// Run: npx tsx scripts/i18n-english.verify.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/;
const SOURCE_DIRS = ['src', 'server', 'shared', 'cli', 'desktop'];

const { EN } = await import('../src/i18n/dict/en/index.ts');
const { IT } = await import('../src/i18n/dict/it/index.ts');
const { RU } = await import('../src/i18n/dict/ru/index.ts');
const { ZH_DATA } = await import('../src/i18n/dict/zh/index.ts');
const EN_DATA = (await import('../src/i18n/dict/en/templates-data.ts')).default;
const IT_DATA = (await import('../src/i18n/dict/it/templates-data.ts')).default;

const failures = [];
const fail = (message) => failures.push(message);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(full);
    return [full];
  });
}

const relative = (file) => path.relative(ROOT, file).split(path.sep).join('/');
const isTestFile = (file) => /\.(verify|check)\.(tsx?|mts|mjs)$/.test(file);
// The dictionary tables are the data, not a consumer of it. Everything else
// under src/i18n is code that calls t() (storedNames.ts does) and stays in.
const isDictionaryData = (file) => file.startsWith(path.join(ROOT, 'src', 'i18n', 'dict'));

const sourceFiles = SOURCE_DIRS
  .map((dir) => path.join(ROOT, dir))
  .filter((dir) => fs.existsSync(dir))
  .flatMap(walk)
  .filter((file) => /\.(ts|tsx|mts)$/.test(file) && !isTestFile(file) && !isDictionaryData(file));

// ── 1. dictionary hygiene ───────────────────────────────────────────────────
const placeholders = (text) => (String(text).match(/\{(\w+)\}/g) ?? []).sort().join(',');

const TABLES = [
  ['en', EN, 'UI'],
  ['en/templates-data', EN_DATA, 'data'],
  ['it', IT, 'UI'],
  ['it/templates-data', IT_DATA, 'data'],
  ['ru', RU, 'UI'],
  ['zh', ZH_DATA, 'data'],
];
const tableSizes = {};
for (const [name, table, kind] of TABLES) {
  tableSizes[name] = Object.keys(table).length;
  for (const [key, value] of Object.entries(table)) {
    if (typeof value !== 'string' || !value.trim()) {
      fail(`${name}: empty translation for ${JSON.stringify(key)}`);
      continue;
    }
    if (kind === 'UI' && placeholders(key) !== placeholders(value)) {
      fail(`${name}: placeholder mismatch for ${JSON.stringify(key)} — key has [${placeholders(key)}], value has [${placeholders(value)}]`);
    }
    if (name === 'en' && CJK.test(value)) {
      fail(`en: the English value still contains Chinese: ${JSON.stringify(key)} → ${JSON.stringify(value)}`);
    }
  }
}

// ── 2. keys another locale translates and English does not ──────────────────
// "Live" means the Chinese original is still a string literal somewhere in the
// sources, which is what makes it a key t() can be called with. A key that is no
// longer a literal anywhere is an orphan left behind when the source text changed
// — dead weight, not a leak. (A plain substring test is not good enough: the
// orphan '素材保存目录' is a substring of the live '选择素材保存目录'.)
const sourceLiterals = new Set();

// ── 3 + 4. every key the code passes to t()/tData() ─────────────────────────
// Literal arguments are read directly; an identifier argument is resolved to the
// string constants declared in the same file. A key that is not a constant of the
// same file (a table lookup, a prop) cannot be resolved statically — those are
// counted and left to the rendered scan, which sees what actually reaches a pixel.
let literalKeys = 0;
let resolvedKeys = 0;
const unresolved = [];

for (const file of sourceFiles) {
  const text = fs.readFileSync(file, 'utf8');
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const constants = new Map();
  const remember = (name, value) => {
    const values = constants.get(name) ?? [];
    values.push(value);
    constants.set(name, values);
  };
  const unwrap = (node) => {
    let current = node;
    while (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current)) {
      current = current.expression;
    }
    return current;
  };
  (function collect(node) {
    if (ts.isStringLiteralLike(node) && CJK.test(node.text)) sourceLiterals.add(node.text);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializer = unwrap(node.initializer);
      if (ts.isStringLiteralLike(initializer)) remember(node.name.text, initializer.text);
      if (ts.isConditionalExpression(initializer)) {
        for (const branch of [initializer.whenTrue, initializer.whenFalse]) {
          const value = unwrap(branch);
          if (ts.isStringLiteralLike(value)) remember(node.name.text, value.text);
        }
      }
    }
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && ts.isStringLiteralLike(node.initializer)) {
      remember(node.name.text, node.initializer.text);
    }
    ts.forEachChild(node, collect);
  })(source);

  const check = (key, table, name, node) => {
    if (!CJK.test(key)) return; // an English key passes through t() unchanged
    if (key in table) return;
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    fail(`${relative(file)}:${line + 1} ${name}(${JSON.stringify(key)}) has no English entry — it renders the Chinese original`);
  };

  (function visit(node) {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && (node.expression.text === 't' || node.expression.text === 'tData')
      && node.arguments[0]
    ) {
      const isData = node.expression.text === 'tData';
      const table = isData ? EN_DATA : EN;
      const argument = node.arguments[0];
      if (ts.isStringLiteralLike(argument)) {
        literalKeys += 1;
        check(argument.text, table, node.expression.text, argument);
      } else if (ts.isIdentifier(argument) && constants.has(argument.text)) {
        resolvedKeys += 1;
        for (const value of constants.get(argument.text)) check(value, table, node.expression.text, argument);
      } else {
        unresolved.push(`${relative(file)}: ${node.expression.text}(${argument.getText(source).slice(0, 48)})`);
      }
    }
    ts.forEachChild(node, visit);
  })(source);
}

const orphaned = [];
for (const [name, table] of [['it', IT], ['ru', RU], ['it/templates-data', IT_DATA]]) {
  for (const key of Object.keys(table)) {
    const reference = name === 'it/templates-data' ? EN_DATA : EN;
    if (key in reference) continue;
    if (sourceLiterals.has(key)) {
      fail(`${name} translates a key English does not have: ${JSON.stringify(key)} — an English user sees the Chinese original`);
    } else {
      orphaned.push(`${name}: ${JSON.stringify(key)}`);
    }
  }
}

// ── 5. data tables whose names reach t() through a variable ─────────────────
// The inspector renders t(def.name), t(def.desc) and t(p.label) for every effect
// (src/components/inspector/InspectorVisualControls.tsx), so an effect added
// without a dictionary entry is invisible to section 3 — the key is a table
// field, not a literal — and shows Chinese in the English interface. The
// professional colorist toolkit shipped that way: 27 rows across four effects.
// This reads the tables instead of guessing at them.
const { ALL_FX, LUT_EFFECTS } = await import('../src/gl/fx/effects.ts');
const effectRows = [];
for (const definition of [...Object.values(ALL_FX), ...Object.values(LUT_EFFECTS)]) {
  effectRows.push(['name', definition.name]);
  if (definition.desc) effectRows.push(['desc', definition.desc]);
  for (const property of definition.props ?? []) {
    if (property.label) effectRows.push(['label', property.label]);
  }
}
const seenEffectRows = new Set();
let effectRowsChecked = 0;
for (const [kind, text] of effectRows) {
  const identity = `${kind}\u0000${text}`;
  if (seenEffectRows.has(identity)) continue;
  seenEffectRows.add(identity);
  effectRowsChecked += 1;
  // An English row needs no entry: t() returns it unchanged.
  if (!CJK.test(text) || text in EN) continue;
  fail(`effect ${kind} ${JSON.stringify(text)} has no English entry — the inspector renders the Chinese original`);
}

// ── 6. the propose→apply surface ────────────────────────────────────────────
// A proposal is stored data: the verb comes from the tool→verb table in
// src/agent/proposal.ts, the impact is a counted fragment, the target and the
// title/summary have Chinese fallbacks, and change-log sessions carry their own
// summary. All of it is composed at runtime, so none of it is a literal t()
// argument and section 3 cannot see it — ProposalCard.tsx and
// AgentChangeLogMenu.tsx rendered Chinese in the English interface until
// src/i18n/proposalText.ts started translating these at display time. This
// reads the tables, so a new verb or fragment without an entry fails here.
const { VERB } = await import('../src/agent/proposal.ts');
const { IMPACT_FRAGMENTS, IMPACT_WORDS, PROPOSAL_FALLBACKS, CHANGE_SESSION_SUMMARIES } = await import(
  '../src/i18n/proposalText.ts'
);
const proposalRows = [
  ...Object.values(VERB).map((text) => ['verb', text]),
  ...IMPACT_FRAGMENTS.map((text) => ['impact fragment', text]),
  ...IMPACT_WORDS.map((text) => ['impact word', text]),
  ...PROPOSAL_FALLBACKS.map((text) => ['fallback', text]),
  ...CHANGE_SESSION_SUMMARIES.map((text) => ['change-log summary', text]),
];
const seenProposalRows = new Set();
let proposalRowsChecked = 0;
for (const [kind, text] of proposalRows) {
  const identity = `${kind}\u0000${text}`;
  if (seenProposalRows.has(identity)) continue;
  seenProposalRows.add(identity);
  proposalRowsChecked += 1;
  if (!CJK.test(text) || text in EN) continue;
  fail(`proposal ${kind} ${JSON.stringify(text)} has no English entry — the proposal card renders the Chinese original`);
}

// ── 7. sound-effect descriptions ────────────────────────────────────────────
// SoundBrowser.tsx interpolates t(sound.desc) into the hover tooltip, so every
// row's desc is a dictionary key reached through a variable. 350 rows shipped
// Chinese-only. Names and groups were already bilingual.
const { SOUND_EFFECTS } = await import('../src/audio/soundLibrary.ts');
let soundRowsChecked = 0;
for (const sound of SOUND_EFFECTS) {
  soundRowsChecked += 1;
  if (!CJK.test(sound.desc) || sound.desc in EN) continue;
  fail(`sound desc ${JSON.stringify(sound.id)} has no English entry — the SFX tooltip renders the Chinese original`);
}

// ── report ──────────────────────────────────────────────────────────────────
const summary = [
  `dictionaries: ${Object.entries(tableSizes).map(([name, count]) => `${name} ${count}`).join(' · ')}`,
  `source files scanned: ${sourceFiles.length} (${SOURCE_DIRS.join(', ')})`,
  `t()/tData() keys checked: ${literalKeys} literal + ${resolvedKeys} resolved from a same-file constant`,
  `non-literal keys left to the rendered scan: ${unresolved.length}`,
  `effect name/desc/label rows checked: ${effectRowsChecked}`,
  `proposal verb/impact/fallback rows checked: ${proposalRowsChecked}`,
  `sound desc rows checked: ${soundRowsChecked}`,
  `orphaned translations (source text changed; nothing leaks): ${orphaned.length}`,
];

if (failures.length > 0) {
  console.error(`i18n English coverage FAILED — ${failures.length} problem(s)`);
  console.error(summary.map((line) => `  ${line}`).join('\n'));
  for (const message of failures) console.error(`  ✗ ${message}`);
  process.exit(1);
}

console.log('i18n English coverage: every key the code translates has an English entry');
console.log(summary.map((line) => `  ${line}`).join('\n'));
if (orphaned.length > 0) {
  console.log('  orphaned translations (safe to delete, kept out of this slice):');
  for (const entry of orphaned) console.log(`    · ${entry}`);
}
assert.ok(Object.keys(EN).length > 2000, 'the English dictionary must be the large one');
