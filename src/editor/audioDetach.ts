// AV1: detach a video clip's own audio onto its own audio clip, and merge it back.
//
// Owner requirement: right-click a video clip on the timeline → "Detach audio"
// moves its sound onto a real audio clip the user can select, trim, move and mix
// like any other audio clip, and the video clip becomes picture-only; "Merge
// audio" puts it back.
//
// Design (the alternatives that lost are in the AV1 report):
//  * The pair is a FLAG + a BACK-POINTER, not a link group. `audioDetached` on
//    the video item is what silences it (the same mute seam the track mute uses,
//    so preview and the server render cannot disagree); `audioOfItemId` on the
//    audio clip is what merge follows back. A `linkGroups` "linked" pair would
//    make the two clips delete and ripple together — the opposite of the
//    independent clip the owner asked for — and "Unlink" from the menu would
//    silently destroy the merge path.
//  * The audio clip is an ordinary `kind: 'audio'` item, so every existing audio
//    behaviour (select, trim, split, move, mix, fades, volume keyframes, loudness
//    normalization, audio transitions) works on it with no new code.
//  * The video item keeps `src`, its transcript and its D2/D6 slots. Merge is a
//    flag flip plus clip removal, so both directions are byte-exact (I4: the
//    source is never replaced).
//
// What merge discards: every edit made to the detached clip — including a split
// into several pieces, all of which carry the same back-pointer and are all
// removed. That is what "the clip is removed" means, and removing all of them is
// the only way to guarantee the export has no double audio.
import type { AtomicAction, ProjectDispatch } from './reduce';
import type { ProjectDoc, TimelineItem, TimelineState, TrackId } from './types';
import { activeTimeline, timelineTrackIds, trackKind } from './types';

/** Why a detach/merge was refused. Every refusal is `{ ok: false, error, code }`. */
export type AudioDetachErrorCode =
  | 'unknown_item'
  | 'unsupported_item_kind'
  | 'already_detached'
  | 'not_detached'
  | 'no_audio_source'
  | 'locked_track';

export type AudioDetachResult =
  | {
    ok: true;
    /** The detached clip (detach) or the clip that was removed (merge). */
    audioItemId: string;
    /** Lane the detached clip landed on. */
    trackId: TrackId;
    /** True when no audio lane was free and a new one had to be created. */
    trackCreated: boolean;
  }
  | { ok: false; error: string; code: AudioDetachErrorCode };

export type AudioDetachPlanResult =
  | {
    ok: true;
    actions: AtomicAction[];
    audioItemId: string;
    trackId: TrackId;
    trackCreated: boolean;
  }
  | { ok: false; error: string; code: AudioDetachErrorCode };

const refuse = (code: AudioDetachErrorCode, error: string): { ok: false; error: string; code: AudioDetachErrorCode } =>
  ({ ok: false, error, code });

/**
 * Is this clip's own audio silenced?
 *
 * The single seam the timeline composition (preview) and the render composition
 * (export) both read — they are one component, so there is no second place to
 * forget. A detached video clip is picture-only even though its `src`, its
 * volume and its fades are untouched, which is what makes merge exact.
 */
export function isItemAudioSilenced(item: TimelineItem, trackMuted: boolean): boolean {
  return trackMuted || item.audioDetached === true;
}

/**
 * Does this clip present as picture-only on the timeline?
 *
 * The UI counterpart of the silence seam: a detached video clip draws no waveform
 * strip, gets the full filmstrip height, and drops its audio-only badges, because
 * the sound it used to carry is on another clip. Merge clears the flag and every
 * one of those comes back with the sound.
 */
export function isItemPictureOnly(item: TimelineItem): boolean {
  return item.kind === 'video' && item.audioDetached === true;
}

/** Ids the caller mints (the builder owns `uid`, so the planner stays pure). */
export interface AudioDetachIds {
  itemId: string;
  trackId: string;
}

/**
 * First audio lane with room for [startFrame, startFrame+durationInFrames).
 *
 * The lane must be picked explicitly: the `add` action resolves a same-track
 * collision by SHIFTING the new clip (`clampMoveDeltaToTrackGaps` with delta 0),
 * which would silently break the alignment the feature exists to guarantee.
 * Locked lanes are skipped — a locked lane would reject the add outright.
 */
function freeAudioLane(
  s: TimelineState,
  startFrame: number,
  durationInFrames: number,
): TrackId | null {
  const end = startFrame + durationInFrames;
  for (const id of timelineTrackIds(s)) {
    if (trackKind(s, id) !== 'audio') continue;
    if (s.tracks?.[id]?.locked) continue;
    const busy = s.items.some((item) => item.track === id
      && item.startFrame < end
      && startFrame < item.startFrame + item.durationInFrames);
    if (!busy) return id;
  }
  return null;
}

/**
 * The audio clip a detach produces.
 *
 * Copied: source identity (so the clip survives pool removal and relink like any
 * other), the trim/speed window (same source frames, same speed → same sound),
 * the volume envelope (item-local frames, and both clips share origin and length,
 * so the curve is sample-identical), and the D2/D6 voice slots (the artifact
 * describes THIS source's voice, and the sound is what moved).
 *
 * Deliberately NOT copied: the transcript and everything derived from it
 * (`variants`, `deletedWordIdx`, `gapCapsMs`, `silenceFrames`, `cutPadFrames`,
 * `transcriptPlayOrder`). The words stay on the video clip — that keeps caption
 * projection pointing at the clip the user still sees, and it keeps the audio
 * clip's duration from being recomputed from a transcript (`editedDuration`),
 * which would break the alignment. A detached clip without a transcript sounds
 * exactly like the video did: video clips never segment-cut their audio at
 * deleted words (`PlainMediaFill` has no kept-segments path).
 *
 * Also not copied: picture state (transform, filters, zoom, effects, derived
 * picture, face artifacts, background fill) and `width`/`height` — an audio lane
 * draws nothing.
 */
function detachedAudioItem(
  video: TimelineItem,
  id: string,
  trackId: TrackId,
): Omit<TimelineItem, 'startFrame'> {
  const volumeKeyframes = video.keyframes?.volume;
  return {
    id,
    track: trackId,
    durationInFrames: video.durationInFrames,
    kind: 'audio',
    name: video.name,
    src: video.src,
    sourceAssetId: video.sourceAssetId,
    sourceRevision: video.sourceRevision,
    sourceContentHash: video.sourceContentHash,
    sourceFilename: video.sourceFilename,
    originalFilePath: video.originalFilePath,
    srcInFrame: video.srcInFrame,
    playbackRate: video.playbackRate,
    volume: video.volume,
    fadeInFrames: video.fadeInFrames,
    fadeOutFrames: video.fadeOutFrames,
    ...(volumeKeyframes?.length ? { keyframes: { volume: volumeKeyframes } } : {}),
    denoisedSrc: video.denoisedSrc,
    denoiseStrength: video.denoiseStrength,
    denoisedEngine: video.denoisedEngine,
    audioOfItemId: video.id,
  };
}

/**
 * Plan "Detach audio" for a video clip: create the audio clip on a free audio
 * lane (creating a lane when every lane is busy) and silence the video clip, as
 * ONE undoable batch.
 */
export function planAudioDetach(
  s: TimelineState,
  videoId: string,
  ids: AudioDetachIds,
): AudioDetachPlanResult {
  const video = s.items.find((item) => item.id === videoId);
  if (!video) return refuse('unknown_item', `No clip with id ${videoId}.`);
  if (video.kind !== 'video') {
    return refuse('unsupported_item_kind', 'Only a video clip can detach its audio.');
  }
  if (video.audioDetached === true) {
    return refuse('already_detached', 'This clip already has its audio detached.');
  }
  if (s.tracks?.[video.track]?.locked) {
    return refuse('locked_track', 'The clip is on a locked track.');
  }
  if (!video.src) return refuse('no_audio_source', 'This clip has no media source to detach audio from.');

  const lane = freeAudioLane(s, video.startFrame, video.durationInFrames);
  const trackId = lane ?? ids.trackId;
  const actions: AtomicAction[] = [];
  if (!lane) actions.push({ type: 'track.create', track: { id: trackId, kind: 'audio' } });
  actions.push({
    type: 'add',
    item: detachedAudioItem(video, ids.itemId, trackId),
    startFrame: video.startFrame,
  });
  actions.push({ type: 'setAudioDetached', id: video.id, detached: true });
  return { ok: true, actions, audioItemId: ids.itemId, trackId, trackCreated: !lane };
}

/**
 * Plan "Merge audio": remove every clip that carries this video's audio and make
 * the video clip sound again, as ONE undoable batch.
 *
 * The audio clip may be gone already (the user deleted it to keep a silent
 * video); then merge is just the flag flip and still restores the sound.
 */
export function planAudioMerge(s: TimelineState, videoId: string): AudioDetachPlanResult {
  const video = s.items.find((item) => item.id === videoId);
  if (!video) return refuse('unknown_item', `No clip with id ${videoId}.`);
  if (video.kind !== 'video') {
    return refuse('unsupported_item_kind', 'Only a video clip can merge audio back.');
  }
  if (video.audioDetached !== true) {
    return refuse('not_detached', 'This clip has no detached audio to merge.');
  }
  if (s.tracks?.[video.track]?.locked) {
    return refuse('locked_track', 'The clip is on a locked track.');
  }
  const detached = s.items.filter((item) => item.audioOfItemId === videoId);
  const actions: AtomicAction[] = [
    ...detached.map((item): AtomicAction => ({ type: 'remove', id: item.id })),
    { type: 'setAudioDetached', id: videoId, detached: false },
  ];
  return {
    ok: true,
    actions,
    audioItemId: detached[0]?.id ?? '',
    trackId: detached[0]?.track ?? video.track,
    trackCreated: false,
  };
}

/** Everything a detach/merge command needs from the store; keeps the planner pure. */
export interface AudioDetachDeps {
  dispatch: ProjectDispatch;
  getDoc: () => ProjectDoc;
  uid: (prefix: string) => string;
}

/** Commit "Detach audio" for a video clip. One history step. */
export function runAudioDetach(deps: AudioDetachDeps, videoId: string): AudioDetachResult {
  const state = activeTimeline(deps.getDoc());
  const plan = planAudioDetach(state, videoId, { itemId: deps.uid('item'), trackId: deps.uid('track') });
  if (!plan.ok) return plan;
  deps.dispatch({ type: 'batch', label: 'Detach audio', actions: plan.actions });
  return {
    ok: true,
    audioItemId: plan.audioItemId,
    trackId: plan.trackId,
    trackCreated: plan.trackCreated,
  };
}

/** Commit "Merge audio" for a video clip. One history step. */
export function runAudioMerge(deps: AudioDetachDeps, videoId: string): AudioDetachResult {
  const plan = planAudioMerge(activeTimeline(deps.getDoc()), videoId);
  if (!plan.ok) return plan;
  deps.dispatch({ type: 'batch', label: 'Merge audio', actions: plan.actions });
  return {
    ok: true,
    audioItemId: plan.audioItemId,
    trackId: plan.trackId,
    trackCreated: plan.trackCreated,
  };
}
