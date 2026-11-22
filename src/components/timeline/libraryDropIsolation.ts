// The revision-aware commit boundary for the Library's audio-fx drop path.
//
// The drop is asynchronous: the separation is a media job, so the clip can change
// while it runs. This module is where that race is decided — the source revision is
// captured before the job starts, the artifact identity is built from it, and the
// commit is refused if the clip's source moved in the meantime.
import {
  runVoiceIsolationJob,
  uploadNameOf,
  type VoiceIsolationRunResult,
} from '../../audio/isolateVoice';
import {
  captureTimelineItemSource,
  validateTimelineItemSourceResult,
  type TimelineItemSourceStale,
} from '../../editor/mediaSourceRevision';
import type { MediaAsset, TimelineItem, TimelineState } from '../../editor/types';

/** One isolation run, injectable so the verify can drive the boundary without a server. */
export type VoiceIsolationRunner = (
  sourceName: string,
  options: { sourceRevision: string },
) => Promise<VoiceIsolationRunResult>;

export interface LibraryDropIsolationContext {
  getState: () => TimelineState;
  getAssets: () => readonly MediaAsset[];
  setItemDenoise: (itemId: string, denoisedSrc: string, strength: number, engine: string | null) => void;
}

export type LibraryDropIsolationResult = TimelineItemSourceStale | {
  status: 'committed';
  itemId: string;
  denoisedSrc: string;
  strength: number;
  engine: string | null;
  sourceRevision: string;
};

const defaultRunner: VoiceIsolationRunner = (sourceName, options) => runVoiceIsolationJob({
  sourceName,
  revision: options.sourceRevision,
});

/**
 * Run isolation for a dropped clip and commit it only if the source is unchanged.
 * The callback is never invoked for a missing, replaced, relinked, or
 * server-revision-mismatched item.
 */
export async function applyLibraryDropIsolation(
  item: TimelineItem,
  strength: number,
  context: LibraryDropIsolationContext,
  run: VoiceIsolationRunner = defaultRunner,
): Promise<LibraryDropIsolationResult> {
  const snapshot = captureTimelineItemSource(item, context.getAssets());
  const sourceName = uploadNameOf(snapshot.src);
  if (!sourceName) {
    throw new Error('voice isolation needs a media-pool source (/media/uploads/…)');
  }
  const result = await run(sourceName, { sourceRevision: snapshot.sourceRevision });
  const currentItem = context.getState().items.find((candidate) => candidate.id === snapshot.itemId);
  const validation = validateTimelineItemSourceResult(
    snapshot,
    currentItem,
    context.getAssets(),
    result.sourceRevision,
  );
  if (validation.status === 'stale') return validation;

  context.setItemDenoise(snapshot.itemId, result.path, strength, result.engine);
  return {
    status: 'committed',
    itemId: snapshot.itemId,
    denoisedSrc: result.path,
    strength,
    engine: result.engine,
    sourceRevision: result.sourceRevision,
  };
}
