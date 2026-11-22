// D4 · the one non-pass texture an effect can read: the face atlas.
//
// A clip effect's inputs are normally earlier passes. The atlas is different — it
// is an ASSET that lives beside the media and arrives by URL, so it has to be
// loaded, and a render must not run before it is ready (a mask-less frame would
// silently fall back to the landmark region and then pop when the image landed).
//
// Same two-phase shape as the .cube loader beside it: `ensureFxImage` starts the
// load, `fxImageSettled` is what the render tick waits on, `fxImage` is what the
// runtime binds. A failed load settles too — the shader's fallback is honest, a
// spinner is not.
const pending = new Map<string, Promise<HTMLImageElement | null>>();
const loaded = new Map<string, HTMLImageElement | null>();

/** Start (or reuse) the load of one image URL. */
export function ensureFxImage(url: string): Promise<HTMLImageElement | null> {
  const existing = pending.get(url);
  if (existing) return existing;
  const promise = new Promise<HTMLImageElement | null>((resolve) => {
    if (typeof Image === 'undefined') {
      resolve(null);
      return;
    }
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      loaded.set(url, image);
      resolve(image);
    };
    image.onerror = () => {
      loaded.set(url, null);
      resolve(null);
    };
    image.src = url;
  });
  pending.set(url, promise);
  return promise;
}

/** True once the load finished, successfully or not. */
export function fxImageSettled(url: string): boolean {
  return pending.has(url) && loaded.has(url);
}

/** The decoded image, or null while loading / after a failure. */
export function fxImage(url: string): HTMLImageElement | null {
  return loaded.get(url) ?? null;
}

/** Drop every cached image and its in-flight load. Verifies only. */
export function __resetFxImages(): void {
  pending.clear();
  loaded.clear();
}
