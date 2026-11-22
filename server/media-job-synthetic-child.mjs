// The synthetic heavy job child (D1a scaffold; D1b replaces it with the real
// matting engine).
//
// It exists so the job module's guarantees are proven against a REAL spawned
// process rather than a promise that pretends to be one: it progresses, it
// writes per-step files, and it can be told to crash, so the verify can watch a
// SIGKILL land on a pid and assert that no artifact survives it.
//
// argv: <outFile> <steps> <stepMs> <crashAfter>
//   steps       how many progress steps to run
//   stepMs      how long each step pretends to work
//   crashAfter  exit non-zero at this step (0 = never crash)
// stdout: one `step <i>/<n>` line per step, then `done`
import { writeFileSync } from 'node:fs';

const [outFile, stepsArg, stepMsArg, crashAfterArg] = process.argv.slice(2);
const steps = Math.max(1, Number(stepsArg) || 1);
const stepMs = Math.max(0, Number(stepMsArg) || 0);
const crashAfter = Math.max(0, Number(crashAfterArg) || 0);

if (!outFile) {
  process.stderr.write('synthetic job needs an output file\n');
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

for (let step = 1; step <= steps; step += 1) {
  await sleep(stepMs);
  if (crashAfter > 0 && step === crashAfter) {
    process.stdout.write(`crash ${step}/${steps}\n`);
    process.exit(3);
  }
  writeFileSync(`${outFile}.step${step}`, `synthetic step ${step} of ${steps}\n`);
  process.stdout.write(`step ${step}/${steps}\n`);
}

writeFileSync(outFile, `synthetic artifact: ${steps} step(s)\n`);
process.stdout.write('done\n');
