// The ONE kill policy for heavy media jobs (D-job contract, H1).
//
// server/media-run.ts learned this on Windows: a wedged encoder ignores
// SIGTERM, so a "polite then force" pair leaves a child alive after the caller
// believes it cancelled. There is therefore exactly one policy here — SIGKILL,
// immediately, no SIGTERM first — and every D engine spawns through this
// helper so no engine can invent a second one.
//
// The `kill` hook exists for the mutation test in server/media-job.verify.ts:
// breaking the wiring has to be observable, or "cancel kills the child" is a
// claim nobody checks.
import type { ChildProcess } from 'node:child_process';
import { spawnMediaProcess } from './media-process.ts';

/** Enough stderr to see why an engine refused, small enough to log. */
const MAX_CAPTURED_CHARS = 8_000;

export interface JobProcessOptions {
  readonly signal?: AbortSignal;
  /** Hard deadline for the child; the job module sets the job-level one. */
  readonly timeoutMs?: number;
  /**
   * Working directory for the child. Needed by an engine that has to name a
   * model file inside an FFmpeg filter graph: an absolute Windows path there has
   * to survive FFmpeg's own `:`-and-quoting rules, while a bare file name plus a
   * cwd cannot be misparsed.
   */
  readonly cwd?: string;
  /** Called once per complete stdout line, for engine progress parsing. */
  readonly onStdoutLine?: (line: string) => void;
  readonly onStderrLine?: (line: string) => void;
  /** Called as soon as the child exists, so a caller can record its pid. */
  readonly onSpawn?: (pid: number | undefined) => void;
  /**
   * Injection point for the mutation test only. Production callers omit it and
   * get `killJobProcess`.
   */
  readonly kill?: (child: ChildProcess) => void;
}

export interface JobProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly aborted: boolean;
  readonly timedOut: boolean;
}

/** The single kill policy: SIGKILL, no SIGTERM first. */
export function killJobProcess(child: ChildProcess): void {
  child.kill('SIGKILL');
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('media job cancelled');
  error.name = 'AbortError';
  return error;
}

function bounded(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length <= MAX_CAPTURED_CHARS ? next : next.slice(next.length - MAX_CAPTURED_CHARS);
}

/** Feed complete lines to `onLine`, keeping the trailing partial line. */
function lineReader(onLine?: (line: string) => void): (chunk: string) => void {
  let partial = '';
  return (chunk: string) => {
    if (!onLine) return;
    partial += chunk;
    const lines = partial.split(/\r?\n/);
    partial = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) onLine(trimmed);
    }
  };
}

/**
 * Run one engine child to completion, or kill it the moment the job is
 * cancelled or the deadline passes.
 *
 * Throws when the child was killed (abort, deadline) or exited non-zero: a
 * caller must never mistake a dead engine for an empty result.
 */
export function runJobProcess(
  command: string,
  args: readonly string[],
  options: JobProcessOptions = {},
): Promise<JobProcessResult> {
  const { signal } = options;
  if (signal?.aborted) return Promise.reject(abortError(signal));
  const kill = options.kill ?? killJobProcess;
  const timeoutMs = Math.max(1, options.timeoutMs ?? 30 * 60_000);

  return new Promise<JobProcessResult>((resolve, reject) => {
    // spawnMediaProcess keeps the child at below-normal priority: a heavy job
    // must never make the editor stutter.
    const child = spawnMediaProcess(command, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
    options.onSpawn?.(child.pid);
    const readOut = lineReader(options.onStdoutLine);
    const readErr = lineReader(options.onStderrLine);
    let stdout = '';
    let stderr = '';
    let aborted = false;
    let timedOut = false;
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve({ code: child.exitCode, stdout, stderr, aborted, timedOut });
    };
    const onAbort = (): void => {
      aborted = true;
      kill(child);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill(child);
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = String(chunk);
      stdout = bounded(stdout, text);
      readOut(text);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = String(chunk);
      stderr = bounded(stderr, text);
      readErr(text);
    });
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      if (aborted) {
        finish(abortError(signal));
        return;
      }
      if (timedOut) {
        const error = new Error(`media job process timed out after ${Math.round(timeoutMs / 1_000)}s`);
        error.name = 'TimeoutError';
        finish(error);
        return;
      }
      if (code !== 0) {
        finish(new Error(`${command} exited ${code}: ${stderr.slice(-500)}`));
        return;
      }
      finish();
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/** Spawn without waiting — for engines that stream and settle themselves. */
export function spawnJobProcess(command: string, args: readonly string[]): ChildProcess {
  return spawnMediaProcess(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
}

/** The Node executable, so a synthetic engine needs no PATH lookup. */
export function jobProcessNodeBinary(): string {
  return process.execPath;
}
