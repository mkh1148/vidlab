// The whisper.cpp runtime this engine drives: one WARM server child, and a CLI
// fallback for a machine whose provisioned archive has no server binary.
//
// What "warm" means concretely here, because the kit asks for it and a comment is
// not evidence:
//
//   * ONE child process per (binary, model file), owned by this module, spawned on
//     the first chunk that needs it and reused for every later chunk of that job AND
//     for every later job in the same server process. The model is loaded once, by
//     `whisper-server -m <model>`, at spawn time;
//   * a chunk therefore costs inference only — no model load, no process start. The
//     measured difference is in docs/d-job-implementation.md §D3a (first chunk of a
//     cold server vs the same chunk on a warm one);
//   * "warm between jobs" is the same fact stated across jobs: a second transcription
//     job on the same tier reuses the server the first one left running;
//   * it is NOT kept forever: an idle timer stops it after `WHISPER_SERVER_IDLE_MS`,
//     because a warm server holds the model's RAM and this app's whole D design is
//     "one heavy thing at a time, and nothing heavy when idle";
//   * it IS killed on cancel. The D-job contract's kill policy is SIGKILL through
//     `server/media-job-process.ts`, and the engine's child for a running job is this
//     server, so a cancel kills it and the next job pays one model load. That is the
//     honest trade: a cancelled job must stop burning CPU, and a shared server that
//     survives a cancel would keep computing a transcript nobody will read.
//
// The CLI fallback exists because the server binary is provisioned from a release
// archive: if the platform's archive lacks `whisper-server`, refusing to transcribe
// would be a worse answer than transcribing more slowly. It spawns `whisper-cli`
// through the same kill policy, one chunk at a time, and reports `backend: 'cli'` in
// the job detail so the difference is visible rather than inferred.
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { whisperCliBin } from './media-binaries.ts';
import { killJobProcess, runJobProcess, spawnJobProcess } from './media-job-process.ts';
import {
  whisperTokensToWordSpans,
  whisperWordsToWordSpans,
  type WhisperWordSpan,
} from '../shared/whisper-tokens.ts';
import type { ChildProcess } from 'node:child_process';

/** How long a ready server may sit unused before it is stopped. */
export const WHISPER_SERVER_IDLE_MS = 5 * 60_000;

/** How long the server may take to answer /health after spawn. */
export const WHISPER_SERVER_READY_MS = 30_000;

/** Per-chunk deadline. A 25 s chunk on CPU is well under this; a wedge is not. */
export const WHISPER_CHUNK_TIMEOUT_MS = 10 * 60_000;

/** Threads the binary may use. The job queue is concurrency 1, so this is the box. */
export const WHISPER_THREADS = 8;

export type WhisperBackend = 'server' | 'cli';

export interface WhisperWarmState {
  readonly warm: boolean;
  readonly backend: WhisperBackend;
  readonly pid: number | null;
  readonly port: number | null;
  readonly modelFile: string | null;
  /** Milliseconds since the server last served a chunk; null when cold. */
  readonly idleMs: number | null;
}

interface WarmServer {
  readonly child: ChildProcess;
  readonly port: number;
  readonly modelFile: string;
  lastUsedAt: number;
}

let warm: WarmServer | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let exitHookInstalled = false;

/** The server binary beside the provisioned CLI, or an explicit override. */
export function whisperServerBin(): string {
  const override = process.env.OPENCHATCUT_WHISPER_SERVER;
  if (override) return override;
  const cli = whisperCliBin();
  const suffix = process.platform === 'win32' ? '.exe' : '';
  return join(dirname(cli), `whisper-server${suffix}`);
}

/** True when this machine can run the warm server; false means the CLI path. */
export function whisperServerAvailable(): boolean {
  return existsSync(whisperServerBin());
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      server.close(() => resolve(address.port));
    });
  });
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // A child must never outlive the process that owns it, including on a crash.
  process.once('exit', () => {
    if (warm) killJobProcess(warm.child);
  });
}

function armIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    stopWarmWhisperServer();
  }, WHISPER_SERVER_IDLE_MS);
  // A warm server must never keep the process alive on its own.
  idleTimer.unref?.();
}

/** Stop the warm server, if any. Safe to call when cold, and on cancel. */
export function stopWarmWhisperServer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (!warm) return;
  const { child } = warm;
  warm = null;
  killJobProcess(child);
}

/** Current warmth, for a job's `detail` and for the verify. */
export function whisperWarmState(now: number = Date.now()): WhisperWarmState {
  return {
    warm: warm !== null,
    backend: warm ? 'server' : whisperServerAvailable() ? 'server' : 'cli',
    pid: warm?.child.pid ?? null,
    port: warm?.port ?? null,
    modelFile: warm?.modelFile ?? null,
    idleMs: warm ? Math.max(0, now - warm.lastUsedAt) : null,
  };
}

async function waitForHealth(port: number, child: ChildProcess, deadline: number): Promise<void> {
  let exited = false;
  child.once('exit', () => { exited = true; });
  while (Date.now() < deadline) {
    if (exited) throw new Error('the whisper server exited before it became ready');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {
      // Not listening yet; the loop is the retry.
    }
    await new Promise((resolve) => { setTimeout(resolve, 200); });
  }
  throw new Error('the whisper server did not become ready in time');
}

/**
 * The warm server for `modelFile`, spawning it if this is the first chunk.
 *
 * A different model file means a different server: whisper-server loads one model at
 * spawn, so a tier change restarts it rather than pretending the old one can answer.
 */
async function ensureWarmServer(modelFile: string): Promise<WarmServer> {
  if (warm && warm.modelFile === modelFile && warm.child.exitCode === null && !warm.child.killed) {
    warm.lastUsedAt = Date.now();
    return warm;
  }
  stopWarmWhisperServer();
  installExitHook();
  const bin = whisperServerBin();
  if (!existsSync(bin)) throw new Error(`the whisper server binary is missing at ${bin}`);
  const port = await freePort();
  const child = spawnJobProcess(bin, [
    '-m', modelFile,
    '--host', '127.0.0.1',
    '--port', String(port),
    '-t', String(WHISPER_THREADS),
  ]);
  // The server logs to stderr; drain it or the pipe fills and the child blocks.
  child.stderr?.resume();
  child.stdout?.resume();
  try {
    await waitForHealth(port, child, Date.now() + WHISPER_SERVER_READY_MS);
  } catch (error) {
    killJobProcess(child);
    throw error;
  }
  warm = { child, port, modelFile, lastUsedAt: Date.now() };
  armIdleTimer();
  return warm;
}

export interface TranscribeChunkOptions {
  readonly signal?: AbortSignal;
  /** ISO-639-1 code, or 'auto' to let the model detect it. */
  readonly language?: string;
  readonly timeoutMs?: number;
}

export interface TranscribeChunkResult {
  readonly words: WhisperWordSpan[];
  readonly text: string;
  readonly backend: WhisperBackend;
}

interface VerboseJson {
  readonly text?: string;
  readonly segments?: readonly {
    readonly text?: string;
    readonly words?: readonly { readonly word?: string; readonly start?: number; readonly end?: number }[];
  }[];
}

function parseVerboseJson(payload: VerboseJson): { words: WhisperWordSpan[]; text: string } {
  const words = whisperWordsToWordSpans(payload.segments?.flatMap((segment) => segment.words ?? []));
  const text = (payload.segments ?? [])
    .map((segment) => (segment.text ?? '').trim())
    .filter(Boolean)
    .join('\n') || (payload.text ?? '').trim();
  return { words, text };
}

/**
 * Transcribe one chunk file through the warm server.
 *
 * The response is `verbose_json`, which is the only format that carries per-word
 * times: the transcript this feature stores is word-level by contract, and a
 * segment-level answer would have to invent word positions.
 */
export async function transcribeChunkViaServer(
  modelFile: string,
  wavPath: string,
  options: TranscribeChunkOptions = {},
): Promise<TranscribeChunkResult> {
  const server = await ensureWarmServer(modelFile);
  const form = new FormData();
  form.append('file', new Blob([await readFile(wavPath)], { type: 'audio/wav' }), 'chunk.wav');
  form.append('response_format', 'verbose_json');
  const language = (options.language ?? 'auto').trim();
  if (language && language !== 'auto') form.append('language', language);
  const signals = [AbortSignal.timeout(options.timeoutMs ?? WHISPER_CHUNK_TIMEOUT_MS)];
  if (options.signal) signals.push(options.signal);
  const response = await fetch(`http://127.0.0.1:${server.port}/inference`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.any(signals),
  });
  if (!response.ok) {
    throw new Error(`whisper server inference failed (${response.status})`);
  }
  const payload = await response.json() as VerboseJson;
  const parsed = parseVerboseJson(payload);
  server.lastUsedAt = Date.now();
  armIdleTimer();
  return { words: parsed.words, text: parsed.text, backend: 'server' };
}

/**
 * Transcribe one chunk file through `whisper-cli` instead.
 *
 * Same kill policy, same deadline, one process per chunk: this is the slow path, and
 * it exists so a machine without the server binary still gets a transcript.
 */
export async function transcribeChunkViaCli(
  modelFile: string,
  wavPath: string,
  options: TranscribeChunkOptions = {},
): Promise<TranscribeChunkResult> {
  const jsonBase = `${wavPath}.whisper`;
  const language = (options.language ?? 'auto').trim() || 'auto';
  try {
    await runJobProcess(
      whisperCliBin(),
      [
        '-m', modelFile,
        '-f', wavPath,
        '-t', String(WHISPER_THREADS),
        '-l', language,
        '-sow',
        '-ojf',
        '-nt',
        '-of', jsonBase,
      ],
      { signal: options.signal, timeoutMs: options.timeoutMs ?? WHISPER_CHUNK_TIMEOUT_MS },
    );
    const payload = JSON.parse(await readFile(`${jsonBase}.json`, 'utf8')) as {
      transcription?: readonly { text?: string; tokens?: readonly { text?: string; offsets?: { from: number; to: number } }[] }[];
    };
    const { text, words } = whisperTokensToWordSpans(payload.transcription);
    return { words, text, backend: 'cli' };
  } finally {
    await rm(`${jsonBase}.json`, { force: true }).catch(() => undefined);
  }
}

/**
 * Transcribe one chunk with whichever backend this machine has.
 *
 * The server path is the kit's engine; the CLI path is the fallback, and the result
 * says which one ran so a job's `detail` can report it.
 */
export async function transcribeSpeechChunk(
  modelFile: string,
  wavPath: string,
  options: TranscribeChunkOptions = {},
): Promise<TranscribeChunkResult> {
  if (whisperServerAvailable()) return transcribeChunkViaServer(modelFile, wavPath, options);
  return transcribeChunkViaCli(modelFile, wavPath, options);
}
