// Milestone B2 · the dangerous-class check.
//
// A CJK literal is DANGEROUS when it reaches the renderer at locale=en and has no
// English coverage: t() falls back to its key, so the English interface shows the
// Chinese original. The two checks that already exist cannot see the whole class:
//
//   scripts/check-i18n.mjs          — t('literal') keys and raw JSX renders only.
//   scripts/i18n-english.verify.mjs — t()/tData() keys and three named tables.
//
// Both miss the same shape: a Chinese string that is neither a t() argument nor a
// JSX literal but still lands on screen — an app-authored error message pushed
// into an `errors: string[]`, a label table read through a variable, a stored
// name rendered raw, a helper that returns Chinese into JSX. The independent
// triage at 443e8633 found 216 of those across 51 files.
//
// So this check inverts the question. It enumerates EVERY CJK text unit in src/
// and demands that each one be provably safe, by exactly one of the rules below.
// A unit that matches no rule and has no English entry fails. The rules, their
// operational detail and the residual are written up in docs/i18n-allowlist.md.
//
//   A1  bilingual pair — the Chinese half sits beside its English twin: a sibling
//       `*En`/`en` property, a `*Zh`/`zh` property beside the English one, a
//       two-element [zh, en] array, or an argument of localizedCatalogText().
//   A2  translation key — the unit is (part of) the first argument of t(), tData(),
//       translate(), `*.t`, localizedCatalogText(), storedName(), displayProjectName()
//       or one of the proposal/session display helpers, and the evaluated key has an
//       English entry. A `+` chain of string literals is evaluated before the
//       lookup, so 'first half ' + 'second half' is one unit and one key.
//   A3  zh-only table — a module-scope `*ZH`/`*Zh` table in a file that guards a
//       read with a `'zh'` comparison. The Chinese half of a localized catalog.
//   A4  dictionary data — src/i18n/dict/**.
//   A5  test — *.verify.* and *.check.*, including the `*.verify.<name>.ts` form
//       the base's regex missed.
//   A6  log-only — the unit's nearest enclosing call is console.*, log*(), a
//       logger.* method, warn/error/debug/info.
//   A7  algorithm data — the unit is inside a module-scope const of a file on the
//       reviewed ALGORITHM_DATA list (a reason is mandatory per file): word lists,
//       punctuation classes, search indexes and thresholds that are compared
//       against, never printed.
//   A8  agent/LLM-facing — the unit's module is reachable from src/agent/** or
//       src/skills/** and no .tsx imports it directly. The base's rule is that
//       LLM-facing content does not enter i18n; the moment a component imports the
//       module itself, its text is UI copy and needs English entries. That is the
//       hole that hid approval-details.ts:86.
//   A9  key name — a property name, enum member or element-access key.
//   A10 regex — a regular-expression literal.
//   A11 endonym — the explicit list below (日本語, 中文 …): a language names itself
//       in its own script in every locale.
//   A12 dead metadata — the explicit list below. These are DELETED, not
//       allow-listed, wherever the check finds them; the list exists only so a
//       unit can be retired deliberately. It must stay empty.
//   A13 matcher table — the unit is an element of an array literal that
//       initialises a module-scope const or a property on the reviewed
//       INDEX_TABLES name list (aliasZh, aliases, keywords, scenarios, tags,
//       synonyms, FILLER …). A CJK string in a matcher table is compared
//       against text; it is never printed. If you need to print one, move it out
//       of the table and translate it there.
//   A14 stored-name vocabulary — a module-scope const in src/i18n/storedNames.ts
//       or src/i18n/projectNames.ts. These are the names the app writes INTO a
//       document (the default sequence, generated project names). They are data:
//       never rewritten, translated at display by storedName()/displayProjectName(),
//       and each one is covered by a verify in scripts/i18n-stored-names.verify.ts.
//
// One more escape, also documented: an English dictionary entry. The unit IS a key,
// so any render through the translation surface translates it; a RAW render of key
// text is check-i18n.mjs's raw-JSX audit and the rendered scan's job, not this
// check's.
//
// Run: npx tsx scripts/i18n-allowlist.verify.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const DICT = path.join(SRC, 'i18n', 'dict');

import {
  ALGORITHM_DATA, CJK, DEAD_METADATA, ENDONYMS, INDEX_TABLES, LLM_FACING_ROOTS,
  STORED_NAME_MODULES, TRANSLATION_CALLEES,
} from './i18n-allowlist-rules.mjs';

/** Callees that only write to a log (A6). */
const LOG_CALLEES = /^(console\.\w+|log|logError|logWarn|logInfo|logDebug|debug|info|warn|error)$|(^|\.)logger\./;

const relative = (file) => path.relative(ROOT, file).split(path.sep).join('/');
const isTestFile = (file) => /\.(verify|check)\./.test(path.basename(file));
const isDictionary = (file) => file.startsWith(DICT);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const { EN } = await import('../src/i18n/dict/en/index.ts');
const EN_DATA = (await import('../src/i18n/dict/en/templates-data.ts')).default;
const ENGLISH_KEYS = new Set([...Object.keys(EN), ...Object.keys(EN_DATA)]);

const files = walk(SRC).filter((file) => /\.(ts|tsx)$/.test(file) && !isTestFile(file) && !isDictionary(file));
const sources = new Map();
for (const file of files) {
  sources.set(file, ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  ));
}

// ── the graph: what a .tsx renders (A7/A8) ──────────────────────────────────
// Resolving specifiers here rather than trusting a hand-kept list is what makes
// A7/A8 honest: one import added to a component pulls a module into the rendered
// set, and its Chinese literals become this check's business.
function resolveSpecifier(from, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(from), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? null;
}

const importsOf = new Map();
for (const [file, sf] of sources) {
  const targets = new Set();
  (function scan(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const target = resolveSpecifier(file, node.moduleSpecifier.text);
      if (target) targets.add(target);
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const target = resolveSpecifier(file, node.moduleSpecifier.text);
      if (target) targets.add(target);
    }
    if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments[0]
      && ts.isStringLiteral(node.arguments[0])
    ) {
      const target = resolveSpecifier(file, node.arguments[0].text);
      if (target) targets.add(target);
    }
    ts.forEachChild(node, scan);
  })(sf);
  importsOf.set(file, targets);
}

function closure(roots) {
  const reached = new Set(roots);
  const pending = [...roots];
  while (pending.length > 0) {
    const file = pending.pop();
    for (const target of importsOf.get(file) ?? []) {
      if (reached.has(target)) continue;
      reached.add(target);
      pending.push(target);
    }
  }
  return reached;
}

const componentFiles = files.filter((file) => file.endsWith('.tsx'));
const rendered = closure(componentFiles);
const agentRoots = files.filter((file) => LLM_FACING_ROOTS.test(relative(file)));
const agentReached = closure(agentRoots);
/** Modules a component imports by name — their text is UI copy, not LLM copy. */
const directlyImportedByComponents = new Set();
for (const file of componentFiles) {
  for (const target of importsOf.get(file) ?? []) directlyImportedByComponents.add(target);
}

// ── helpers over a unit ─────────────────────────────────────────────────────
const calleeText = (node, sf) => {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return `${node.expression.getText(sf)}.${node.name.text}`;
  return node.getText(sf);
};

/** The nearest enclosing call, or null when a statement/function boundary comes first. */
function enclosingCall(node, sf) {
  for (let parent = node.parent; parent && parent !== sf; parent = parent.parent) {
    if (ts.isCallExpression(parent)) return parent;
    if (ts.isStatement(parent) || ts.isFunctionLike(parent) || ts.isPropertyAssignment(parent)) return null;
  }
  return null;
}

/** Every key an expression can evaluate to: literals, `+` chains, both ternary arms. */
function evaluatedKeys(node) {
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isParenthesizedExpression(node)) return evaluatedKeys(node.expression);
  if (ts.isConditionalExpression(node)) {
    return [...evaluatedKeys(node.whenTrue), ...evaluatedKeys(node.whenFalse)];
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = evaluatedKeys(node.left);
    const right = evaluatedKeys(node.right);
    if (left.length === 0 || right.length === 0) return [];
    return left.flatMap((a) => right.map((b) => a + b));
  }
  return [];
}

/** The expression that forms the key a literal belongs to (concat chain, ternary arm). */
function keyExpression(node) {
  let current = node;
  for (;;) {
    const parent = current.parent;
    if (!parent) return current;
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      current = parent;
      continue;
    }
    if (ts.isConditionalExpression(parent) && (parent.whenTrue === current || parent.whenFalse === current)) {
      current = parent;
      continue;
    }
    if (ts.isParenthesizedExpression(parent)) {
      current = parent;
      continue;
    }
    return current;
  }
}

// A2 is "the key this literal becomes is in the English dictionary", NOT "a t()
// call is nearby". A `t()` whose key is missing from dict/en renders the Chinese
// key at locale=en — that is the T1 class the triage found invisible to both
// checks, and the reason this rule must look the key up instead of trusting the
// callee. A ternary key is checked arm by arm, because `t(a ? 'x' : 'y')` hides
// two keys behind one argument.
function translationCallee(node, sf) {
  const call = enclosingCall(node, sf);
  if (!call || !call.arguments[0]) return null;
  const callee = calleeText(call.expression, sf);
  if (!TRANSLATION_CALLEES.test(callee)) return null;
  if (call.arguments[0].getStart(sf) > node.getStart(sf)) return null;
  const keys = evaluatedKeys(keyExpression(node));
  if (keys.length === 0) return null;
  return keys.every((key) => ENGLISH_KEYS.has(key)) ? callee : null;
}

function logCallee(node, sf) {
  const call = enclosingCall(node, sf);
  if (!call) return null;
  const callee = calleeText(call.expression, sf);
  return LOG_CALLEES.test(callee) ? callee : null;
}

const propertyName = (property, sf) => property.name.getText(sf).replace(/['"]/g, '');

function pairRule(node, sf) {
  const parent = node.parent;
  if (parent && ts.isPropertyAssignment(parent) && ts.isObjectLiteralExpression(parent.parent)) {
    const own = propertyName(parent, sf);
    const stem = own.replace(/(En|Zh|EN|ZH)$/, '');
    const siblings = parent.parent.properties.filter(ts.isPropertyAssignment);
    const englishTwin = siblings.some((sibling) => {
      if (sibling === parent) return false;
      const name = propertyName(sibling, sf);
      if (!ts.isStringLiteralLike(sibling.initializer) || CJK.test(sibling.initializer.text)) return false;
      return name === 'en' || name === 'zh' || /En$/.test(name) || /^en[A-Z]/.test(name) || name === stem;
    });
    if (englishTwin) return 'A1';
  }
  if (parent && ts.isArrayLiteralExpression(parent) && parent.elements.length === 2) {
    const [first, second] = parent.elements;
    const cjkOf = (element) => ts.isStringLiteralLike(element) && CJK.test(element.text);
    if (cjkOf(first) !== cjkOf(second)) return 'A1';
  }
  const call = enclosingCall(node, sf);
  if (call && /localizedCatalogText/.test(calleeText(call.expression, sf))) return 'A1';
  return null;
}

function keyNameRule(node) {
  const parent = node.parent;
  if (!parent) return null;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return 'A9';
  if ((ts.isPropertySignature(parent) || ts.isMethodSignature(parent) || ts.isMethodDeclaration(parent)) && parent.name === node) return 'A9';
  if (ts.isEnumMember(parent)) return 'A9';
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return 'A9';
  return null;
}

function regexRule(node) {
  return node.kind === ts.SyntaxKind.RegularExpressionLiteral ? 'A10' : null;
}

/** A3: a module-scope `*ZH` table in a file that guards a read with `'zh'`. */
function zhOnlyTableRule(node, sf) {
  if (!/['"]zh['"]/.test(sf.text)) return null;
  let declaration = null;
  for (let parent = node.parent; parent && parent !== sf; parent = parent.parent) {
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) declaration = parent;
  }
  if (!declaration) return null;
  if (!/ZH|Zh/.test(declaration.name.text)) return null;
  return ts.isVariableStatement(declaration.parent?.parent) ? 'A3' : null;
}

/** A7: inside a module-scope const of a reviewed algorithm-data module. */
function algorithmDataRule(node, sf, rel) {
  if (!ALGORITHM_DATA.has(rel)) return null;
  for (let parent = node.parent; parent && parent !== sf; parent = parent.parent) {
    if (ts.isFunctionLike(parent)) return null;
    if (ts.isVariableDeclaration(parent)) {
      return ts.isVariableStatement(parent.parent?.parent) ? 'A7' : null;
    }
  }
  return null;
}

/** A13: an element of a reviewed matcher table. */
function matcherTableRule(node) {
  const array = node.parent;
  if (!array || !ts.isArrayLiteralExpression(array)) return null;
  const owner = array.parent;
  if (!owner) return null;
  if (ts.isVariableDeclaration(owner) && ts.isIdentifier(owner.name)) {
    return INDEX_TABLES.test(owner.name.text) && ts.isVariableStatement(owner.parent?.parent) ? 'A13' : null;
  }
  if (ts.isPropertyAssignment(owner)) {
    const name = owner.name.getText().replace(/['"]/g, '');
    return INDEX_TABLES.test(name) ? 'A13' : null;
  }
  if (ts.isNewExpression(owner)) {
    const callee = owner.expression.getText();
    if (callee === 'Set' || callee === 'Map') {
      const declaration = owner.parent;
      if (declaration && ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) {
        return INDEX_TABLES.test(declaration.name.text) && ts.isVariableStatement(declaration.parent?.parent) ? 'A13' : null;
      }
    }
  }
  return null;
}

/** A14: a module-scope const in a stored-name vocabulary module. */
function storedNameRule(node, sf, rel) {
  if (!STORED_NAME_MODULES.has(rel)) return null;
  for (let parent = node.parent; parent && parent !== sf; parent = parent.parent) {
    if (ts.isFunctionLike(parent)) return null;
    if (ts.isVariableDeclaration(parent)) return ts.isVariableStatement(parent.parent?.parent) ? 'A14' : null;
  }
  return null;
}

// ── `+` concatenation ──────────────────────────────────────────────────────
// A note built as 'first half ' + 'second half' is ONE rendered string, so it is
// one unit and one dictionary key. Evaluating the chain before the lookup is the
// same fix scripts/check-i18n.mjs needed: without it the halves look like two
// unrelated literals and neither one matches the key the renderer actually uses.
const consumed = new Set();

/** The literal operands of a topmost `+` chain, or null when the chain is mixed. */
function concatParts(node) {
  if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.PlusToken) return null;
  const parent = node.parent;
  if (parent && ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.PlusToken) return null;
  const parts = [];
  let current = node;
  while (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    parts.unshift(current.right);
    current = current.left;
  }
  parts.unshift(current);
  if (!parts.every((part) => ts.isStringLiteral(part))) return null;
  return parts;
}

// ── the walk ────────────────────────────────────────────────────────────────
const ruleCounts = {};
const failures = [];
let unitCount = 0;

function textOf(node) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (
    node.kind === ts.SyntaxKind.TemplateHead
    || node.kind === ts.SyntaxKind.TemplateMiddle
    || node.kind === ts.SyntaxKind.TemplateTail
  ) return node.text;
  if (node.kind === ts.SyntaxKind.JsxText) return node.text.trim();
  if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) return node.text;
  return null;
}

for (const [file, sf] of sources) {
  const rel = relative(file);
  const isRendered = rendered.has(file);
  const isAgentFacing = agentReached.has(file) && !directlyImportedByComponents.has(file);

  (function visit(node) {
    const parts = concatParts(node);
    if (parts) {
      for (const part of parts) consumed.add(part);
      const joined = parts.map((part) => part.text).join('');
      if (CJK.test(joined)) {
        unitCount += 1;
        const rule = classify(node, sf, rel, joined.trim(), isRendered, isAgentFacing);
        if (rule) ruleCounts[rule] = (ruleCounts[rule] ?? 0) + 1;
        else {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          failures.push({ where: `${rel}:${line + 1}`, text: joined.trim(), kind: 'concatenation' });
        }
      }
    }
    const unit = consumed.has(node) ? null : textOf(node);
    if (unit && CJK.test(unit)) {
      unitCount += 1;
      const key = unit.trim();
      const rule = classify(node, sf, rel, key, isRendered, isAgentFacing);
      if (rule) ruleCounts[rule] = (ruleCounts[rule] ?? 0) + 1;
      else {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        failures.push({
          where: `${rel}:${line + 1}`,
          text: key,
          kind: node.kind === ts.SyntaxKind.JsxText ? 'JSX text' : 'literal',
        });
      }
    }
    ts.forEachChild(node, visit);
  })(sf);
}

function classify(node, sf, rel, key, isRendered, isAgentFacing) {
  if (ENDONYMS.has(key)) return 'A11';
  if (DEAD_METADATA.has(`${rel}::${key}`)) return 'A12';
  if (translationCallee(node, sf)) return 'A2';
  if (logCallee(node, sf)) return 'A6';
  if (pairRule(node, sf)) return 'A1';
  if (keyNameRule(node)) return 'A9';
  if (regexRule(node)) return 'A10';
  if (zhOnlyTableRule(node, sf)) return 'A3';
  if (storedNameRule(node, sf, rel)) return 'A14';
  if (matcherTableRule(node)) return 'A13';
  if (algorithmDataRule(node, sf, rel)) return 'A7';
  if (ENGLISH_KEYS.has(key)) return 'EN';
  if (!isRendered) return 'A7-unrendered';
  if (isAgentFacing) return 'A8';
  return null;
}

// ── report ──────────────────────────────────────────────────────────────────
const summary = [
  `source files scanned: ${sources.size} (src/, excluding src/i18n/dict and *.verify.*/*.check.*)`,
  `CJK text units: ${unitCount}`,
  `rendered modules (a .tsx reaches them): ${rendered.size}`,
  `agent-only modules (src/agent|src/skills reach them, no .tsx imports them): ${[...agentReached].filter((file) => !directlyImportedByComponents.has(file)).length}`,
  `units cleared by rule: ${Object.entries(ruleCounts).sort((a, b) => b[1] - a[1]).map(([rule, count]) => `${rule} ${count}`).join(' · ')}`,
];

if (failures.length > 0) {
  console.error(`i18n dangerous class FAILED — ${failures.length} CJK unit(s) reach the renderer with no English coverage`);
  console.error(summary.map((line) => `  ${line}`).join('\n'));
  const byFile = new Map();
  for (const failure of failures) {
    const [file] = failure.where.split(':');
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(failure);
  }
  for (const [file, entries] of [...byFile].sort((a, b) => b[1].length - a[1].length)) {
    console.error(`  ${file} (${entries.length})`);
    for (const entry of entries) {
      console.error(`    ${entry.where} ${entry.kind} ${JSON.stringify(entry.text)} — no A-rule, no English entry`);
    }
  }
  process.exit(1);
}

console.log('i18n dangerous class: every CJK unit in src/ is translated or allow-listed');
console.log(summary.map((line) => `  ${line}`).join('\n'));
