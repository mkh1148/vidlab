// Kit D5: "selecting another look replaces the current one".
//
// The rule lives in the reducer's `setEffects` case because that is the one point every
// apply path already funnels through: the library LUT/FX grid click
// (useEditorController.onApplyFx), the drag-onto-clip handler
// (libraryDropActions.applyLibraryToClip), the inspector's "add effect" select
// (InspectorVisualControls.addEffect) and both agent tools (edit_item's addEffect plan
// and manage_effects). Testing the reducer therefore covers all five, and a sixth path
// added later inherits the rule instead of silently stacking a second look.
//
//   npx tsx src/editor/lookReplace.verify.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reduce } from './reduce';
import type { ClipEffect } from './clipTypes';
import type { TimelineItem, TimelineState } from './types';

const clip = (over: Partial<TimelineItem> = {}): TimelineItem => ({
  id: 'a', track: 'V1', startFrame: 0, durationInFrames: 60, kind: 'video',
  name: 'clip', src: '/m.mp4', ...over,
});

const state = (effects: ClipEffect[]): TimelineState => ({
  fps: 30, width: 1920, height: 1080, selectedId: null,
  items: [clip({ effects })],
});

const fx = (id: string, assetId: string, overrides?: Record<string, number>): ClipEffect =>
  ({ id, assetId, ...(overrides ? { overrides } : {}) });

const effectsOf = (s: TimelineState) => s.items[0].effects ?? [];
const idsOf = (s: TimelineState) => effectsOf(s).map((e) => e.assetId);

const TEAL = 'builtin:look-teal-orange';
const MONO = 'builtin:look-mono';
const GRAIN = 'builtin:fx-film-grain';

// ── 1. a second look replaces the first ──────────────────────────────────────
{
  const before = state([fx('fx_1', TEAL)]);
  const after = reduce(before, { type: 'setEffects', id: 'a', effects: [fx('fx_1', TEAL), fx('fx_2', MONO)] });
  assert.deepEqual(idsOf(after), [MONO], 'applying a second look leaves only the new one');
  console.log('replace: second look replaces the first');
}

// ── 2. non-look effects survive, in order ────────────────────────────────────
{
  const before = state([fx('fx_1', GRAIN), fx('fx_2', TEAL)]);
  const after = reduce(before, { type: 'setEffects', id: 'a', effects: [fx('fx_1', GRAIN), fx('fx_2', TEAL), fx('fx_3', MONO)] });
  assert.deepEqual(idsOf(after), [GRAIN, MONO], 'a plain FX keeps its slot; only the look is replaced');
  console.log('replace: non-look effects keep their order');
}

// ── 3. the same look twice collapses to one ─────────────────────────────────
{
  const before = state([]);
  const after = reduce(before, { type: 'setEffects', id: 'a', effects: [fx('fx_1', TEAL), fx('fx_1', TEAL)] });
  assert.deepEqual(idsOf(after), [TEAL], 'the same look applied twice is still one look');
  console.log('replace: duplicate look collapses');
}

// ── 4. the LAST look wins, so a re-apply keeps the newest overrides ─────────
{
  const before = state([fx('fx_1', TEAL, { intensity: 0.2 })]);
  const after = reduce(before, { type: 'setEffects', id: 'a', effects: [fx('fx_1', TEAL, { intensity: 0.2 }), fx('fx_2', MONO, { intensity: 0.9 })] });
  assert.deepEqual(effectsOf(after).map((e) => e.overrides), [{ intensity: 0.9 }], 'the surviving look carries its own slider values');
  console.log('replace: surviving look keeps its overrides');
}

// ── 5. no look in the stack: the array is untouched ─────────────────────────
{
  const effects = [fx('fx_1', GRAIN), fx('fx_2', 'builtin:fx-vignette')];
  const after = reduce(state([]), { type: 'setEffects', id: 'a', effects });
  assert.deepEqual(idsOf(after), [GRAIN, 'builtin:fx-vignette'], 'a stack with no look is passed through');
  console.log('replace: look-free stacks are untouched');
}

// ── 6. loading a project does NOT rewrite a legacy stack ────────────────────
// A document saved before D5 can hold two looks. Silently dropping one on open would
// change an existing edit behind the owner's back, so the rule is apply-time only.
{
  const legacy = state([fx('fx_1', TEAL), fx('fx_2', MONO)]);
  const loaded = reduce(state([]), { type: 'setFullState', state: legacy });
  assert.deepEqual(idsOf(loaded), [TEAL, MONO], 'a saved two-look stack survives project load');
  console.log('replace: legacy stacks survive load');
}

// ── 7. every apply path still enters through the funnel ─────────────────────
// The rule above is only as good as the claim that all four routes go through
// `setEffects`. That claim is checked here rather than trusted in a comment: if a route
// is rerouted to write `items[].effects` itself, this fails and points at the funnel.
{
  const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
  const funnel = [
    ['library click', 'src/editor/useEditorController.tsx', 'setItemEffects('],
    ['library drag-drop', 'src/components/timeline/libraryDropActions.ts', 'setItemEffects('],
    ['inspector add-effect', 'src/editor/useEditorController.tsx', 'onItemEffectsChange'],
    ['agent edit_item', 'src/agent/tools/edit-item-commit.ts', 'setItemEffects('],
    ['agent manage_effects', 'src/agent/tools/effect-tools.ts', 'setItemEffects('],
  ] as const;
  for (const [name, file, needle] of funnel) {
    assert.ok(read(file).includes(needle), `${name} no longer applies effects through ${needle} — it must enter the reducer funnel`);
  }
  assert.match(
    read('src/editor/storeCommandBuilder.ts'),
    /setItemEffects:[\s\S]{0,120}type: 'setEffects'/,
    'setItemEffects must still dispatch the setEffects action, or the one-look rule stops being enforced',
  );
  console.log('replace: all four apply paths still enter through setEffects');
}

console.log('lookReplace.verify: OK (one look per clip on every apply path, legacy stacks preserved)');
