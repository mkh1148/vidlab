import { captionTrackEntries, captionsOnTrack, trackAlias, trackKind, type TimelineState, type TrackId } from '../editor/types';
import type { CaptionsData, CaptionPacing, CaptionTemplate } from './types';
import { hasOperationalTranscript } from '../transcript/types';
import { buildCaptionPages } from './captionPages';

/** Existing captions, or a default caption source derived from the selected track. */
export function captionsForTrack(state: TimelineState, trackId: TrackId): CaptionsData | null {
  if (trackKind(state, trackId) === 'caption') return captionsOnTrack(state, trackId);
  if (state.captions) return state.captions;
  const source = state.items.find((item) => item.track === trackId && hasOperationalTranscript(item));
  return source
    ? { enabled: true, template: 'plain', pacing: 'phrase', sourceItemId: source.id }
    : null;
}

// ── The transcript → caption-track join (D3b) ────────────────────────────────
//
// A caption track holds NO words of its own on this path: it holds a BINDING to a
// clip, and every word it shows is projected from that clip's stored transcript
// through the clip's current trim/edit state (resolve.ts → projectRetimedWords /
// projectMediaWindowWords). That is what makes "trimming a clip trims its
// captions" structural instead of a sync job, and it is why REFRESH costs nothing:
// after a re-transcription the same binding projects the new words, so a refresh
// is only "re-assert the binding and make sure the track is on".
//
// The plan below is pure so the inspector control, the agent tool and the verify
// all describe the same join. It never mutates and never invents a transcript.

/** Why a clip cannot become a caption track's source. */
export type CaptionTrackRefusalCode = 'item_missing' | 'not_speech_media' | 'transcript_stale' | 'no_transcript';

export interface CaptionTrackRefusal {
  readonly ok: false;
  readonly code: CaptionTrackRefusalCode;
  readonly error: string;
}

export interface CaptionTrackPlan {
  readonly ok: true;
  /** The track already bound to this clip, or null when the caller must create one. */
  readonly trackId: TrackId | null;
  /** The payload to write. On a refresh this differs from the stored one only when
   * the track was off; the look (template/pacing/style/layout) is never reset. */
  readonly captions: CaptionsData;
  /** True when the stored payload already equals `captions` — write nothing, so a
   * repeated call is not a phantom history step. */
  readonly unchanged: boolean;
}

/** Does this caption payload read its words from `itemId`? */
export function captionsBindItem(captions: CaptionsData | null | undefined, itemId: string): boolean {
  if (!captions) return false;
  if (captions.sourceItemId === itemId) return true;
  if (captions.sources?.includes(itemId)) return true;
  return !!captions.sourceEntries?.some((entry) => entry.itemId === itemId);
}

/** The caption track already bound to this clip, if any. */
export function captionTrackForItem(state: TimelineState, itemId: string): { trackId: TrackId; captions: CaptionsData } | null {
  for (const entry of captionTrackEntries(state)) {
    if (captionsBindItem(entry.captions, itemId)) return { trackId: entry.id, captions: entry.captions! };
  }
  return null;
}

/** The look a new track inherits: the first existing caption track's own choices,
 * so a second clip's captions match the first instead of resetting to Plain. */
function inheritedLook(state: TimelineState): { template: CaptionTemplate; pacing: CaptionPacing } {
  const existing = captionTrackEntries(state).find((entry) => entry.captions);
  return {
    template: existing?.captions?.template ?? 'plain',
    pacing: existing?.captions?.pacing ?? 'phrase',
  };
}

/**
 * Plan the join for one clip. Refuses instead of guessing: a clip with no
 * transcript, a stale (review-only) transcript, or a kind that cannot carry
 * speech gets a code the UI and the agent tool can report.
 */
export function captionTrackPlan(state: TimelineState, itemId: string): CaptionTrackPlan | CaptionTrackRefusal {
  const item = state.items.find((candidate) => candidate.id === itemId);
  if (!item) return { ok: false, code: 'item_missing', error: `no timeline item ${itemId}` };
  if (item.kind !== 'audio' && item.kind !== 'video') {
    return { ok: false, code: 'not_speech_media', error: `item ${itemId} is a ${item.kind} clip; captions need a clip with speech` };
  }
  if (item.transcriptStale === true) {
    return { ok: false, code: 'transcript_stale', error: `item ${itemId} carries a stale transcript; transcribe it again before captioning` };
  }
  if (!hasOperationalTranscript(item)) {
    return { ok: false, code: 'no_transcript', error: `item ${itemId} has no transcript; run transcription first` };
  }

  const bound = captionTrackForItem(state, itemId);
  if (bound) {
    // Refresh: keep the binding shape (single source, `sources` list or lanes) and
    // the look; only make sure the track is on.
    const captions: CaptionsData = bound.captions.enabled ? bound.captions : { ...bound.captions, enabled: true };
    return { ok: true, trackId: bound.trackId, captions, unchanged: captions === bound.captions };
  }

  const look = inheritedLook(state);
  return {
    ok: true,
    trackId: null,
    captions: { enabled: true, template: look.template, pacing: look.pacing, sourceItemId: itemId },
    unchanged: false,
  };
}

/** What an inspector control needs to describe the binding, or null when the clip
 *  has no caption track yet. The cue count is the track's real page count, so the
 *  number the user reads is the number that renders. */
export interface CaptionTrackSummary {
  alias: string;
  cues: number;
  enabled: boolean;
}

export function captionTrackSummary(state: TimelineState, itemId: string): CaptionTrackSummary | null {
  const bound = captionTrackForItem(state, itemId);
  if (!bound) return null;
  return {
    alias: trackAlias(state, bound.trackId),
    cues: buildCaptionPages(bound.captions, state.items, state.fps).length,
    enabled: bound.captions.enabled,
  };
}
