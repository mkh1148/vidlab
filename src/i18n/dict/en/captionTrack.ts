// Milestone D3b — the caption track (English-keyed entries).
//
// Same convention as backgroundRemoval.ts and voiceCleanup.ts: the D surface is
// English-only by decision (docs/d-job-implementation.md), so its keys ARE the
// English copy and these entries are the identity mapping that keeps
// `verify:i18n` green. A t('…') key with no dictionary entry is a failure, and
// adding a Chinese original would be new CJK in a feature that has none.
//
// The keys are never named like an index table (INDEX_TABLES in
// scripts/i18n-allowlist-rules.mjs) — they are read through t() at the render
// site, not collected into a label table.
export default {
  // ── inspector: the caption-track control ──────────────────────────────────
  'Captions': 'Captions',
  'Create caption track': 'Create caption track',
  'Refresh captions': 'Refresh captions',
  'Caption track created from this clip\'s transcript.': 'Caption track created from this clip\'s transcript.',
  'Captions refreshed from this clip\'s transcript.': 'Captions refreshed from this clip\'s transcript.',
  'Captions already follow this clip\'s transcript.': 'Captions already follow this clip\'s transcript.',
  'This clip has no transcript yet. Transcribe it first, then add captions.':
    'This clip has no transcript yet. Transcribe it first, then add captions.',
  'This clip\'s transcript is out of date. Transcribe it again before adding captions.':
    'This clip\'s transcript is out of date. Transcribe it again before adding captions.',
  'Captions follow this clip\'s transcript, so trimming the clip trims the captions.':
    'Captions follow this clip\'s transcript, so trimming the clip trims the captions.',
  'Caption track {alias} · {n} cues{off}': 'Caption track {alias} · {n} cues{off}',
  ' · hidden': ' · hidden',
} as Record<string, string>;
