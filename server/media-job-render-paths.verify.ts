// D1 · every render path honours an APPLIED matte (reviewer condition C1).
//
// The kit's D1 exit test says "every render path must honour it — plain playback,
// effects, transitions, browser export, server export — test each". D1b proved
// the artifact, the apply command and the export PREFLIGHT; this suite proves the
// two paths a person actually looks at, with the app's OWN pipeline:
//
//   A. a real server export (POST /export on the production server) of a project
//      whose video item carries `derivedPictureSrc`. The export is decoded and
//      sampled: the background must be visible behind the subject, the subject
//      must be the matte's picture, and the ORIGINAL source must not appear at
//      all. Nothing is composited outside the app — the frames are the app's.
//   B. a rendered PREVIEW frame in headless Chrome against the real editor, which
//      loads the matte through the derived read route. Same three assertions.
//   C. (D3b) a second server export of a clip whose transcript drives a bound
//      caption track: the caption band must carry white text while the words are
//      on screen and none after the page's linger, so "captions burn into the
//      export" is measured rather than read off the plan.
//
// The fixtures make a wrong answer impossible to confuse with a right one:
//
//   background layer : solid BLUE
//   source clip      : solid GREEN  (what the wrong picture would show)
//   matte            : RED with an opaque square in the middle, transparent
//                      everywhere else (a real VP9-alpha WebM, decoded and
//                      checked before it is used)
//
// So a passing frame is blue outside the square, red inside it, and green
// nowhere. A render path that ignores the derived reference shows green; one that
// drops the alpha shows red everywhere; one that loses the picture shows black.
//
// Run: npx tsx server/media-job-render-paths.verify.ts   (part B needs `npm run build`)
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, openSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolateVerifyHome } from '../shared/verify-home.ts';
import { ffmpegBin, ffprobeBin } from './media-binaries.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 30;
const FRAMES = 30;
/** The matte's opaque square, in frame pixels. */
const SQUARE = { left: 440, right: 840, top: 140, bottom: 540 };
const BLUE = { r: 0x00, g: 0x00, b: 0xff };
const RED = { r: 0xff, g: 0x00, b: 0x00 };

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((candidate): candidate is string => Boolean(candidate));

const fixture = await mkdtemp(join(tmpdir(), 'vidlab-render-paths-'));
// Chrome needs a real %USERPROFILE% to start (it derives its crash/profile paths
// from it); the app processes get the throwaway home, the browser keeps the
// machine's, exactly as the rendered scan does.
const realHome = homedir();
const restoreHome = isolateVerifyHome(join(fixture, 'home'));
const dataDir = join(fixture, 'vidlab-data');
process.env.OPENCHATCUT_DATA_DIR = dataDir;

// Imported AFTER the redirect: the runtime profile resolves once, at module load.
const { uploadDir } = await import('./media-dir.ts');
const { mediaJobDerivedRoot } = await import('./media-job-artifact.ts');

const sleep = (ms: number): Promise<void> => new Promise((done) => { setTimeout(done, ms); });
const ffmpeg = ffmpegBin();
const ffprobe = ffprobeBin();

function ffmpegRun(args: string[]): void {
  execFileSync(ffmpeg, ['-v', 'error', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

/** One frame of a file as rgb24 bytes, plus its dimensions. */
async function frameRgb(file: string, seconds: number): Promise<{ data: Buffer; width: number; height: number }> {
  const probe = JSON.parse(execFileSync(ffprobe, [
    '-v', 'error', '-print_format', 'json', '-show_streams', file,
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
  const video = probe.streams.find((stream: { codec_type: string }) => stream.codec_type === 'video');
  assert.ok(video, `${file} has no video stream`);
  const width = Number(video.width);
  const height = Number(video.height);
  const raw = execFileSync(ffmpeg, [
    '-v', 'error', '-ss', String(seconds), '-i', file, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { maxBuffer: 256 * 1024 * 1024 });
  assert.equal(raw.length, width * height * 3, `${file} at ${seconds}s did not decode one rgb24 frame`);
  return { data: raw, width, height };
}

/** One frame of an ALPHA file as rgba bytes. */
async function frameRgba(file: string, seconds: number): Promise<{ data: Buffer; width: number; height: number }> {
  const probe = JSON.parse(execFileSync(ffprobe, [
    '-v', 'error', '-print_format', 'json', '-show_streams', file,
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
  const video = probe.streams.find((stream: { codec_type: string }) => stream.codec_type === 'video');
  assert.ok(video, `${file} has no video stream`);
  const width = Number(video.width);
  const height = Number(video.height);
  // The native vp9 decoder drops alpha; libvpx keeps it.
  const raw = execFileSync(ffmpeg, [
    '-v', 'error', '-c:v', 'libvpx-vp9', '-ss', String(seconds), '-i', file, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-',
  ], { maxBuffer: 256 * 1024 * 1024 });
  assert.equal(raw.length, width * height * 4, `${file} at ${seconds}s did not decode one rgba frame`);
  return { data: raw, width, height };
}

type Rgb = { data: Buffer; width: number; height: number };
const pixel = (frame: Rgb, x: number, y: number): [number, number, number] => {
  const index = (y * frame.width + x) * 3;
  return [frame.data[index]!, frame.data[index + 1]!, frame.data[index + 2]!];
};
const near = (rgb: readonly number[], target: { r: number; g: number; b: number }, tolerance = 40): boolean => (
  Math.abs(rgb[0]! - target.r) <= tolerance
  && Math.abs(rgb[1]! - target.g) <= tolerance
  && Math.abs(rgb[2]! - target.b) <= tolerance
);
const show = (rgb: readonly number[]): string => `rgb(${rgb.join(',')})`;

/** Green anywhere means the ORIGINAL picture was drawn instead of the matte. */
function greenPixels(frame: Rgb): number {
  let count = 0;
  for (let index = 0; index < frame.width * frame.height; index += 1) {
    const r = frame.data[index * 3]!;
    const g = frame.data[index * 3 + 1]!;
    const b = frame.data[index * 3 + 2]!;
    if (g > r + 40 && g > b + 40) count += 1;
  }
  return count;
}

/** Near-black anywhere means the picture was lost (a dropped alpha reads black). */
function darkPixels(frame: Rgb): number {
  let count = 0;
  for (let index = 0; index < frame.width * frame.height; index += 1) {
    const r = frame.data[index * 3]!;
    const g = frame.data[index * 3 + 1]!;
    const b = frame.data[index * 3 + 2]!;
    if (r + g + b < 30) count += 1;
  }
  return count;
}

/**
 * The three assertions every render path must satisfy, expressed against a frame
 * of the composition: background behind the subject, the matte's picture where it
 * is opaque, and no trace of the original source.
 */
function assertComposite(frame: Rgb, label: string): void {
  // Inside the matte's opaque square: the matte's own picture.
  const centre = pixel(frame, Math.round(frame.width * 0.5), Math.round(frame.height * 0.5));
  assert.ok(near(centre, RED), `${label}: the subject area must be the matte's picture, got ${show(centre)}`);

  // Outside the square: the background layer, visible THROUGH the matte.
  const below = pixel(frame, Math.round(frame.width * 0.5), Math.round(frame.height * 0.85));
  assert.ok(near(below, BLUE), `${label}: the background must show through the transparent matte, got ${show(below)}`);
  const above = pixel(frame, Math.round(frame.width * 0.5), Math.round(frame.height * 0.05));
  assert.ok(near(above, BLUE), `${label}: the background must show above the subject, got ${show(above)}`);

  // The seam: one pixel either side of the matte edge, at the same height.
  const seamY = Math.round(frame.height * 0.5);
  const outsideLeft = pixel(frame, SQUARE.left - 4, seamY);
  const insideLeft = pixel(frame, SQUARE.left + 4, seamY);
  const outsideRight = pixel(frame, SQUARE.right + 4, seamY);
  assert.ok(near(outsideLeft, BLUE), `${label}: just outside the matte edge must be background, got ${show(outsideLeft)}`);
  assert.ok(near(insideLeft, RED), `${label}: just inside the matte edge must be the subject, got ${show(insideLeft)}`);
  assert.ok(near(outsideRight, BLUE), `${label}: the far edge of the matte must be background, got ${show(outsideRight)}`);

  // The original source must not appear anywhere.
  const green = greenPixels(frame);
  assert.equal(green, 0, `${label}: ${green} pixels are the ORIGINAL source — the derived picture was not used`);
  // Nor may the picture be lost.
  const dark = darkPixels(frame);
  assert.equal(dark, 0, `${label}: ${dark} near-black pixels — the picture was lost (a dropped alpha exports black)`);
}

/** The production server, on its own port, with its own home and data dir. */
async function startServer(port: number): Promise<{ child: ReturnType<typeof spawn>; origin: string }> {
  const child = spawn(process.execPath, [
    '--import', 'tsx', join(repoRoot, 'scripts', 'serve-prod.mjs'), '--port', String(port),
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      USERPROFILE: join(fixture, 'home'),
      HOME: join(fixture, 'home'),
      OPENCHATCUT_DATA_DIR: dataDir,
      OPENCHATCUT_PORT: String(port),
      OPENCHATCUT_EDITOR_URL: '',
      OPENCHATCUT_ALLOWED_HOSTS: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const origin = await new Promise<string>((resolveOrigin, rejectOrigin) => {
    const timer = setTimeout(() => rejectOrigin(new Error(`production server never became ready:\n${log}`)), 120_000);
    const onData = (chunk: Buffer): void => {
      log += String(chunk);
      const match = log.match(/\[serve-prod\] (\{.*\})/);
      if (!match) return;
      clearTimeout(timer);
      resolveOrigin(JSON.parse(match[1]!).origin as string);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      rejectOrigin(new Error(`production server exited early (${code}):\n${log}`));
    });
  });
  return { child, origin };
}

type Cdp = {
  send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  evaluate: (expression: string) => Promise<unknown>;
  close: () => void;
};

/** A minimal CDP client over the WebSocket Node ships with. */
async function connectCdp(port: number): Promise<Cdp> {
  let socketUrl: string | null = null;
  let lastError = 'no attempt';
  for (let attempt = 0; attempt < 160 && !socketUrl; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json() as Array<{ type: string; webSocketDebuggerUrl?: string }>;
      socketUrl = targets.find((target) => target.type === 'page')?.webSocketDebuggerUrl ?? null;
      lastError = socketUrl ? '' : `no page target among ${targets.length}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (!socketUrl) await sleep(250);
  }
  assert.ok(socketUrl, `headless Chrome never exposed a debuggable page on port ${port} (${lastError})`);

  const socket = new WebSocket(socketUrl);
  await new Promise<void>((resolveOpen, rejectOpen) => {
    socket.addEventListener('open', () => resolveOpen(), { once: true });
    socket.addEventListener('error', () => rejectOpen(new Error('CDP socket failed')), { once: true });
  });
  let nextId = 0;
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number; result?: Record<string, unknown>; error?: { message: string };
    };
    const waiter = message.id ? pending.get(message.id) : undefined;
    if (!waiter) return;
    pending.delete(message.id!);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result ?? {});
  });
  const send = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
    new Promise((resolveSend, rejectSend) => {
      nextId += 1;
      const id = nextId;
      // A dead browser must fail the check, not hang it: every request has a
      // deadline, and a closed socket rejects whatever is in flight.
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectSend(new Error(`CDP ${method} did not answer in 20 s (the browser may have exited)`));
      }, 20_000);
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolveSend(value); },
        reject: (error) => { clearTimeout(timer); rejectSend(error); },
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  socket.addEventListener('close', () => {
    for (const [id, waiter] of pending) {
      pending.delete(id);
      waiter.reject(new Error('the CDP socket closed (the browser exited)'));
    }
  });
  const evaluate = async (expression: string): Promise<unknown> => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    }) as { result: { value: unknown }; exceptionDetails?: { exception?: { description?: string } } };
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'page threw');
    return result.value;
  };
  return { send, evaluate, close: () => socket.close() };
}

let chrome: ReturnType<typeof spawn> | null = null;
let cdp: Cdp | null = null;
let server: { child: ReturnType<typeof spawn> } | null = null;

try {
  // ── the fixtures: a green source, a red matte with a transparent border ────
  const subjectFile = join(fixture, 'subject.mp4');
  ffmpegRun([
    '-f', 'lavfi', '-i', `color=c=0x00c000:size=${WIDTH}x${HEIGHT}:rate=${FPS}`,
    '-frames:v', String(FRAMES), '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-y', subjectFile,
  ]);
  const matteFile = join(fixture, 'matte.webm');
  ffmpegRun([
    '-f', 'lavfi', '-i', `color=c=0xff0000:size=${WIDTH}x${HEIGHT}:rate=${FPS}`,
    '-frames:v', String(FRAMES),
    '-vf', `format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(between(X,${SQUARE.left},${SQUARE.right})*between(Y,${SQUARE.top},${SQUARE.bottom}),255,0)'`,
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-y', matteFile,
  ]);

  // The fixture must really be an alpha matte before any render path is blamed.
  const matteFrame = await frameRgba(matteFile, 0.5);
  const alphaAt = (x: number, y: number): number => matteFrame.data[(y * matteFrame.width + x) * 4 + 3]!;
  assert.equal(alphaAt(10, 10), 0, 'the fixture matte must be transparent outside the square');
  assert.equal(alphaAt(WIDTH - 10, HEIGHT - 10), 0, 'the fixture matte must be transparent outside the square');
  assert.equal(alphaAt(WIDTH / 2, HEIGHT / 2), 255, 'the fixture matte must be opaque inside the square');
  console.log(`render paths: fixtures ready — ${WIDTH}x${HEIGHT} source (green), matte (red, transparent border)`);

  // ── the artifact, placed where the app serves it ──────────────────────────
  const uploads = uploadDir();
  await mkdir(uploads, { recursive: true });
  const sourceName = 'd1-render-paths.mp4';
  await copyFile(subjectFile, join(uploads, sourceName));
  const sourceKey = 'd1-render-paths-mp4-v1-00000000';
  const matteName = 'd1-render-paths-matte-v1.webm';
  const matteDir = join(mediaJobDerivedRoot(), sourceKey);
  await mkdir(matteDir, { recursive: true });
  await copyFile(matteFile, join(matteDir, matteName));
  const matteUrl = `/media/derived/${sourceKey}/${matteName}`;

  const port = await freePort();
  const started = await startServer(port);
  server = started;
  const origin = started.origin;

  // ── A. the server export, through the app's own pipeline ──────────────────
  const exportBody = {
    state: {
      fps: FPS,
      width: WIDTH,
      height: HEIGHT,
      selectedId: null,
      items: [
        {
          id: 'd1-background',
          track: 'V1',
          startFrame: 0,
          durationInFrames: FRAMES,
          kind: 'solid',
          name: 'background',
          props: { color: '#0000ff' },
        },
        {
          id: 'd1-subject',
          track: 'V2',
          startFrame: 0,
          durationInFrames: FRAMES,
          kind: 'video',
          name: 'subject',
          src: `/media/uploads/${sourceName}`,
          derivedPictureSrc: matteUrl,
          derivedPictureEngine: 'rvm-mobilenetv3-v1',
          width: WIDTH,
          height: HEIGHT,
        },
      ],
    },
    format: 'video',
    codec: 'h264',
    resolution: '720p',
    fps: FPS,
    name: 'd1-render-paths',
  };
  const exportStarted = Date.now();
  const response = await fetch(`${origin}/export`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
      'sec-fetch-site': 'none',
    },
    body: JSON.stringify(exportBody),
  });
  const exportMs = Date.now() - exportStarted;
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, 200, `server export failed: ${bytes.toString('utf8').slice(0, 400)}`);
  const exported = join(fixture, 'export.mp4');
  await writeFile(exported, bytes);

  const exportedFrame = await frameRgb(exported, 1 / 3);
  assert.equal(exportedFrame.width, WIDTH);
  assert.equal(exportedFrame.height, HEIGHT);
  assertComposite(exportedFrame, 'server export');
  console.log(`render paths: server export honoured the applied matte (${exportMs} ms, ${bytes.length} bytes)`);

  // ── C. captions are burned into the server export ─────────────────────────
  // D3b: a caption track is a PROJECTION of a clip's transcript, and the export
  // renders it through the same TimelineComposition as the preview. Prove it with
  // pixels rather than by reading the plan: a green clip carrying a two-word
  // transcript plus a caption track bound to it must show WHITE TEXT inside the
  // caption band while the words are on screen, and none once they are gone.
  //
  // Timing fixture: words 0-200 ms and 200-400 ms → one phrase page 0-400 ms,
  // which stays on screen for LINGER_MS (1500 ms) more, so the caption is gone
  // after 1.9 s. The composition is 2 s: 0.2 s is inside the page and 1.9 s is
  // past the linger — the two samples straddle the caption's own end, not an
  // arbitrary frame.
  const CAPTION_FRAMES = 60;
  const captionSourceFile = join(fixture, 'caption-source.mp4');
  ffmpegRun([
    '-f', 'lavfi', '-i', `color=c=0x00c000:size=${WIDTH}x${HEIGHT}:rate=${FPS}`,
    '-frames:v', String(CAPTION_FRAMES), '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-y', captionSourceFile,
  ]);
  const captionSourceName = 'd3b-caption-source.mp4';
  await copyFile(captionSourceFile, join(uploads, captionSourceName));

  const captionBody = {
    state: {
      fps: FPS,
      width: WIDTH,
      height: HEIGHT,
      selectedId: null,
      tracks: {
        V1: { kind: 'video' },
        C1: {
          kind: 'caption',
          captions: { enabled: true, template: 'plain', pacing: 'phrase', sourceItemId: 'd3b-speech' },
        },
      },
      items: [
        {
          id: 'd3b-speech',
          track: 'V1',
          startFrame: 0,
          durationInFrames: CAPTION_FRAMES,
          kind: 'video',
          name: 'speech',
          src: `/media/uploads/${captionSourceName}`,
          width: WIDTH,
          height: HEIGHT,
          transcriptGenerationId: 'd3b-gen-1',
          transcript: [
            { id: 'd3b-w1', text: 'hello', start: 0, end: 200 },
            { id: 'd3b-w2', text: 'world', start: 200, end: 400 },
          ],
        },
      ],
    },
    format: 'video',
    codec: 'h264',
    resolution: '720p',
    fps: FPS,
    name: 'd3b-captions',
  };
  const captionStarted = Date.now();
  const captionResponse = await fetch(`${origin}/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, 'sec-fetch-site': 'none' },
    body: JSON.stringify(captionBody),
  });
  const captionMs = Date.now() - captionStarted;
  const captionBytes = Buffer.from(await captionResponse.arrayBuffer());
  assert.equal(
    captionResponse.status,
    200,
    `caption export failed: ${captionBytes.toString('utf8').slice(0, 400)}`,
  );
  const captionExported = join(fixture, 'export-captions.mp4');
  await writeFile(captionExported, captionBytes);
  const captionDuration = Number(execFileSync(ffprobe, [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', captionExported,
  ]).toString().trim());
  assert.ok(
    captionDuration >= (CAPTION_FRAMES - 1) / FPS,
    `the caption export must cover the whole composition, got ${captionDuration}s`,
  );

  // The caption band: the 'plain' template sits bottom-centre with 8% bottom
  // inset and 10% side padding, so the band below is generously larger than the
  // text and still excludes the rest of the picture.
  const BAND = { x0: 0.15, x1: 0.85, y0: 0.78, y1: 0.95 };
  const bandArea = Math.round(WIDTH * (BAND.x1 - BAND.x0)) * Math.round(HEIGHT * (BAND.y1 - BAND.y0));
  /** Pixels that can only be caption TEXT: near-white, which the green clip never is. */
  const bandWhitePixels = (frame: Rgb): number => {
    let count = 0;
    for (let y = Math.round(HEIGHT * BAND.y0); y < Math.round(HEIGHT * BAND.y1); y += 1) {
      for (let x = Math.round(WIDTH * BAND.x0); x < Math.round(WIDTH * BAND.x1); x += 1) {
        const [r, g, b] = pixel(frame, x, y);
        if (r > 150 && g > 150 && b > 150) count += 1;
      }
    }
    return count;
  };

  const during = await frameRgb(captionExported, 0.2);
  const after = await frameRgb(captionExported, 1.9);
  const duringWhite = bandWhitePixels(during);
  const afterWhite = bandWhitePixels(after);
  assert.ok(
    duringWhite >= 100,
    `server export: the caption band must show caption text at 0.2 s, found ${duringWhite} white pixels`,
  );
  assert.ok(
    duringWhite < bandArea * 0.3,
    `server export: ${duringWhite} white pixels is a filled band, not text (band is ${bandArea} pixels)`,
  );
  assert.equal(
    afterWhite,
    0,
    `server export: the caption must be gone at 1.9 s (page ends at 0.4 s + a 1.5 s linger), found ${afterWhite} white pixels`,
  );
  // The picture itself is untouched: the clip is still the green source above the band.
  const above = pixel(during, Math.round(WIDTH * 0.5), Math.round(HEIGHT * 0.3));
  assert.ok(near(above, { r: 0x00, g: 0xc0, b: 0x00 }, 60), `server export: the clip must still render, got ${show(above)}`);
  console.log(
    `render paths: server export burned the transcript's captions in (${captionMs} ms, `
    + `${duringWhite} text pixels at 0.2 s, ${afterWhite} at 1.9 s)`,
  );

  // ── B. a rendered PREVIEW frame, in the real editor ───────────────────────
  if (!existsSync(join(repoRoot, 'dist', 'index.html'))) {
    console.log('render paths: SKIPPED the preview half — no built editor at dist/ (run "npm run build").');
  } else {
    const created = spawnSync(process.execPath, [
      '--import', 'tsx', join(repoRoot, 'cli', 'occ.mjs'),
      '--data-dir', dataDir, 'project', 'new', 'D1 render paths', '--json',
    ], { cwd: repoRoot, env: { ...process.env }, encoding: 'utf8' });
    assert.equal(created.status, 0, `occ project new failed:\n${created.stdout}\n${created.stderr}`);
    const projectId = (JSON.parse(created.stdout.match(/\{[\s\S]*\}/)![0]) as { id: string }).id;

    // Seed the timeline through the project store itself (the same API the app
    // writes with), so the preview renders a project, not a test-only shape.
    const { getStoredEntry, setStoredEntry } = await import('./plugins/project-store.ts');
    const stored = await getStoredEntry(`project:${projectId}`);
    assert.ok(stored.found, 'the CLI-created project must be in the store');
    const doc = stored.value as {
      timelines: Array<Record<string, unknown>>;
      activeTimelineId: string;
    };
    const timeline = doc.timelines[0]!;
    timeline.width = WIDTH;
    timeline.height = HEIGHT;
    timeline.fps = FPS;
    // trackOrder is TOP-DOWN: the first track is the topmost layer, so the
    // subject sits above the background.
    timeline.trackOrder = ['track_v2', 'track_v1'];
    timeline.tracks = { track_v1: { kind: 'video' }, track_v2: { kind: 'video' } };
    timeline.items = [
      {
        id: 'd1-background',
        track: 'track_v1',
        startFrame: 0,
        durationInFrames: FRAMES,
        kind: 'solid',
        name: 'background',
        props: { color: '#0000ff' },
      },
      {
        id: 'd1-subject',
        track: 'track_v2',
        startFrame: 0,
        durationInFrames: FRAMES,
        kind: 'video',
        name: 'subject',
        src: `/media/uploads/${sourceName}`,
        derivedPictureSrc: matteUrl,
        derivedPictureEngine: 'rvm-mobilenetv3-v1',
        width: WIDTH,
        height: HEIGHT,
      },
    ];
    await setStoredEntry(`project:${projectId}`, doc);

    const chromePath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
    assert.ok(chromePath, `no Chromium-family browser found; tried:\n  ${CHROME_CANDIDATES.join('\n  ')}`);
    const profileDir = join(fixture, 'chrome');
    const debugPort = await freePort();
    // Chrome's own log, so a browser that dies during the render says why.
    const chromeLog = openSync(join(fixture, 'chrome.log'), 'a');
    chrome = spawn(chromePath, [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--window-size=1600,1000',
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${debugPort}`,
      'about:blank',
    ], { stdio: ['ignore', chromeLog, chromeLog], env: { ...process.env, HOME: realHome, USERPROFILE: realHome } });
    chrome.once('exit', (code, signal) => {
      console.log(`render paths: headless Chrome exited (code ${code}, signal ${signal})`);
    });
    if (process.env.RENDER_PATHS_DEBUG) {
      console.log(`render paths: chrome pid ${chrome.pid} on debug port ${debugPort}, profile ${profileDir}`);
    }
    cdp = await connectCdp(debugPort);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: `${origin}/#/editor/${projectId}` });

    // The frame rect inside the preview element: the composition is 16:9 and the
    // player letterboxes it, so sampling the element would sample its bars.
    const FRAME_RECT = `(() => {
      const element = document.querySelector('.cc-preview-canvas');
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 40) return null;
      const aspect = ${WIDTH} / ${HEIGHT};
      let width = rect.width;
      let height = rect.height;
      if (width / height > aspect) width = height * aspect;
      else height = width / aspect;
      return { x: rect.x + (rect.width - width) / 2, y: rect.y + (rect.height - height) / 2, width, height };
    })()`;

    const deadline = Date.now() + 90_000;
    let last: { centre: string; below: string } | null = null;
    let previewFrame: Rgb | null = null;
    while (Date.now() < deadline) {
      const rect = await cdp.evaluate(FRAME_RECT) as { x: number; y: number; width: number; height: number } | null;
      if (rect) {
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }) as { data: string };
        const shotFile = join(fixture, 'preview.png');
        await writeFile(shotFile, Buffer.from(shot.data, 'base64'));
        const rawFile = join(fixture, 'preview.raw');
        ffmpegRun(['-i', shotFile, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-y', rawFile]);
        const probe = JSON.parse(execFileSync(ffprobe, [
          '-v', 'error', '-print_format', 'json', '-show_streams', shotFile,
        ], { encoding: 'utf8' })) as { streams: Array<{ width: number; height: number }> };
        const shotWidth = Number(probe.streams[0]!.width);
        const shotHeight = Number(probe.streams[0]!.height);
        const data = await readFile(rawFile);
        const sample = (fx: number, fy: number): [number, number, number] => {
          const x = Math.round(rect.x + rect.width * fx);
          const y = Math.round(rect.y + rect.height * fy);
          const index = (y * shotWidth + x) * 3;
          return [data[index]!, data[index + 1]!, data[index + 2]!];
        };
        const centre = sample(0.5, 0.5);
        const below = sample(0.5, 0.85);
        last = { centre: show(centre), below: show(below) };
        if (process.env.RENDER_PATHS_DEBUG) {
          console.log(`render paths: preview sample centre ${last.centre}, background ${last.below}`);
        }
        if (near(centre, RED) && near(below, BLUE)) {
          // Crop the composition out of the screenshot, so the whole-frame
          // assertions (no green, no black) run on the picture only.
          const cropX = Math.max(0, Math.round(rect.x));
          const cropY = Math.max(0, Math.round(rect.y));
          const cropW = Math.min(shotWidth - cropX, Math.round(rect.width));
          const cropH = Math.min(shotHeight - cropY, Math.round(rect.height));
          const cropped = join(fixture, 'preview-frame.raw');
          ffmpegRun([
            '-i', shotFile, '-vf', `crop=${cropW}:${cropH}:${cropX}:${cropY},scale=${WIDTH}:${HEIGHT}`,
            '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-y', cropped,
          ]);
          const cropData = await readFile(cropped);
          assert.equal(cropData.length, WIDTH * HEIGHT * 3, 'the cropped preview frame must be one rgb24 frame');
          previewFrame = { data: cropData, width: WIDTH, height: HEIGHT };
          break;
        }
      }
      await sleep(500);
    }
    assert.ok(previewFrame, `the preview never rendered the composite; last sample ${JSON.stringify(last)}`);
    assertComposite(previewFrame, 'editor preview');
    console.log(`render paths: the editor preview honoured the applied matte (centre ${last?.centre}, background ${last?.below})`);
  }

  console.log('render paths: server export and editor preview both honour an applied matte: OK');
  console.log('render paths: server export burns a bound caption track in: OK');
} catch (error) {
  // Say what failed BEFORE the cleanup, so a cleanup problem cannot hide it.
  console.error(`render paths: FAILED — ${error instanceof Error ? error.message : String(error)}`);
  throw error;
} finally {
  cdp?.close();
  // Chrome and the server hold file locks until they have actually exited, so
  // wait for the processes (not just the kill signal) before removing the fixture.
  //
  // `child.kill()` reaches only the direct child. The server spawns render
  // children of its own and they inherit its stdout/stderr pipes, so a plain
  // kill leaves them holding the pipes open and this verify never exits (seen
  // as a hung `verify:d` with stray `tsx` trees). Take the whole tree down, then
  // drop our ends of the pipes.
  const stop = async (child: ReturnType<typeof spawn> | null): Promise<void> => {
    if (!child) return;
    const exited = new Promise<void>((done) => {
      child.once('exit', () => done());
      setTimeout(done, 10_000);
    });
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform === 'win32' && child.pid !== undefined) {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        child.kill('SIGKILL');
      }
    }
    await exited;
    child.stdout?.destroy();
    child.stderr?.destroy();
  };
  await stop(chrome);
  await stop(server?.child ?? null);
  restoreHome();
  // Deleting the fixture from THIS process never settles: the project store
  // holds an open `node:sqlite` database inside it, and the unlink of an open
  // database file blocks a threadpool thread, so `rm` hangs instead of failing
  // (measured: `rm` still pending after 20 s, process idle). Hand the deletion
  // to a short-lived detached child that runs once this process is gone; a
  // leftover temp directory is noise, a hung gate is a defect.
  spawn(process.execPath, ['-e', `
    const { rmSync } = require('node:fs');
    const target = ${JSON.stringify(fixture)};
    const deadline = Date.now() + 20_000;
    const attempt = () => {
      try { rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
      catch { if (Date.now() < deadline) setTimeout(attempt, 250); }
    };
    setTimeout(attempt, 800);
  `], { detached: true, stdio: 'ignore' }).unref();
}
