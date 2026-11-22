// The Library drop path's revision boundary: a drop that starts a job must not
// commit its artifact onto a clip whose source moved while the job ran.
//
// The runner is injected, so this file proves the boundary without a server: the
// real one starts a media job and waits for it, and both are the same shape here.
import assert from 'node:assert/strict';
import type { MediaAsset, TimelineItem, TimelineState } from '../../editor/types';
import {
  applyLibraryDropIsolation,
  type LibraryDropIsolationContext,
  type VoiceIsolationRunner,
} from './libraryDropIsolation';

const sourceRevision = 'source-drop-original';
const sourceAsset: MediaAsset = {
  id: 'asset_voice',
  name: 'Voice',
  kind: 'audio',
  src: '/media/uploads/voice.wav',
  durationInFrames: 300,
  sourceRevision,
};
const sourceItem: TimelineItem = {
  id: 'clip_voice',
  track: 'A1',
  startFrame: 0,
  durationInFrames: 300,
  name: 'Voice',
  kind: 'audio',
  src: sourceAsset.src,
  sourceRevision: 'source-item-stale-copy',
};
const initialState: TimelineState = {
  fps: 30,
  width: 1920,
  height: 1080,
  items: [sourceItem],
  assets: [sourceAsset],
  selectedId: null,
  tracks: { A1: { kind: 'audio' } },
  trackOrder: ['A1'],
};

interface VerifyIsolationResult {
  path: string;
  sourceRevision: string;
  engine: string | null;
}

function deferredIsolation() {
  let resolve!: (result: VerifyIsolationResult) => void;
  const promise = new Promise<VerifyIsolationResult>((done) => { resolve = done; });
  return { promise, resolve };
}

let liveState = initialState;
let denoiseWrites = 0;
let lastDenoisedSrc: string | undefined;
let lastEngine: string | null | undefined;
const context: LibraryDropIsolationContext = {
  getState: () => liveState,
  getAssets: () => liveState.assets ?? [],
  setItemDenoise: (_itemId, denoisedSrc, _strength, engine) => {
    denoiseWrites += 1;
    lastDenoisedSrc = denoisedSrc;
    lastEngine = engine;
  },
};

const pending = deferredIsolation();
const submitted: {
  value?: { sourceName: string; sourceRevision: string };
} = {};
const isolatePending: VoiceIsolationRunner = async (sourceName, options) => {
  submitted.value = { sourceName, sourceRevision: options.sourceRevision };
  const result = await pending.promise;
  return { ...result, elapsedMs: 1 };
};
const stalePromise = applyLibraryDropIsolation(sourceItem, 70, context, isolatePending);
assert.deepEqual(submitted.value, {
  sourceName: 'voice.wav',
  sourceRevision,
}, 'drop captures the associated asset revision instead of the stale item copy');

const relinkedRevision = 'source-drop-relinked';
const relinkedSrc = '/media/uploads/voice-relinked.wav';
const relinkedAsset: MediaAsset = { ...sourceAsset, src: relinkedSrc, sourceRevision: relinkedRevision };
const relinkedItem: TimelineItem = { ...sourceItem, src: relinkedSrc, sourceRevision: relinkedRevision };
liveState = { ...liveState, items: [relinkedItem], assets: [relinkedAsset] };
pending.resolve({
  path: '/media/derived/voice-abc/voice.wav',
  sourceRevision,
  engine: 'voice-isolation',
});

const stale = await stalePromise;
assert(stale.status === 'stale', 'same-id relink must be stale');
assert.equal(stale.reason, 'item_source_changed');
assert.equal('denoisedSrc' in stale, false, 'stale result discards the derived URL');
assert.equal(denoiseWrites, 0, 'same-id relink while pending must never reach setItemDenoise');
assert.equal(lastDenoisedSrc, undefined);

const isolateCurrent: VoiceIsolationRunner = async (_sourceName, options) => ({
  path: '/media/derived/voice-abc/voice-relinked.wav',
  sourceRevision: options.sourceRevision,
  engine: 'voice-isolation',
  elapsedMs: 1,
});
const committed = await applyLibraryDropIsolation(relinkedItem, 65, context, isolateCurrent);
assert.equal(committed.status, 'committed');
assert.equal(denoiseWrites, 1, 'unchanged source commits exactly once');
assert.equal(lastDenoisedSrc, '/media/derived/voice-abc/voice-relinked.wav');
if (committed.status === 'committed') {
  assert.equal(committed.engine, 'voice-isolation', 'the drop records which engine produced the artifact');
  assert.equal(committed.strength, 65, 'the library entry sets the dry/wet mix, not the engine');
}
assert.equal(lastEngine, 'voice-isolation', 'the engine tag reaches the command');

const isolateMismatched: VoiceIsolationRunner = async () => ({
  path: '/media/derived/voice-abc/voice-mismatched.wav',
  sourceRevision: 'source-drop-server-mismatch',
  engine: 'voice-isolation',
  elapsedMs: 1,
});
const mismatch = await applyLibraryDropIsolation(relinkedItem, 65, context, isolateMismatched);
assert(mismatch.status === 'stale', 'server revision mismatch must be stale');
assert.equal(mismatch.reason, 'result_revision_mismatch');
assert.equal(denoiseWrites, 1, 'server revision mismatch must not commit');
assert.equal(lastDenoisedSrc, '/media/derived/voice-abc/voice-relinked.wav');

// A clip whose source is not in the media pool cannot start a job: the route names
// its source by upload name, never by path.
await assert.rejects(
  () => applyLibraryDropIsolation({ ...relinkedItem, src: 'blob:preview' }, 65, context, isolateCurrent),
  /media-pool source/,
  'a non-pool source is refused before any job starts',
);

console.log('libraryDropActions.verify: deferred relink, current success, engine tag, and server revision mismatch guarded');
