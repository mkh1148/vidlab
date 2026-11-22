// Milestone C · scale: ten files on four tracks, five consecutive runs.
//
// The backbone proves one pass end to end; this proves the same agent session
// survives repetition at size: five runs on one project, each importing ten
// files, placing them across four video tracks, adding an effect to every clip,
// letting the owner see the step, undoing it, rendering, and proving with a
// pixel sample that the effect is in the exported picture. One MCP client is
// used for all five runs — a session that dropped would fail the run it
// dropped in. Between runs the agent clears its own clips, so every run starts
// from the same empty timeline.
//
// Run: npx tsx scripts/c-scale.verify.ts   (needs `npm run build` first)
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { freePort, repoRoot, scratchDir, startProdServer } from './a1-harness.mjs';
import {
  activeTimelineItemCount, click, connectMcp, downloadExport, evaluate, generateClip, launchChrome,
  probeVideo, readFrame, sleep, storeDoc, storeRevision, waitFor,
} from './c-harness.ts';

const dist = join(repoRoot, 'dist');
assert.ok(existsSync(join(dist, 'index.html')), 'run "npm run build" first (P9)');

const RUNS = 5;
const CLIPS = 10;
const TRACKS = 4;
const FPS = 30;
const ROW_FRAMES = 36;

const home = await scratchDir('home');
const dataDir = await scratchDir('data');
const profile = await scratchDir('chrome');
const mediaDir = await scratchDir('media');
const port = await freePort();
const debugPort = await freePort();
const token = 'c-scale-token-0123456789';

// Every clip is the same red source so the invert effect has one expected
// colour whatever the track stacking puts on top. Distinct durations keep the
// content hashes distinct, or the pool would dedupe them into one.
const clipFrames = Array.from({ length: CLIPS }, (_, index) => Math.round((0.8 + index * 0.05) * FPS));
const rowStart = (index: number): number => Math.floor(index / TRACKS) * ROW_FRAMES;
const timelineFrames = Math.max(...clipFrames.map((frames, index) => rowStart(index) + frames));

const server = await startProdServer({
  home, dataDir, port,
  extraEnv: { OPENCHATCUT_MCP_TOKEN: token, AGENT_IMPORT_ROOTS: mediaDir },
});
const chrome = await launchChrome(debugPort, profile);
const mcp = await connectMcp(port, token, 'c-scale');
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
const itemCount = (read: Record<string, any>): number => {
  const timelines = (read.timelines ?? []) as Array<Record<string, any>>;
  return (timelines.find((entry) => entry.active) ?? timelines[0])?.itemCount as number;
};
const storedItemIds = async (projectId: string): Promise<string[]> => {
  const doc = await storeDoc(port, projectId);
  const timelines = ((doc as Record<string, any> | null)?.timelines ?? []) as Array<Record<string, any>>;
  const active = timelines.find((entry) => entry.id === (doc as Record<string, any>)?.activeTimelineId) ?? timelines[0];
  return ((active?.items ?? []) as Array<Record<string, any>>).map((item) => item.id as string);
};

const runTimings: string[] = [];

try {
  const created = await must('create_project', { name: 'C scale', editorBaseUrl: `http://127.0.0.1:${port}` });
  const projectId = created.id as string;
  await chrome.send('Page.navigate', { url: `http://127.0.0.1:${port}/#/editor/${projectId}` });
  await waitFor(chrome.send, `!!document.querySelector('canvas, [data-timeline], body')`, { timeoutMs: 60_000, label: 'editor shell' });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const status = await must('openchatcut_status');
    if ((status.connectedProjectIds as string[] | undefined)?.includes(projectId)) break;
    await sleep(500);
  }
  await must('target_project', { projectId });

  // A fresh project carries one video track; four tracks is the point of the
  // scale run, so the agent creates the other three once, up front.
  const setup = await must('begin_edit_session', { clientName: 'c-scale setup', approvalMode: 'auto' });
  const setupSessionId = setup.editSessionId as string;
  const tracks = await must('edit_track', {
    action: 'create', json: JSON.stringify({ trackType: 'video', count: TRACKS - 1 }), editSessionId: setupSessionId,
  });
  assert.equal((tracks.created as unknown[]).length, TRACKS - 1, `the agent must create ${TRACKS - 1} tracks`);
  const trackIdByAlias = new Map<string, string>([['V1', 'track_v1']]);
  for (const track of tracks.created as Array<Record<string, any>>) {
    trackIdByAlias.set(track.alias as string, track.id as string);
  }
  await must('review_edit_session', { editSessionId: setupSessionId, summary: 'C scale: four video tracks' });
  await must('discard_edit_session', { editSessionId: setupSessionId });

  for (let run = 1; run <= RUNS; run += 1) {
    const started = Date.now();
    const clips = Array.from({ length: CLIPS }, (_, index) => generateClip(
      mediaDir, `c-scale-r${run}-${index}.mp4`, { color: 'red', seconds: 0.8 + index * 0.05 },
    ));

    const session = await must('begin_edit_session', { clientName: `c-scale run ${run}`, approvalMode: 'auto' });
    const editSessionId = session.editSessionId as string;

    const assetIds: string[] = [];
    for (let index = 0; index < CLIPS; index += 1) {
      const imported = await must('import_asset', { path: clips[index], editSessionId });
      const assetId = imported.imported[0].id as string;
      assert.ok(assetId, `run ${run}: clip ${index} must land in the pool`);
      assetIds.push(assetId);
    }
    const imported = Date.now();

    const itemIds: string[] = [];
    for (let index = 0; index < CLIPS; index += 1) {
      const track = `V${(index % TRACKS) + 1}`;
      const placed = await must('edit_item', {
        adds: [{
          type: 'video', assetId: assetIds[index], track, startFrame: rowStart(index),
        }],
        editSessionId,
      });
      const placedItem = placed.results[0].placed as Record<string, any>;
      assert.equal(placedItem.track, trackIdByAlias.get(track), `run ${run}: clip ${index} must land on ${track}`);
      itemIds.push(placedItem.itemId as string);
    }
    const placed = Date.now();

    for (const itemId of itemIds) {
      const effected = await must('manage_effects', {
        action: 'add', targetItemId: itemId, assetId: 'builtin:fx-invert', editSessionId,
      });
      assert.ok(JSON.stringify(effected).includes('fx-invert'), `run ${run}: the effect must attach`);
    }
    const read = await must('read_project', { editSessionId });
    assert.equal(itemCount(read), CLIPS, `run ${run}: all ${CLIPS} clips must be in the draft`);
    const reviewed = await must('review_edit_session', {
      editSessionId, summary: `C scale run ${run}: ${CLIPS} clips on ${TRACKS} tracks`,
    });
    assert.equal(reviewed.status, 'applied', `run ${run}: the auto session must apply on review`);
    const applied = Date.now();

    assert.equal(activeTimelineItemCount(await storeDoc(port, projectId)), CLIPS,
      `run ${run}: the owner's project must carry all ${CLIPS} clips after the review`);
    const visible = await waitFor<boolean>(
      chrome.send,
      `document.body.innerText.includes('c-scale-r${run}-${CLIPS - 1}')`,
      { timeoutMs: 20_000, label: `run ${run}: the clip name in the timeline` },
    );
    assert.equal(visible, true, `run ${run}: the owner must see the agent step in the interface`);

    // An applied session is finished; the export runs in a fresh drafting one.
    await must('discard_edit_session', { editSessionId });
    const exportSession = await must('begin_edit_session', { clientName: `c-scale export ${run}`, approvalMode: 'auto' });
    const exportSessionId = exportSession.editSessionId as string;
    const submitted = await must('submit_render_job', {
      format: 'video', codec: 'h264', resolution: '480p', fps: FPS,
      name: `c-scale-${run}`, editSessionId: exportSessionId,
    });
    const renderId = (submitted.renderId ?? submitted.id) as string;
    let downloadUrl = '';
    for (let attempt = 0; attempt < 40 && !downloadUrl; attempt += 1) {
      const polled = await must('track_export', {
        action: 'wait', renderIds: renderId, timeoutSeconds: 20, editSessionId: exportSessionId,
      });
      const jobs = (polled.jobs ?? polled.renderJobs ?? [polled]) as Array<Record<string, any>>;
      const job = jobs.find((entry) => entry.downloadUrl) ?? jobs[0];
      assert.notEqual(job?.status, 'failed', `run ${run}: the render failed: ${JSON.stringify(job).slice(0, 400)}`);
      downloadUrl = (job?.downloadUrl as string) ?? '';
    }
    assert.ok(downloadUrl, `run ${run}: the export must finish with a download URL`);
    const rendered = Date.now();

    const file = join(dataDir, `c-scale-${run}.mp4`);
    const bytes = await downloadExport(port, downloadUrl, file);
    assert.ok(bytes.length > 10_000, `run ${run}: the export must carry a picture, got ${bytes.length} bytes`);
    const probed = probeVideo(file);
    // 480p on a 16:9 project: 864 wide, 486 tall (the encoder's even dimensions).
    assert.equal(probed.width, 864, `run ${run}: 480p export width for a 16:9 project`);
    assert.equal(probed.height, 486, `run ${run}: 480p export height for a 16:9 project`);
    assert.ok(probed.frames >= timelineFrames - 6,
      `run ${run}: the export must carry the ${timelineFrames}-frame timeline, got ${probed.frames}`);
    for (const frame of [5, 80]) {
      const decoded = readFrame(file, frame, probed.width, probed.height, dataDir);
      assert.equal(decoded.size, decoded.expected, `run ${run}: frame ${frame} must decode fully`);
      const centre = decoded.pixel(Math.floor(probed.width / 2), Math.floor(probed.height / 2));
      assert.ok(centre[1] > 150 && centre[2] > 150 && centre[0] < 100,
        `run ${run}: the invert must be in the exported picture at frame ${frame}, got rgb(${centre.join(',')})`);
    }

    // ── the owner can undo the agent's step ─────────────────────────────────
    const revisionBeforeUndo = await storeRevision(port, projectId);
    const undoEnabled = await evaluate<boolean>(chrome.send, `(() => {
      const node = document.querySelector('button[aria-label="Undo"], button[aria-label="撤销"]');
      return !!node && !node.disabled;
    })()`);
    assert.equal(undoEnabled, true, `run ${run}: the undo control must be enabled`);
    assert.equal(await click(chrome.send, 'button[aria-label="Undo"], button[aria-label="撤销"]'), true);
    let revisionAfterUndo = revisionBeforeUndo;
    for (let attempt = 0; attempt < 40 && revisionAfterUndo === revisionBeforeUndo; attempt += 1) {
      await sleep(250);
      revisionAfterUndo = await storeRevision(port, projectId);
    }
    assert.ok(revisionAfterUndo && revisionAfterUndo !== revisionBeforeUndo,
      `run ${run}: the owner's undo must reach the stored project`);

    // The owner's undo retires the agent's draft: the discard is refused as
    // stale (the draft is pinned to the revision it was opened on), which also
    // retires the transport's snapshot. Re-targeting is the documented re-bind,
    // and the draft is then cleared through the recovery path the listing
    // advertises — an orphaned draft is only ever touched explicitly.
    const retired = await tool('discard_edit_session', { editSessionId: exportSessionId });
    assert.equal(retired.body?.outcome, 'stale', `run ${run}: the owner's undo must retire the draft: ${JSON.stringify(retired.body).slice(0, 300)}`);
    await must('target_project', { projectId });
    const discarded = await must('recover_edit_session', { editSessionId: exportSessionId, action: 'discard' });
    assert.equal(discarded.status, 'cancelled', `run ${run}: the retired draft must be discarded: ${JSON.stringify(discarded).slice(0, 300)}`);

    // ── clear the timeline so the next run starts from the same place ───────
    const remaining = await storedItemIds(projectId);
    if (remaining.length) {
      const reset = await must('begin_edit_session', { clientName: `c-scale reset ${run}`, approvalMode: 'auto' });
      const resetSessionId = reset.editSessionId as string;
      await must('edit_item', {
        deletes: remaining.map((itemId) => ({ type: 'video', itemId })),
        editSessionId: resetSessionId,
      });
      await must('review_edit_session', { editSessionId: resetSessionId, summary: `C scale run ${run}: clear` });
      await must('discard_edit_session', { editSessionId: resetSessionId });
      assert.equal(activeTimelineItemCount(await storeDoc(port, projectId)), 0,
        `run ${run}: the agent must be able to clear its own clips`);
    }
    const cleared = Date.now();

    console.log();
    console.log(`  run ${run}/${RUNS} green`);
    runTimings.push(
      `run ${run}: import ${imported - started} ms, place ${placed - imported} ms, `
      + `effect+review ${applied - placed} ms, render ${rendered - applied} ms, `
      + `undo+clear ${cleared - rendered} ms, total ${cleared - started} ms, `
      + `${probed.frames} frames, ${bytes.length} bytes`,
    );
  }

  console.log(`c-scale.verify: ${RUNS}/${RUNS} runs green, ${CLIPS} files on ${TRACKS} tracks each, one MCP session`);
  for (const line of runTimings) console.log(`  ${line}`);
} finally {
  await mcp.close().catch(() => undefined);
  chrome.close();
  await server.stop();
  for (const dir of [home, dataDir, profile, mediaDir]) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  }
}
