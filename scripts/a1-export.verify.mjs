// A1 item 5 (P2) · an export fills empty canvas with black, not the preview
// checkerboard.
//
// The defect: the composition painted its preview checkerboard (#242424 /
// #1c1c1c) behind the picture, so letterbox bars and the area around a scaled
// clip were baked into the delivered file. Measured on this machine before the
// fix: bar pixels read 28,28,28 and 36,36,36.
//
// The check drives the REAL server export route (POST /export) on the
// production server, saves the bytes, then proves the picture with ffprobe and
// a pixel sample of the bars.
//
// Run: node scripts/a1-export.verify.mjs   (needs `npm run build` first)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { freePort, repoRoot, request, scratchDir, startProdServer } from './a1-harness.mjs';

// The bundled binaries, not whatever is on PATH: the check must measure the same
// FFmpeg the server runs (server/media-binaries.ts).
const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('@ffprobe-installer/ffprobe').path;

const dist = join(repoRoot, 'dist');
assert.ok(existsSync(join(dist, 'index.html')), 'run "npm run build" first (P9)');

/** 1280x720 canvas, one red solid at 50% scale: bars on all four sides. */
const EXPORT_BODY = {
  state: {
    fps: 30,
    width: 1280,
    height: 720,
    items: [{
      id: 'a1-solid',
      track: 'V1',
      startFrame: 0,
      durationInFrames: 30,
      kind: 'solid',
      name: 'a1-solid',
      props: { color: '#ff0000' },
      transform: { scale: 0.5 },
    }],
    selectedId: null,
  },
  format: 'video',
  codec: 'h264',
  resolution: '720p',
  fps: 30,
  name: 'a1-p2-check',
};

const home = await scratchDir('home');
const dataDir = await scratchDir('data');
const port = await freePort();
const server = await startProdServer({ home, dataDir, port });

try {
  const started = Date.now();
  const response = await request(port, '/export', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: `http://127.0.0.1:${port}`,
      'sec-fetch-site': 'none',
    },
    body: JSON.stringify(EXPORT_BODY),
  });
  const exportMs = Date.now() - started;
  assert.equal(response.status, 200, `server export failed: ${response.text().slice(0, 400)}`);
  assert.equal(response.headers['content-type'], 'video/mp4');

  const file = join(dataDir, 'a1-p2-export.mp4');
  await writeFile(file, response.body);

  // ── ffprobe accepts the export ──────────────────────────────────────────
  const probe = JSON.parse(execFileSync(ffprobe, [
    '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file,
  ], { encoding: 'utf8' }));
  const video = probe.streams.find((stream) => stream.codec_type === 'video');
  assert.equal(video.codec_name, 'h264');
  assert.equal(video.width, 1280);
  assert.equal(video.height, 720);
  assert.equal(Number(video.nb_frames), 30, 'the export must carry every frame of the 1 s timeline');
  assert.ok(Math.abs(Number(probe.format.duration) - 1) < 0.2, `unexpected duration ${probe.format.duration}`);

  // ── pixel test: the bars are black, the clip is still there ─────────────
  const raw = join(dataDir, 'a1-frame.raw');
  execFileSync(ffmpeg, [
    '-v', 'error', '-i', file, '-vf', 'select=eq(n\\,10)', '-vframes', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw, '-y',
  ]);
  const frame = await readFile(raw);
  const WIDTH = 1280;
  const pixel = (x, y) => {
    const index = (y * WIDTH + x) * 3;
    return [frame[index], frame[index + 1], frame[index + 2]];
  };
  const samples = {
    'top-left corner': [2, 2],
    'top edge': [640, 2],
    'bottom edge': [640, 717],
    'left edge': [2, 360],
    'right edge': [1277, 360],
    'bottom-right corner': [1277, 717],
  };
  const report = {};
  for (const [label, [x, y]] of Object.entries(samples)) {
    const rgb = pixel(x, y);
    report[label] = rgb.join(',');
    assert.deepEqual(
      rgb,
      [0, 0, 0],
      `${label} must be black (P2), got rgb(${rgb.join(',')}) — the preview checkerboard leaked into the export`,
    );
  }
  const centre = pixel(640, 360);
  assert.ok(centre[0] > 200 && centre[1] < 40 && centre[2] < 40, `the clip must still render, got rgb(${centre.join(',')})`);

  // No checkerboard colour anywhere in the frame's border band.
  const checkerboard = new Set(['28,28,28', '36,36,36']);
  const leaks = [];
  for (let x = 0; x < WIDTH; x += 16) {
    for (const y of [0, 1, 718, 719]) {
      const key = pixel(x, y).join(',');
      if (checkerboard.has(key)) leaks.push(`${x},${y}=${key}`);
    }
  }
  assert.deepEqual(leaks, [], `checkerboard grey found in the export border: ${leaks.slice(0, 5).join(' ')}`);

  console.log(
    `a1-export.verify: export 200 in ${exportMs} ms, ${response.body.length} bytes, ffprobe 1280x720 30 frames, `
    + `bars black (${Object.entries(report).map(([k, v]) => `${k}=${v}`).join('; ')}), clip rgb(${centre.join(',')})`,
  );
} finally {
  await server.stop();
  await rm(home, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
}
