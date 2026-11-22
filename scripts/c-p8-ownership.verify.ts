// Milestone C · P8 regression: a crashed agent must not lock a project out.
//
// The shape at v0.2.17: the offline owner's claim is leased for 90 s and only a
// slow idle sweep releases it, so an agent process that dies mid-session leaves
// every other client refused ("busy") for a minute and a half. The fix keeps the
// lease for a live owner (a returning owner that renews first keeps its session)
// and lets another client take over once the owner has been quiet past a short
// quiet period.
//
// Run: npx tsx scripts/c-p8-ownership.verify.ts   (needs `npm run build` first)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { freePort, repoRoot, scratchDir, startProdServer } from './a1-harness.mjs';
import { connectMcp, sleep } from './c-harness.ts';

const dist = join(repoRoot, 'dist');
assert.ok(existsSync(join(dist, 'index.html')), 'run "npm run build" first (P9)');

const home = await scratchDir('home');
const dataDir = await scratchDir('data');
const port = await freePort();
const token = 'c-p8-token-0123456789';
const server = await startProdServer({ home, dataDir, port, extraEnv: { OPENCHATCUT_MCP_TOKEN: token } });

/** A separate OS process holding the project, so the check can kill it dead. */
function startAgentProcess(projectId: string, name: string) {
  const code = `
    import { Client } from '@modelcontextprotocol/sdk/client/index.js';
    import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
    const client = new Client({ name: ${JSON.stringify(name)}, version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(
      new URL('http://127.0.0.1:${port}/api/external-mcp/mcp'),
      { requestInit: { headers: { Authorization: 'Bearer ${token}' } } },
    ));
    const targeted = await client.callTool({ name: 'target_project', arguments: { projectId: ${JSON.stringify(projectId)} } });
    const begun = await client.callTool({ name: 'begin_edit_session', arguments: { clientName: ${JSON.stringify(name)}, approvalMode: 'auto' } });
    const sessionId = begun.structuredContent?.editSessionId;
    // Real committed work before the crash, so the check can prove nothing was lost.
    const placed = await client.callTool({ name: 'edit_item', arguments: {
      adds: [{ type: 'solid', color: '#1a1a1a' }], editSessionId: sessionId,
    } });
    process.stdout.write('READY ' + JSON.stringify({
      targeted: targeted.isError !== true,
      begun: begun.isError !== true,
      placed: placed.isError !== true,
      session: sessionId,
    }) + '\\n');
    setInterval(() => {}, 1000);
  `;
  return spawn(process.execPath, ['--input-type=module', '-e', code], {
    cwd: repoRoot,
    env: { ...process.env, USERPROFILE: home, HOME: home, OPENCHATCUT_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const waitForLine = (child: ReturnType<typeof startAgentProcess>, timeoutMs = 60_000): Promise<string> =>
  new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`agent process never became ready: ${buffer}`)), timeoutMs);
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      if (!buffer.includes('READY')) return;
      clearTimeout(timer);
      resolve(buffer);
    });
    child.stderr.on('data', (chunk) => { buffer += String(chunk); });
    child.once('exit', (exitCode) => {
      clearTimeout(timer);
      if (!buffer.includes('READY')) reject(new Error(`agent process exited (${exitCode}): ${buffer}`));
    });
  });

const claim = async (client: Awaited<ReturnType<typeof connectMcp>>['client'], projectId: string) => {
  const targeted = await client.callTool({ name: 'target_project', arguments: { projectId } });
  if (targeted.isError === true) return { ok: false, reason: JSON.stringify(targeted.structuredContent).slice(0, 200), sessionId: '' };
  const begun = await client.callTool({ name: 'begin_edit_session', arguments: { clientName: 'second', approvalMode: 'auto' } });
  return begun.isError === true
    ? { ok: false, reason: JSON.stringify(begun.structuredContent).slice(0, 200), sessionId: '' }
    : { ok: true, reason: '', sessionId: String((begun.structuredContent as Record<string, any>)?.editSessionId ?? '') };
};

try {
  const owner = await connectMcp(port, token, 'c-p8-owner');
  const created = await owner.client.callTool({ name: 'create_project', arguments: { name: 'C P8' } });
  const projectId = (created.structuredContent as Record<string, any>).id as string;
  await owner.close();

  // ── the owner takes the project and then dies mid-session ────────────────
  const agent = startAgentProcess(projectId, 'c-p8-agent');
  const ready = await waitForLine(agent);
  assert.ok(ready.includes('"begun":true'), `the agent must hold the project: ${ready.slice(0, 300)}`);
  assert.ok(ready.includes('"placed":true'), `the agent must place a clip before it dies: ${ready.slice(0, 300)}`);
  agent.kill('SIGKILL');
  await new Promise((resolve) => { agent.once('exit', resolve); });
  const killedAt = Date.now();

  // ── a second client is refused while the dead owner is still fresh ───────
  const second = await connectMcp(port, token, 'c-p8-second');
  const whileFresh = await claim(second.client, projectId);
  const freshMs = Date.now() - killedAt;
  assert.equal(whileFresh.ok, false, 'a second client must be refused while the owner is fresh');

  // ── and accepted once the owner has been quiet past the quiet period ─────
  let after = whileFresh;
  while (!after.ok && Date.now() - killedAt < 120_000) {
    await sleep(1_000);
    after = await claim(second.client, projectId);
  }
  const takeoverMs = Date.now() - killedAt;
  assert.equal(after.ok, true, `a second client must take over after the quiet period: ${after.reason}`);

  // ── the work the dead owner committed is still there ─────────────────────
  const read = await second.client.callTool({ name: 'read_project', arguments: { editSessionId: after.sessionId } });
  const timelines = ((read.structuredContent as Record<string, any>)?.timelines ?? []) as Array<Record<string, any>>;
  const itemCount = (timelines.find((entry) => entry.active) ?? timelines[0])?.itemCount;
  assert.notEqual(read.isError, true, `the taken-over session must read the project: ${JSON.stringify(read.structuredContent).slice(0, 300)}`);
  assert.equal(itemCount, 1, 'the clip the crashed owner placed must survive the takeover');

  // ── a returning owner that renews first keeps its session ────────────────
  const returning = await connectMcp(port, token, 'c-p8-returning');
  const returningClaim = await claim(returning.client, projectId);
  assert.equal(returningClaim.ok, false, 'the live owner must not be evicted by a returning one');

  console.log(
    `c-p8-ownership.verify: refused while fresh (${freshMs} ms after the kill), `
    + `taken over after ${takeoverMs} ms of quiet, live owner kept its session`,
  );
  await returning.close();
  await second.close();
} finally {
  await server.stop();
  for (const dir of [home, dataDir]) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  }
}
