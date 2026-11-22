// Milestone C · the backbone: an external agent does real work on a project
// through the MCP gateway, from a raw file to an exported video, with a REAL
// headless Chrome on the other side of the bridge.
//
// A fake bridge cannot carry this check: the ordering defect (P1) lives in the
// renderer's autosave, and the owner's controls live in the real UI. So the
// script drives the production server, the real MCP Streamable HTTP transport,
// and a real browser, then proves the delivered file with ffprobe and a pixel
// sample of the effect it asked for.
//
// Run: npx tsx scripts/c-mcp-e2e.verify.ts   (needs `npm run build` first)
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { freePort, repoRoot, scratchDir, startProdServer } from './a1-harness.mjs';
import {
  activeTimelineItemCount, click, connectMcp, downloadExport, evaluate, generateClip,
  launchChrome, probeVideo, readFrame, sleep, storeDoc, storeRevision, waitFor,
} from './c-harness.ts';

const dist = join(repoRoot, 'dist');
assert.ok(existsSync(join(dist, 'index.html')), 'run "npm run build" first (P9)');

const home = await scratchDir('home');
const dataDir = await scratchDir('data');
const profile = await scratchDir('chrome');
const mediaDir = await scratchDir('media');
const port = await freePort();
const debugPort = await freePort();
const token = 'c-e2e-token-0123456789';
const timings: Record<string, number> = {};
const mark = (label: string, startedAt: number): void => { timings[label] = Date.now() - startedAt; };

const clip = generateClip(mediaDir, 'c-e2e-clip.mp4', { color: 'red', seconds: 2 });
const server = await startProdServer({
  home, dataDir, port,
  extraEnv: { OPENCHATCUT_MCP_TOKEN: token, AGENT_IMPORT_ROOTS: mediaDir },
});
const chrome = await launchChrome(debugPort, profile);
const mcp = await connectMcp(port, token, 'c-e2e');
const { client } = mcp;

const tool = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args });
  return { result, body: result.structuredContent as Record<string, any> | undefined };
};
const must = async (name: string, args: Record<string, unknown> = {}) => {
  const { result, body } = await tool(name, args);
  assert.notEqual(result.isError, true, `${name} failed: ${JSON.stringify(result.structuredContent).slice(0, 400)}`);
  return body ?? {};
};

try {
  // ── 1. the agent creates the project ─────────────────────────────────────
  const started = Date.now();
  const created = await must('create_project', { name: 'C e2e', editorBaseUrl: `http://127.0.0.1:${port}` });
  const projectId = created.id as string;
  mark('create_project', started);

  // ── 2. the owner opens the editor (a real browser on the bridge) ─────────
  const opened = Date.now();
  await chrome.send('Page.navigate', { url: `http://127.0.0.1:${port}/#/editor/${projectId}` });
  await waitFor(chrome.send, `!!document.querySelector('canvas, [data-timeline], body')`, { timeoutMs: 60_000, label: 'editor shell' });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const status = await must('openchatcut_status');
    if ((status.connectedProjectIds as string[] | undefined)?.includes(projectId)) break;
    await sleep(500);
  }
  const status = await must('openchatcut_status');
  assert.ok((status.connectedProjectIds as string[]).includes(projectId), 'the browser must register as the project editor');
  const toolCount = status.editors[0].toolCount as number;
  mark('editor_connected', opened);

  await must('target_project', { projectId });

  // ── 3. the agent works the project through a drafting session ────────────
  const session = await must('begin_edit_session', { clientName: 'c-e2e', approvalMode: 'auto' });
  const editSessionId = session.editSessionId as string;
  assert.equal(session.status, 'drafting');

  const imported = await must('import_asset', { path: clip, editSessionId });
  const assetId = imported.imported[0].id as string;
  assert.ok(assetId, 'the generated clip must land in the pool');

  const placed = await must('edit_item', {
    adds: [{ type: 'video', assetId, track: 'V1' }],
    editSessionId,
  });
  const placedItemId = placed.results[0].placed.itemId as string;

  // The effect the pixel test will look for: a per-clip GL invert, which turns
  // the red source cyan — a value no other part of the composition produces.
  const effected = await must('manage_effects', {
    action: 'add',
    targetItemId: placedItemId,
    assetId: 'builtin:fx-invert',
    editSessionId,
  });
  assert.ok(JSON.stringify(effected).includes('fx-invert'), `the effect must be attached: ${JSON.stringify(effected).slice(0, 300)}`);

  // ── 4. the owner sees the steps and approves them ────────────────────────
  const reviewed = await must('review_edit_session', { editSessionId, summary: 'C e2e: one clip, one effect' });
  assert.equal(reviewed.status, 'applied', `auto session must apply on review: ${JSON.stringify(reviewed).slice(0, 300)}`);

  const visible = await waitFor<boolean>(
    chrome.send,
    `document.body.innerText.includes('c-e2e-clip')`,
    { timeoutMs: 20_000, label: 'the clip name in the timeline' },
  );
  assert.equal(visible, true, 'the owner must see the agent step in the interface');

  // ── 5. a sensitive tool asks the owner, in the UI, before it runs ────────
  // A manual session's real tool has to be approved in the editor. The retry
  // after the click is also the P1 shape: the next call of the same session
  // must not be refused as stale by the change the tool itself committed.
  const guardSession = await must('begin_edit_session', { clientName: 'c-e2e guard', approvalMode: 'manual' });
  const guardSessionId = guardSession.editSessionId as string;
  const renameArgs = {
    action: 'rename_asset', assetIds: assetId, newName: 'c-e2e renamed', editSessionId: guardSessionId,
  };
  const guarded = await tool('manage_media_pool', renameArgs);
  const guardBody = guarded.body ?? {};
  assert.equal(guardBody.needs_confirmation, true, `a real tool must ask first: ${JSON.stringify(guardBody).slice(0, 300)}`);
  const confirmationId = guardBody.confirmationId as string;

  const dialogText = await waitFor<string>(
    chrome.send,
    `(() => { const d = document.querySelector('[role=alertdialog]'); return d ? d.innerText : '' })()`,
    { timeoutMs: 20_000, label: 'the confirmation card' },
  );
  assert.ok(dialogText.includes(confirmationId), `the card must name the pending approval: ${dialogText.slice(0, 200)}`);
  const confirmed = await click(chrome.send, '[role=alertdialog] button');
  assert.equal(confirmed, true, 'the confirmation card must carry a button');
  await waitFor<boolean>(chrome.send, `!document.querySelector('[role=alertdialog]')`, { timeoutMs: 10_000, label: 'the card to close' });

  const renamed = await must('manage_media_pool', renameArgs);
  assert.ok(JSON.stringify(renamed).includes('c-e2e renamed'), `the approved tool must run: ${JSON.stringify(renamed).slice(0, 300)}`);
  const afterRealTool = await must('read_project', { editSessionId: guardSessionId });
  assert.ok(afterRealTool.timeline, 'the session must survive the change its own real tool committed (P1)');

  // ── 6. the agent exports and downloads the video ─────────────────────────
  await must('discard_edit_session', { editSessionId: guardSessionId });
  const exportSession = await must('begin_edit_session', { clientName: 'c-e2e export', approvalMode: 'auto' });
  const exportSessionId = exportSession.editSessionId as string;
  const renderStarted = Date.now();
  const submitted = await must('submit_render_job', {
    format: 'video', codec: 'h264', resolution: '720p', fps: 30,
    name: 'c-e2e-export', editSessionId: exportSessionId,
  });
  const renderId = (submitted.renderId ?? submitted.id) as string;
  assert.ok(renderId, `the render must start: ${JSON.stringify(submitted).slice(0, 300)}`);

  let downloadUrl = '';
  for (let attempt = 0; attempt < 40 && !downloadUrl; attempt += 1) {
    const polled = await must('track_export', { action: 'wait', renderIds: renderId, timeoutSeconds: 20, editSessionId: exportSessionId });
    const jobs = (polled.jobs ?? polled.renderJobs ?? [polled]) as Array<Record<string, any>>;
    const job = jobs.find((entry) => entry.downloadUrl) ?? jobs[0];
    assert.notEqual(job?.status, 'failed', `the render failed: ${JSON.stringify(job).slice(0, 400)}`);
    downloadUrl = (job?.downloadUrl as string) ?? '';
  }
  assert.ok(downloadUrl, 'the export must finish with a download URL');
  mark('render', renderStarted);

  const file = join(dataDir, 'c-e2e-export.mp4');
  const bytes = await downloadExport(port, downloadUrl, file);
  assert.ok(bytes.length > 10_000, `the export must carry a picture, got ${bytes.length} bytes`);

  // ── 7. ffprobe + pixel proof that the effect is in the picture ───────────
  const probed = probeVideo(file);
  assert.equal(probed.codec, 'h264');
  assert.equal(probed.width, 1280);
  assert.equal(probed.height, 720);
  assert.ok(probed.frames >= 55, `the export must carry the 2 s timeline, got ${probed.frames} frames`);

  const frame = readFrame(file, 10, probed.width, probed.height, dataDir);
  assert.equal(frame.size, frame.expected, 'the decoded frame must be a full RGB frame');
  const centre = frame.pixel(640, 360);
  // Red source + invert = cyan. A missing effect leaves red; a missing clip
  // leaves black. Both are distinguishable from the value asserted here.
  assert.ok(
    centre[1] > 150 && centre[2] > 150 && centre[0] < 100,
    `the invert effect must be in the exported picture, got rgb(${centre.join(',')})`,
  );

  // ── 8. the owner can undo the agent's step ───────────────────────────────
  const beforeUndo = await must('read_project', { editSessionId: exportSessionId });
  const itemCount = (read: Record<string, any>): number => {
    const timelines = (read.timelines ?? []) as Array<Record<string, any>>;
    return (timelines.find((entry) => entry.active) ?? timelines[0])?.itemCount as number;
  };
  const itemsBefore = itemCount(beforeUndo);
  assert.ok(itemsBefore >= 1, `the applied proposal must be on the timeline: ${JSON.stringify(beforeUndo).slice(0, 700)}`);
  const revisionBeforeUndo = await storeRevision(port, projectId);
  const undoEnabled = await evaluate<boolean>(chrome.send, `(() => {
    const node = document.querySelector('button[aria-label="Undo"], button[aria-label="撤销"]');
    return !!node && !node.disabled;
  })()`);
  assert.equal(undoEnabled, true, 'the undo control must be enabled after the agent applied its work');
  const undoClicked = await click(chrome.send, 'button[aria-label="Undo"], button[aria-label="撤销"]');
  assert.equal(undoClicked, true, 'the editor must expose an undo control');
  let revisionAfterUndo = revisionBeforeUndo;
  for (let attempt = 0; attempt < 40 && revisionAfterUndo === revisionBeforeUndo; attempt += 1) {
    await sleep(250);
    revisionAfterUndo = await storeRevision(port, projectId);
  }
  assert.ok(revisionAfterUndo && revisionAfterUndo !== revisionBeforeUndo,
    `the owner's undo must reach the stored project (${revisionBeforeUndo} → ${revisionAfterUndo})`);

  // The owner's edit wins: the agent's session was built on a document that no
  // longer exists, so the gateway refuses its next call as stale (the draft is
  // pinned to the revision it was opened on) and the draft is orphaned — only an
  // explicit recovery can touch it. Nothing is overwritten behind the owner's
  // back.
  const staleAfterUndo = await tool('read_project', { editSessionId: exportSessionId });
  assert.equal(staleAfterUndo.result.isError, true,
    `an owner edit must invalidate the agent session: ${JSON.stringify(staleAfterUndo.result.structuredContent).slice(0, 300)}`);
  assert.equal(staleAfterUndo.body?.outcome, 'stale',
    `the gateway must refuse the retired session as stale: ${JSON.stringify(staleAfterUndo.body).slice(0, 300)}`);
  await must('target_project', { projectId });
  const listed = await must('list_edit_sessions');
  const sessions = (listed.result ?? listed.sessions ?? listed.editSessions ?? listed) as Array<Record<string, any>>;
  const retired = sessions.find((entry) => entry.editSessionId === exportSessionId);
  assert.equal(retired?.orphaned, true,
    `the owner's edit must orphan the agent draft: ${JSON.stringify(retired).slice(0, 400)}`);
  assert.equal(retired?.ownerOnline, false, 'an orphaned draft must not read as owned');
  assert.deepEqual(retired?.recoveryActions, ['discard'],
    'a draft the project moved past can only be discarded');

  // Undo keeps stepping back through the agent's work until the clip it added
  // is gone from the owner's project. The stored document is the owner's view,
  // so the check reads it rather than the agent's (now retired) session.
  let remaining = activeTimelineItemCount(await storeDoc(port, projectId));
  for (let step = 0; step < 6 && remaining > 0; step += 1) {
    await click(chrome.send, 'button[aria-label="Undo"], button[aria-label="撤销"]');
    await sleep(1_200);
    remaining = activeTimelineItemCount(await storeDoc(port, projectId));
  }
  assert.equal(remaining, 0, `the owner must be able to undo the agent's clip away, ${remaining} item(s) left`);

  await must('target_project', { projectId });
  // The orphaned draft is still the editor's active session, and only an
  // explicit recovery may touch it: the agent discards it, exactly as the
  // listing said it could, and then starts clean.
  const discarded = await must('recover_edit_session', { editSessionId: exportSessionId, action: 'discard' });
  assert.equal(discarded.status, 'cancelled', `the orphaned draft must be discarded: ${JSON.stringify(discarded).slice(0, 300)}`);
  const recovered = await must('begin_edit_session', { clientName: 'c-e2e after undo', approvalMode: 'auto' });
  const recoveredSessionId = recovered.editSessionId as string;
  const readAfter = await must('read_project', { editSessionId: recoveredSessionId });
  assert.equal(itemCount(readAfter), 0, 'the agent must read the project the owner reverted to');

  // ── 9. an agent tool behaves like the button it mirrors ──────────────────
  // The UI's only authored-clip button is the "Add solid background/canvas"
  // card in My Media: clicking it must produce the same track, name and
  // duration as the agent's own solid add.
  await must('discard_edit_session', { editSessionId: recoveredSessionId });
  await evaluate<boolean>(chrome.send, `(() => {
    const tab = [...document.querySelectorAll('button, [role=tab]')]
      .find((node) => /^(My Media|我的素材)$/.test((node.textContent || '').trim()));
    if (!tab) return false;
    tab.click();
    return true;
  })()`);
  const cardClicked = await waitFor<boolean>(chrome.send, `(() => {
    const card = document.querySelector('button.cc-add-solid-canvas-card');
    if (!card) return false;
    card.click();
    return true;
  })()`, { timeoutMs: 20_000, label: 'the add-solid card' });
  assert.equal(cardClicked, true);
  // The owner's click is an owner edit, so read the result from the stored
  // project rather than from an agent session the click just invalidated.
  let buttonSolid: Record<string, any> | undefined;
  for (let attempt = 0; attempt < 40 && !buttonSolid; attempt += 1) {
    await sleep(250);
    const doc = await storeDoc(port, projectId);
    const timelines = (doc?.timelines ?? []) as Array<Record<string, any>>;
    const active = timelines.find((entry) => entry.id === doc?.activeTimelineId) ?? timelines[0];
    const items = (active?.items ?? []) as Array<Record<string, any>>;
    buttonSolid = items.filter((item) => item.kind === 'solid').at(-1);
  }
  assert.ok(buttonSolid, 'the add-solid card must place a solid clip');

  await must('target_project', { projectId });
  const solidSession = await must('begin_edit_session', { clientName: 'c-e2e solid', approvalMode: 'auto' });
  const solidSessionId = solidSession.editSessionId as string;
  const agentSolid = await must('edit_item', {
    adds: [{ type: 'solid', color: '#1a1a1a' }],
    editSessionId: solidSessionId,
  });
  const agentSolidPlaced = agentSolid.results[0].placed as Record<string, any>;
  assert.equal(agentSolidPlaced.track, buttonSolid!.track, 'the agent solid must use the button track');
  assert.equal(agentSolidPlaced.name, buttonSolid!.name, 'the agent solid must use the button default name');
  assert.equal(agentSolidPlaced.durationInFrames, buttonSolid!.durationInFrames, 'the agent solid must use the button duration');

  console.log(
    `c-mcp-e2e.verify: ${toolCount} tools with a browser connected; `
    + `create ${timings.create_project} ms, editor ${timings.editor_connected} ms, render ${timings.render} ms; `
    + `export ${bytes.length} bytes, ffprobe ${probed.width}x${probed.height} ${probed.frames} frames, `
    + `centre rgb(${centre.join(',')}) proves the invert; undo ${itemsBefore} → 0 items; `
    + `agent solid = button solid (${agentSolidPlaced.track}, ${agentSolidPlaced.name}, ${agentSolidPlaced.durationInFrames} frames)`,
  );
} finally {
  await mcp.close().catch(() => undefined);
  chrome.close();
  await server.stop();
  for (const dir of [home, dataDir, profile, mediaDir]) {
    // A profile sqlite can outlive the server by a moment on Windows; a scratch
    // directory left behind is not worth failing a green run over.
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  }
}
