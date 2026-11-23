// The interface language, as the server knows it.
//
// The app ships one user-facing language (owner decision D-11): English. Server-authored
// text that reaches the user — the remedy on a failed import, a note pushed into a run —
// is written in English, and localized() stays the single gate every such message goes
// through, so the rule is visible at the call site instead of implied by the string.
//
// UI_LOCALE remains a whitelisted setting (server/keystore-names.ts): the browser
// reconciles it once at startup (src/i18n/localeSync.ts), which is what migrates a stored
// zh/it/ru value from an older build. parseUiLocale rejects those values, so a stale value
// can never select a language again.
import { getKey } from './keystore.ts';

export type UiLocale = 'en';

const LOCALES: ReadonlySet<string> = new Set(['en']);

export function parseUiLocale(value: unknown): UiLocale | null {
  const tag = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return LOCALES.has(tag) ? (tag as UiLocale) : null;
}

export function uiLocale(): UiLocale {
  return parseUiLocale(getKey('UI_LOCALE')) ?? 'en';
}

/**
 * Pick the message for the interface language. There is one language, so this returns the
 * English variant; the zh/ru/it slots stay in the type only because the call sites that
 * carry them are inert data now, and deleting 40 provenance strings is a separate change.
 */
export function localized<T>(variants: { en: T; zh?: T; ru?: T; it?: T }): T {
  return variants.en;
}
