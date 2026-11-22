// A1 item 9 · nothing opens a browser or an external CLI at startup.
//
// Why this is a check and not a promise: a service that opens a browser when it
// starts is unusable as a service (the WinSW wrapper in A2 starts it at logon),
// and a startup that shells out to an external program makes the machine's PATH
// part of the product. Both are the kind of thing that reappears the moment
// somebody "helpfully" adds a convenience call.
//
// Scope: the A1 production start (scripts/serve-prod.mjs), the Electron bootstrap,
// and boot() in desktop/main.ts. User-initiated handlers elsewhere in
// desktop/main.ts (reveal an export in Explorer, hand an external link to the
// browser) are legitimate and are asserted to be exactly that: reachable only
// from an ipcMain.handle registration.
//
// Run: node scripts/startup-audit.verify.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './a1-harness.mjs';

/** Calls that would launch something outside this process. */
const LAUNCH = /\b(?:openExternal|openPath|showItemInFolder|execFile|execFileSync|execSync|spawn|spawnSync|child_process)\b/;

const read = (path) => readFileSync(join(repoRoot, path), 'utf8');

/** The body of a top-level `async function name(` … `\n}` block. */
function functionBody(source, name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name}() must exist`);
  const end = source.indexOf('\n}', start);
  assert.ok(end > start, `${name}() must be a top-level function`);
  return { body: source.slice(start, end), start, end };
}

const findings = [];

// ── the A1 production start ──────────────────────────────────────────────
const serveProd = read('scripts/serve-prod.mjs');
const serveProdHits = serveProd.split('\n')
  .map((line, index) => ({ line: line.trim(), number: index + 1 }))
  .filter(({ line }) => LAUNCH.test(line) && !line.startsWith('//'));
assert.deepEqual(
  serveProdHits,
  [],
  `scripts/serve-prod.mjs must not launch anything at startup: ${JSON.stringify(serveProdHits)}`,
);

// ── the Electron bootstrap ───────────────────────────────────────────────
const bootstrap = read('desktop/bootstrap.ts');
const bootstrapHits = bootstrap.split('\n')
  .map((line, index) => ({ line: line.trim(), number: index + 1 }))
  .filter(({ line }) => LAUNCH.test(line) && !line.startsWith('//'));
assert.deepEqual(
  bootstrapHits,
  [],
  `desktop/bootstrap.ts must not launch anything at startup: ${JSON.stringify(bootstrapHits)}`,
);

// ── boot(): the whole start-up path of the desktop app ───────────────────
const main = read('desktop/main.ts');
const boot = functionBody(main, 'boot');
const bootHits = boot.body.split('\n')
  .map((line, index) => ({ line: line.trim(), number: index + 1 }))
  .filter(({ line }) => LAUNCH.test(line) && !line.startsWith('//'));
assert.deepEqual(bootHits, [], `boot() must not launch anything: ${JSON.stringify(bootHits)}`);

// ── every remaining launch in main.ts is user-initiated ──────────────────
// A helper is allowed to launch something when its only callers are window or
// IPC event handlers. `handOffExternalUrl` hands a link the owner clicked to the
// real browser — the app never opens one on its own.
const USER_INITIATED = new Set(['handOffExternalUrl']);
const REGISTRATION = /webContents\.(?:on|setWindowOpenHandler)\(|ipcMain\.handle\(/;

const lines = main.split('\n');
const enclosingFunction = (index) => {
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const match = /^(?:async )?function ([A-Za-z0-9_]+)\(/.exec(lines[cursor]);
    if (match) return { name: match[1], line: cursor };
  }
  return null;
};

const handlers = [];
lines.forEach((line, index) => {
  if (!LAUNCH.test(line) || line.trim().startsWith('//')) return;
  if (index >= boot.start && index <= boot.end) return; // already asserted above
  const owner = enclosingFunction(index);
  // Walk back to the enclosing registration; a launch that is not inside an
  // ipcMain.handle or a documented user-initiated helper is reachable from
  // startup code and must be fixed instead.
  let registration = null;
  for (let cursor = index; cursor >= 0 && index - cursor < 80; cursor -= 1) {
    if (REGISTRATION.test(lines[cursor])) { registration = cursor + 1; break; }
    if (/^(?:async )?function /.test(lines[cursor])) break;
  }
  const allowed = Boolean(registration) || (owner && USER_INITIATED.has(owner.name));
  handlers.push({ number: index + 1, line: line.trim(), owner: owner?.name ?? '(module)', registration });
  if (!allowed) {
    findings.push(
      `desktop/main.ts:${index + 1} launches outside a handler `
      + `(enclosing ${owner?.name ?? 'module scope'}): ${line.trim()}`,
    );
  }
});
assert.deepEqual(findings, [], `startup path launches something:\n  ${findings.join('\n  ')}`);

// An allowlisted helper must itself only be reached from a window/IPC event.
for (const name of USER_INITIATED) {
  const callSites = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => new RegExp(`\\b${name}\\(`).test(line) && !/^function /.test(line.trim()));
  assert.ok(callSites.length > 0, `${name} must have call sites`);
  for (const { line, index } of callSites) {
    const near = lines.slice(Math.max(0, index - 12), index + 12).join('\n');
    assert.match(
      near,
      REGISTRATION,
      `${name} is called at main.ts:${index + 1} outside a window/IPC event: ${line.trim()}`,
    );
  }
}

assert.ok(handlers.length > 0, 'expected the user-initiated launch sites to still exist');

console.log(
  `startup-audit.verify: serve-prod.mjs, desktop/bootstrap.ts and boot() launch nothing `
  + `(${main.split('\n').length} lines of main.ts scanned); ${handlers.length} launch sites are `
  + `all behind a window/IPC handler (${handlers.map((hit) => `main.ts:${hit.number} in ${hit.owner}`).join(', ')})`,
);
