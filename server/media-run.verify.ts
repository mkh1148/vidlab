// One-shot FFmpeg/ffprobe discipline (kit A step 7).
//
// Two halves:
//   1. runtime — the wrapper kills a process that overruns its deadline, keeps
//      stderr bounded, and resolves the *bundled* binaries rather than PATH;
//   2. static — no production file spawns a bare `'ffmpeg'` / `'ffprobe'`
//      literal, which is how a call site silently depends on the developer's
//      PATH and skips both the priority drop and the timeout (P9c).
//
// Run: npx tsx server/media-run.verify.ts
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ffmpegBin, ffprobeBin } from './media-binaries.ts';
import {
  DEFAULT_MAX_STDERR_BYTES,
  MediaRunError,
  probeJson,
  runFfmpeg,
  runMediaTool,
} from './media-run.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

// ── 1a · bundled binaries, never a bare command name ──────────────────────
for (const [name, bin] of [['ffmpeg', ffmpegBin()], ['ffprobe', ffprobeBin()]] as const) {
  assert.ok(isAbsolute(bin), `${name} must resolve to an absolute bundled path, got "${bin}"`);
  assert.ok(existsSync(bin), `${name} binary is missing on disk: ${bin}`);
}

// ── 1b · a deadline that actually kills ───────────────────────────────────
{
  const started = Date.now();
  await assert.rejects(
    () => runMediaTool(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 700 }),
    (error: unknown) => {
      assert.ok(error instanceof MediaRunError, 'a timeout must surface as MediaRunError');
      assert.equal(error.result.timedOut, true);
      assert.match(error.message, /timed out after 1s/);
      return true;
    },
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 20_000, `the wrapper must not wait for the child: ${elapsed} ms`);
}

// ── 1c · stderr stays bounded ─────────────────────────────────────────────
{
  const noisy = 'process.stderr.write("x".repeat(400000)); process.exit(3);';
  await assert.rejects(
    () => runMediaTool(process.execPath, ['-e', noisy], { timeoutMs: 20_000, maxStderrBytes: 1_000 }),
    (error: unknown) => {
      assert.ok(error instanceof MediaRunError);
      assert.equal(error.result.code, 3);
      assert.ok(
        error.result.stderr.length <= 1_000,
        `stderr must be capped at 1000 chars, got ${error.result.stderr.length}`,
      );
      return true;
    },
  );
  assert.equal(DEFAULT_MAX_STDERR_BYTES, 8_000);
}

// ── 1d · a real round trip: render one frame, then probe it ───────────────
{
  const dir = await mkdtemp(join(tmpdir(), 'media-run-verify-'));
  try {
    const clip = join(dir, 'one.mp4');
    await runFfmpeg([
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=0.2',
      '-frames:v', '6', '-pix_fmt', 'yuv420p', clip,
    ], { timeoutMs: 60_000 });
    const probed = await probeJson(clip) as {
      streams?: Array<{ width?: number; height?: number }>;
      format?: { duration?: string };
    };
    assert.equal(probed.streams?.[0]?.width, 320);
    assert.equal(probed.streams?.[0]?.height, 240);
    assert.ok(Number(probed.format?.duration) > 0, 'probe must report a duration');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── 2 · no production spawn site names ffmpeg/ffprobe as a bare literal ───
{
  const scanRoots = ['server', 'remotion', 'desktop', 'shared', 'cli', 'src'];
  const offenders: string[] = [];
  const literal = /\b(?:spawn|spawnSync|spawnMediaProcess|execFile|execFileSync|exec)\(\s*['"](ffmpeg|ffprobe)['"]/;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { await walk(path); continue; }
      if (!/\.(?:ts|tsx|mts|mjs|js)$/.test(entry.name)) continue;
      if (/\.verify\.|\.check\./.test(entry.name)) continue;
      const text = await readFile(path, 'utf8');
      for (const line of text.split('\n')) {
        if (literal.test(line)) offenders.push(`${path}: ${line.trim()}`);
      }
    }
  };
  for (const dir of scanRoots) {
    if (existsSync(join(root, dir))) await walk(join(root, dir));
  }
  assert.deepEqual(
    offenders,
    [],
    'these spawn a bare ffmpeg/ffprobe from PATH — use runFfmpeg/runFfprobe '
    + '(server/media-run.ts) or ffmpegBin()/ffprobeBin() with spawnMediaProcess:\n'
    + offenders.join('\n'),
  );
}

// ── 3 · the wrapper is the only new dependency-free seam ──────────────────
assert.ok(
  execFileSync(process.execPath, ['-e', 'process.exit(0)']).length === 0,
  'sanity: child processes run',
);

console.log('media-run.verify: bundled binaries, kill deadline, bounded stderr, no bare spawn sites');
