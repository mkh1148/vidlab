// Milestone D6 — voice isolation (English-keyed entries).
//
// Same convention as backgroundRemoval.ts and voiceCleanup.ts: the D surface is
// English-only by decision (docs/d-job-implementation.md), so its keys ARE the
// English copy and these entries are the identity mapping that keeps `verify:i18n`
// green. A t('…') key with no dictionary entry is a failure, and adding a Chinese
// original would be new CJK in a feature that has none.
//
// The engine names are keys too, because the control renders them through t() like
// every other string: a proper noun does not need translating, but it does need to
// be a registered key rather than a literal that bypasses the dictionary.
export default {
  // ── inspector: the voice isolation control ────────────────────────────────
  'Voice isolation': 'Voice isolation',
  'Separate voice': 'Separate voice',
  'Separate the voice from music and background sound on this device':
    'Separate the voice from music and background sound on this device',
  'Voice isolation applied': 'Voice isolation applied',
  'Voice isolation failed': 'Voice isolation failed',
  'Playing the separated voice track; the original audio stays on the clip.':
    'Playing the separated voice track; the original audio stays on the clip.',
  'Playing the original audio; the separated track is kept beside it.':
    'Playing the original audio; the separated track is kept beside it.',
  'This clip already plays a voice track from {engine}.':
    'This clip already plays a voice track from {engine}.',
  'processed in {s} s': 'processed in {s} s',

  // ── the Original / Processed switch (kit D6: both files stay) ─────────────
  Original: 'Original',
  Processed: 'Processed',
  Engine: 'Engine',

  // ── engine names shown in the tag line ───────────────────────────────────
  'Spleeter 2stems + clean-up': 'Spleeter 2stems + clean-up',
  'RNNoise clean-up': 'RNNoise clean-up',
  'an older build': 'an older build',
} as Record<string, string>;
