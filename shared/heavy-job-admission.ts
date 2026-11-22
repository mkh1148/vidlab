// I6 admission: may one more heavy on-device job start right now?
//
// The render clamp (remotion/performance.mjs) answers the same question for
// export tabs and stays a separate system until a measured collision says
// otherwise (D-job contract, S2). This predicate is the one the job module
// consults at job start, and it is deliberately the same arithmetic: half of
// the FREE memory is the budget, because the other half belongs to the editor,
// the browser and the OS page cache. Total RAM is not a budget — on a 15.9 GB
// machine with 5 GB free, a job sized against total RAM is an OOM.
//
// Two properties matter more than the numbers:
//
//   * it never throws and never refuses. A short machine means DEFER — the job
//     stays queued and the gate is re-read later — never an error the owner has
//     to interpret (D-job contract, S2);
//   * it is one predicate in shared/, so the job module, the inspector and any
//     future D consumer cannot drift into three different thresholds.
//
// Host-agnostic on purpose (no node: imports): the caller passes freemem() in.

/** Bytes in one gibibyte, spelled out so the floor below reads as a budget. */
export const GIB_BYTES = 1024 ** 3;

/**
 * Smallest working set a heavy D job is assumed to need.
 *
 * A matte, a denoise or an ASR pass holds a model plus a frame window; below
 * this there is no point starting one, so the requirement is floored here even
 * when a caller asks for less. It is a policy constant, not a measurement: D1b
 * records the measured peak per engine and may pass a larger `requiredBytes`.
 */
export const HEAVY_JOB_MIN_WORKING_SET_BYTES = 1.5 * GIB_BYTES;

/** Half of free memory, floored at zero; a nonsense reading budgets nothing. */
export function heavyJobRamBudget(freeBytes: number): number {
  const free = Number(freeBytes);
  if (!Number.isFinite(free) || free <= 0) return 0;
  return Math.floor(free / 2);
}

export interface HeavyJobRamVerdict {
  /** True when the job may start now; false means defer, not fail. */
  readonly allowed: boolean;
  /** The reading the verdict was taken from. */
  readonly freeBytes: number;
  /** Half of `freeBytes` — what this machine can give a job right now. */
  readonly budgetBytes: number;
  /** The working set the job needs, floored at the policy minimum. */
  readonly requiredBytes: number;
}

/**
 * The verdict with its numbers, so a caller can log *why* a job is deferred
 * instead of guessing from a boolean.
 */
export function heavyJobRamVerdict(
  freeBytes: number,
  requiredBytes: number = HEAVY_JOB_MIN_WORKING_SET_BYTES,
): HeavyJobRamVerdict {
  const free = Number.isFinite(Number(freeBytes)) && Number(freeBytes) > 0 ? Number(freeBytes) : 0;
  const requested = Number(requiredBytes);
  const required = Number.isFinite(requested) && requested > 0
    ? Math.max(requested, HEAVY_JOB_MIN_WORKING_SET_BYTES)
    : HEAVY_JOB_MIN_WORKING_SET_BYTES;
  const budgetBytes = heavyJobRamBudget(free);
  return { allowed: budgetBytes >= required, freeBytes: free, budgetBytes, requiredBytes: required };
}

/**
 * May a heavy job start? `freeRamAllowsHeavyJob(freemem())` at job start.
 *
 * False is a DEFER: the caller queues the job and re-reads the gate, it does
 * not report an error to the owner.
 */
export function freeRamAllowsHeavyJob(
  freeBytes: number,
  requiredBytes: number = HEAVY_JOB_MIN_WORKING_SET_BYTES,
): boolean {
  return heavyJobRamVerdict(freeBytes, requiredBytes).allowed;
}
