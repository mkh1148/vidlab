// Milestone D1 — background removal (English-keyed entries).
//
// Every other dictionary file is keyed by the Chinese original, because the base
// was written in Chinese and t() falls back to the key. The D surface is new and
// English-only by decision (docs/d-job-implementation.md), so its keys ARE the
// English copy and these entries are the identity mapping that keeps
// `verify:i18n` green: a t('…') key with no dictionary entry is a failure, and
// adding the Chinese original would be new CJK in a feature that has none.
//
// The keys are never named like an index table (INDEX_TABLES in
// scripts/i18n-allowlist-rules.mjs) — they are read through t() at the render
// site, not collected into a label table.
export default {
  // ── inspector: the background-removal control ─────────────────────────────
  'Background removal': 'Background removal',
  'Remove background': 'Remove background',
  'Run again': 'Run again',
  'Restore original': 'Restore original',
  'Remove the background on this device': 'Remove the background on this device',
  'Import the clip into the media pool first': 'Import the clip into the media pool first',
  'Deferred - waiting for memory': 'Deferred - waiting for memory',
  'Background removal failed': 'Background removal failed',
  'Background removal applied': 'Background removal applied',
  'Original picture restored': 'Original picture restored',
  'This clip shows a cut-out picture; its audio is still the original source.':
    'This clip shows a cut-out picture; its audio is still the original source.',
} as Record<string, string>;
