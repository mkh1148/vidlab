// Shared harness for the Milestone C checks.
//
// The C checks are the first ones that need BOTH sides of the bridge at once: an
// MCP client on one end and a real headless Chrome running the editor on the
// other. A fake bridge cannot reproduce the ordering defect (P1) — the pending
// autosave it races lives in the renderer — so every C check drives the real
// production server, a real browser, and the real MCP transport, each with its
// own port, data directory, profile and HOME.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { request } from './a1-harness.mjs';
import { revisionOf } from '../src/agent/external-edit-session.ts';
import type { ProjectDoc } from '../src/editor/types.ts';

const require = createRequire(import.meta.url);
export const ffmpeg: string = require('ffmpeg-static');
export const ffprobe: string = require('@ffprobe-installer/ffprobe').path;

export const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

export type CdpSend = (method: string, params?: Record<string, unknown>) => Promise<any>;

export interface ChromeSession {
  send: CdpSend;
  close: () => void;
}

/** Headless Chrome with a fresh profile, driven over CDP. */
export async function launchChrome(debugPort: number, profileDir: string): Promise<ChromeSession> {
  const child: ChildProcess = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileDir}`,
    '--window-size=1600,1000', 'about:blank',
  ], { stdio: 'ignore' });
  const wsUrl = await targetWebSocket(debugPort);
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (error) => reject(error));
  });
  let id = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  ws.on('message', (raw: Buffer) => {
    const message = JSON.parse(raw.toString());
    if (!message.id || !pending.has(message.id)) return;
    const entry = pending.get(message.id)!;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });
  const send: CdpSend = (method, params = {}) => new Promise((resolve, reject) => {
    id += 1;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Page.enable');
  await send('Runtime.enable');
  return {
    send,
    close: () => {
      try { ws.close(); } catch { /* already gone */ }
      child.kill();
    },
  };
}

async function targetWebSocket(debugPort: number): Promise<string> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json() as Array<{
        type: string; webSocketDebuggerUrl?: string;
      }>;
      const page = list.find((target) => target.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* devtools not listening yet */ }
    await sleep(250);
  }
  throw new Error('chrome devtools never came up');
}

/** Evaluate an expression in the page and return its JSON value. */
export async function evaluate<T>(send: CdpSend, expression: string): Promise<T> {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) {
    throw new Error(`page evaluation failed: ${result.exceptionDetails.text ?? 'unknown error'}`);
  }
  return result.result.value as T;
}

/** Poll a page expression until it is truthy. */
export async function waitFor<T>(
  send: CdpSend,
  expression: string,
  { timeoutMs = 30_000, label = expression, intervalMs = 100 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    last = await evaluate<T>(send, expression);
    if (last) return last as T;
    await sleep(intervalMs);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${label} (last value ${JSON.stringify(last)})`);
}

/** Click the first element matching a selector inside the page. */
export async function click(send: CdpSend, selector: string): Promise<boolean> {
  return evaluate<boolean>(send, `(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return false;
    node.click();
    return true;
  })()`);
}

export interface McpConnection {
  client: Client;
  close: () => Promise<void>;
}

/** An MCP client on the Streamable HTTP transport, authorized by the token. */
export async function connectMcp(port: number, token: string, name: string): Promise<McpConnection> {
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/api/external-mcp/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  ));
  return { client, close: () => client.close() };
}

/** The committed revision of a project document in the shared store. */
export async function storeRevision(port: number, projectId: string): Promise<string | null> {
  const response = await request(port, `/api/project-store/entry?key=${encodeURIComponent(`project:${projectId}`)}`, {
    headers: { 'sec-fetch-site': 'none' },
  });
  const body = JSON.parse(response.text()) as { found?: boolean; value?: ProjectDoc };
  return body.found && body.value ? revisionOf(body.value) : null;
}

/** The committed document itself — the owner-visible project, after autosave. */
export async function storeDoc(port: number, projectId: string): Promise<ProjectDoc | null> {
  const response = await request(port, `/api/project-store/entry?key=${encodeURIComponent(`project:${projectId}`)}`, {
    headers: { 'sec-fetch-site': 'none' },
  });
  const body = JSON.parse(response.text()) as { found?: boolean; value?: ProjectDoc };
  return body.found && body.value ? body.value : null;
}

/** Item count of the active timeline in a stored document. */
export function activeTimelineItemCount(doc: ProjectDoc | null): number {
  if (!doc) return -1;
  const timelines = (doc.timelines ?? []) as Array<Record<string, any>>;
  const active = timelines.find((entry) => entry.id === doc.activeTimelineId) ?? timelines[0];
  const items = (active?.items ?? []) as unknown[];
  return items.length;
}

/** A generated clip — never owner media. */
export function generateClip(dir: string, name: string, { color = 'red', seconds = 2, size = '320x180' } = {}): string {
  const file = join(dir, name);
  execFileSync(ffmpeg, [
    '-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}:d=${seconds}:r=30`,
    '-pix_fmt', 'yuv420p', file, '-y',
  ]);
  return file;
}

export interface FrameProbe {
  width: number;
  height: number;
  frames: number;
  durationSeconds: number;
  codec: string;
}

/** ffprobe a file: the export must be a real, complete video. */
export function probeVideo(file: string): FrameProbe {
  const probe = JSON.parse(execFileSync(ffprobe, [
    '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file,
  ], { encoding: 'utf8' })) as {
    streams: Array<{ codec_type: string; codec_name: string; width: number; height: number; nb_frames: string }>;
    format: { duration: string };
  };
  const video = probe.streams.find((stream) => stream.codec_type === 'video');
  if (!video) throw new Error('the export carries no video stream');
  return {
    width: video.width,
    height: video.height,
    frames: Number(video.nb_frames),
    durationSeconds: Number(probe.format.duration),
    codec: video.codec_name,
  };
}

/** One decoded RGB frame, as a pixel reader. */
export function readFrame(file: string, frame: number, width: number, height: number, scratch: string) {
  const raw = join(scratch, `frame-${frame}.raw`);
  execFileSync(ffmpeg, [
    '-v', 'error', '-i', file, '-vf', `select=eq(n\\,${frame})`, '-vframes', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw, '-y',
  ]);
  const bytes = require('node:fs').readFileSync(raw) as Buffer;
  return {
    bytes,
    pixel: (x: number, y: number): [number, number, number] => {
      const index = (y * width + x) * 3;
      return [bytes[index], bytes[index + 1], bytes[index + 2]];
    },
    size: bytes.length,
    expected: width * height * 3,
  };
}

/** Download an export the agent produced through the MCP gateway. */
export async function downloadExport(port: number, downloadUrl: string, target: string): Promise<Buffer> {
  const path = downloadUrl.startsWith('http') ? new URL(downloadUrl).pathname + new URL(downloadUrl).search : downloadUrl;
  const response = await request(port, path, { headers: { 'sec-fetch-site': 'none' } });
  if (response.status !== 200) throw new Error(`export download failed: ${response.status} ${response.text().slice(0, 200)}`);
  require('node:fs').writeFileSync(target, response.body);
  return response.body;
}
