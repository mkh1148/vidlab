// The i18n allow-list policy, in one place.
//
// Two checks ask the same question from different directions:
//
//   scripts/i18n-allowlist.verify.mjs  — every CJK unit in src/ must be provably
//                                        safe. Inverted: it enumerates all of them.
//   scripts/check-i18n.mjs             — the older audit of t() keys, raw JSX and
//                                        exported string tables.
//
// They must agree on what "safe" means, or one of them reports a leak the other
// has already reviewed. So the lists live here and both import them. The rules
// themselves are documented in docs/i18n-allowlist.md.

/** The wide class: Han, kana, CJK punctuation and fullwidth forms, BMP and astral.
 *  CJK Ext B–F (U+20000–U+2EBEF) and Ext G/H (U+30000–U+3134F) are ideographs a
 *  BMP-only class silently passes; the `u` flag is what makes \u{...} legal. */
export const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\u3000-\u303f\uff00-\uffef\u{20000}-\u{2EBEF}\u{30000}-\u{3134F}]/u;

/** Callees whose first argument is a translation key (A2). */
export const TRANSLATION_CALLEES = new RegExp(
  '(^|\\.)('
  + 't|tData|translate|localizedCatalogText|localized|storedName|displayProjectName'
  + '|changeSessionSummary|proposalAction|proposalTarget|proposalImpact'
  + ')$',
);

/** A11: a language names itself in its own script in every locale. */
export const ENDONYMS = new Set(['日本語', '中文', '한국어', 'Español', 'Français', 'Deutsch', 'Русский', 'Italiano']);

/** A12: dead metadata, deleted rather than allow-listed. Kept empty on purpose. */
export const DEAD_METADATA = new Set([]);

/**
 * A7: reviewed algorithm-data modules. Every entry needs a reason; the rule only
 * covers units inside a module-scope const, so a function body in the same file
 * still has to be translated.
 */
export const ALGORITHM_DATA = new Map([
  ['src/audio/soundLibrary.ts', 'sound-effect catalog: names are English, desc is a dictionary key, keywords are a search index compared against, never printed'],
  ['src/captions/segmenterData.ts', 'caption segmentation weights: punctuation classes, particles and break patterns compared against, never printed'],
]);

/**
 * A13: names of tables whose CJK entries are matched against text, never printed.
 * A bare name matches a module-scope const or a property assignment; the suffix
 * forms cover the `*_SET` / `*_LIST` spelling the codebase also uses.
 */
export const INDEX_TABLES = /^(aliasZh|aliases|keywords|scenarios|tags|synonyms|searchTerms|FILLER|STOPWORDS|PARTICLES)$|(_SET|_LIST|_WORDS|_PATTERNS|_ALIASES)$/;

/** A14: the modules that hold app-authored names written into documents. */
export const STORED_NAME_MODULES = new Set(['src/i18n/storedNames.ts', 'src/i18n/projectNames.ts']);

/**
 * A8: LLM-facing roots. Their text is prompt and tool-schema content, which the
 * kit deliberately keeps un-translated (AGENTS.md). A module here is only exempt
 * while no .tsx imports it directly — once a component renders it, its text is
 * UI copy again.
 */
export const LLM_FACING_ROOTS = /^src\/(agent|skills)\//;
