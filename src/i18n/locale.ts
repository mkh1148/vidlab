// One interface language: English (owner decision D-11).
//
// The Chinese original is still the dictionary KEY — that identifier architecture is
// untouched, and rewriting thousands of keys was explicitly out of scope. What changed is
// that there is exactly one dictionary to translate a key and no switcher to leave it:
// t() = ui[zh] ?? zh, so a key the English dictionary does not have renders the raw
// Chinese key. That is the "never go blank" contract, and it is why the coverage verifies
// (scripts/i18n-english.verify.mjs, scripts/i18n-en-only.verify.mjs) exist.
//
// A stored `cc.locale` from an older build is MIGRATED, not merely ignored: an older build
// persisted the interface language there, so a zh/it/ru value is rewritten to 'en' on load.
// Nothing selects a language from it any more — the rewrite is what makes the migration
// observable and stops a stale value outliving the build that could read it. The server's
// UI_LOCALE is reconciled once at startup (i18n/localeSync.ts).
// Rules: use useT() in React components, import { t } directly in pure helper modules.
// LLM-facing text (systemPrompt/tool descriptions/skill content) stays out of i18n.
import { localeDicts } from './dictRegistry';

export { ensureLocaleDict } from './dictRegistry';

export type Locale = 'en';

export const ALL_LOCALES: readonly Locale[] = ['en'];

/** The key an older build wrote its interface language to. Read once, then migrated. */
const LEGACY_LOCALE_KEY = 'cc.locale';

/**
 * Rewrite a stored non-English preference to English. A missing key is left missing: the
 * migration cleans up a value an older build wrote, it does not start persisting one.
 */
function migrateStoredLocale(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const stored = localStorage.getItem(LEGACY_LOCALE_KEY);
    if (stored !== null && stored !== 'en') localStorage.setItem(LEGACY_LOCALE_KEY, 'en');
  } catch {
    // Private mode or a full quota: the interface is English either way, and the stale
    // value cannot select a language because nothing reads it.
  }
}

migrateStoredLocale();

if (typeof document !== 'undefined') document.documentElement.lang = 'en';

export function getLocale(): Locale {
  return 'en';
}

/** The language name an LLM prompt should ask the agent to write in. */
export function localeLanguageName(_locale: Locale): 'English' {
  return 'English';
}

/**
 * Catalog data (skills, shortcuts, workflows) carries an English name and a Chinese one.
 * The interface is English, so the English half is what renders; the Chinese field stays
 * in the data as provenance. The signature keeps both slots so call sites stay honest
 * about which field they are reading.
 */
export function localizedCatalogText(
  english: string,
  _chinese?: string,
  _locale: Locale = 'en',
): string {
  return english;
}

/** t('Selected {n}', { n: 3 }) - The Chinese original text is the key; the placeholder {name} has the same name in both languages. */
export function t(zh: string, params?: Record<string, string | number>): string {
  const { ui } = localeDicts();
  const raw = ui[zh] ?? zh;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (match, key: string) => (key in params ? String(params[key]) : match));
}

/** Two-way data localization: **data** names (template names, etc.) are displayed through the table lookup. If not found, they are returned as they are.
 * English key data (211 built-in items) walks the English table; Chinese key data (self-made package) is returned unchanged.
 * It is only used for display and does not change the data itself (the name is also a reference key). */
export function tData(text: string): string {
  const { data } = localeDicts();
  return data[text] ?? text;
}

/** Get t in the component. There is one language, so there is nothing to subscribe to. */
export function useT(): typeof t {
  return t;
}
