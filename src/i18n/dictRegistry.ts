// The English dictionary is ~330 kB of source, so it is fetched as its own chunk rather
// than imported into the entry bundle. One language, one fetch: there is no per-locale
// map, no fallback dictionary and nothing to prefetch (D-11).
//
// t()/tData() stay SYNCHRONOUS: they read whatever is loaded and fall back to the Chinese
// original, which is also the dictionary key — the same "never go blank" contract locale.ts
// always had. main.tsx and remotion/index.ts await the dictionary before the first render,
// so no rendered frame sees the fallback.
export interface LocaleDicts {
  /** UI copy, keyed by the Chinese original. */
  readonly ui: Record<string, string>;
  /** Display names for **data** (template/sound/music names). */
  readonly data: Record<string, string>;
}

const EMPTY: Record<string, string> = Object.freeze({});

/** Nothing loaded: every lookup falls through to the Chinese original. */
const NONE: LocaleDicts = Object.freeze({ ui: EMPTY, data: EMPTY });

// Replaced, never mutated, so a lookup mid-load sees one consistent snapshot.
let loaded: LocaleDicts | null = null;
let inFlight: Promise<void> | null = null;

async function fetchDicts(): Promise<LocaleDicts> {
  const [en, enData] = await Promise.all([
    import('./dict/en'), import('./dict/en/templates-data'),
  ]);
  return { ui: en.EN, data: enData.default };
}

/** The dictionaries currently in memory (empty until loaded). */
export function localeDicts(): LocaleDicts {
  return loaded ?? NONE;
}

/** Load the dictionary once; concurrent callers share the same fetch. */
export function ensureLocaleDict(): Promise<void> {
  if (inFlight) return inFlight;
  const task = fetchDicts()
    .then((dicts) => { loaded = dicts; })
    .catch(() => {
      // A failed chunk fetch (offline, stale deploy) must not blank the UI —
      // t() keeps returning the Chinese original. Drop the memo so a later
      // caller retries instead of being stuck on the failure.
      inFlight = null;
    });
  inFlight = task;
  return task;
}
