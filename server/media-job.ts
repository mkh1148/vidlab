// The D job module (D-job contract, H1): one heavy job at a time, in memory,
// cancellable down to the child process, with progress and machine-parseable
// errors.
//
// What it deliberately is NOT:
//
//   * not persisted. There is no SQLite table and no job table to migrate. The
//     ARTIFACT is the crash recovery: a restart re-runs the job, and a job only
//     reports success when its output file exists and is non-empty (checked
//     here, not trusted from the engine);
//   * not session-aware. A job holds no project ownership and no heartbeat, so
//     it cannot be a dead-epoch writer while a client takes the edit session
//     over (that is what closes D-entry condition 3 by construction);
//   * not a scheduler. Concurrency is 1 across every D consumer because a
//     second heavy job on a 16 GB machine is an OOM, not a throughput win.
//
// The interface is dumb on purpose — `run(signal, onProgress)` — so an engine
// (RVM matting, RNNoise, whisper) plugs in without the module learning its
// shape. Per-engine resumability lives in artifacts, never in the job record.
import { stat, unlink } from 'node:fs/promises';
import { freemem } from 'node:os';
import {
  freeRamAllowsHeavyJob,
  heavyJobRamVerdict,
  HEAVY_JOB_MIN_WORKING_SET_BYTES,
} from '../shared/heavy-job-admission.ts';

export type MediaJobStatus =
  | 'queued'
  | 'deferred'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface MediaJobProgress {
  /** 0..1; the module clamps and never lets it go backwards. */
  readonly progress: number;
  /** Short EN phase name ('decoding', 'matting', 'encoding'). */
  readonly phase?: string;
  /** Engine counters echoed to the poller unchanged. */
  readonly detail?: Readonly<Record<string, number | string>>;
}

export interface MediaJobArtifact {
  /** Absolute path on disk. */
  readonly file: string;
  /** Media URL a clip reference stores. */
  readonly url: string;
  readonly bytes: number;
}

export interface MediaJobOutcome {
  /** The artifact the job exists to produce. */
  readonly artifact: MediaJobArtifact;
  /** Per-step artifacts a multi-step engine also wrote (resume material). */
  readonly intermediate?: readonly MediaJobArtifact[];
}

export type MediaJobRun = (
  signal: AbortSignal,
  onProgress: (update: MediaJobProgress) => void,
) => Promise<MediaJobOutcome>;

export interface MediaJobRequest {
  /**
   * Dedupe key. A second start with the same key while the first is in flight
   * reuses it (the keyed-dedup semantics of derivative-queue), so a double
   * click cannot queue the same heavy work twice.
   */
  readonly key: string;
  readonly run: MediaJobRun;
  /** Hard deadline for the whole job; the engine child is killed at it. */
  readonly timeoutMs?: number;
  /** Working set this engine needs, for the RAM gate. */
  readonly requiredBytes?: number;
  /**
   * Where the engine will write. Declared up front so a poller can show the
   * destination before the job finishes, and so a failed or cancelled job can
   * remove a partial file the engine left behind.
   */
  readonly target?: { readonly file: string; readonly url: string };
}

export interface MediaJobSnapshot {
  readonly jobId: string;
  readonly key: string;
  readonly status: MediaJobStatus;
  readonly progress: number;
  readonly phase: string | null;
  readonly detail: Readonly<Record<string, number | string>> | null;
  readonly artifact: MediaJobArtifact | null;
  readonly intermediate: readonly MediaJobArtifact[] | null;
  /** Declared output location; set from the moment the job is queued. */
  readonly target: { readonly file: string; readonly url: string } | null;
  /** EN message; null unless `status` is failed. */
  readonly error: string | null;
  /** Machine-parseable code: `job_cancelled`, `artifact_missing`, ... */
  readonly code: string | null;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly updatedAt: number;
  readonly finishedAt: number | null;
  /** True while the RAM gate holds the job back. A defer, never an error. */
  readonly deferred: boolean;
}

export interface MediaJobStartResult {
  readonly jobId: string;
  /** True when an in-flight job with the same key was reused. */
  readonly deduped: boolean;
}

export interface MediaJobQueueOptions {
  /** Heavy jobs are serialized: one at a time, across every D consumer. */
  readonly concurrency?: number;
  /** Free-memory probe; injected by the gate verify. */
  readonly freeMemoryBytes?: () => number;
  /** How often a deferred job re-reads the gate. */
  readonly gateRecheckMs?: number;
  /** Retain finished jobs this long so a poller can still read the result. */
  readonly retentionMs?: number;
  readonly now?: () => number;
}

/** Default job deadline: a 10-minute 1080p matte is already generous. */
export const DEFAULT_MEDIA_JOB_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_RETENTION_MS = 60 * 60_000;
const DEFAULT_GATE_RECHECK_MS = 1_000;

interface InternalJob {
  readonly id: string;
  readonly key: string;
  readonly run: MediaJobRun;
  readonly timeoutMs: number;
  readonly requiredBytes: number;
  readonly target: { readonly file: string; readonly url: string } | null;
  readonly controller: AbortController;
  status: MediaJobStatus;
  progress: number;
  phase: string | null;
  detail: Readonly<Record<string, number | string>> | null;
  artifact: MediaJobArtifact | null;
  intermediate: readonly MediaJobArtifact[] | null;
  error: string | null;
  code: string | null;
  createdAt: number;
  startedAt: number | null;
  updatedAt: number;
  finishedAt: number | null;
}

const TERMINAL: ReadonlySet<MediaJobStatus> = new Set(['completed', 'failed', 'cancelled']);

function snapshotOf(job: InternalJob): MediaJobSnapshot {
  return {
    jobId: job.id,
    key: job.key,
    status: job.status,
    progress: job.progress,
    phase: job.phase,
    detail: job.detail,
    artifact: job.artifact,
    intermediate: job.intermediate,
    target: job.target,
    error: job.error,
    code: job.code,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt,
    deferred: job.status === 'deferred',
  };
}

/** An artifact only counts when the file exists and is non-empty. */
async function artifactBytes(file: string): Promise<number> {
  try {
    const info = await stat(file);
    return info.isFile() ? info.size : 0;
  } catch {
    return 0;
  }
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error('media job cancelled');
  error.name = 'AbortError';
  return error;
}

export class MediaJobQueue {
  readonly concurrency: number;
  private readonly freeMemoryBytes: () => number;
  private readonly gateRecheckMs: number;
  private readonly retentionMs: number;
  private readonly now: () => number;
  private readonly jobs = new Map<string, InternalJob>();
  private readonly byKey = new Map<string, string>();
  private readonly pending: string[] = [];
  private readonly active = new Set<string>();
  private gateTimer: ReturnType<typeof setTimeout> | null = null;
  private sequence = 0;

  constructor(options: MediaJobQueueOptions = {}) {
    const requested = Math.floor(options.concurrency ?? 1);
    this.concurrency = Number.isFinite(requested) && requested >= 1 ? requested : 1;
    this.freeMemoryBytes = options.freeMemoryBytes ?? (() => freemem());
    this.gateRecheckMs = Math.max(10, options.gateRecheckMs ?? DEFAULT_GATE_RECHECK_MS);
    this.retentionMs = Math.max(0, options.retentionMs ?? DEFAULT_RETENTION_MS);
    this.now = options.now ?? (() => Date.now());
  }

  start(request: MediaJobRequest): MediaJobStartResult {
    this.sweep();
    const key = request.key.trim();
    if (!key) throw new Error('a media job needs a non-empty key');
    const inFlight = this.byKey.get(key);
    if (inFlight) {
      const existing = this.jobs.get(inFlight);
      if (existing && !TERMINAL.has(existing.status)) return { jobId: existing.id, deduped: true };
      this.byKey.delete(key);
    }
    this.sequence += 1;
    const at = this.now();
    const job: InternalJob = {
      id: `job_${this.sequence.toString(36)}_${at.toString(36)}`,
      key,
      run: request.run,
      timeoutMs: Math.max(1, request.timeoutMs ?? DEFAULT_MEDIA_JOB_TIMEOUT_MS),
      requiredBytes: request.requiredBytes ?? HEAVY_JOB_MIN_WORKING_SET_BYTES,
      target: request.target ?? null,
      controller: new AbortController(),
      status: 'queued',
      progress: 0,
      phase: null,
      detail: null,
      artifact: null,
      intermediate: null,
      error: null,
      code: null,
      createdAt: at,
      startedAt: null,
      updatedAt: at,
      finishedAt: null,
    };
    this.jobs.set(job.id, job);
    this.byKey.set(key, job.id);
    this.pending.push(job.id);
    this.pump();
    return { jobId: job.id, deduped: false };
  }

  /** Snapshot for a poller; null when the id is unknown (or swept). */
  poll(jobId: string): MediaJobSnapshot | null {
    this.sweep();
    const job = this.jobs.get(jobId);
    if (!job) return null;
    // A poll is also a gate re-read: a deferred job must not wait for a timer
    // to notice that the machine has freed memory.
    if (job.status === 'deferred') this.pump();
    return snapshotOf(job);
  }

  /** Cancel: abort the signal, which is what kills the engine child. */
  cancel(jobId: string): MediaJobSnapshot | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (TERMINAL.has(job.status)) return snapshotOf(job);
    if (job.status === 'running') {
      // Report the cancel at once, then abort: the engine's child is killed by
      // the signal, and the settle path below re-finishes the same state. A
      // cancelled job must never be able to report success afterwards, even if
      // the engine ignores the abort and finishes its work.
      job.status = 'cancelled';
      job.code = 'job_cancelled';
      job.error = 'media job cancelled';
      job.updatedAt = this.now();
      job.controller.abort(abortError(job.controller.signal));
      return snapshotOf(job);
    }
    // Queued or deferred: nothing is running, so finish it here.
    const index = this.pending.indexOf(job.id);
    if (index >= 0) this.pending.splice(index, 1);
    this.finish(job, 'cancelled', { error: 'media job cancelled', code: 'job_cancelled' });
    return snapshotOf(job);
  }

  /**
   * Wait for a terminal status, clamped short: a poll route must never hold a
   * request open (the MCP bridge kills a call at 180 s by construction).
   */
  async wait(jobId: string, timeoutMs = 20_000): Promise<MediaJobSnapshot | null> {
    const deadline = this.now() + Math.max(0, timeoutMs);
    for (;;) {
      const snapshot = this.poll(jobId);
      if (!snapshot) return null;
      if (TERMINAL.has(snapshot.status)) return snapshot;
      if (this.now() >= deadline) return snapshot;
      await new Promise((resolve) => { setTimeout(resolve, 50); });
    }
  }

  /** Every live job, for a status route or a verify. */
  snapshot(): readonly MediaJobSnapshot[] {
    return [...this.jobs.values()].map(snapshotOf);
  }

  /** Drop every job and timer. Verifies only. */
  reset(): void {
    for (const job of this.jobs.values()) {
      if (job.status === 'running') job.controller.abort(abortError(job.controller.signal));
    }
    this.jobs.clear();
    this.byKey.clear();
    this.pending.length = 0;
    this.active.clear();
    this.sequence = 0;
    if (this.gateTimer) {
      clearTimeout(this.gateTimer);
      this.gateTimer = null;
    }
  }

  private sweep(): void {
    const cutoff = this.now() - this.retentionMs;
    for (const [id, job] of this.jobs) {
      if (!TERMINAL.has(job.status) || job.updatedAt >= cutoff) continue;
      this.jobs.delete(id);
      if (this.byKey.get(job.key) === id) this.byKey.delete(job.key);
    }
  }

  private pump(): void {
    while (this.active.size < this.concurrency) {
      const head = this.pending[0];
      if (head === undefined) return;
      const job = this.jobs.get(head);
      if (!job || TERMINAL.has(job.status)) {
        this.pending.shift();
        continue;
      }
      // The admission gate: half of free memory, floored. A short machine means
      // DEFER — the job keeps its place at the head of the queue and the gate is
      // re-read on a timer and on every poll. It is never an error.
      const verdict = heavyJobRamVerdict(this.freeMemoryBytes(), job.requiredBytes);
      if (!freeRamAllowsHeavyJob(verdict.freeBytes, job.requiredBytes)) {
        if (job.status !== 'deferred') {
          job.status = 'deferred';
          job.code = 'ram_below_gate';
          job.error = null;
          job.updatedAt = this.now();
        }
        this.scheduleGateRecheck();
        return;
      }
      this.pending.shift();
      this.launch(job);
    }
  }

  private scheduleGateRecheck(): void {
    if (this.gateTimer) return;
    this.gateTimer = setTimeout(() => {
      this.gateTimer = null;
      this.pump();
    }, this.gateRecheckMs);
    // A deferred job must never keep the process alive on its own.
    this.gateTimer.unref?.();
  }

  private launch(job: InternalJob): void {
    this.active.add(job.id);
    job.status = 'running';
    job.code = null;
    job.error = null;
    job.startedAt = this.now();
    job.updatedAt = job.startedAt;
    const deadline = setTimeout(() => {
      if (TERMINAL.has(job.status)) return;
      job.controller.abort(abortError(job.controller.signal));
    }, job.timeoutMs);
    deadline.unref?.();

    void Promise.resolve()
      .then(() => job.run(job.controller.signal, (update) => this.reportProgress(job, update)))
      .then(
        async (outcome) => {
          clearTimeout(deadline);
          if (job.controller.signal.aborted) {
            await this.discardTarget(job);
            this.finish(job, 'cancelled', { error: 'media job cancelled', code: 'job_cancelled' });
            return;
          }
          // Success is the artifact existing and being non-empty — never the
          // engine's word for it. This is also the crash-recovery rule: a
          // restart re-runs, and a truncated file is a failed job.
          const bytes = await artifactBytes(outcome.artifact.file);
          if (bytes <= 0) {
            await this.discardTarget(job);
            this.finish(job, 'failed', {
              error: `media job produced no artifact at ${outcome.artifact.file}`,
              code: 'artifact_missing',
            });
            return;
          }
          job.artifact = { ...outcome.artifact, bytes };
          job.intermediate = outcome.intermediate ?? null;
          this.finish(job, 'completed', { progress: 1 });
        },
        async (error: unknown) => {
          clearTimeout(deadline);
          await this.discardTarget(job);
          if (job.controller.signal.aborted) {
            this.finish(job, 'cancelled', { error: 'media job cancelled', code: 'job_cancelled' });
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          this.finish(job, 'failed', {
            error: message,
            code: error instanceof Error && error.name === 'TimeoutError' ? 'job_timeout' : 'engine_failed',
          });
        },
      )
      .finally(() => {
        this.active.delete(job.id);
        this.pump();
      });
  }

  /**
   * Remove the declared output after a failure or a cancel. A partial artifact
   * is worse than none: it is exactly what a restart would mistake for
   * finished work. Best effort — a missing file is the normal case.
   */
  private async discardTarget(job: InternalJob): Promise<void> {
    if (!job.target) return;
    await unlink(job.target.file).catch(() => undefined);
  }

  private reportProgress(job: InternalJob, update: MediaJobProgress): void {
    if (TERMINAL.has(job.status)) return;
    const requested = Number(update.progress);
    const next = Number.isFinite(requested) ? Math.max(0, Math.min(1, requested)) : job.progress;
    job.progress = Math.max(job.progress, next);
    if (update.phase) job.phase = update.phase;
    // Detail is a cumulative bag of engine counters: a later progress update
    // must not erase the pid (or any other one-off fact) an earlier one reported.
    if (update.detail) job.detail = { ...job.detail, ...update.detail };
    job.updatedAt = this.now();
  }

  private finish(
    job: InternalJob,
    status: Extract<MediaJobStatus, 'completed' | 'failed' | 'cancelled'>,
    patch: { progress?: number; error?: string; code?: string } = {},
  ): void {
    job.status = status;
    job.progress = patch.progress ?? job.progress;
    job.error = patch.error ?? null;
    job.code = patch.code ?? null;
    job.phase = status === 'completed' ? null : job.phase;
    const at = this.now();
    job.updatedAt = at;
    job.finishedAt = at;
    if (this.byKey.get(job.key) === job.id) this.byKey.delete(job.key);
  }
}

/** The process-wide queue: concurrency 1 across every D consumer. */
export const mediaJobs = new MediaJobQueue();

export function startMediaJob(request: MediaJobRequest): MediaJobStartResult {
  return mediaJobs.start(request);
}

export function pollMediaJob(jobId: string): MediaJobSnapshot | null {
  return mediaJobs.poll(jobId);
}

export function cancelMediaJob(jobId: string): MediaJobSnapshot | null {
  return mediaJobs.cancel(jobId);
}

export function waitMediaJob(jobId: string, timeoutMs?: number): Promise<MediaJobSnapshot | null> {
  return mediaJobs.wait(jobId, timeoutMs);
}
