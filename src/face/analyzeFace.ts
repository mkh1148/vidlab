// D4 · "Analyze face": seek through the clip ONCE and store a compact landmark
// track plus a skin-mask atlas.
//
// The kit's recipe, in the kit's order:
//
//   1. sample the source at FACE_ANALYSIS_FPS (5 Hz) — not every frame, because the
//      track has to stay small and the box between samples interpolates;
//   2. per sample: Face Landmarker for the geometry, selfie segmentation for the
//      person mask, then cut the skin cell out of the two;
//   3. write the samples keyed by SOURCE frame (a trim then cannot shift the mask);
//   4. pack the cells into one atlas image and hand both to the caller, which
//      persists them through the server (the artifacts live in the storage root).
//
// The seek loop is a callback so this file has no video element in it: the browser
// wrapper below owns the element, and a verify can drive the same loop with a
// synthetic source.
import {
  FACE_ANALYSIS_FPS,
  FACE_TRACK_MAX_SAMPLES,
  FACE_TRACK_VERSION,
  clampFaceBox,
  quantizeFaceBox,
  type FaceBox,
  type FaceSample,
  type FaceTrack,
} from './faceTrack.ts';
import { FACE_ATLAS_CELL, faceAtlasGrid, packFaceAtlas, skinMaskCell } from './faceAtlas.ts';
import type { FaceRuntime } from './faceLandmarker.ts';

export interface FaceAnalysisProgress {
  /** 0..1 across the sampled frames. */
  readonly progress: number;
  readonly phase: 'sampling' | 'encoding';
  readonly frame: number;
  readonly frames: number;
}

export interface FaceAnalysisOutcome {
  readonly track: FaceTrack;
  /** RGBA pixels of the atlas, ready for a PNG encoder. */
  readonly atlas: Uint8ClampedArray;
  readonly atlasWidth: number;
  readonly atlasHeight: number;
  readonly sampleCount: number;
  readonly facesFound: number;
  readonly elapsedMs: number;
}

/** Frame indices the pass will sample, in ascending SOURCE order. */
export function faceSampleFrames(sourceFps: number, sourceFrames: number, analysisFps: number): number[] {
  const step = Math.max(1, sourceFps / Math.max(Number.EPSILON, analysisFps));
  const count = Math.min(FACE_TRACK_MAX_SAMPLES, Math.max(1, Math.ceil(sourceFrames / step)));
  const frames: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const frame = Math.min(sourceFrames - 1, Math.round(index * step));
    if (frames.length === 0 || frame > frames[frames.length - 1]!) frames.push(frame);
  }
  return frames;
}

/**
 * Run the pass over a source.
 *
 * `seek` returns the pixels of one SOURCE frame already scaled to the inference
 * edge, or null when the frame could not be decoded (a seek that never lands must
 * not hang the pass). A frame with no face is a sample with confidence 0 and an
 * empty cell — the track stays aligned to the frames that did have one.
 */
export async function analyzeFaceFrames(input: {
  readonly sourceFps: number;
  readonly sourceFrames: number;
  readonly runtime: FaceRuntime;
  readonly seek: (sourceFrame: number) => Promise<HTMLCanvasElement | null>;
  readonly analysisFps?: number;
  readonly cell?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (update: FaceAnalysisProgress) => void;
  readonly now?: () => number;
}): Promise<FaceAnalysisOutcome> {
  const now = input.now ?? (() => Date.now());
  const started = now();
  const analysisFps = input.analysisFps ?? FACE_ANALYSIS_FPS;
  const cell = input.cell ?? FACE_ATLAS_CELL;
  const frames = faceSampleFrames(input.sourceFps, input.sourceFrames, analysisFps);
  const grid = faceAtlasGrid(frames.length, cell);
  const cells: Uint8Array[] = [];
  const samples: FaceSample[] = [];
  let facesFound = 0;

  for (let index = 0; index < frames.length; index += 1) {
    input.signal?.throwIfAborted();
    const sourceFrame = frames[index]!;
    const canvas = await input.seek(sourceFrame);
    let box: FaceBox | null = null;
    let confidence = 0;
    let maskCell: Uint8Array = new Uint8Array(grid.cell * grid.cell);
    if (canvas) {
      const inference = input.runtime.infer(canvas);
      const clamped = inference.box ? clampFaceBox(inference.box) : null;
      if (clamped) {
        box = clamped;
        confidence = inference.confidence;
        facesFound += 1;
        maskCell = skinMaskCell({
          person: inference.person,
          personWidth: inference.personWidth,
          personHeight: inference.personHeight,
          box: clamped,
          cell: grid.cell,
        });
      }
    }
    // A frame without a face still gets a sample: the track must stay a dense,
    // ordered series of source frames, or the interpolation would jump across the
    // gap and drag the mask onto a face that is not there.
    samples.push({
      f: sourceFrame,
      box: box ?? quantizeFaceBox({ x: 0, y: 0, w: 0, h: 0 }),
      c: confidence,
    });
    cells.push(maskCell);
    input.onProgress?.({
      progress: (index + 1) / frames.length,
      phase: 'sampling',
      frame: index + 1,
      frames: frames.length,
    });
  }

  input.onProgress?.({ progress: 1, phase: 'encoding', frame: frames.length, frames: frames.length });
  const atlas = packFaceAtlas(cells, grid);
  // A sample with no face has a degenerate box; the parser refuses those, so the
  // track keeps a 1-pixel box in the frame's corner instead. The shader's region is
  // then empty (weight 0), which is the honest "no face here".
  const trackSamples = samples.map((sample) => (
    sample.box.w > 0 && sample.box.h > 0
      ? sample
      : { ...sample, box: quantizeFaceBox({ x: 0, y: 0, w: 0.0001, h: 0.0001 }) }
  ));
  const track: FaceTrack = {
    version: FACE_TRACK_VERSION,
    sourceFps: input.sourceFps,
    sourceFrames: input.sourceFrames,
    analysisFps,
    cols: grid.cols,
    rows: grid.rows,
    cell: grid.cell,
    samples: trackSamples,
  };
  return {
    track,
    atlas,
    atlasWidth: grid.width,
    atlasHeight: grid.height,
    sampleCount: frames.length,
    facesFound,
    elapsedMs: now() - started,
  };
}

/** Encode packed RGBA pixels as a PNG blob (browser only). */
export async function encodeFaceAtlasPng(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable for the skin-mask atlas');
  // A fresh view, so the ImageData is backed by a plain ArrayBuffer (the packed
  // atlas may arrive as a SharedArrayBuffer view on some platforms).
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('the skin-mask atlas could not be encoded as PNG');
  return new Uint8Array(await blob.arrayBuffer());
}

/** Scale a source frame into an inference canvas at the model's working edge. */
export function drawInferenceFrame(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  edge: number,
): HTMLCanvasElement | null {
  if (sourceWidth <= 0 || sourceHeight <= 0) return null;
  const scale = Math.min(1, edge / Math.max(sourceWidth, sourceHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, Math.round(sourceWidth * scale));
  canvas.height = Math.max(2, Math.round(sourceHeight * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Seek a video element to one SOURCE frame and hand back its pixels. */
export function videoFrameSeeker(
  video: HTMLVideoElement,
  options: { readonly sourceFps: number; readonly edge: number; readonly timeoutMs?: number },
): (sourceFrame: number) => Promise<HTMLCanvasElement | null> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  return (sourceFrame) => new Promise<HTMLCanvasElement | null>((resolve) => {
    let settled = false;
    const finish = (value: HTMLCanvasElement | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
      resolve(value);
    };
    const onSeeked = (): void => {
      const width = video.videoWidth;
      const height = video.videoHeight;
      finish(drawInferenceFrame(video, width, height, options.edge));
    };
    // A seek that never lands (a corrupt frame, a decoder stall) must not hang the
    // pass: the sample becomes "no face" and the run continues.
    const timer = setTimeout(() => finish(null), timeoutMs);
    video.addEventListener('seeked', onSeeked, { once: true });
    // Aim at the middle of the frame's presentation interval, so a rounded frame
    // index cannot land on the boundary and decode the neighbour.
    video.currentTime = (sourceFrame + 0.5) / Math.max(Number.EPSILON, options.sourceFps);
  });
}
