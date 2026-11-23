// D-11 · the EN-only guarantee, in one place.
//
// The owner decided the app ships exactly ONE user-facing language. The rendered scan
// proves what reaches a pixel; this proves the state that makes that true, because each
// of these regressions would restore a second language without a single CJK character on
// a screen the scan visits:
//
//   1. a locale payload or a switcher comes back — an import of dict/it|ru|zh, a
//      LocaleToggle, a setLocale/subscribeLocale, a prefetch of the other languages;
//   2. the server starts answering in a stored language again — parseUiLocale accepting
//      zh/it/ru, or uiLocale() defaulting to zh on a fresh data directory;
//   3. a t()-visible value in the English dictionary still contains CJK, which renders
//      Chinese inside an English frame;
//   4. the two leak classes the owner could actually see come back — the caption style
//      save-name prefill (Rank 1) and the server-authored probe/refusal text (Rank 2).
//
// Run: npx tsx scripts/i18n-en-only.verify.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\u{20000}-\u{2EBEF}\u{30000}-\u{3134F}]/u;

// ── the detector must see past the BMP ──────────────────────────────────────
// A BMP-only class passes every astral ideograph, so a Chinese sentence written in
// CJK Ext B would reach the screen with no detector firing. These assertions fail if
// the class loses its astral ranges or its `u` flag — that is the point of them.
assert.ok(CJK.test('\u{20000}'), 'the CJK class must catch CJK Ext B (U+20000)');
assert.ok(CJK.test('\u{2A700}'), 'the CJK class must catch CJK Ext C (U+2A700)');
assert.ok(CJK.test('\u{2EBEF}'), 'the CJK class must catch CJK Ext F (U+2EBEF)');
assert.ok(CJK.test('\u{30000}'), 'the CJK class must catch CJK Ext G (U+30000)');
assert.ok(CJK.test('\u{3134F}'), 'the CJK class must catch CJK Ext H (U+3134F)');
assert.ok(CJK.test('\u4e00'), 'the CJK class still catches a BMP ideograph');
assert.ok(!CJK.test('Plain English copy'), 'the CJK class must not fire on Latin text');
const SOURCE_DIRS = ['src', 'server', 'shared', 'cli', 'desktop', 'remotion', 'scripts'];
const SELF = path.relative(ROOT, fileURLToPath(import.meta.url)).split(path.sep).join('/');

const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const relativeOf = (file) => path.relative(ROOT, file).split(path.sep).join('/');

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(full);
    return [full];
  });
}

const sourceFiles = SOURCE_DIRS
  .flatMap((dir) => walk(path.join(ROOT, dir)))
  .filter((file) => /\.(ts|tsx|mts|mjs)$/.test(file))
  .filter((file) => relativeOf(file) !== SELF);

// ── 1. one locale, one dictionary, no switcher ──────────────────────────────
// A browser that stored 'zh' in an older build is the migration case: the module migrates
// the value on load, so the stub has to be in place before locale.ts is imported.
const store = new Map([['cc.locale', 'zh']]);
globalThis.localStorage = {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => { store.set(key, value); },
};
const locale = await import('../src/i18n/locale.ts');
assert.deepEqual([...locale.ALL_LOCALES], ['en'], 'the locale list is exactly English');
assert.equal(locale.getLocale(), 'en', 'the app has no other language to report');
assert.equal(store.get('cc.locale'), 'en',
  'a stored non-English preference is migrated to English on load, not left as residue');

const localeSource = read('src/i18n/locale.ts');
for (const symbol of ['setLocale', 'subscribeLocale', 'prefetchLocaleDicts', 'STORAGE_KEY', 'systemLocale']) {
  assert.doesNotMatch(
    localeSource,
    new RegExp(`\\b${symbol}\\b`),
    `src/i18n/locale.ts must not carry ${symbol} any more — there is nothing to switch or warm`,
  );
}

// A payload import is how the second language came back last time: the deleted
// dictionaries were lazy chunks, so an import is the only thing that can revive one.
const payloadImports = [];
for (const file of sourceFiles) {
  const text = fs.readFileSync(file, 'utf8');
  const match = text.match(/['"`][^'"`]*\/dict\/(it|ru|zh)(\/[^'"`]*)?['"`]/);
  if (match) payloadImports.push(`${relativeOf(file)}: ${match[0]}`);
  if (/\bLocaleToggle\b/.test(text)) payloadImports.push(`${relativeOf(file)}: LocaleToggle`);
}
assert.deepEqual(payloadImports, [],
  `the it/ru/zh dictionaries and the language switcher are deleted (D-11):\n  ${payloadImports.join('\n  ')}`);

// ── 2. the server answers in English, whatever is stored ────────────────────
const { parseUiLocale, uiLocale, localized } = await import('../server/ui-locale.ts');
for (const rejected of ['zh', 'it', 'ru', 'zh-CN', 'it-IT', 'ru-RU', '', '  ', null, undefined, 42]) {
  assert.equal(parseUiLocale(rejected), null,
    `parseUiLocale must reject ${JSON.stringify(rejected)} — a stale value cannot select a language`);
}
assert.equal(parseUiLocale('en'), 'en');
assert.equal(parseUiLocale(' EN '), 'en', 'a stored value is trimmed and lowercased, as before');
assert.equal(uiLocale(), 'en',
  'uiLocale() is English — a fresh data directory, or a stored zh/it/ru value, resolves to English');
assert.equal(localized({ zh: 'ZH-ARM', en: 'English' }), 'English',
  'localized() returns the English variant; the other arms are inert data');

// ── 3. no CJK in a t()-visible English value ────────────────────────────────
const { EN } = await import('../src/i18n/dict/en/index.ts');
const EN_DATA = (await import('../src/i18n/dict/en/templates-data.ts')).default;
for (const [name, table] of [['en', EN], ['en/templates-data', EN_DATA]]) {
  const leaking = Object.entries(table)
    .filter(([, value]) => typeof value === 'string' && CJK.test(value))
    .map(([key, value]) => `${JSON.stringify(key)} → ${JSON.stringify(value)}`);
  assert.deepEqual(leaking, [],
    `${name} values still contain CJK — an English frame renders them:\n  ${leaking.join('\n  ')}`);
}

// ── 4a. Rank 1: the caption style save-name prefill and the preset list ─────
// One dictionary entry serves both the prefill and the display of a stored name, so
// the two cannot drift; the key is the Chinese template the base used to inline.
const styleKey = Object.keys(EN).find((key) => EN[key] === 'My style {name}');
assert.ok(styleKey, 'the English dictionary must translate the caption style save-name template');
const { t, ensureLocaleDict } = await import('../src/i18n/locale.ts');
await ensureLocaleDict();
assert.equal(t(styleKey, { name: '2026/11/22' }), 'My style 2026/11/22',
  'the save-name prefill is English');

const { storedName } = await import('../src/i18n/storedNames.ts');
assert.equal(storedName(styleKey.replace('{name}', '2026/11/22')), 'My style 2026/11/22',
  'a preset saved with the prefill renders in English, including one saved before D-11');
assert.equal(storedName('My own caption look'), 'My own caption look',
  'a name the user or the agent typed is theirs and survives verbatim');

const menuSource = read('src/captions/CaptionStyleMenu.tsx');
assert.match(menuSource, /setNameDraft\(t\(/, 'the save-name draft must come from the dictionary');
assert.match(menuSource, /\{storedName\(p\.name\)\}/, 'saved presets must render through the stored-name channel');
assert.doesNotMatch(menuSource, /`[^`]*[\u3400-\u9fff][^`]*\$\{/, 'no Chinese template literal may prefill the draft');

// ── 4b. Rank 2: the server text the owner reads ─────────────────────────────
const { mediaDirOkText, mediaDirPostCheck } = await import('../server/media-dir.ts');
const note = mediaDirOkText(JSON.stringify({
  ok: true, note: { zh: 'ZH-NOTE', en: 'Not set · using the default directory /tmp/media' },
}));
assert.equal(note, 'Not set · using the default directory /tmp/media',
  'the media-directory probe note is English');
assert.equal(
  mediaDirPostCheck(JSON.stringify({ ok: false, error: { zh: 'ZH-ERROR', en: 'The directory is not writable' } })),
  'The directory is not writable',
  'the media-directory probe error is English',
);

// The local renderer's resolution refusal is an interpolated string, so it can never be
// a dictionary key — it has to be English at the source.
const { planExport } = await import('../server/plugins/export-plan.ts');
const { exportFailureFrom } = await import('../src/export/exportFailure.ts');
let refusal;
try {
  planExport({
    state: {
      fps: 30, width: 1366, height: 768, selectedId: null,
      items: [{ id: 'clip', name: 'clip', kind: 'video', track: 'V1', src: '/media/uploads/clip.mp4', startFrame: 0, durationInFrames: 120 }],
    },
    format: 'video', codec: 'h264', resolution: '480p',
  });
} catch (error) {
  refusal = exportFailureFrom(error);
}
assert.equal(refusal?.code, 'export_resolution_unsupported', 'the unrepresentable canvas must be refused');
assert.doesNotMatch(refusal.message, CJK, `the export refusal must be English: ${JSON.stringify(refusal.message)}`);
assert.match(refusal.message, /cannot scale the 1366x768 canvas/,
  'the refusal names the canvas it could not scale');

const exportPlanSource = read('server/plugins/export-plan.ts');
assert.match(exportPlanSource, /localized\(\{/, 'the refusal goes through localized() like every other server message');

console.log('i18n-en-only.verify: one interface language — no payload, no switcher, no CJK value, no Chinese prefill or server text');
