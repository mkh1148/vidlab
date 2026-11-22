// D2 · the cleaned track REPLACES the clip's audio in the mix (kit D2: "the cleaned
// track must REPLACE the clip's audio in the mix, not play on top").
//
// The claim is proven on the app's OWN export pipeline, not on the reducer field:
// a real `POST /export` against the production server, of a project whose audio
// clip carries `denoisedSrc` at full strength. The exported file is decoded and
// measured with a two-bin DFT.
//
// The fixture makes a wrong answer impossible to confuse with a right one:
//
//   source track  : 440 Hz sine   (what "playing on top of the original" would keep)
//   cleaned track : 1000 Hz sine  (what the cleaned track is)
//   background    : a solid colour clip, so the export has a picture to mux
//
// Two exports of the same project, differing only in `denoisedSrc`:
//
//   A. with the cleaned track  -> 1000 Hz dominates and 440 Hz is GONE
//   B. without it              -> 440 Hz dominates and 1000 Hz is GONE
//
// B is the control that makes A mean something: it proves the measurement can see
// the source when the source is what plays.
//
// Run: npx tsx server/media-job-voice-cleanup-mix.verify.ts   (needs `npm run build`)
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolateVerifyHome } from '../shared/verify-home.ts';
import { ffmpegBin } from './media-binaries.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const FPS = 30;
const FRAMES = 30;
const WIDTH = 320;
const HEIGHT = 240;
const SOURCE_HZ = 440;
const CLEANED_HZ = 1000;

const fixture = await mkdtemp(join(tmpdir(), 'vidlab-voice-mix-'));
const restoreHome = isolateVerifyHome(join(fixture, 'home'));
const dataDir = join(fixture, 'vidlab-data');
process.env.OPENCHATCUT_DATA_DIR = dataDir;

// Imported AFTER the redirect: the runtime profile resolves once, at module load.
const { uploadDir } = await import('./media-dir.ts');
const { mediaJobDerivedRoot } = await import('./media-job-artifact.ts');
const { voiceCleanupArtifactLocation } = await import('./media-job-voice-cleanup.ts');

const sleep = (ms: number): Promise<void> => new Promise((done) => { setTimeout(done, ms); });

function ffmpegRun(args: string[]): void {
  execFileSync(ffmpegBin(), ['-v', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
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

/** Decode an exported file's audio to mono f32 at 48 kHz. */
function decodeExportAudio(file: string): Float32Array {
  const result = spawnSync(
    ffmpegBin(),
    ['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'],
    { maxBuffer: 512 * 1024 * 1024 },
  );
  assert.equal(result.status, 0, `could not decode the export's audio: ${String(result.stderr)}`);
  const buffer = result.stdout as Buffer;
  const copy = new ArrayBuffer(buffer.byteLength - (buffer.byteLength % 4));
  new Uint8Array(copy).set(buffer.subarray(0, copy.byteLength));
  return new Float32Array(copy);
}

/**
 * Energy at one frequency, by a single-bin DFT over the middle of the signal.
 *
 * A single bin is enough here because the two fixtures are pure sines 560 Hz
 * apart: there is no leakage question to answer, only "which tone is present".
 */
function toneEnergy(samples: Float32Array, hz: number, sampleRate = 48_000): number {
  const from = Math.round(samples.length * 0.25);
  const to = Math.round(samples.length * 0.75);
  const count = to - from;
  if (count <= 0) return 0;
  let real = 0;
  let imaginary = 0;
  const omega = (2 * Math.PI * hz) / sampleRate;
  for (let index = 0; index < count; index += 1) {
    const value = samples[from + index]!;
    real += value * Math.cos(omega * index);
    imaginary += value * Math.sin(omega * index);
  }
  return Math.sqrt((real * real + imaginary * imaginary) / count);
}

const dB = (value: number): number => (value > 0 ? 20 * Math.log10(value) : -Infinity);

let server: { child: ReturnType<typeof spawn> } | null = null;
try {
  // ── the fixtures, placed where the app serves them ────────────────────────
  const sourceName = 'd2-mix-source.wav';
  const uploads = uploadDir();
  await mkdir(uploads, { recursive: true });
  const sourceFile = join(uploads, sourceName);
  ffmpegRun(['-f', 'lavfi', '-i', `sine=frequency=${SOURCE_HZ}:sample_rate=48000:duration=2`,
    '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', sourceFile]);

  // The cleaned artifact goes exactly where the engine would have put it, so the
  // URL the export reads is the URL the engine produces.
  const location = voiceCleanupArtifactLocation({ sourceName, sourceFile, revision: 'r1' });
  await mkdir(location.dir, { recursive: true });
  ffmpegRun(['-f', 'lavfi', '-i', `sine=frequency=${CLEANED_HZ}:sample_rate=48000:duration=2`,
    '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', location.file]);
  assert.ok(location.dir.startsWith(mediaJobDerivedRoot()), 'the artifact sits under the derived root');
  assert.match(location.url, /^\/media\/derived\/[^/]+\/[^/]+$/, 'and its URL is the two-segment derived shape');
  console.log(`voice mix: fixtures ready — source ${SOURCE_HZ} Hz, cleaned ${CLEANED_HZ} Hz`);

  const port = await freePort();
  const started = await startServer(port);
  server = started;
  const origin = started.origin;

  const exportProject = (withCleaned: boolean) => ({
    state: {
      fps: FPS,
      width: WIDTH,
      height: HEIGHT,
      selectedId: null,
      items: [
        {
          id: 'd2-background',
          track: 'V1',
          startFrame: 0,
          durationInFrames: FRAMES,
          kind: 'solid',
          name: 'background',
          props: { color: '#202020' },
        },
        {
          id: 'd2-voice',
          track: 'A1',
          startFrame: 0,
          durationInFrames: FRAMES,
          kind: 'audio',
          name: 'voice',
          src: `/media/uploads/${sourceName}`,
          ...(withCleaned ? { denoisedSrc: location.url, denoiseStrength: 100 } : {}),
        },
      ],
    },
    format: 'video',
    codec: 'h264',
    resolution: '480p',
    fps: FPS,
    name: withCleaned ? 'd2-mix-cleaned' : 'd2-mix-source',
  });

  const exportOnce = async (withCleaned: boolean): Promise<Float32Array> => {
    const response = await fetch(`${origin}/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, 'sec-fetch-site': 'none' },
      body: JSON.stringify(exportProject(withCleaned)),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200, `server export failed: ${bytes.toString('utf8').slice(0, 400)}`);
    const exported = join(fixture, withCleaned ? 'export-cleaned.mp4' : 'export-source.mp4');
    await writeFile(exported, bytes);
    return decodeExportAudio(exported);
  };

  // ── A. with the cleaned track: it REPLACES the source ────────────────────
  const cleaned = await exportOnce(true);
  const cleanedAtCleanedTone = dB(toneEnergy(cleaned, CLEANED_HZ));
  const cleanedAtSourceTone = dB(toneEnergy(cleaned, SOURCE_HZ));
  assert.ok(cleanedAtCleanedTone > -40,
    `the export must carry the cleaned track (${CLEANED_HZ} Hz at ${cleanedAtCleanedTone.toFixed(1)} dB)`);
  assert.ok(cleanedAtCleanedTone - cleanedAtSourceTone > 20,
    `the cleaned track must REPLACE the source, not play on top of it: ${CLEANED_HZ} Hz `
    + `${cleanedAtCleanedTone.toFixed(1)} dB vs ${SOURCE_HZ} Hz ${cleanedAtSourceTone.toFixed(1)} dB `
    + `(${(cleanedAtCleanedTone - cleanedAtSourceTone).toFixed(1)} dB apart)`);

  // ── B. the control: without it, the source is what plays ─────────────────
  const source = await exportOnce(false);
  const sourceAtSourceTone = dB(toneEnergy(source, SOURCE_HZ));
  const sourceAtCleanedTone = dB(toneEnergy(source, CLEANED_HZ));
  assert.ok(sourceAtSourceTone > -40,
    `the control export must carry the source (${SOURCE_HZ} Hz at ${sourceAtSourceTone.toFixed(1)} dB)`);
  assert.ok(sourceAtSourceTone - sourceAtCleanedTone > 20,
    `the control must not contain the cleaned tone: ${SOURCE_HZ} Hz ${sourceAtSourceTone.toFixed(1)} dB vs `
    + `${CLEANED_HZ} Hz ${sourceAtCleanedTone.toFixed(1)} dB`);

  console.log(`voice mix: export with the cleaned track is ${CLEANED_HZ} Hz by `
    + `${(cleanedAtCleanedTone - cleanedAtSourceTone).toFixed(1)} dB; without it the export is ${SOURCE_HZ} Hz by `
    + `${(sourceAtSourceTone - sourceAtCleanedTone).toFixed(1)} dB — the cleaned track replaces the source in the mix`);
  console.log('media-job voice cleanup mix: the export uses the cleaned track, the original is gone: OK');
} finally {
  if (server) {
    server.child.kill('SIGKILL');
    await sleep(200);
  }
  restoreHome();
  await rm(fixture, { recursive: true, force: true });
}
