// D4 · the landmark track: what "Analyze face" stores, and how one frame finds it.
//
// The kit's rule is "a compact landmark track keyed by source frame, so trims keep
// lining up". That single sentence decides the whole shape here:
//
//   * `samples[].f` is a SOURCE frame index, never a clip-local or timeline frame.
//     A trim only changes which source frame a timeline frame shows, so the lookup
//     is `boxAtSourceFrame(track, sourceFrameAt(item, timelineFrame))` and a trim
//     cannot shift the face off the mask.
//   * samples are taken at FACE_ANALYSIS_FPS, not at the source frame rate. A
//     13 s clip at 30 fps is 65 samples instead of 390, and the box between two
//     samples is interpolated at render time — the track stays small without the
//     mask drifting during a head turn.
//   * the box is quantized to FACE_BOX_DECIMALS so two runs of the same model on
//     the same file produce the same bytes (a cache keyed by content stays a hit).
//
// The atlas grid lives in the track on purpose: cell i belongs to samples[i], so
// "aligned to the landmarks" is one array index rather than a second file that can
// disagree with the first.
export const FACE_TRACK_VERSION = 1;

/** Samples per second of SOURCE time. 5 Hz tracks a talking head without a jitter. */
export const FACE_ANALYSIS_FPS = 5;

/** Guard against a pathological probe (a 3 h clip at 5 Hz is 54 000 samples). */
export const FACE_TRACK_MAX_SAMPLES = 20_000;

/** Decimals kept for a normalized box coordinate (0.0001 of a frame edge). */
export const FACE_BOX_DECIMALS = 4;

/** One face box, normalized to the frame, top-left origin. */
export interface FaceBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface FaceSample {
  /** SOURCE frame index this sample was measured on. */
  readonly f: number;
  readonly box: FaceBox;
  /** Detector confidence 0..1; 0 means "no face in this frame". */
  readonly c: number;
}

export interface FaceTrack {
  readonly version: number;
  /** Frame rate of the SOURCE file, so a frame index can be re-derived from time. */
  readonly sourceFps: number;
  /** Frame count of the SOURCE file. */
  readonly sourceFrames: number;
  readonly analysisFps: number;
  /** Atlas grid: `cols * rows` cells of `cell` pixels, cell index == sample index. */
  readonly cols: number;
  readonly rows: number;
  readonly cell: number;
  readonly samples: readonly FaceSample[];
}

/** Round a normalized coordinate to the track's precision. */
export function quantizeFaceBox(box: FaceBox): FaceBox {
  const q = (value: number): number => {
    const factor = 10 ** FACE_BOX_DECIMALS;
    return Math.round(value * factor) / factor;
  };
  return { x: q(box.x), y: q(box.y), w: q(box.w), h: q(box.h) };
}

/** Clamp a box into the frame and drop degenerate ones. */
export function clampFaceBox(box: FaceBox): FaceBox | null {
  const x = Math.min(1, Math.max(0, box.x));
  const y = Math.min(1, Math.max(0, box.y));
  const w = Math.min(1 - x, Math.max(0, box.w));
  const h = Math.min(1 - y, Math.max(0, box.h));
  if (w <= 0 || h <= 0) return null;
  return quantizeFaceBox({ x, y, w, h });
}

/**
 * The box at one SOURCE frame.
 *
 * Between two samples the box is interpolated linearly (a head moving across the
 * frame gets one continuous box instead of a 5 Hz stair-step); outside the sampled
 * range the nearest sample wins, so a clip trimmed past the last sample still has
 * a face region rather than none.
 */
export function boxAtSourceFrame(track: FaceTrack, sourceFrame: number): FaceBox | null {
  const samples = track.samples;
  if (samples.length === 0) return null;
  const frame = Number.isFinite(sourceFrame) ? sourceFrame : 0;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  if (frame <= first.f) return first.box;
  if (frame >= last.f) return last.box;
  // Samples are stored in ascending frame order (validated on load), so a binary
  // search is exact and cheap enough to run once per rendered frame.
  let low = 0;
  let high = samples.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (samples[middle]!.f <= frame) low = middle;
    else high = middle;
  }
  const left = samples[low]!;
  const right = samples[high]!;
  const span = right.f - left.f;
  if (span <= 0) return left.box;
  const t = (frame - left.f) / span;
  return {
    x: left.box.x + (right.box.x - left.box.x) * t,
    y: left.box.y + (right.box.y - left.box.y) * t,
    w: left.box.w + (right.box.w - left.box.w) * t,
    h: left.box.h + (right.box.h - left.box.h) * t,
  };
}

/** Index of the sample whose atlas cell covers this source frame (nearest, ties low). */
export function atlasCellAtSourceFrame(track: FaceTrack, sourceFrame: number): number {
  const samples = track.samples;
  if (samples.length === 0) return -1;
  const frame = Number.isFinite(sourceFrame) ? sourceFrame : 0;
  let best = 0;
  let bestDistance = Math.abs(samples[0]!.f - frame);
  for (let index = 1; index < samples.length; index += 1) {
    const distance = Math.abs(samples[index]!.f - frame);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}

/** Sample index whose frame is the first at or after `frame`; used by the analyzer. */
export function sampleFrameAt(index: number, analysisFps: number, sourceFps: number): number {
  const ratio = sourceFps / Math.max(Number.EPSILON, analysisFps);
  return Math.round(index * ratio);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseBox(value: unknown): FaceBox | null {
  if (!value || typeof value !== 'object') return null;
  const box = value as Record<string, unknown>;
  if (!isFiniteNumber(box.x) || !isFiniteNumber(box.y) || !isFiniteNumber(box.w) || !isFiniteNumber(box.h)) {
    return null;
  }
  if (box.w <= 0 || box.h <= 0) return null;
  return { x: box.x, y: box.y, w: box.w, h: box.h };
}

/**
 * Parse a track read back from disk.
 *
 * A track is a cache artifact, not user data: an unreadable or future-version one
 * is rejected so the caller re-runs the analysis instead of rendering with a mask
 * that does not match the clip.
 */
export function parseFaceTrack(value: unknown): FaceTrack | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== FACE_TRACK_VERSION) return null;
  if (!isFiniteNumber(raw.sourceFps) || raw.sourceFps <= 0) return null;
  if (!isFiniteNumber(raw.sourceFrames) || raw.sourceFrames <= 0) return null;
  if (!isFiniteNumber(raw.analysisFps) || raw.analysisFps <= 0) return null;
  if (!isFiniteNumber(raw.cols) || raw.cols <= 0) return null;
  if (!isFiniteNumber(raw.rows) || raw.rows <= 0) return null;
  if (!isFiniteNumber(raw.cell) || raw.cell <= 0) return null;
  if (!Array.isArray(raw.samples) || raw.samples.length === 0) return null;
  if (raw.samples.length > FACE_TRACK_MAX_SAMPLES) return null;
  const samples: FaceSample[] = [];
  let previousFrame = -1;
  for (const entry of raw.samples) {
    if (!entry || typeof entry !== 'object') return null;
    const sample = entry as Record<string, unknown>;
    if (!isFiniteNumber(sample.f) || sample.f < 0 || sample.f <= previousFrame) return null;
    const box = parseBox(sample.box);
    if (!box) return null;
    const confidence = isFiniteNumber(sample.c) ? Math.min(1, Math.max(0, sample.c)) : 1;
    previousFrame = sample.f;
    samples.push({ f: sample.f, box, c: confidence });
  }
  return {
    version: FACE_TRACK_VERSION,
    sourceFps: raw.sourceFps,
    sourceFrames: raw.sourceFrames,
    analysisFps: raw.analysisFps,
    cols: raw.cols,
    rows: raw.rows,
    cell: raw.cell,
    samples,
  };
}

/** Bytes a serialized track occupies, for the inspector's "track size" line. */
export function faceTrackBytes(track: FaceTrack): number {
  return new TextEncoder().encode(JSON.stringify(track)).length;
}
