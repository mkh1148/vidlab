// D4 · what the shader is told about the face on the frame it is drawing.
//
// One function, so preview and export cannot disagree about the region: ClipFx
// computes this per rendered frame from the track and the atlas grid, and the
// fragment shader reads exactly these uniforms. The fallback (no atlas) is the
// same math the analyzer uses to cut a skin mask out of the person mask, so
// "without a mask it falls back to a landmark-based region" is one ellipse
// definition in two places that a verify keeps equal.
import type { UniformValue } from '../gl/runtimeTypes.js';
import type { FaceBox, FaceTrack } from './faceTrack.js';
import { atlasCellAtSourceFrame, boxAtSourceFrame } from './faceTrack.js';

/** Ellipse radius as a fraction of the box half-extent (matches faceAtlas.ts). */
export const FACE_REGION_RADIUS = 1.05;

/** Feather width of the ellipse edge, in normalized box units. */
export const FACE_REGION_FEATHER = 0.35;

/** Weight of the landmark region at one point of the frame, 0..1. */
export function faceRegionWeight(
  point: { readonly x: number; readonly y: number },
  box: FaceBox,
  radius: number = FACE_REGION_RADIUS,
  feather: number = FACE_REGION_FEATHER,
): number {
  if (box.w <= 0 || box.h <= 0) return 0;
  const nx = ((point.x - box.x) / box.w) * 2 - 1;
  const ny = ((point.y - box.y) / box.h) * 2 - 1;
  const distance = Math.sqrt(nx * nx + ny * ny) / radius;
  const t = Math.min(1, Math.max(0, (distance - (1 - feather)) / feather));
  return 1 - t * t * (3 - 2 * t);
}

export interface FaceFrameRegion {
  /** The uniforms the shader reads; empty when the frame carries no face. */
  readonly uniforms: Record<string, UniformValue>;
  /** Texture uniforms the clip's atlas supplies, when there is one. */
  readonly images: Record<string, string>;
  readonly hasFace: boolean;
  readonly hasMask: boolean;
}

/**
 * Per-frame shader context for one clip.
 *
 * `sourceFrame` is a SOURCE frame index — ClipFx passes the same value it gives the
 * decoder, so a trim moves the lookup with the picture.
 */
export function faceFrameRegion(input: {
  readonly track: FaceTrack | null;
  readonly atlasUrl: string | null;
  readonly sourceFrame: number;
}): FaceFrameRegion {
  const { track, atlasUrl, sourceFrame } = input;
  const box = track ? boxAtSourceFrame(track, sourceFrame) : null;
  if (!box) {
    return { uniforms: { u_face_mask: 0 }, images: {}, hasFace: false, hasMask: false };
  }
  const hasMask = Boolean(track && atlasUrl);
  const cell = track && hasMask ? atlasCellAtSourceFrame(track, sourceFrame) : -1;
  const uniforms: Record<string, UniformValue> = {
    u_face_box: [box.x, box.y, box.w, box.h],
    u_face_mask: hasMask ? 1 : 0,
    u_face_cell: cell >= 0 && track ? [cell % track.cols, Math.floor(cell / track.cols)] : [0, 0],
    u_face_grid: track ? [track.cols, track.rows] : [1, 1],
    u_face_cell_px: track ? track.cell : 1,
  };
  return {
    uniforms,
    images: hasMask && atlasUrl ? { u_face_atlas: atlasUrl } : {},
    hasFace: true,
    hasMask,
  };
}
