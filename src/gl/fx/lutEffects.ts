// The LUT tab: every shipped film look, rendered through one shader and its own
// generated .cube.
//
// A look's colour lives in exactly one place — `src/gl/looks/lookFormulas.ts` —
// and `scripts/generate-looks.mjs` bakes it into `assets/luts/<id>.cube`. This
// module only wires those artefacts into the FX catalog: the cube URL, the shared
// `look.frag`, and the two sliders a 3D LUT cannot express (grain, vignette) plus
// intensity. There is no per-look GLSL to keep in sync, which is the point.
//
// The catalog keeps its old name (`LUT_EFFECTS`) because effects.ts re-exports it
// and every import site resolves there.
import lookFrag from './look.frag.ts';
import { LOOK_FORMULAS, LOOK_IDS } from '../looks/lookFormulas';
import type { FxDef } from './uniforms';

export const LUT_EFFECTS: Record<string, FxDef> = Object.fromEntries(
  LOOK_IDS.map((id) => {
    const look = LOOK_FORMULAS[id];
    const def: FxDef = {
      id,
      name: look.name,
      desc: look.desc,
      frag: lookFrag,
      cube: `/luts/${look.id}.cube`,
      props: [
        { key: 'intensity', label: '强度', default: look.defaults.intensity, min: 0, max: 1, step: 0.01 },
        { key: 'grain', label: '颗粒', default: look.defaults.grain, min: 0, max: 0.5, step: 0.01 },
        { key: 'vignette', label: '暗角', default: look.defaults.vignette, min: 0, max: 1, step: 0.01 },
      ],
    };
    return [id, def];
  }),
);

export const LUT_ORDER: readonly string[] = LOOK_IDS;
export const LUT_IDS: readonly string[] = [...LOOK_IDS];
