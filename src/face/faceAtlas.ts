// D4 · the skin-mask atlas: one grayscale cell per landmark sample, packed into a
// single image next to the media.
//
// Why an atlas and not a video or a per-frame PNG: the shader needs a mask for the
// frame it is drawing, and a texture is the only thing it can read. One image with
// a grid of cells is one texture upload, one URL to serve, one file to move in
// clean-up and export — the kit's "image atlas" and the effect-asset rule agree.
//
// The grid is derived from the sample count, not stored twice: `cols = ceil(sqrt(n))`
// and cell index == sample index (see faceTrack.ts). The track carries cols/rows/cell
// so a reader never has to guess, and the two files cannot disagree.
//
// The mask itself is a SKIN mask, not the segmenter's raw person mask: the analyzer
// multiplies the person mask by the face ellipse, so the shader does not have to
// re-decide what "skin" means and the atlas stays small (a person mask covers the
// whole body, most of which this effect must not touch).
export const FACE_ATLAS_CELL = 128;

/** Atlas cells are 8-bit gray; the PNG carries the value in R, G and B. */
export const FACE_ATLAS_MAX_CELLS = 4096;

export interface FaceAtlasGrid {
  readonly cols: number;
  readonly rows: number;
  readonly cell: number;
  readonly width: number;
  readonly height: number;
}

/** Grid that holds `count` cells of `cell` pixels, as square as the count allows. */
export function faceAtlasGrid(count: number, cell: number = FACE_ATLAS_CELL): FaceAtlasGrid {
  const cells = Math.max(1, Math.min(FACE_ATLAS_MAX_CELLS, Math.floor(count)));
  const size = Math.max(1, Math.floor(cell));
  const cols = Math.ceil(Math.sqrt(cells));
  const rows = Math.ceil(cells / cols);
  return { cols, rows, cell: size, width: cols * size, height: rows * size };
}

/** Top-left pixel of one cell inside the atlas. */
export function faceAtlasCellOrigin(index: number, grid: FaceAtlasGrid): { x: number; y: number } {
  const safe = Math.max(0, Math.min(grid.cols * grid.rows - 1, Math.floor(index)));
  return {
    x: (safe % grid.cols) * grid.cell,
    y: Math.floor(safe / grid.cols) * grid.cell,
  };
}

/**
 * Pack cell buffers (one `cell * cell` gray buffer each) into one RGBA atlas.
 *
 * RGBA rather than a single-channel texture because WebGL2 uploads an RGB/RGBA
 * `ImageData` without an unpack alignment dance, and the PNG encoder the browser
 * gives us is RGBA anyway. Alpha is opaque: this image is data, not a picture to
 * composite.
 */
export function packFaceAtlas(
  cells: readonly Uint8Array[],
  grid: FaceAtlasGrid,
): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(grid.width * grid.height * 4);
  for (let index = 0; index < cells.length; index += 1) {
    const source = cells[index]!;
    const origin = faceAtlasCellOrigin(index, grid);
    for (let y = 0; y < grid.cell; y += 1) {
      const sourceRow = y * grid.cell;
      const targetRow = ((origin.y + y) * grid.width + origin.x) * 4;
      for (let x = 0; x < grid.cell; x += 1) {
        const value = source[sourceRow + x] ?? 0;
        const at = targetRow + x * 4;
        rgba[at] = value;
        rgba[at + 1] = value;
        rgba[at + 2] = value;
        rgba[at + 3] = 255;
      }
    }
  }
  return rgba;
}

/** Read one cell back out of a packed atlas (the round-trip a verify proves). */
export function unpackFaceAtlasCell(
  rgba: Uint8ClampedArray,
  width: number,
  grid: FaceAtlasGrid,
  index: number,
): Uint8Array {
  const origin = faceAtlasCellOrigin(index, grid);
  const cell = new Uint8Array(grid.cell * grid.cell);
  for (let y = 0; y < grid.cell; y += 1) {
    const row = ((origin.y + y) * width + origin.x) * 4;
    for (let x = 0; x < grid.cell; x += 1) cell[y * grid.cell + x] = rgba[row + x * 4] ?? 0;
  }
  return cell;
}

/**
 * Build one cell's skin mask from the segmenter's person mask.
 *
 * `person` is the model's own mask (any resolution, row-major, 0..255 person
 * confidence). The cell covers the face box exactly, so a pixel of the cell maps to
 * the same point of the frame the box describes; the ellipse weight trims the
 * person mask down to the face and its immediate surroundings, with a soft edge so
 * the shader's mix has something to feather.
 */
export function skinMaskCell(input: {
  readonly person: Uint8Array;
  readonly personWidth: number;
  readonly personHeight: number;
  readonly box: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  readonly cell: number;
  /** Ellipse radius as a fraction of the box half-extent; >1 reaches the neck. */
  readonly radius?: number;
  /** Feather width of the ellipse edge, in normalized box units. */
  readonly feather?: number;
}): Uint8Array {
  const { person, personWidth, personHeight, box, cell } = input;
  const radius = input.radius ?? 1.05;
  const feather = Math.max(0.02, input.feather ?? 0.35);
  const out = new Uint8Array(cell * cell);
  if (personWidth <= 0 || personHeight <= 0 || box.w <= 0 || box.h <= 0) return out;
  for (let y = 0; y < cell; y += 1) {
    // Cell pixel -> frame point (the cell covers the box).
    const fy = box.y + ((y + 0.5) / cell) * box.h;
    const ny = ((y + 0.5) / cell) * 2 - 1;
    for (let x = 0; x < cell; x += 1) {
      const fx = box.x + ((x + 0.5) / cell) * box.w;
      const nx = ((x + 0.5) / cell) * 2 - 1;
      const distance = Math.sqrt(nx * nx + ny * ny) / radius;
      const ellipse = 1 - smoothstep(1 - feather, 1, distance);
      if (ellipse <= 0) continue;
      const px = Math.min(personWidth - 1, Math.max(0, Math.floor(fx * personWidth)));
      const py = Math.min(personHeight - 1, Math.max(0, Math.floor(fy * personHeight)));
      const personValue = (person[py * personWidth + px] ?? 0) / 255;
      out[y * cell + x] = Math.round(Math.min(1, personValue * ellipse) * 255);
    }
  }
  return out;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge1 <= edge0) return value < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
