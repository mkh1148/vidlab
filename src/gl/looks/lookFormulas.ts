/**
 * The colour formulas behind every shipped look — the single source of truth.
 *
 * These functions ARE the looks. `scripts/generate-looks.mjs` bakes each one into a
 * committed 3D LUT (`assets/luts/<id>.cube`), and that LUT is what the renderer
 * samples through `src/gl/fx/look.frag`. There is no second implementation of a
 * look's colour anywhere, so `scripts/looks.verify.mjs` guards the pixels the
 * renderer actually reads rather than a decorative file beside them.
 *
 * Domain: values are the sRGB/BT.709 *encoded* code values the GL texture already
 * holds (`src/gl/colorPipeline.ts`: texture 'srgb', unpackConversion 'none';
 * `src/gl/runtime.ts` sets `unpackColorSpace`/`drawingBufferColorSpace` to 'srgb'),
 * and the result is written straight to an sRGB drawing buffer. No linearisation
 * happens on either side, which is also what the pre-D5 look shaders did.
 *
 * Output is clamped to [0,1]. The pre-D5 shaders left some channels above 1 and
 * relied on the 8-bit framebuffer to clip them; a LUT cannot store that, so the
 * clamp is explicit here and is the same image.
 *
 * Grain and vignette are NOT here: a 3D LUT is a per-pixel colour map and cannot
 * express either. They are uniforms on `look.frag`, defaulted per look below.
 */

export type Rgb = readonly [number, number, number];

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
/**
 * `clamp(v, 0, hi)` — the two-sided clamp the pre-D5 shaders applied to a single channel
 * in the middle of the pipeline. The lower bound is load-bearing wherever a cast or a
 * channel gain runs before a later mix: without it a negative channel is carried into
 * that mix and lifts the result instead of being floored (D5 review C1/C2).
 */
const clampBand = (v: number, hi: number): number => (v < 0 ? 0 : v > hi ? hi : v);
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
const mix3 = (a: Rgb, b: Rgb, t: number): Rgb => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
const dot3 = (a: Rgb, b: Rgb): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const mul3 = (a: Rgb, b: Rgb): Rgb => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
const add3 = (a: Rgb, b: Rgb): Rgb => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale3 = (a: Rgb, k: number): Rgb => [a[0] * k, a[1] * k, a[2] * k];
const clamp3 = (a: Rgb): Rgb => [clamp01(a[0]), clamp01(a[1]), clamp01(a[2])];
const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

// Luma weights, named because the looks deliberately disagree: the Rec.601 trio
// reads warmer on skin, the Rec.709 trio matches the display transform.
const LUMA_601: Rgb = [0.299, 0.587, 0.114];
const LUMA_709: Rgb = [0.2126, 0.7152, 0.0722];

/** Slider defaults that ride on top of the baked colour (see the module header). */
export interface LookDefaults {
  intensity: number;
  grain: number;
  vignette: number;
}

export interface LookFormula {
  /** Asset id without the `builtin:` prefix, and the .cube file stem. */
  id: string;
  name: string;
  desc: string;
  defaults: LookDefaults;
  /** Encoded sRGB in, encoded sRGB out, clamped to [0,1]. */
  grade: (c: Rgb) => Rgb;
}

const LOOK_LIST: readonly LookFormula[] = [
  {
    id: 'look-teal-orange',
    name: '青橙电影感',
    desc: '阴影偏青、高光偏橙的好莱坞调色。',
    defaults: { intensity: 0.85, grain: 0, vignette: 0 },
    grade: (c) => {
      const g = add3(scale3([c[0] - 0.5, c[1] - 0.5, c[2] - 0.5], 1.1), [0.5, 0.5, 0.5]);
      const lum = dot3(g, LUMA_601);
      const teal: Rgb = [0.15, 0.45, 0.55];
      const orange: Rgb = [0.95, 0.55, 0.25];
      const grade = mix3(scale3(teal, lum * 1.4), scale3(orange, 0.4 + lum * 0.9), smoothstep(0.25, 0.75, lum));
      const mixed = mix3(add3(scale3(g, 0.55), scale3(grade, 0.45)), grade, 0.35);
      return clamp3(mixed);
    },
  },
  {
    id: 'look-mono',
    name: '黑白胶片',
    desc: '高对比黑白 + 轻微动态颗粒。',
    defaults: { intensity: 1, grain: 0.08, vignette: 0 },
    grade: (c) => {
      const y = clamp01((dot3(c, LUMA_601) - 0.5) * 1.25 + 0.5);
      return [y, y, y];
    },
  },
  {
    id: 'look-warm',
    name: '暖调复古',
    desc: '偏暖色温与轻度褪色，复古质感。',
    defaults: { intensity: 0.9, grain: 0, vignette: 0 },
    grade: (c) => {
      let w: Rgb = [c[0] * 1.175, c[1], c[2] * 0.86];
      const grey = dot3(w, [0.3, 0.3, 0.3]);
      w = mix3(w, [grey, grey, grey], 0.1225);
      w = mix3(w, mul3(w, [1.05, 0.95, 0.8]), 0.35);
      return clamp3(w);
    },
  },
  {
    id: 'look-cool',
    name: '冷调青蓝',
    desc: '偏冷色温，阴影加压蓝。',
    defaults: { intensity: 0.85, grain: 0, vignette: 0 },
    grade: (c) => {
      let col: Rgb = [c[0] * 0.91, c[1], c[2] * 1.165];
      const lum = dot3(col, LUMA_601);
      col = mix3(col, mul3(col, [0.75, 0.9, 1.15]), (1 - lum) * 0.55);
      return clamp3(col);
    },
  },
  {
    id: 'look-sunset',
    name: '日落暖金',
    desc: '高光偏金、阴影压暖的黄昏感。',
    defaults: { intensity: 0.9, grain: 0, vignette: 0 },
    grade: (c) => {
      const g = dot3(c, LUMA_601);
      let warm = mul3(c, [1.25, 1, 0.85]);
      warm = [
        Math.min(1.5, warm[0] + 0.08),
        warm[1],
        clamp01(warm[2] - 0.05 + g * 0.05),
      ];
      warm = mix3(warm, [1, 0.78, 0.55], smoothstep(0.55, 1, g) * 0.18);
      return clamp3(warm);
    },
  },
  {
    id: 'look-cyber',
    name: '赛博霓虹',
    desc: '阴影青蓝、高光品红的霓虹科幻调。',
    defaults: { intensity: 0.85, grain: 0, vignette: 0 },
    grade: (c) => {
      const x = add3(scale3([c[0] - 0.5, c[1] - 0.5, c[2] - 0.5], 1.2), [0.5, 0.5, 0.5]);
      const g = dot3(x, LUMA_601);
      const shadows = mix3(x, [0.05, 0.35, 0.55], 0.45);
      const highs = mix3(x, [1, 0.25, 0.75], 0.35);
      const look = mix3(shadows, highs, smoothstep(0.25, 0.75, g));
      return clamp3([look[0], look[1], Math.min(1.2, look[2] + 0.08)]);
    },
  },
  {
    id: 'look-bleach',
    name: '漂白旁路',
    desc: '低饱和 + 抬黑的漂白旁路电影感。',
    defaults: { intensity: 0.9, grain: 0, vignette: 0 },
    grade: (c) => {
      const g = dot3(c, LUMA_709);
      let d = mix3(c, [g, g, g], 0.55);
      const softContrast: Rgb = [d[0] * d[0] * (3 - 2 * d[0]), d[1] * d[1] * (3 - 2 * d[1]), d[2] * d[2] * (3 - 2 * d[2])];
      d = mix3(d, softContrast, 0.25);
      d = mix3(d, [0.5, 0.5, 0.5], 0.1575);
      return clamp3(scale3(d, 1.08));
    },
  },
  {
    id: 'look-fuji-chrome',
    name: '富士 Classic Chrome',
    desc: '低饱和、柔和对比、中灰偏冷——旅行/街拍纪录片感（灵感自富士胶片模拟，非官方 LUT）。',
    defaults: { intensity: 0.92, grain: 0.06, vignette: 0 },
    grade: (c) => {
      const lum = dot3(c, LUMA_601);
      let x = mix3([lum, lum, lum], c, 0.72);
      x = mix3(x, [Math.max(x[0], 0.06), Math.max(x[1], 0.06), Math.max(x[2], 0.06)], 0.18);
      x = mix3(x, [x[0] * x[0] * (3 - 2 * x[0]), x[1] * x[1] * (3 - 2 * x[1]), x[2] * x[2] * (3 - 2 * x[2])], 0.28);
      return clamp3([
        x[0] + 0.025 * smoothstep(0.45, 0.95, lum),
        x[1] * 0.98,
        x[2] + 0.04 * (1 - lum),
      ]);
    },
  },
  {
    id: 'look-fuji-portra',
    name: '富士人像 Pro Neg',
    desc: '奶油肤色、粉柔高光、抬黑阴影——人像/生活感（灵感自 Portra / Pro Neg）。',
    defaults: { intensity: 0.9, grain: 0.05, vignette: 0 },
    grade: (c) => {
      const lum = dot3(c, LUMA_709);
      let x = mix3(c, add3(scale3([c[0] - 0.5, c[1] - 0.5, c[2] - 0.5], 0.88), [0.5, 0.5, 0.5]), 0.7);
      const lift = 0.08 + lum * 0.05;
      x = mix3(x, [Math.max(x[0], lift), Math.max(x[1], lift), Math.max(x[2], lift)], 0.35);
      x = [Math.min(x[0], 0.96), Math.min(x[1], 0.96), Math.min(x[2], 0.96)];
      x = [
        Math.min(1.2, x[0] * 1.102),
        Math.min(1.1, x[1] * 1.034 - 0.02),
        Math.min(1, x[2] * 0.915 + 0.02),
      ];
      const maxc = Math.max(x[0], x[1], x[2]);
      const minc = Math.min(x[0], x[1], x[2]);
      const sat = maxc - minc;
      return clamp3(mix3([lum, lum, lum], x, mix(1, 0.82, smoothstep(0.15, 0.55, sat))));
    },
  },
  {
    id: 'look-fuji-velvia',
    name: '富士 Velvia 风光',
    desc: '高饱和绿/蓝、通透对比——景区/自然风光（灵感自 Velvia 反转片）。',
    defaults: { intensity: 0.88, grain: 0.04, vignette: 0 },
    grade: (c) => {
      const lum = dot3(c, LUMA_601);
      let x = add3(scale3([c[0] - 0.5, c[1] - 0.5, c[2] - 0.5], 1.15), [0.5, 0.5, 0.5]);
      // Pre-D5: `clamp(c.g * (1 + 0.18 * sat), 0.0, 1.25)` and the same for b/r — the
      // lower bound matters here too, because the 1.045 saturation mix below carries a
      // negative channel into the final `+ 0.03 * (1 - lum)` lift (D5 review C2).
      x = [
        clampBand(x[0] * 1.066, 1.15),
        clampBand(x[1] * 1.198, 1.25),
        clampBand(x[2] * 1.154, 1.2),
      ];
      x = mix3([lum, lum, lum], x, 1.045);
      return clamp3([x[0], x[1], x[2] + 0.03 * (1 - lum)]);
    },
  },
  {
    id: 'look-ricoh-gr',
    name: '理光 GR 街拍',
    desc: '硬一点对比、冷中性灰、城市纪实——GR 随手拍感（灵感自理光街拍审美）。',
    defaults: { intensity: 0.9, grain: 0.07, vignette: 0 },
    grade: (c) => {
      const lum = dot3(c, LUMA_601);
      let x = add3(scale3([c[0] - 0.5, c[1] - 0.5, c[2] - 0.5], 1.22), [0.5, 0.5, 0.5]);
      // Pre-D5: `clamp(c.g * (1 + 0.04 * cool), 0.0, 1.1)`, same shape for b/r. Without
      // the floor, a negative channel survives the 0.88 desaturation mix and the
      // `- 0.02` crush, which moved blue by up to 22.9/255 (D5 review C2).
      x = [
        clampBand(x[0] * 0.9625, 1.05),
        clampBand(x[1] * 1.03, 1.1),
        clampBand(x[2] * 1.06, 1.15),
      ];
      x = mix3([lum, lum, lum], x, 0.88);
      x = [Math.max(x[0] - 0.02, 0), Math.max(x[1] - 0.02, 0), Math.max(x[2] - 0.02, 0)];
      return clamp3(scale3(x, 1.04));
    },
  },
  {
    id: 'look-kodak-gold',
    name: '柯达金 Gold',
    desc: '暖黄绿怀旧、软对比——千禧年随手拍 / 家庭相册感（灵感自 Kodak Gold）。',
    defaults: { intensity: 0.9, grain: 0.08, vignette: 0 },
    grade: (c) => {
      const lum = dot3(c, LUMA_601);
      let x = mix3(c, [c[0] * c[0] * (3 - 2 * c[0]), c[1] * c[1] * (3 - 2 * c[1]), c[2] * c[2] * (3 - 2 * c[2])], 0.2);
      x = mix3(x, [Math.max(x[0], 0.07), Math.max(x[1], 0.07), Math.max(x[2], 0.07)], 0.2);
      x = [
        Math.min(1.2, x[0] * 1.14),
        Math.min(1.15, x[1] * 1.1 + 0.02),
        Math.min(1, x[2] * 0.84),
      ];
      x = [x[0], Math.min(1.1, x[1] + 0.03 * (1 - lum)), x[2]];
      return clamp3(mix3([lum, lum, lum], x, 0.9));
    },
  },
  {
    id: 'look-disposable',
    name: '拍立得 / 一次性',
    desc: '软糊、绿偏、粗颗粒、暗角——拍立得与一次性相机那味。',
    defaults: { intensity: 0.92, grain: 0.16, vignette: 0.45 },
    grade: (c) => {
      const lum = dot3(c, [0.3, 0.59, 0.11]);
      let x = mix3(c, [0.15 + lum * 0.7, 0.15 + lum * 0.7, 0.15 + lum * 0.7], 0.35);
      x = mix3([lum, lum, lum], x, 0.75);
      return clamp3([
        Math.min(1.1, x[0] + 0.027 * smoothstep(0.5, 1, lum)),
        Math.min(1.1, x[1] + 0.054),
        Math.min(1, x[2] - 0.036 + 0.03 * smoothstep(0.6, 1, lum)),
      ]);
    },
  },
  {
    id: 'look-cinestill',
    name: 'CineStill 夜景',
    desc: '钨丝灯冷青、高光微溢——夜街/霓虹（灵感自 CineStill 800T）。',
    defaults: { intensity: 0.88, grain: 0.09, vignette: 0 },
    grade: (c) => {
      const lum = dot3(c, LUMA_709);
      let x = add3(scale3([c[0] - 0.5, c[1] - 0.5, c[2] - 0.5], 1.18), [0.5, 0.5, 0.5]);
      // The cast clamps to [0, upper] per channel *before* the glow mix — the pre-D5
      // shader wrote `clamp(c.r - …, 0.0, 1.15)` and the same for g/b. The lower bound
      // is load-bearing: contrast 1.18 pushes dark code values negative, and the glow
      // mix then lifts them again (`x * 1.12 + 0.08`), so a deferred clamp brightens
      // the glow in the extreme-blue highlight corner by up to 8.6/255 (D5 review C1).
      x = [
        clampBand(x[0] - 0.0475 * (1 - lum) + 0.06 * smoothstep(0.55, 1, lum), 1.15),
        clampBand(x[1] + 0.038, 1.15),
        clampBand(x[2] + 0.095 * (1 - lum), 1.2),
      ];
      const hi = smoothstep(0.65, 0.95, lum);
      const glow: Rgb = [
        Math.min(1, x[0] * 0.9 + 0.08),
        Math.min(1, x[1] * 1.05 + 0.08),
        Math.min(1, x[2] * 1.12 + 0.08),
      ];
      return clamp3(mix3(x, glow, hi * 0.4275));
    },
  },
];

/** Every shipped look, keyed by its `builtin:` asset id. */
export const LOOK_FORMULAS: Readonly<Record<string, LookFormula>> = Object.freeze(
  Object.fromEntries(LOOK_LIST.map((look) => [`builtin:${look.id}`, look])),
);

/** Catalog order for the LUT tab: the camera-aesthetic looks first, then the grades. */
export const LOOK_IDS: readonly string[] = Object.freeze([
  'builtin:look-fuji-chrome',
  'builtin:look-fuji-portra',
  'builtin:look-fuji-velvia',
  'builtin:look-ricoh-gr',
  'builtin:look-kodak-gold',
  'builtin:look-disposable',
  'builtin:look-cinestill',
  'builtin:look-teal-orange',
  'builtin:look-mono',
  'builtin:look-warm',
  'builtin:look-cool',
  'builtin:look-sunset',
  'builtin:look-cyber',
  'builtin:look-bleach',
].filter((id) => id in LOOK_FORMULAS));

/** True when `assetId` is one of the shipped looks (one per clip — see the reducer). */
export function isLookId(assetId: string): boolean {
  return assetId in LOOK_FORMULAS;
}
