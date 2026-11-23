// Runnable check: `npx tsx src/editor/audioDetach.verify.ts`
//
// AV1 — detach / merge a video clip's own audio.
//
// The owner's requirement: right-click a video clip → "Detach audio" moves its
// sound onto a real audio clip the user can select, trim, move and mix like any
// other audio, and the video clip becomes picture-only; "Merge audio" puts it
// back. What this file proves, in order:
//   1. detach: the audio clip is aligned, independent, and the video is silent
//      in the mix — one seam shared by preview and export;
//   2. the pair survives the edits the feature exists for (select/trim/move/
//      split/delete on either side) without silently re-sounding the video;
//   3. merge restores the exact pre-detach document (byte-for-byte on the items)
//      and undo/redo are byte-exact in both directions;
//   4. refusals are `{ ok: false, error, code }`, reference-stable, and create no
//      history step;
//   5. the clip's other audio state (transcript, captions, D2/D6 voice slots,
//      volume/fade/speed keyframes, loudness eligibility) is neither orphaned nor
//      double-played;
//   6. the FCPXML hand-off marks BOTH sides of the pair — `srcEnable="video"` on
//      the picture clip so the NLE cannot play the file's own audio on top of the
//      detached clip, and `srcEnable="audio"` on the detached clip so OCC's own
//      importer re-joins them instead of importing a second video clip.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isItemAudioSilenced, planAudioDetach, planAudioMerge, runAudioDetach, runAudioMerge } from './audioDetach';
import { historyReduce, reduce, type History } from './reduce';
import type { ProjectDispatch } from './reduce';
import type { AtomicAction, Action } from './reducerActions';
import type { MediaAsset, TimelineItem, TimelineState } from './types';
import { activeTimeline } from './types';
import { makeDraft } from './store';
import { captionTrackPlan } from '../captions/captionTrack';
import { timelineToFcpxml } from '../export/fcpxml';
import { fcpxmlDtdViolations } from '../export/fcpxml.verify-support';
import { docFromTimeline } from '../persist/projectStore';
import { execTimelineImportTool } from '../agent/tools/timeline-import-tools';
import type { AgentContext } from '../agent/context';
import { EN } from '../i18n/dict/en';

// ── Fixture: one video clip carrying every kind of audio state AV1 must respect ──
const video: TimelineItem = {
  id: 'v1',
  track: 'V1',
  kind: 'video',
  name: 'interview',
  src: '/media/uploads/interview.mp4',
  sourceAssetId: 'asset_1',
  sourceRevision: 'rev_1',
  startFrame: 120,
  durationInFrames: 90,
  srcInFrame: 30,
  playbackRate: 1.5,
  volume: 0.8,
  fadeInFrames: 6,
  fadeOutFrames: 9,
  keyframes: {
    volume: [{ frame: 0, value: 0.2 }, { frame: 89, value: 1 }],
    scale: [{ frame: 0, value: 1.2 }],
  },
  denoisedSrc: '/media/derived/interview-denoised.wav',
  denoiseStrength: 100,
  denoisedEngine: 'voice-isolation',
  transcript: [{ text: 'hello', start: 0, end: 10 }],
  transform: { scale: 1.2 },
  derivedPictureSrc: '/media/derived/matte.webm',
  faceTrackUrl: '/media/derived/face.json',
} as TimelineItem;

const baseState = (over: Partial<TimelineState> = {}, items: TimelineItem[] = [video]): TimelineState => ({
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: 'v1',
  selectedIds: ['v1'],
  trackOrder: ['V2', 'V1', 'A1', 'A2'],
  tracks: {
    V2: { kind: 'video' },
    V1: { kind: 'video' },
    A1: { kind: 'audio' },
    A2: { kind: 'audio' },
  },
  items,
  ...over,
} as TimelineState);

const ids = { itemId: 'a1', trackId: 'track_new' };
const applyAll = (s: TimelineState, actions: readonly AtomicAction[]): TimelineState =>
  actions.reduce((acc, action) => reduce(acc, action as Action), s);
const itemOf = (s: TimelineState, id: string): TimelineItem | undefined => s.items.find((it) => it.id === id);
const json = (value: unknown): string => JSON.stringify(value);
const attrOf = (element: string, name: string): string =>
  element.match(new RegExp(` ${name}="([^"]*)"`))?.[1] ?? '';

/**
 * Import an exported document through the real tool, on a fresh draft whose pool
 * holds the one asset the fixture uses. Returns the imported timeline's items.
 */
async function importFcpxml(content: string): Promise<TimelineItem[]> {
  const doc = docFromTimeline({
    fps: 30, width: 1280, height: 720, selectedId: null,
    trackOrder: ['V1'], tracks: { V1: { kind: 'video' } }, items: [],
  } as TimelineState);
  doc.assets.push({
    id: 'asset_1', name: 'interview.mp4', kind: 'video', src: '/media/uploads/interview.mp4',
    durationInFrames: 90 * 30, originalFilePath: '/media/uploads/interview.mp4',
  } as MediaAsset);
  const draft = makeDraft(doc);
  const ctx = {
    commands: draft.commands, getState: draft.getState, getDoc: draft.getDoc,
    getCreativeMode: () => null, templates: [], audio: [],
  } as unknown as AgentContext;
  const result = await execTimelineImportTool('import_timeline', { format: 'fcpxml', content }, ctx);
  assert.equal(result.ok, true, `the export must re-import: ${JSON.stringify(result).slice(0, 400)}`);
  return draft.getDoc().timelines.find((entry) => entry.id === result.timelineId)!.items;
}

// ── 1. Detach: alignment, independence, and the video goes silent ─────────────
{
  const plan = planAudioDetach(baseState(), 'v1', ids);
  assert.equal(plan.ok, true, 'detach plans for a plain video clip');
  if (!plan.ok) throw new Error('unreachable');
  assert.equal(plan.trackId, 'A1', 'detach lands on the first free audio lane');
  assert.equal(plan.trackCreated, false, 'a free lane is reused, not duplicated');
  assert.equal(plan.actions.length, 2, 'free lane: add + flag, one batch');
  assert.deepEqual(plan.actions.map((a) => a.type), ['add', 'setAudioDetached']);

  const after = applyAll(baseState(), plan.actions);
  const audio = itemOf(after, 'a1')!;
  const videoAfter = itemOf(after, 'v1')!;

  // alignment: same lane origin, same length, same source window
  assert.equal(audio.startFrame, 120, 'the audio clip starts exactly where the video does');
  assert.equal(audio.durationInFrames, 90, 'the audio clip is exactly as long as the video clip');
  assert.equal(audio.srcInFrame, 30, 'same source in-point');
  assert.equal(audio.playbackRate, 1.5, 'same speed, so the sound stays in sync');
  assert.equal(audio.src, video.src, 'same source file');
  assert.equal(audio.sourceAssetId, 'asset_1', 'pool identity travels with the clip');
  assert.equal(audio.sourceRevision, 'rev_1', 'source revision travels with the clip');

  // independence: an ordinary audio item on an ordinary audio lane
  assert.equal(audio.kind, 'audio', 'the detached clip is a real audio item');
  assert.equal(audio.track, 'A1', 'it lives on an audio lane');
  assert.equal(audio.audioOfItemId, 'v1', 'the back-pointer is what merge follows');
  assert.equal(audio.transform, undefined, 'no picture state on an audio clip');
  assert.equal(audio.derivedPictureSrc, undefined, 'a matte is picture state, it stays on the video');
  assert.equal(audio.faceTrackUrl, undefined, 'face artifacts are picture state');
  assert.equal(audio.transcript, undefined, 'the words stay on the video clip');
  assert.equal(audio.deletedWordIdx, undefined);
  assert.equal(audio.variants, undefined);
  assert.equal(audio.effects, undefined);

  // the video is picture-only, but nothing about its audio state was rewritten
  assert.equal(videoAfter.audioDetached, true, 'the video clip is flagged detached');
  assert.equal(videoAfter.src, video.src, 'I4: the source is never replaced');
  assert.equal(videoAfter.volume, 0.8, 'the user volume is untouched (not zeroed)');
  assert.equal(videoAfter.fadeInFrames, 6);
  assert.equal(videoAfter.fadeOutFrames, 9);
  assert.deepEqual(videoAfter.keyframes, video.keyframes, 'volume + picture keyframes all stay');
  assert.equal(videoAfter.transcript, video.transcript, 'the transcript stays on the video');
  assert.equal(videoAfter.denoisedSrc, video.denoisedSrc, 'the D2/D6 slot stays for merge');

  // the sound moved: volume envelope + D2/D6 voice slots are on the audio clip too
  assert.equal(audio.volume, 0.8, 'volume envelope base follows the sound');
  assert.deepEqual(audio.keyframes, { volume: video.keyframes!.volume! }, 'only the volume curve follows the sound');
  assert.equal(audio.denoisedSrc, video.denoisedSrc, 'the isolated-voice artifact follows the sound');
  assert.equal(audio.denoiseStrength, 100);
  assert.equal(audio.denoisedEngine, 'voice-isolation');

  // ── the video is silent in the mix, through the one seam preview+export share ──
  assert.equal(isItemAudioSilenced(video, false), false, 'before detach the clip sounds');
  assert.equal(isItemAudioSilenced(videoAfter, false), true, 'after detach the video clip is silent');
  assert.equal(isItemAudioSilenced(audio, false), false, 'the detached audio clip sounds');
  assert.equal(isItemAudioSilenced(audio, true), true, 'track mute still wins for the audio clip');

  // both render call sites must read that seam, not their own inline rule
  for (const [file, pattern] of [
    ['./TimelineComposition.tsx', /isItemAudioSilenced\(item, isMuted\(item\.track\)\)/],
    ['./TimelineMediaLayer.tsx', /isItemAudioSilenced\(item, muted\)/],
  ] as const) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(source, pattern, `${file} must silence a detached clip through the shared seam`);
  }
  const composition = readFileSync(new URL('./TimelineComposition.tsx', import.meta.url), 'utf8');
  assert.match(composition, /muted=\{isSilent\(item\)\}/, 'MediaFill gets the per-item mute');
  assert.match(composition, /muted=\{isSilent\(group\[0\]!\)\}/, 'the shared visual group gets it too');
}

// ── 2. Lane choice: never let `add` shift the clip off alignment ─────────────
{
  const blocker: TimelineItem = {
    id: 'music', track: 'A1', kind: 'audio', name: 'music', src: '/media/uploads/music.mp3',
    startFrame: 100, durationInFrames: 200,
  } as TimelineItem;
  const busyA1 = baseState({}, [video, blocker]);
  const plan = planAudioDetach(busyA1, 'v1', ids);
  assert.equal(plan.ok, true);
  if (!plan.ok) throw new Error('unreachable');
  assert.equal(plan.trackId, 'A2', 'a busy lane is skipped instead of shifting the clip');
  assert.equal(plan.trackCreated, false);
  const after = applyAll(busyA1, plan.actions);
  assert.equal(itemOf(after, 'a1')!.startFrame, 120, 'alignment survives a busy lane');
  assert.equal(itemOf(after, 'music')!.startFrame, 100, 'the neighbour is not pushed');

  const busyBoth = baseState({}, [video, blocker, { ...blocker, id: 'music2', track: 'A2' } as TimelineItem]);
  const noLane = planAudioDetach(busyBoth, 'v1', ids);
  assert.equal(noLane.ok, true);
  if (!noLane.ok) throw new Error('unreachable');
  assert.equal(noLane.trackCreated, true, 'no free lane → a new audio lane is created');
  assert.deepEqual(noLane.actions[0], { type: 'track.create', track: { id: 'track_new', kind: 'audio' } });
  const grown = applyAll(busyBoth, noLane.actions);
  assert.equal(grown.tracks?.track_new?.kind, 'audio', 'the new lane is an audio lane');
  assert.equal(itemOf(grown, 'a1')!.startFrame, 120, 'still aligned on the new lane');

  const locked = baseState({ tracks: { V2: { kind: 'video' }, V1: { kind: 'video', locked: true }, A1: { kind: 'audio', locked: true }, A2: { kind: 'audio', locked: true } } });
  const lockedPlan = planAudioDetach(locked, 'v1', ids);
  assert.equal(lockedPlan.ok, false, 'a locked video track refuses');
  if (!lockedPlan.ok) assert.equal(lockedPlan.code, 'locked_track');
}

// ── 3. Independence: the user edits the audio clip, the video does not follow ──
{
  const plan = planAudioDetach(baseState(), 'v1', ids);
  if (!plan.ok) throw new Error('unreachable');
  const detached = applyAll(baseState(), plan.actions);

  const selected = reduce(detached, { type: 'select', id: 'a1' });
  assert.equal(selected.selectedId, 'a1', 'the detached clip is selectable on its own');

  const trimmed = reduce(detached, { type: 'retime', id: 'a1', durationInFrames: 40 });
  assert.equal(itemOf(trimmed, 'a1')!.durationInFrames, 40, 'the audio clip trims independently');
  assert.equal(itemOf(trimmed, 'v1')!.durationInFrames, 90, 'the video clip is untouched by that trim');
  assert.equal(itemOf(trimmed, 'v1')!.audioDetached, true, 'and it stays picture-only');

  const moved = reduce(detached, { type: 'move', id: 'a1', startFrame: 400 });
  assert.equal(itemOf(moved, 'a1')!.startFrame, 400, 'the audio clip moves on its own');
  assert.equal(itemOf(moved, 'v1')!.startFrame, 120, 'the video clip does not follow');

  // The other direction is independent too: trimming the video leaves the audio put.
  const videoTrimmed = reduce(detached, { type: 'retime', id: 'v1', durationInFrames: 45 });
  assert.equal(itemOf(videoTrimmed, 'a1')!.startFrame, 120, 'a video trim does not drag the audio');
  assert.equal(itemOf(videoTrimmed, 'a1')!.durationInFrames, 90, 'nor re-time it');

  // Splitting the VIDEO after detaching: both halves are picture-only (the one
  // detached clip still covers the whole span), and merging each half in turn
  // restores every half's own sound with no audio clip left behind. The pair is
  // independent, so the audio clip is NOT cut with the video.
  const halves = reduce(detached, { type: 'split', id: 'v1', atFrame: 165, newId: 'v1b' });
  assert.equal(itemOf(halves, 'v1b')!.audioDetached, true, 'the new half is picture-only too');
  assert.equal(itemOf(halves, 'a1')!.durationInFrames, 90, 'the detached clip is not cut with the video');
  const leftMerge = planAudioMerge(halves, 'v1');
  if (!leftMerge.ok) throw new Error('unreachable');
  const leftMerged = applyAll(halves, leftMerge.actions);
  assert.equal(leftMerged.items.filter((it) => it.kind === 'audio').length, 0, 'merging one half takes the audio clip');
  assert.equal(isItemAudioSilenced(itemOf(leftMerged, 'v1')!, false), false, 'the merged half sounds');
  assert.equal(isItemAudioSilenced(itemOf(leftMerged, 'v1b')!, false), true, 'the other half stays silent until it is merged');
  const rightMerge = planAudioMerge(leftMerged, 'v1b');
  if (!rightMerge.ok) throw new Error('unreachable');
  const bothMerged = applyAll(leftMerged, rightMerge.actions);
  assert.equal(bothMerged.items.filter((it) => isItemAudioSilenced(it, false)).length, 0, 'both halves sound again');
}

// ── 4. Merge: exact restore, including after the user cut the clip up ────────
{
  const original = baseState();
  const plan = planAudioDetach(original, 'v1', ids);
  if (!plan.ok) throw new Error('unreachable');
  const detached = applyAll(original, plan.actions);

  const merge = planAudioMerge(detached, 'v1');
  assert.equal(merge.ok, true, 'merge plans for a detached clip');
  if (!merge.ok) throw new Error('unreachable');
  assert.deepEqual(merge.actions.map((a) => a.type), ['remove', 'setAudioDetached']);
  const merged = applyAll(detached, merge.actions);
  assert.deepEqual(merged.items, original.items, 'merge restores the items byte-for-byte');
  assert.equal(isItemAudioSilenced(itemOf(merged, 'v1')!, false), false, 'the video clip sounds again');
  assert.equal('audioDetached' in itemOf(merged, 'v1')!, false, 'the flag is cleared, not stored as false');

  // Split the detached clip in two, then merge: both halves go, no double audio.
  const split = reduce(detached, { type: 'split', id: 'a1', atFrame: 160, newId: 'a1b' });
  assert.equal(split.items.filter((it) => it.audioOfItemId === 'v1').length, 2, 'both halves keep the back-pointer');
  const mergeSplit = planAudioMerge(split, 'v1');
  if (!mergeSplit.ok) throw new Error('unreachable');
  const mergedSplit = applyAll(split, mergeSplit.actions);
  assert.equal(mergedSplit.items.filter((it) => it.kind === 'audio').length, 0, 'no detached audio survives the merge');
  assert.equal(json(mergedSplit.items), json(original.items), 'and the video is exactly the pre-detach clip');

  // Delete the detached clip to keep a silent video, then merge to get sound back.
  const deleted = reduce(detached, { type: 'remove', id: 'a1' });
  assert.equal(isItemAudioSilenced(itemOf(deleted, 'v1')!, false), true, 'deleting the audio keeps the video silent');
  const mergeGone = planAudioMerge(deleted, 'v1');
  if (!mergeGone.ok) throw new Error('unreachable');
  const restored = applyAll(deleted, mergeGone.actions);
  assert.equal(isItemAudioSilenced(itemOf(restored, 'v1')!, false), false, 'merge still restores the sound');
  assert.equal(json(restored.items), json(original.items));
}

// ── 5. Undo / redo are byte-exact in both directions ────────────────────────
{
  const doc = docFromTimeline(baseState());
  let history: History = { past: [], present: doc, future: [] };
  const dispatch: ProjectDispatch = (action) => { history = historyReduce(history, action); };
  const deps = { dispatch, getDoc: () => history.present, uid: (p: string) => `${p}_fixed` };
  const docJson = () => json(history.present);

  const before = docJson();
  const itemsBefore = json(activeTimeline(history.present).items);
  const detachResult = runAudioDetach(deps, 'v1');
  assert.equal(detachResult.ok, true, 'the detach command commits');
  const afterDetach = docJson();
  assert.notEqual(afterDetach, before, 'detach changed the document');
  assert.equal(history.past.length, 1, 'detach is ONE history step');

  history = historyReduce(history, { type: 'undo' });
  assert.equal(docJson(), before, 'undo is byte-exact');
  history = historyReduce(history, { type: 'redo' });
  assert.equal(docJson(), afterDetach, 'redo is byte-exact');

  const mergeResult = runAudioMerge(deps, 'v1');
  assert.equal(mergeResult.ok, true, 'the merge command commits');
  const afterMerge = docJson();
  assert.equal(history.past.length, 2, 'merge is ONE history step');
  assert.equal(
    json(activeTimeline(history.present).items),
    itemsBefore,
    'merge returns the items to the pre-detach bytes',
  );
  history = historyReduce(history, { type: 'undo' });
  assert.equal(docJson(), afterDetach, 'undoing the merge is byte-exact');
  history = historyReduce(history, { type: 'redo' });
  assert.equal(docJson(), afterMerge, 'redoing the merge is byte-exact');
}

// ── 6. Refusals: { ok:false, error, code }, reference-stable, no history step ──
{
  const state = baseState();
  const detachPlan = planAudioDetach(state, 'v1', ids);
  if (!detachPlan.ok) throw new Error('unreachable');
  const detached = applyAll(state, detachPlan.actions);

  const cases: Array<[ReturnType<typeof planAudioDetach>, string]> = [
    [planAudioDetach(state, 'nope', ids), 'unknown_item'],
    [planAudioDetach(detached, 'v1', ids), 'already_detached'],
    [planAudioMerge(state, 'v1'), 'not_detached'],
    [planAudioMerge(state, 'nope'), 'unknown_item'],
  ];
  for (const [result, code] of cases) {
    assert.equal(result.ok, false, `refuses with ${code}`);
    if (result.ok) continue;
    assert.equal(result.code, code);
    assert.equal(typeof result.error, 'string', `${code} carries an EN message`);
    assert.ok(result.error.length > 0);
  }

  const audioOnly = baseState({}, [{ ...video, kind: 'audio' } as TimelineItem]);
  const wrongKind = planAudioDetach(audioOnly, 'v1', ids);
  assert.equal(wrongKind.ok, false);
  if (!wrongKind.ok) assert.equal(wrongKind.code, 'unsupported_item_kind');

  const noSrc = baseState({}, [{ ...video, src: undefined } as TimelineItem]);
  const noSource = planAudioDetach(noSrc, 'v1', ids);
  assert.equal(noSource.ok, false);
  if (!noSource.ok) assert.equal(noSource.code, 'no_audio_source');

  // Reference stability: a no-op must return the SAME state object, or history
  // records a phantom undo step and drops the redo stack.
  assert.equal(reduce(detached, { type: 'setAudioDetached', id: 'v1', detached: true }), detached,
    're-setting the flag is a no-op');
  assert.equal(reduce(state, { type: 'setAudioDetached', id: 'v1', detached: false }), state,
    'clearing an unset flag is a no-op');
  assert.equal(reduce(state, { type: 'setAudioDetached', id: 'nope', detached: true }), state,
    'an unknown id is a no-op');
  assert.equal(reduce(state, { type: 'setAudioDetached', id: 'a1', detached: true }), state,
    'a non-video clip cannot be flagged');

  // A refused command must not push history.
  const doc = docFromTimeline(baseState());
  let history: History = { past: [], present: doc, future: [] };
  const deps = { dispatch: (a: Parameters<ProjectDispatch>[0]) => { history = historyReduce(history, a); }, getDoc: () => history.present, uid: (p: string) => `${p}_x` };
  const refused = runAudioMerge(deps, 'v1');
  assert.equal(refused.ok, false);
  assert.equal(history.past.length, 0, 'a refusal creates no undo step');
  assert.equal(history.present, doc, 'and leaves the document object alone');
}

// ── 7. Coherence with everything else that lives on the clip's audio ─────────
{
  const plan = planAudioDetach(baseState(), 'v1', ids);
  if (!plan.ok) throw new Error('unreachable');
  const detached = applyAll(baseState(), plan.actions);

  // Transcript + caption projection still resolve against the video clip.
  const videoCaps = captionTrackPlan(detached, 'v1');
  assert.equal(videoCaps.ok, true, 'captions still project from the video clip transcript');
  const audioCaps = captionTrackPlan(detached, 'a1');
  assert.equal(audioCaps.ok, false, 'the detached clip carries no transcript of its own');
  if (!audioCaps.ok) assert.equal(audioCaps.code, 'no_transcript');

  // Loudness normalization is audio-only: eligibility moves with the sound.
  const loudnessEligible = (item: TimelineItem) => item.kind === 'audio' && !!item.src;
  assert.equal(loudnessEligible(itemOf(detached, 'a1')!), true, 'the detached clip can be normalized');
  assert.equal(loudnessEligible(itemOf(detached, 'v1')!), false, 'the video clip no longer can be');

  // Speed still applies to the detached clip (it is a plain audio item).
  const sped = reduce(detached, { type: 'setSpeed', id: 'a1', rate: 1 });
  assert.equal(itemOf(sped, 'a1')!.playbackRate, 1, 'the detached clip takes a speed change');

  // A second detach on the same clip is refused rather than duplicating the sound.
  const again = planAudioDetach(detached, 'v1', { itemId: 'a2', trackId: 'track_x' });
  assert.equal(again.ok, false, 'detaching twice would double the audio');
}

// ── 8. FCPXML hand-off: both sides of the pair are marked ───────────────────
{
  const plan = planAudioDetach(baseState(), 'v1', ids);
  if (!plan.ok) throw new Error('unreachable');
  const detached = applyAll(baseState(), plan.actions);
  const xml = timelineToFcpxml(detached, { title: 'AV1' });
  assert.deepEqual(fcpxmlDtdViolations(xml), [], 'srcEnable is a legal asset-clip attribute');
  // Retimed clips carry a <timeMap> child, so match the open tag, not `/>`.
  const clips = xml.match(/<asset-clip [^>]*>/g) ?? [];
  assert.equal(clips.length, 2, 'the pair exports as two clips: picture and sound');
  const videoClip = clips.find((clip) => clip.includes('srcEnable="video"')) ?? '';
  assert.ok(videoClip, 'the detached video clip is exported');
  assert.match(videoClip, /lane="1"/, 'the video clip stays on its picture lane');
  const audioClip = clips.find((clip) => clip.includes('srcEnable="audio"')) ?? '';
  assert.ok(audioClip, 'the detached audio clip is marked as audio, not as a second picture');
  assert.match(audioClip, /lane="-1"/, 'the audio clip exports on an audio lane');
  assert.equal(attrOf(audioClip, 'offset'), attrOf(videoClip, 'offset'), 'both start on the same frame');
  assert.equal(attrOf(audioClip, 'duration'), attrOf(videoClip, 'duration'), 'both run the same length');

  const beforeXml = timelineToFcpxml(baseState(), { title: 'AV1' });
  assert.doesNotMatch(beforeXml, /srcEnable/, 'a clip that was never detached is not marked');

  // The marks are only worth anything if OCC's own importer collapses the pair,
  // so round-trip the export through the real tool. Without `srcEnable="audio"`
  // the audio clip imports as a second VIDEO clip (leafFamily falls back to the
  // asset's kind), reconcileClips has nothing to re-join, and the timeline comes
  // back as two stacked video clips, one of them silent.
  const imported = await importFcpxml(xml);
  assert.equal(imported.length, 1, 'the pair re-imports as ONE clip, not two stacked ones');
  const only = imported[0]!;
  assert.equal(only.kind, 'video', 'the surviving clip is the picture clip');
  assert.equal(only.startFrame, 120, 'and it starts where the pair did');
  assert.equal(only.durationInFrames, 90, 'and runs the length the pair did');
  assert.notEqual(only.volume, 0, 'it is audible: the merged audio component unmuted it');
  assert.equal(only.audioDetached, undefined, 'no detach flag survives the hand-off');
  assert.equal(only.audioOfItemId, undefined, 'and no back-pointer either');
}

// ── 9. The two menu labels are registered in the EN dictionary ──────────────
{
  const dict = EN as Record<string, string>;
  assert.equal(dict['分离音频'], 'Detach audio');
  assert.equal(dict['合并音频'], 'Merge audio');

  // The clip menu is the only entry point, and it must go through the dict and
  // the commands rather than inlining its own strings or reducer calls.
  const menu = readFileSync(new URL('../components/timeline/ClipContextMenu.tsx', import.meta.url), 'utf8');
  assert.match(menu, /label=\{t\('分离音频'\)\}/, 'the menu label goes through the dictionary');
  assert.match(menu, /label=\{t\('合并音频'\)\}/);
  assert.match(menu, /commands\.detachAudio\(item\.id\)/, 'the menu calls the command');
  assert.match(menu, /commands\.mergeAudio\(item\.id\)/);
  assert.match(menu, /\{item\.kind === 'video' && \(/, 'the pair only appears on a video clip');
  assert.match(menu, /if \(!result\.ok\) showAppToast\(result\.error, \{ error: true \}\)/, 'a refusal is surfaced, not swallowed');
}

console.log('audioDetach.verify: ok (detach/alignment/silence, independence, merge restore, undo-redo, refusals, coherence, fcpxml round-trip, dict)');
