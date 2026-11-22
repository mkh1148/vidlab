import { availableParallelism, freemem } from 'node:os';

const MAX_RENDER_CONCURRENCY = 24;
const GIB = 1024 ** 3;
/** Budgeted working set of one headless render tab, measured on this project's
 *  reference machine while rendering 720p/1080p timelines. */
const RENDER_TAB_BUDGET_BYTES = 1.25 * GIB;

function cpuCount(value) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function configuredConcurrency(value, cores) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  const percent = raw.match(/^(\d+(?:\.\d+)?)%$/);
  if (percent) {
    const ratio = Math.min(100, Math.max(1, Number(percent[1]))) / 100;
    return Math.max(1, Math.min(cores, Math.floor(cores * ratio)));
  }
  if (/^\d+$/.test(raw)) return Math.max(1, Math.min(cores, Number(raw)));
  return null;
}

/**
 * Use most of the CPU during export while leaving one or two logical cores for
 * Electron and the OS, and never budget more render tabs than the machine can
 * hold *right now*.
 *
 * The memory side used to derive from total RAM (`0.5 × totalmem`), which on a
 * 15.9 GB machine allowed six tabs while the editor, Chrome and the desktop
 * already held most of it: the first render then died with
 * `Compositor exited with code 3221226505` (`0xC0000409`, a failed allocation).
 * Free memory is what the renderer can actually take, so that is what the
 * budget is computed from. `OPENCHATCUT_RENDER_CONCURRENCY` still wins outright
 * for a deliberate override.
 */
export function resolveRenderConcurrency({
  cores = availableParallelism(),
  freeMemoryBytes = freemem(),
  override = process.env.OPENCHATCUT_RENDER_CONCURRENCY,
} = {}) {
  const count = cpuCount(cores);
  const configured = configuredConcurrency(override, count);
  if (configured !== null) return configured;
  if (count <= 2) return 1;
  const cpuTarget = Math.round(count * 0.8);
  // Half of the *free* memory is reserved for the browser the renderer drives,
  // the encoder child process and the OS page cache; the rest buys tabs.
  const free = Number(freeMemoryBytes);
  const budgetable = Number.isFinite(free) && free > 0 ? free : 0;
  const memoryTarget = Math.max(1, Math.floor((budgetable * 0.5) / RENDER_TAB_BUDGET_BYTES));
  return Math.max(1, Math.min(MAX_RENDER_CONCURRENCY, cpuTarget, memoryTarget));
}

/** OffthreadVideo is memory-heavy; scale it more conservatively than pages. */
export function resolveOffthreadVideoThreads({ cores = availableParallelism() } = {}) {
  const count = cpuCount(cores);
  if (count <= 2) return 1;
  return Math.max(2, Math.min(4, Math.ceil(count / 4)));
}

/**
 * Remotion natively maps H.264 to VideoToolbox on macOS and NVENC on Windows
 * and Linux. Other probed engines are selected through a narrow FFmpeg override.
 */
export function remotionHardwareAcceleration(codec, {
  platform = process.platform,
  disabled = /^(?:1|true|yes)$/i.test(process.env.OPENCHATCUT_DISABLE_HARDWARE_ENCODING ?? ''),
  encoder,
} = {}) {
  if (disabled || codec !== 'h264' || encoder === 'libx264') return 'disable';
  if (encoder === 'h264_videotoolbox') return platform === 'darwin' ? 'required' : 'disable';
  if (encoder === 'h264_nvenc') {
    return platform === 'win32' || platform === 'linux' ? 'required' : 'disable';
  }
  if (encoder) return 'disable';
  return platform === 'darwin' || platform === 'win32' || platform === 'linux'
    ? 'required'
    : 'disable';
}

/** Stable, high-quality H.264 bitrate scaled by output pixels and frame rate. */
export function resolveH264VideoBitrate({ width, height, fps, scale = 1 } = {}) {
  const outputWidth = Math.max(2, Number(width) * Number(scale));
  const outputHeight = Math.max(2, Number(height) * Number(scale));
  const frameRate = Math.max(1, Number(fps));
  const raw = Number.isFinite(outputWidth * outputHeight * frameRate)
    ? outputWidth * outputHeight * frameRate * 0.16
    : 10_000_000;
  // Keep Auto aligned with the export UI and server FPS-retiming policy.
  const clamped = Math.max(4_000_000, Math.min(60_000_000, raw));
  return `${Math.ceil(clamped / 500_000) * 500}k`;
}

/**
 * Hardware H.264 encoders cap each frame dimension well below what the codec
 * itself allows: H.264 Level 6.2 permits ~16k pixels wide, but NVENC, Quick
 * Sync, AMF and VideoToolbox all stop at 4096. Verified on this project's
 * reference machine — `h264_nvenc` encodes 3840x2160 fine and fails 5808x2160
 * with "No capable devices found", writing a zero-byte file.
 *
 * 5808x2160 is not exotic: it is what a 2.69:1 scope timeline becomes when the
 * "4k" preset scales the SHORT side to 2160. Such a project could not export
 * H.264 at all — the server render failed on the GPU limit, fell back to the
 * browser, and WebCodecs hit the same GPU.
 *
 * A dimension this large therefore selects software encoding up front instead
 * of discovering the failure mid-render. HEVC has no such problem (NVENC
 * handles 7680x2160), so an H.265 route would keep hardware speed here.
 */
export const H264_HARDWARE_MAX_DIMENSION = 4096;

/** Whether a hardware H.264 encoder can encode this frame size at all. */
export function h264HardwareSupportsDimensions(width, height, {
  max = H264_HARDWARE_MAX_DIMENSION,
} = {}) {
  const w = Math.ceil(Number(width));
  const h = Math.ceil(Number(height));
  // An unknown size must not silently disable hardware: only a size we can
  // read AND that exceeds the cap rules it out.
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return true;
  return w <= max && h <= max;
}

/** Runtime device/driver failure that an encoder-list probe cannot detect. */
export function isHardwareEncoderFailure(error) {
  const message = error instanceof Error
    ? `${error.message}\n${error.cause instanceof Error ? error.cause.message : String(error.cause ?? '')}`
    : String(error ?? '');
  return /videotoolbox|nvenc|nvcuda|libcuda|qsv|quick sync|mfx|amf|vaapi|va-api|renderD\d+|no (?:nvenc )?capable devices|no device|device setup failed|hardware encoder|hardware acceleration|failed to open encoder|could not open encoder|error while opening encoder|error initializing output stream|incorrect parameters such as|invalid (?:frame )?(?:size|dimensions)|(?:width|height) (?:is )?(?:too large|not supported)/i.test(message);
}

export function hardwareEncoderFailureClass(error) {
  const message = error instanceof Error
    ? `${error.message}\n${error.cause instanceof Error ? error.cause.message : String(error.cause ?? '')}`
    : String(error ?? '');
  if (/no (?:nvenc )?capable devices|no device|device unavailable|renderD\d+|cannot load|not available/i.test(message)) {
    return 'device-unavailable';
  }
  if (/unsupported|unknown encoder|encoder not found|not implemented/i.test(message)) {
    return 'unsupported';
  }
  if (/initializ|failed to open|could not open|device setup/i.test(message)) {
    return 'initialization-failed';
  }
  return 'runtime-failure';
}

export const SOFTWARE_H264_PROFILE = Object.freeze({
  id: 'libx264',
  label: 'Software (libx264)',
  hardware: false,
  transport: 'server',
});
const DIRECT_H264_ENCODERS = {
  h264_videotoolbox: true,
  h264_nvenc: true,
  h264_qsv: true,
  h264_amf: true,
  h264_vaapi: true,
};
const VAAPI_DEVICE_PATTERN = /^\/dev\/dri\/renderD\d+$/;

function overrideH264Args(args, encoder, vaapiDevice) {
  const next = [...args];
  const codecIndex = next.findIndex((arg, index) => arg === '-c:v' && index + 1 < next.length);
  if (codecIndex < 0 || next[codecIndex + 1] === 'copy') return next;
  next[codecIndex + 1] = encoder;
  const pixelFormat = encoder === 'h264_vaapi'
    ? 'vaapi'
    : encoder === 'h264_qsv' || encoder === 'h264_amf' ? 'nv12' : 'yuv420p';
  const pixelIndex = next.indexOf('-pix_fmt');
  if (pixelIndex >= 0 && pixelIndex + 1 < next.length) next[pixelIndex + 1] = pixelFormat;
  else next.splice(codecIndex, 0, '-pix_fmt', pixelFormat);
  if (encoder !== 'h264_vaapi') return next;

  const deviceIndex = next.indexOf('-i');
  next.splice(Math.max(0, deviceIndex), 0, '-vaapi_device', vaapiDevice);
  const filterIndex = next.indexOf('-vf');
  if (filterIndex >= 0 && filterIndex + 1 < next.length) {
    next[filterIndex + 1] = `${next[filterIndex + 1]},format=nv12,hwupload`;
  } else {
    const outputCodecIndex = next.indexOf('-c:v');
    next.splice(outputCodecIndex, 0, '-vf', 'format=nv12,hwupload');
  }
  return next;
}

/** Override only H.264 encoding steps; final copy/mux steps stay untouched. */
export function h264FfmpegOverride(encoder, {
  vaapiDevice = process.env.OPENCHATCUT_VAAPI_DEVICE,
} = {}) {
  if (!Object.hasOwn(DIRECT_H264_ENCODERS, encoder)) {
    throw new Error(`unsupported direct H.264 encoder: ${String(encoder)}`);
  }
  const rawDevice = String(vaapiDevice ?? '').trim();
  const device = VAAPI_DEVICE_PATTERN.test(rawDevice) ? rawDevice : '/dev/dri/renderD128';
  return ({ args }) => overrideH264Args(args, encoder, device);
}

/** A declared hardware attempt always reports the profile that actually completed. */
export async function withEncoderProfileFallback({
  render,
  hardwareOptions,
  softwareOptions,
  hardwareProfile,
  softwareProfile = SOFTWARE_H264_PROFILE,
  cleanup = async () => {},
  onFallback = () => {},
}) {
  try {
    return { result: await render(hardwareOptions), encoder: hardwareProfile };
  } catch (error) {
    if (!hardwareProfile.hardware || !isHardwareEncoderFailure(error)) throw error;
    const encoderFallbackReason = `${hardwareProfile.id}: ${hardwareEncoderFailureClass(error)}`;
    await cleanup();
    onFallback(error);
    const result = await render(softwareOptions);
    return { result, encoder: softwareProfile, encoderFallbackReason };
  }
}

/** Backward-compatible fallback helper for Remotion's native hardware mode. */
export async function withHardwareEncoderFallback({
  render,
  hardwareOptions,
  softwareOptions,
  cleanup = async () => {},
  onFallback = () => {},
}) {
  try {
    return await render(hardwareOptions);
  } catch (error) {
    if (hardwareOptions.hardwareAcceleration === 'disable' || !isHardwareEncoderFailure(error)) throw error;
    await cleanup();
    onFallback(error);
    return render(softwareOptions);
  }
}
