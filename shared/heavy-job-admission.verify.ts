// D1a · the shared RAM admission predicate.
//
// The three properties the job module relies on: half of free memory is the
// budget, the requirement has a floor, and a short machine is a DEFER (false)
// — never a throw and never a refusal the owner has to read as an error.
import assert from 'node:assert/strict';
import {
  GIB_BYTES,
  HEAVY_JOB_MIN_WORKING_SET_BYTES,
  freeRamAllowsHeavyJob,
  heavyJobRamBudget,
  heavyJobRamVerdict,
} from './heavy-job-admission.ts';

// ── 1. half of free memory is the budget, not total RAM ────────────────────
assert.equal(heavyJobRamBudget(8 * GIB_BYTES), 4 * GIB_BYTES, 'half of free, exactly');
assert.equal(heavyJobRamBudget(3 * GIB_BYTES + 1), 1.5 * GIB_BYTES, 'floored, never rounded up');
assert.equal(
  freeRamAllowsHeavyJob(8 * GIB_BYTES),
  true,
  '4 GiB of budget covers the 1.5 GiB floor',
);
assert.equal(
  freeRamAllowsHeavyJob(2 * GIB_BYTES),
  false,
  '2 GiB free is 1 GiB of budget: short of the floor, so defer',
);
// The boundary is the floor, and it is inclusive: exactly enough is enough.
assert.equal(
  freeRamAllowsHeavyJob(HEAVY_JOB_MIN_WORKING_SET_BYTES * 2),
  true,
  'exactly the floor is admitted',
);
assert.equal(
  freeRamAllowsHeavyJob(HEAVY_JOB_MIN_WORKING_SET_BYTES * 2 - 1),
  false,
  'one byte short of the floor is deferred',
);

// ── 2. the requirement has a floor, and a caller may ask for more ──────────
assert.equal(
  heavyJobRamVerdict(8 * GIB_BYTES, 1).requiredBytes,
  HEAVY_JOB_MIN_WORKING_SET_BYTES,
  'a smaller request is raised to the policy floor, never honoured',
);
assert.equal(
  freeRamAllowsHeavyJob(8 * GIB_BYTES, 6 * GIB_BYTES),
  false,
  'a caller that needs 6 GiB is deferred on a 4 GiB budget',
);
assert.equal(
  freeRamAllowsHeavyJob(16 * GIB_BYTES, 6 * GIB_BYTES),
  true,
  'the same caller runs once the machine can give it 8 GiB',
);

// ── 3. a nonsense reading defers; it never throws and never allows ─────────
for (const reading of [0, -1, Number.NaN, Number.NEGATIVE_INFINITY]) {
  assert.equal(
    freeRamAllowsHeavyJob(reading),
    false,
    `free memory ${reading} must defer, not admit`,
  );
  assert.doesNotThrow(() => freeRamAllowsHeavyJob(reading), 'the predicate never throws');
  assert.equal(heavyJobRamBudget(reading), 0, `free memory ${reading} budgets nothing`);
}

// ── 4. the verdict carries the numbers a log needs ─────────────────────────
const verdict = heavyJobRamVerdict(5 * GIB_BYTES);
assert.deepEqual(verdict, {
  allowed: true,
  freeBytes: 5 * GIB_BYTES,
  budgetBytes: 2.5 * GIB_BYTES,
  requiredBytes: HEAVY_JOB_MIN_WORKING_SET_BYTES,
});

console.log('heavy-job-admission.verify: half-of-freemem budget, floor and defer semantics hold');
