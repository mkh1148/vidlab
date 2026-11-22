// Milestone C · P1 regression: a tool result must never be reported before the
// change it made is committed, or the agent's next call carries an outdated
// revision and the session drops.
//
// The check runs the two shapes that reproduce at v0.2.17, five times each,
// against a REAL headless Chrome on the bridge:
//   1. the kit's shape — import a generated clip, then immediately place it;
//   2. the shape that actually drops the session — a real-project tool (it
//      mutates the live document) followed at once by another call.
// Before the fix, shape 2 failed on the first iteration with "stale"; shape 1
// never failed, because the draft path commits explicitly before it answers.
//
// Run: npx tsx scripts/c-p1-ordering.verify.ts   (needs `npm run build` first)
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { freePort, repoRoot, scratchDir, startProdServer } from './a1-harness.mjs';
import { connectMcp, generateClip, launchChrome, sleep, storeRevision } from './c-harness.ts';

const dist = join(repoRoot, 'dist');
assert.ok(existsSync(join(dist, 'index.html')), 'run "npm run build" first (P9)');
const ROUNDS = 5;

const home = await scratchDir('home');
const dataDir = await scratchDir('data');
const profile = await scratchDir('chrome');
const mediaDir = await scratchDir('media');
const port = await freePort();
const debugPort = await freePort();
const token = 'c-p1-token-0123456789';

// Distinct content per round: the pool skips duplicate media by content hash.
const CLIP_COLORS = ['red', 'blue', 'green', 'yellow', 'white'];
const clips = Array.from({ length: ROUNDS }, (_, index) => generateClip(
  mediaDir, `c-p1-clip-${index}.mp4`, { color: CLIP_COLORS[index]!, seconds: 1 },
));
const server = await startProdServer({
  home, dataDir, port,
  extraEnv: { OPENCHATCUT_MCP_TOKEN: token, AGENT_IMPORT_ROOTS: mediaDir },
});
const chrome = await launchChrome(debugPort, profile);
const mcp = await connectMcp(port, token, 'c-p1');
const { client } = mcp;

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args });
  return { result, body: (result.structuredContent ?? {}) as Record<string, any> };
};
const must = async (name: string, args: Record<string, unknown> = {}) => {
  const { result, body } = await call(name, args);
  assert.notEqual(result.isError, true, `${name} failed: ${JSON.stringify(result.structuredContent).slice(0, 300)}`);
  return body;
};

try {
  const created = await must('create_project', { name: 'C P1', editorBaseUrl: `http://127.0.0.1:${port}` });
  const projectId = created.id as string;
  await chrome.send('Page.navigate', { url: `http://127.0.0.1:${port}/#/editor/${projectId}` });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const status = await must('openchatcut_status');
    if ((status.connectedProjectIds as string[] | undefined)?.includes(projectId)) break;
    await sleep(500);
  }
  await must('target_project', { projectId });

  const importPlace: number[] = [];
  const realTool: number[] = [];

  for (let round = 0; round < ROUNDS; round += 1) {
    // ── shape 1: import, then place at once ────────────────────────────────
    const started = Date.now();
    const session = await must('begin_edit_session', { clientName: `c-p1 ${round}`, approvalMode: 'auto' });
    const editSessionId = session.editSessionId as string;
    const imported = await must('import_asset', { path: clips[round], editSessionId });
    const assetId = imported.imported[0].id as string;
    const placed = await must('edit_item', { adds: [{ type: 'video', assetId, track: 'V1' }], editSessionId });
    assert.ok(placed.results[0].placed.itemId, 'the clip must be placed');
    // The store must already carry the change when the tool answers (P1).
    const revision = await storeRevision(port, projectId);
    assert.ok(revision, 'the project must be committed');
    const reviewed = await must('review_edit_session', { editSessionId, summary: `round ${round}` });
    assert.equal(reviewed.status, 'applied', `round ${round}: the draft must apply`);
    importPlace.push(Date.now() - started);

    // ── shape 2: a real-project tool, then the next call at once ───────────
    const startedReal = Date.now();
    const realSession = await must('begin_edit_session', { clientName: `c-p1 real ${round}`, approvalMode: 'auto' });
    const realSessionId = realSession.editSessionId as string;
    const renamed = await must('manage_media_pool', {
      action: 'rename_asset', assetIds: assetId, newName: `c-p1 renamed ${round}`, editSessionId: realSessionId,
    });
    assert.ok(JSON.stringify(renamed).includes('renamed'), `round ${round}: the real tool must apply: ${JSON.stringify(renamed).slice(0, 200)}`);
    const next = await call('read_project', { editSessionId: realSessionId });
    assert.notEqual(next.result.isError, true,
      `round ${round}: the call after a real tool must not be stale: ${JSON.stringify(next.result.structuredContent).slice(0, 300)}`);
    // A draft tool after the real tool: the session snapshot must have advanced
    // with the change the real tool committed, or the editor refuses it.
    const text = await call('edit_item', {
      adds: [{ type: 'text', text: `round ${round}` }], editSessionId: realSessionId,
    });
    assert.notEqual(text.result.isError, true,
      `round ${round}: a draft tool after a real tool must not be stale: ${JSON.stringify(text.result.structuredContent).slice(0, 300)}`);
    realTool.push(Date.now() - startedReal);

    const info = await must('get_edit_session', { editSessionId: realSessionId });
    assert.equal(info.stale, false, `round ${round}: the session must stay fresh`);
    assert.equal(info.status, 'drafting');
    await must('discard_edit_session', { editSessionId: realSessionId });
  }

  const median = (values: number[]): number => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  console.log(
    `c-p1-ordering.verify: ${ROUNDS}/${ROUNDS} rounds green; import→place median ${median(importPlace)} ms `
    + `(${importPlace.join(', ')}), real tool→next call median ${median(realTool)} ms (${realTool.join(', ')})`,
  );
} finally {
  await mcp.close().catch(() => undefined);
  chrome.close();
  await server.stop();
  for (const dir of [home, dataDir, profile, mediaDir]) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  }
}
