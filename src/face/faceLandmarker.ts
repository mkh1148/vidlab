// D4 · the Face Landmarker runtime, loaded lazily in the renderer.
//
// Why here and not in a media-job child: `@mediapipe/tasks-vision` needs a DOM
// canvas. Under Node 24 the import and the FilesetResolver resolve, and then
// `FaceLandmarker.createFromOptions` throws `ReferenceError: document is not
// defined` — measured, not assumed (docs/d-job-implementation.md §D4 records the
// probe). The alternative is a native canvas dependency, which is exactly the P9
// trap the mandate warned about, so the inference runs where the browser already
// runs it for reframe geometry.
//
// Shape is deliberately the same as src/geometry/mediapipe.ts: one lazy module
// import, CPU delegate only (the base measured that the WebGL delegate initialises
// and then returns empty masks), abortable, best-effort close, and a verification
// seam so the analyze pass can be driven without a real model in a test.
import type { FaceLandmarker, ImageSegmenter } from '@mediapipe/tasks-vision';
import type { FaceBox } from './faceTrack.ts';

/** Long edge of the inference input, matching the geometry pass's 512 px budget. */
export const FACE_INFERENCE_EDGE = 512;

/** The landmark model is served by the app from the data-dir model cache (I5). */
export const FACE_MODEL_ROUTE = '/api/media-job/face-model';

/** The person mask comes from the model the base already provisions. */
export const FACE_SEGMENTER_MODEL = '/mediapipe/selfie_segmenter.tflite';

const WASM_PATH = '/mediapipe/wasm';

/** Confidence above which a pixel counts as person (the geometry pass's threshold). */
export const FACE_PERSON_THRESHOLD = 0.4;

export interface FaceFrameInference {
  /** Landmark-derived face box, normalized; null when no face was found. */
  readonly box: FaceBox | null;
  /** Person confidence mask at the model's own resolution, 0..255. */
  readonly person: Uint8Array;
  readonly personWidth: number;
  readonly personHeight: number;
  /** Landmarker presence score 0..1. */
  readonly confidence: number;
}

export interface FaceRuntime {
  infer: (canvas: HTMLCanvasElement) => FaceFrameInference;
  close: () => void;
}

export type FaceRuntimeLoader = (signal: AbortSignal) => Promise<FaceRuntime | null>;

function closeTask(task: { close: () => void } | null): void {
  try {
    task?.close();
  } catch {
    // Best-effort release for an optional analysis runtime.
  }
}

async function loadRuntime(signal: AbortSignal): Promise<FaceRuntime | null> {
  const { FaceLandmarker, FilesetResolver, ImageSegmenter } = await import('@mediapipe/tasks-vision');
  if (signal.aborted) return null;
  let landmarker: FaceLandmarker | null = null;
  let segmenter: ImageSegmenter | null = null;
  const closeResources = (): void => {
    const activeLandmarker = landmarker;
    const activeSegmenter = segmenter;
    landmarker = null;
    segmenter = null;
    closeTask(activeLandmarker);
    closeTask(activeSegmenter);
  };
  signal.addEventListener('abort', closeResources, { once: true });
  try {
    const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
    signal.throwIfAborted();
    landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: FACE_MODEL_ROUTE, delegate: 'CPU' },
      runningMode: 'IMAGE',
      numFaces: 1,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
    });
    signal.throwIfAborted();
    segmenter = await ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: FACE_SEGMENTER_MODEL, delegate: 'CPU' },
      runningMode: 'IMAGE',
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    });
    signal.throwIfAborted();
    const activeLandmarker = landmarker;
    const activeSegmenter = segmenter;
    signal.removeEventListener('abort', closeResources);
    return {
      infer: (canvas) => inferFrame(activeLandmarker, activeSegmenter, canvas),
      close: () => {
        closeTask(activeLandmarker);
        closeTask(activeSegmenter);
      },
    };
  } catch (error) {
    signal.removeEventListener('abort', closeResources);
    closeResources();
    if (signal.aborted) return null;
    console.warn('[face] MediaPipe runtime failed to load:', error);
    return null;
  }
}

interface RuntimeState {
  promise: Promise<FaceRuntime | null>;
  controller: AbortController;
  runtime: FaceRuntime | null;
  settled: boolean;
  waiters: number;
}

let runtimeState: RuntimeState | null = null;
let runtimeLoader: FaceRuntimeLoader = loadRuntime;

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

function releaseWaiter(state: RuntimeState): void {
  state.waiters = Math.max(0, state.waiters - 1);
  if (!state.settled && state.waiters === 0 && runtimeState === state) {
    runtimeState = null;
    state.controller.abort();
  }
}

function startRuntimeLoad(): RuntimeState {
  const loader = runtimeLoader;
  const controller = new AbortController();
  const state: RuntimeState = {
    promise: Promise.resolve(null),
    controller,
    runtime: null,
    settled: false,
    waiters: 0,
  };
  runtimeState = state;
  state.promise = Promise.resolve()
    .then(() => loader(controller.signal))
    .catch(() => null)
    .then((runtime) => {
      state.settled = true;
      if (runtimeState !== state) {
        runtime?.close();
        return null;
      }
      if (runtime) state.runtime = runtime;
      else runtimeState = null;
      return runtime;
    });
  return state;
}

function waitForRuntime(state: RuntimeState, signal?: AbortSignal): Promise<FaceRuntime | null> {
  state.waiters += 1;
  if (!signal) return state.promise.finally(() => releaseWaiter(state));
  return new Promise<FaceRuntime | null>((resolve, reject) => {
    let done = false;
    const finish = (callback: () => void): void => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(abortReason(signal)));
    signal.addEventListener('abort', onAbort, { once: true });
    state.promise.then(
      (runtime) => finish(() => resolve(runtime)),
      (error) => finish(() => reject(error)),
    );
  }).finally(() => releaseWaiter(state));
}

/** Load or reuse the face runtime; an aborted in-flight load is retired and may be retried. */
export function getFaceRuntime(signal?: AbortSignal): Promise<FaceRuntime | null> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return waitForRuntime(runtimeState ?? startRuntimeLoad(), signal);
}

/** Debug/verify hook: closes or retires the current runtime. */
export function __resetFaceRuntime(): void {
  const state = runtimeState;
  runtimeState = null;
  if (state && !state.settled) state.controller.abort();
  state?.runtime?.close();
}

/** Deterministic verifier seam; null restores the production lazy loader. */
export function __setFaceRuntimeLoaderForVerification(loader: FaceRuntimeLoader | null): void {
  __resetFaceRuntime();
  runtimeLoader = loader ?? loadRuntime;
}

function inferFrame(
  landmarker: FaceLandmarker,
  segmenter: ImageSegmenter,
  canvas: HTMLCanvasElement,
): FaceFrameInference {
  let box: FaceBox | null = null;
  let confidence = 0;
  try {
    const result = landmarker.detect(canvas);
    const landmarks = result.faceLandmarks?.[0];
    if (landmarks && landmarks.length > 0) {
      // The box is the landmark cloud's own extent, not a detector's guess: the kit
      // asks for geometry from the Face Landmarker, and the extent is what the mask
      // cell and the fallback ellipse both need.
      let minX = 1;
      let minY = 1;
      let maxX = 0;
      let maxY = 0;
      for (const point of landmarks) {
        if (point.x < minX) minX = point.x;
        if (point.y < minY) minY = point.y;
        if (point.x > maxX) maxX = point.x;
        if (point.y > maxY) maxY = point.y;
      }
      if (maxX > minX && maxY > minY) {
        box = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
        confidence = 1;
      }
    }
  } catch {
    // No face in this frame is a normal outcome, not a failure.
  }

  let person = new Uint8Array(0);
  let personWidth = 0;
  let personHeight = 0;
  try {
    const result = segmenter.segment(canvas);
    try {
      const mask = result.confidenceMasks?.[0];
      if (mask) {
        const values = mask.getAsFloat32Array();
        personWidth = mask.width;
        personHeight = mask.height;
        person = new Uint8Array(values.length);
        for (let index = 0; index < values.length; index += 1) {
          const value = values[index] ?? 0;
          person[index] = value > FACE_PERSON_THRESHOLD ? 255 : Math.round(Math.min(1, Math.max(0, value)) * 255);
        }
      }
    } finally {
      result.confidenceMasks?.forEach((mask) => mask.close());
      result.categoryMask?.close();
      result.close();
    }
  } catch {
    // An empty mask degrades to "no skin", which the shader then treats as a
    // landmark-only region for that sample.
  }
  return { box, person, personWidth, personHeight, confidence };
}
