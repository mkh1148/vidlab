// Which file supplies a clip's PICTURE (D1 background removal).
//
// The D-job contract splits a clip in two: `item.src` is the original source and
// stays the clip's audio, duration and every fallback (I4 — the original is never
// replaced); `item.derivedPictureSrc` is a cut-out picture that only affects what
// you see. Every render path that draws the picture reads it through this one
// function, so "does this path honour the matte?" has a single answer to check
// instead of one per component.
//
// The artifact is the same size and frame rate as the source (the engine encodes
// at the probed display geometry), so a trim offset computed from the source
// applies to the derived picture unchanged.
import type { TimelineItem } from './types';

/** The URL the picture comes from: the derived artifact when one is attached. */
export function pictureSourceOf(item: Pick<TimelineItem, 'src' | 'derivedPictureSrc'>): string | undefined {
  return item.derivedPictureSrc ?? item.src;
}

/** True when the picture is a derived artifact rather than the original source. */
export function usesDerivedPicture(item: Pick<TimelineItem, 'derivedPictureSrc'>): boolean {
  return Boolean(item.derivedPictureSrc);
}
