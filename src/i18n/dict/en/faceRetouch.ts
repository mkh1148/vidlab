// Milestone D4 — face retouching (English-keyed entries).
//
// Same rule as backgroundRemoval.ts: the D surface is English-only by decision, so
// these keys ARE the English copy and the entries are the identity mapping that keeps
// `verify:i18n` green and keeps the dictionary honest about what the surface says.
export default {
  // ── inspector: the face-retouch control ───────────────────────────────────
  // ('Face retouch' itself lives in fx.ts, because it is also the effect's name.)
  'Analyze face': 'Analyze face',
  'Apply to clip': 'Apply to clip',
  'Find the face on this device and build a skin mask':
    'Find the face on this device and build a skin mask',
  'Packing the skin masks': 'Packing the skin masks',
  'frame {n} of {total}': 'frame {n} of {total}',
  'Face analysis applied': 'Face analysis applied',
  'An analysis is already cached for this source.': 'An analysis is already cached for this source.',
  'Smoothness, even tone and reshape are in the effect stack above; the mask follows every trim of this clip.':
    'Smoothness, even tone and reshape are in the effect stack above; the mask follows every trim of this clip.',
} as Record<string, string>;
