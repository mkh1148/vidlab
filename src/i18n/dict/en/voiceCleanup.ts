// Milestone D2 — voice clean-up (English-keyed entries).
//
// Same convention as backgroundRemoval.ts: the D surface is English-only by
// decision (docs/d-job-implementation.md), so its keys ARE the English copy and
// these entries are the identity mapping that keeps `verify:i18n` green. A t('…')
// key with no dictionary entry is a failure, and adding a Chinese original would
// be new CJK in a feature that has none.
//
// The keys are never named like an index table (INDEX_TABLES in
// scripts/i18n-allowlist-rules.mjs) — they are read through t() at the render
// site, not collected into a label table.
export default {
  // ── inspector: the voice clean-up control ─────────────────────────────────
  'Voice clean-up': 'Voice clean-up',
  'Clean up voice': 'Clean up voice',
  'Clean up the speech on this device': 'Clean up the speech on this device',
  'Voice clean-up failed': 'Voice clean-up failed',
  'Voice clean-up applied': 'Voice clean-up applied',
  'Original audio restored': 'Original audio restored',
  'This clip plays a cleaned voice track; its original audio is still on the clip.':
    'This clip plays a cleaned voice track; its original audio is still on the clip.',
} as Record<string, string>;
