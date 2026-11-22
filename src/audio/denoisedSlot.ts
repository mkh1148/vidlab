// Who owns the `denoisedSrc` slot on a clip.
//
// Two engines write it: D6 `voice-isolation` (Spleeter 2stems + the D2 chain) and D2
// `voice-cleanup` (the chain alone). Before the engine was recorded beside the path,
// both inspector controls read "active" on the same clip and neither could say what
// produced the file — the defect the D6 slice closes.
//
// A clip whose artifact predates the tag reports `legacy` rather than guessing an
// engine: the honest answer is "something produced this and we do not know what".
import type { TimelineItem } from '../editor/types';

export const VOICE_ISOLATION_ENGINE = 'voice-isolation';
export const VOICE_CLEANUP_ENGINE = 'voice-cleanup';

/** The engine id that produced the artifact, or `legacy` for an untagged one. */
export type DenoisedSlotOwner = string;

export function denoisedSlotOwner(
  item: Pick<TimelineItem, 'denoisedSrc' | 'denoisedEngine'>,
): DenoisedSlotOwner | null {
  if (!item.denoisedSrc) return null;
  const engine = item.denoisedEngine?.trim();
  return engine ? engine : 'legacy';
}

/** True when this clip plays a voice artifact produced by `engine`. */
export function denoisedSlotIs(
  item: Pick<TimelineItem, 'denoisedSrc' | 'denoisedEngine'>,
  engine: DenoisedSlotOwner,
): boolean {
  return denoisedSlotOwner(item) === engine;
}
