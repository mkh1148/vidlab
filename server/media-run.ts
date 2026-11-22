// One-shot FFmpeg / ffprobe calls, in one place.
//
// The base already funnels most media work through two helpers —
// `ffmpegBin()` / `ffprobeBin()` (server/media-binaries.ts, bundled binaries, no
// PATH dependency) and `spawnMediaProcess()` (server/media-process.ts, below
// normal priority) — and each call site wraps them in its own timeout. Three
// sites escaped that discipline and spawned a bare `'ffmpeg'` / `'ffprobe'`
// from PATH with no timeout, no priority and unbounded output; they now use
// this wrapper, and server/media-run.verify.ts keeps every production spawn
// site honest.
//
// This is deliberately NOT a general process library: it runs one short-lived
// media tool, kills it on a deadline, and keeps only the tail of its output.
import { ffmpegBin, ffprobeBin } from './media-binaries.ts';
import { spawnMediaProcess } from './media-process.ts';

/** A probe or a single-frame grab is worthless after this long. */
export const DEFAULT_MEDIA_TIMEOUT_MS = 30_000;
/** Enough stderr to see why ffmpeg refused, small enough to log. */
export const DEFAULT_MAX_STDERR_BYTES = 8_000;
/** ffprobe JSON for a long file is large; keep the head, not the tail. */
export const DEFAULT_MAX_STDOUT_BYTES = 4_000_000;

export interface MediaRunOptions {
  readonly timeoutMs?: number;
  readonly maxStderrBytes?: number;
  readonly maxStdoutBytes?: number;
  readonly signal?: AbortSignal;
}

export interface MediaRunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;
}

export class MediaRunError extends Error {
  readonly result: MediaRunResult;
  constructor(message: string, result: MediaRunResult) {
    super(message);
    this.name = 'MediaRunError';
    this.result = result;
  }
}

/** Append a chunk while keeping the buffer bounded (tail for stderr, head for stdout). */
function bounded(current: string, chunk: Buffer, limit: number, keep: 'head' | 'tail'): string {
  const next = current + String(chunk);
  if (next.length <= limit) return next;
  return keep === 'tail' ? next.slice(next.length - limit) : next.slice(0, limit);
}

/**
 * Run one media tool to completion, or kill it at the deadline.
 *
 * Resolves with the exit code and captured output; a non-zero exit, a timeout
 * or an abort is reported through `MediaRunError` so a caller cannot mistake a
 * dead process for an empty result.
 */
export async function runMediaTool(
  command: string,
  args: readonly string[],
  options: MediaRunOptions = {},
): Promise<MediaRunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_MEDIA_TIMEOUT_MS;
  const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
  const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
  const { signal } = options;
  signal?.throwIfAborted();

  const deferred = Promise.withResolvers<MediaRunResult>();
  const child = spawnMediaProcess(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let aborted = false;
  let settled = false;

  const settle = (result: MediaRunResult): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    deferred.resolve(result);
  };
  const kill = (): void => {
    // SIGKILL: a wedged encoder ignores SIGTERM on Windows.
    child.kill('SIGKILL');
  };
  const onAbort = (): void => {
    aborted = true;
    kill();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, Math.max(1, timeoutMs));

  child.stdout?.on('data', (chunk: Buffer) => { stdout = bounded(stdout, chunk, maxStdoutBytes, 'head'); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr = bounded(stderr, chunk, maxStderrBytes, 'tail'); });
  child.once('error', (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    deferred.reject(error);
  });
  child.once('close', (code) => settle({ code, stdout, stderr, timedOut, aborted }));
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();

  const result = await deferred.promise;
  if (result.aborted) throw signal?.reason ?? new Error(`${command} aborted`);
  if (result.timedOut) {
    throw new MediaRunError(`${command} timed out after ${Math.round(timeoutMs / 1_000)}s`, result);
  }
  if (result.code !== 0) {
    throw new MediaRunError(`${command} exited ${result.code}: ${result.stderr.slice(-500)}`, result);
  }
  return result;
}

/** Run the bundled FFmpeg. */
export function runFfmpeg(args: readonly string[], options?: MediaRunOptions): Promise<MediaRunResult> {
  return runMediaTool(ffmpegBin(), args, options);
}

/** Run the bundled ffprobe. */
export function runFfprobe(args: readonly string[], options?: MediaRunOptions): Promise<MediaRunResult> {
  return runMediaTool(ffprobeBin(), args, options);
}

/** ffprobe as JSON: the shape every probe in this repo wants. */
export async function probeJson(path: string, options: MediaRunOptions = {}): Promise<unknown> {
  const { stdout } = await runFfprobe(
    ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path],
    options,
  );
  return JSON.parse(stdout);
}
