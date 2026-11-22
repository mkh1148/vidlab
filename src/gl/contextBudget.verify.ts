// P5 · the WebGL context budget, and the proof that mounting the inspector preview
// over and over does not leak one.
//
// The kit names this as D4's trap: "effects exhaust WebGL contexts". A browser keeps
// a handful of live contexts per page and silently drops the OLDEST when a page asks
// for more, so a leak does not throw — it turns an earlier canvas black and never
// recovers. Counting is therefore the only honest test, and it has to count the real
// code path: `createGlRuntime` (one context), the runtime slot (one per mount, reused
// for every frame), and `dispose` (every GL object released).
//
// The GL context here is a recording mock, because Node has no WebGL. That is a
// limitation and it is stated: this suite proves the BOOKKEEPING and the release
// contract; the real-context evidence is the headless-Chrome exit test, which counts
// the same counters through the browser's own `getContext`.
//
// What is pinned:
//   1. the budget is a declared number, not a hope, and the peak is observable;
//   2. one mount = one context, however many frames it draws (a frame must never
//      create a context);
//   3. mount/unmount repeated N times returns the live count to zero every time and
//      never exceeds the budget;
//   4. dispose releases every texture, buffer, program and framebuffer it created —
//      including the atlas texture and the dummy LUT — and is idempotent;
//   5. the budget check has teeth: ten un-disposed runtimes are caught, then released.
import assert from 'node:assert/strict';
import { __resetFxImages, ensureFxImage } from './fx/imageCache.js';
import {
  GL_CONTEXT_BUDGET,
  activeGlRuntimeCount,
  createGlRuntime,
  peakGlRuntimeCount,
  resetGlRuntimePeak,
} from './runtime.js';
import { disposeRuntimeSlot, ensureRuntimeSlot, type RuntimeSlot } from './runtimeSlot.js';
import type { GlRuntime } from './runtimeTypes.js';

const GL = {
  TEXTURE_2D: 0x0de1, TEXTURE_3D: 0x806f, CLAMP_TO_EDGE: 0x812f, LINEAR: 0x2601,
  RGBA: 0x1908, UNSIGNED_BYTE: 0x1401, ARRAY_BUFFER: 0x8892, STATIC_DRAW: 0x88e4,
  FLOAT: 0x1406, VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30,
  COMPILE_STATUS: 0x8b81, LINK_STATUS: 0x8b82,
  UNPACK_FLIP_Y_WEBGL: 0x9240, UNPACK_COLORSPACE_CONVERSION_WEBGL: 0x9243, NONE: 0,
  UNPACK_ALIGNMENT: 0x0cf5, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
  RGB32F: 0x8815, RGB8: 0x8051, RGB: 0x1907,
  TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800,
  TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803, TEXTURE_WRAP_R: 0x8072,
  TEXTURE0: 0x84c0, COLOR_BUFFER_BIT: 0x4000, TRIANGLE_STRIP: 5,
  FRAMEBUFFER: 0x8d40, COLOR_ATTACHMENT0: 0x8ce0,
} as const;

interface Live {
  textures: Set<object>;
  buffers: Set<object>;
  programs: Set<object>;
  framebuffers: Set<object>;
  shaders: Set<object>;
  createdTextures: number;
  createdFramebuffers: number;
  draws: number;
  lost: boolean;
}

/** A recording WebGL2 context: every create/delete pair is counted, nothing is drawn. */
function recordingGl() {
  const live: Live = {
    textures: new Set(), buffers: new Set(), programs: new Set(), framebuffers: new Set(),
    shaders: new Set(), createdTextures: 0, createdFramebuffers: 0, draws: 0, lost: false,
  };
  const track = (set: Set<object>) => {
    const handle = { kind: set };
    set.add(handle);
    return handle;
  };
  const gl = {
    ...GL,
    ...live,
    createTexture: () => { live.createdTextures += 1; return track(live.textures); },
    deleteTexture: (t: object) => { live.textures.delete(t); },
    createBuffer: () => track(live.buffers),
    deleteBuffer: (b: object) => { live.buffers.delete(b); },
    createProgram: () => track(live.programs),
    deleteProgram: (p: object) => { live.programs.delete(p); },
    createFramebuffer: () => { live.createdFramebuffers += 1; return track(live.framebuffers); },
    deleteFramebuffer: (f: object) => { live.framebuffers.delete(f); },
    createShader: () => track(live.shaders),
    deleteShader: (s: object) => { live.shaders.delete(s); },
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getShaderInfoLog: () => '',
    getProgramInfoLog: () => '',
    getAttribLocation: () => 0,
    getUniformLocation: (_p: object, name: string) => ({ name }),
    getExtension: () => null,
    isContextLost: () => live.lost,
    drawArrays: () => { live.draws += 1; },
    bindBuffer() {}, bufferData() {}, bindTexture() {}, texParameteri() {},
    shaderSource() {}, compileShader() {}, attachShader() {}, linkProgram() {},
    enableVertexAttribArray() {}, vertexAttribPointer() {}, activeTexture() {},
    pixelStorei() {}, texImage2D() {}, texImage3D() {}, uniform1f() {}, uniform2f() {},
    uniform3f() {}, uniform4f() {}, uniform1i() {}, framebufferTexture2D() {},
    bindFramebuffer() {}, viewport() {}, useProgram() {}, clearColor() {}, clear() {},
  };
  return { gl, live };
}

/** A canvas whose `getContext` counts how many times a context was asked for. */
function recordingCanvas(width = 320, height = 180) {
  const { gl, live } = recordingGl();
  const canvas = {
    width,
    height,
    contextRequests: 0,
    getContext(kind: string) {
      assert.equal(kind, 'webgl2', 'the runtime must ask for webgl2');
      canvas.contextRequests += 1;
      return gl;
    },
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, live, state: canvas };
}

const FRAG = 'void main() { gl_FragColor = vec4(1.0); }';

function assertReleased(live: Live, label: string) {
  assert.equal(live.textures.size, 0, `${label}: every texture is deleted`);
  assert.equal(live.buffers.size, 0, `${label}: the quad buffer is deleted`);
  assert.equal(live.programs.size, 0, `${label}: every program is deleted`);
  assert.equal(live.framebuffers.size, 0, `${label}: every framebuffer is deleted`);
  assert.equal(live.shaders.size, 0, `${label}: every shader is deleted`);
}

// ── 1. the budget is declared and observable ────────────────────────────────
assert.equal(GL_CONTEXT_BUDGET, 4, 'the budget covers preview, transition and the two thumbnail pools');
assert.equal(activeGlRuntimeCount(), 0, 'no runtime is live before the first mount');
resetGlRuntimePeak();
assert.equal(peakGlRuntimeCount(), 0);

// ── 2. one mount is one context, however many frames ────────────────────────
{
  const { canvas, live, state } = recordingCanvas();
  const slot: RuntimeSlot<GlRuntime> = { current: null };
  const runtime = ensureRuntimeSlot(slot, () => createGlRuntime(canvas));
  assert.equal(state.contextRequests, 1, 'the first mount asks for exactly one context');
  assert.equal(activeGlRuntimeCount(), 1);
  for (let frame = 0; frame < 15; frame += 1) {
    // Two passes, so the ping-pong framebuffer is part of what has to be released.
    runtime.renderFxChain([
      { frag: FRAG, uniforms: { u_smoothness: frame / 15 } },
      { frag: FRAG, uniforms: { u_even_tone: frame / 15 } },
    ], {} as TexImageSource);
  }
  assert.equal(state.contextRequests, 1, 'thirty frames reuse the one context — a frame never creates one');
  assert.equal(live.draws, 30, 'every pass of every frame drew');
  assert.equal(ensureRuntimeSlot(slot, () => createGlRuntime(canvas)), runtime, 'the slot hands back the same runtime');
  disposeRuntimeSlot(slot);
  assert.equal(activeGlRuntimeCount(), 0, 'unmount returns the live count to zero');
  assertReleased(live, 'after one mount/unmount');
  assert.equal(live.createdTextures > 0, true, 'the runtime really did allocate textures');
  assert.equal(live.createdFramebuffers > 0, true, 'and framebuffers (the FX chain ping-pong)');
}

// ── 3. repeated mount/unmount never leaks and never exceeds the budget ──────
{
  resetGlRuntimePeak();
  const cycles = 40;
  let contexts = 0;
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    const { canvas, live, state } = recordingCanvas();
    const slot: RuntimeSlot<GlRuntime> = { current: null };
    const runtime = ensureRuntimeSlot(slot, () => createGlRuntime(canvas));
    runtime.renderFxChain([{ frag: FRAG }], {} as TexImageSource);
    disposeRuntimeSlot(slot);
    contexts += state.contextRequests;
    assert.equal(activeGlRuntimeCount(), 0, `cycle ${cycle}: nothing is left live`);
    assertReleased(live, `cycle ${cycle}`);
    assert.ok(peakGlRuntimeCount() <= GL_CONTEXT_BUDGET,
      `cycle ${cycle}: peak ${peakGlRuntimeCount()} must stay within the budget ${GL_CONTEXT_BUDGET}`);
  }
  assert.equal(contexts, cycles, 'one context per mount, and every one of them was released');
  assert.equal(activeGlRuntimeCount(), 0, `${cycles} mount/unmount cycles leak nothing`);
  assert.equal(peakGlRuntimeCount(), 1, 'the peak of a serial mount/unmount loop is one context');
}

// ── 4. dispose is idempotent and a disposed runtime cannot draw ─────────────
{
  const { canvas, live } = recordingCanvas();
  const runtime = createGlRuntime(canvas);
  runtime.renderFxChain([{ frag: FRAG }], {} as TexImageSource);
  const texturesBefore = live.createdTextures;
  runtime.dispose();
  runtime.dispose();
  assert.equal(activeGlRuntimeCount(), 0, 'a second dispose does not decrement below zero');
  assertReleased(live, 'double dispose');
  assert.equal(live.createdTextures, texturesBefore, 'double dispose deletes nothing twice');
  assert.throws(() => runtime.renderFxChain([{ frag: FRAG }], {} as TexImageSource),
    /WebGL context lost/, 'a disposed runtime refuses to draw');
  const slot: RuntimeSlot<GlRuntime> = { current: null };
  disposeRuntimeSlot(slot);
  assert.equal(activeGlRuntimeCount(), 0, 'disposing an empty slot is a no-op');
}

// ── 5. the atlas texture is uploaded once per URL and released with the runtime ──
{
  __resetFxImages();
  class FakeImage {
    decoding = '';
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_value: string) { queueMicrotask(() => this.onload?.()); }
  }
  const previousImage = (globalThis as { Image?: unknown }).Image;
  (globalThis as { Image?: unknown }).Image = FakeImage;
  try {
    const atlasUrl = '/media/derived/talking-head-1a2b3c4d/atlas.png';
    await ensureFxImage(atlasUrl);
    const { canvas, live } = recordingCanvas();
    const runtime = createGlRuntime(canvas);
    const pass = { frag: FRAG, images: { u_face_atlas: atlasUrl } };
    runtime.renderFxChain([pass], {} as TexImageSource);
    const afterFirst = live.createdTextures;
    runtime.renderFxChain([pass], {} as TexImageSource);
    assert.equal(live.createdTextures, afterFirst,
      'the atlas is uploaded once per URL, not once per frame — a re-upload every frame would cost more than the effect');
    runtime.dispose();
    assertReleased(live, 'atlas texture');
  } finally {
    (globalThis as { Image?: unknown }).Image = previousImage;
    __resetFxImages();
  }
}

// ── 6. the budget check has teeth ───────────────────────────────────────────
{
  resetGlRuntimePeak();
  const runtimes: GlRuntime[] = [];
  for (let index = 0; index < 10; index += 1) {
    const { canvas } = recordingCanvas();
    runtimes.push(createGlRuntime(canvas));
  }
  assert.equal(activeGlRuntimeCount(), 10);
  assert.ok(peakGlRuntimeCount() > GL_CONTEXT_BUDGET,
    'ten un-disposed runtimes are caught by the budget — the assertion is not vacuous');
  for (const runtime of runtimes) runtime.dispose();
  assert.equal(activeGlRuntimeCount(), 0);
  resetGlRuntimePeak();
  assert.equal(peakGlRuntimeCount(), 0, 'and the peak resets for the next measurement');
}

console.log(`contextBudget.verify: budget ${GL_CONTEXT_BUDGET}, 40 mount/unmount cycles, zero leaked contexts, every GL object released`);
