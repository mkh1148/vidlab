// P4 · Selection must not save the project.
//
// The base already keeps selection out of the undo stack (`MUTATING` in
// reducerActions.ts excludes `select` and `tl.switch`), but the editor autosave
// used to watch the *document object*, and selection produces a new one. Twenty
// clicks therefore queued twenty full project writes and twenty history
// versions.
//
// This counts writes the way the editor does: drive the history reducer, feed
// each resulting document to the same autosave gate the hook uses
// (pendingAutosaveAfterObservation), and count the saves it queues.
//
// Run: npx tsx src/editor/selectionWrites.verify.ts
import assert from 'node:assert/strict';
import { historyReduce, type History } from './reduce';
import { pendingAutosaveAfterObservation } from '../persist/autosaveRecovery';
import type { ProjectDoc, TimelineItem } from './types';

const item = (id: string): TimelineItem => ({
  id,
  track: 'V1',
  startFrame: 0,
  durationInFrames: 30,
  kind: 'solid',
  name: id,
  props: { color: '#123456' },
} as TimelineItem);

const timeline = (id: string, order: number, items: TimelineItem[]) => ({
  id,
  name: id,
  order,
  fps: 30,
  width: 1280,
  height: 720,
  selectedId: null,
  tracks: { V1: { kind: 'video' as const } },
  trackOrder: ['V1'],
  items,
});

const docOf = (): ProjectDoc => ({
  version: 3,
  assets: [],
  mediaFolders: [],
  activeTimelineId: 'tl1',
  timelines: [timeline('tl1', 0, Array.from({ length: 20 }, (_, i) => item(`c${i}`))), timeline('tl2', 1, [])],
} as unknown as ProjectDoc);

/** Mirrors useEditorAutosave: one observation per dispatch, count the saves. */
function countedWrites(actions: Parameters<typeof historyReduce>[1][]) {
  let h: History = { past: [], present: docOf(), future: [], revision: 0 };
  let previous = { projectId: 'p4', doc: h.present, revision: h.revision };
  let writes = 0;
  for (const action of actions) {
    h = historyReduce(h, action);
    const next = { projectId: 'p4', doc: h.present, revision: h.revision };
    if (pendingAutosaveAfterObservation(previous, next) !== null) writes += 1;
    previous = next;
  }
  return { writes, historySteps: h.past.length, doc: h.present };
}

// ── 20 selection clicks: 0 writes, 0 history versions ─────────────────────
{
  const clicks = Array.from({ length: 20 }, (_, i) => ({ type: 'select' as const, id: `c${i}` }));
  const result = countedWrites(clicks);
  assert.equal(result.writes, 0, '20 selection clicks must queue 0 project writes');
  assert.equal(result.historySteps, 0, 'selection must not create history versions');
  assert.equal(result.doc.timelines[0]!.selectedId, 'c19', 'the selection itself still moves');
}

// ── 20 timeline switches: also navigation, also 0 writes ──────────────────
{
  const switches = Array.from({ length: 20 }, () => ({ type: 'tl.switch' as const, id: 'tl2' }));
  const result = countedWrites(switches);
  assert.equal(result.writes, 0, 'timeline switching must queue 0 project writes');
  assert.equal(result.historySteps, 0, 'timeline switching must not create history versions');
}

// ── one real edit: exactly 1 write, exactly 1 history version ─────────────
{
  const result = countedWrites([{ type: 'move', id: 'c3', startFrame: 90 }]);
  assert.equal(result.writes, 1, 'one edit must queue exactly one project write');
  assert.equal(result.historySteps, 1, 'one edit must create exactly one history version');
  assert.equal(result.doc.timelines[0]!.items.find((candidate) => candidate.id === 'c3')!.startFrame, 90);
}

// ── selection interleaved with an edit still writes once ──────────────────
{
  const result = countedWrites([
    ...Array.from({ length: 20 }, (_, i) => ({ type: 'select' as const, id: `c${i}` })),
    { type: 'move', id: 'c0', startFrame: 30 },
    ...Array.from({ length: 20 }, (_, i) => ({ type: 'select' as const, id: `c${i}` })),
  ]);
  assert.equal(result.writes, 1, '20 clicks, one edit, 20 clicks: exactly one write');
  assert.equal(result.historySteps, 1);
}

// ── undo and redo change the document, so each is a write ─────────────────
{
  const result = countedWrites([
    { type: 'move', id: 'c0', startFrame: 30 },
    { type: 'undo' },
    { type: 'redo' },
  ]);
  assert.equal(result.writes, 3, 'edit + undo + redo are three document revisions');
}

console.log('selectionWrites.verify: 20 selection clicks = 0 writes, 1 edit = 1 write');
