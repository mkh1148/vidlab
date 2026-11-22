// D4 · the landmark track as the renderer needs it: loaded once per URL, parsed
// once, and settled — never a half-loaded track deciding the face region.
//
// Same two-phase shape as the .cube loader: `ensureFaceTrack` starts the fetch,
// `faceTrackSettled` is what the render tick waits on, `faceTrackFor` is what the
// shader frame reads. A track that fails to load or fails validation settles as
// null, which makes the shader fall back to the landmark region — honest, and it
// does not block the export forever.
import { parseFaceTrack, type FaceTrack } from './faceTrack.js';

const pending = new Map<string, Promise<FaceTrack | null>>();
const parsed = new Map<string, FaceTrack | null>();

/** Start (or reuse) the load of one track URL. */
export function ensureFaceTrack(url: string): Promise<FaceTrack | null> {
  const existing = pending.get(url);
  if (existing) return existing;
  const promise = (async () => {
    try {
      const response = await fetch(url);
      // A 404 is a settled failure, not a pending load: the render tick waits on
      // `faceTrackSettled`, so returning here without recording the miss would
      // leave the preview (and an export's delayRender) waiting forever on a
      // track that media clean-up already removed.
      if (!response.ok) {
        parsed.set(url, null);
        return null;
      }
      const track = parseFaceTrack(await response.json());
      parsed.set(url, track);
      return track;
    } catch {
      parsed.set(url, null);
      return null;
    }
  })();
  pending.set(url, promise);
  return promise;
}

/** True once the load finished, successfully or not. */
export function faceTrackSettled(url: string): boolean {
  return pending.has(url) && parsed.has(url);
}

/** The parsed track, or null while loading / after a failure. */
export function faceTrackFor(url: string): FaceTrack | null {
  return parsed.get(url) ?? null;
}

/** Drop every cached track and its in-flight load. Verifies only. */
export function __resetFaceTracks(): void {
  pending.clear();
  parsed.clear();
}
