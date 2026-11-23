// Reconcile the server's non-secret UI_LOCALE setting with the one interface language.
//
// The server authors some text the user reads directly — the remedy on a failed media
// import, a note pushed into an agent run — and it has no navigator or localStorage to
// learn the language from. It used to be told the browser's choice on every switch; there
// is one language now, so this runs once at startup and writes only when the stored value
// is something else (a zh/it/ru value from an older build, or nothing at all).
// Fire-and-forget; a missing server (static preview, verifies) is not an error.
import { getLocale } from './locale';

async function send(locale: string): Promise<void> {
  if (typeof fetch !== 'function') return;
  try {
    await fetch('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ UI_LOCALE: locale }),
    });
  } catch {
    // No server to tell; the next launch tries again.
  }
}

/**
 * Reconcile the stored value. `stored` is the server's current UI_LOCALE (from
 * GET /api/keys → models); an already-correct value is not re-sent on every launch.
 */
export function startUiLocaleSync(stored?: string): void {
  const locale = getLocale();
  if (stored === locale) return;
  void send(locale);
}
