// D4 · the atlas and the landmark track are effect ASSETS, so they must travel with
// the project into an export.
//
// The kit's rule is one sentence — "the atlas is an effect asset: include it in media
// clean-up and project export" — and the clean-up half is proven server-side
// (server/face-analysis.verify.ts). This suite proves the export half against the real
// planner, not against a description of it:
//
//   1. a clip that carries `faceTrackUrl` / `faceAtlasUrl` contributes BOTH as media
//      references, so the export preflight fetches them and fails loudly when they are
//      missing instead of rendering a silently unmasked face;
//   2. the reference is owned by the item and named by field, so a failure message
//      points at the clip rather than at "some media";
//   3. the planner collects the URLs from the CLIP and, separately, from an effect
//      object (it skips `item.effects` in the generic item scan but scans each effect
//      explicitly). So the planner is not what decides the placement — this suite
//      records that, and the placement is decided on correctness: the artifact is
//      per SOURCE, so it belongs to the clip (one copy shared by every trim and every
//      effect instance) rather than to one effect instance that could disagree with
//      its twin;
//   4. a missing atlas is a `missing_source` issue at preflight — the export refuses
//      before it renders, which is the defined missing-asset behaviour.
import assert from 'node:assert/strict';
import {
  assertExportMediaReadable,
  collectExportMediaPlan,
  type ExportMediaReference,
} from '../export/exportMediaPlan.js';

const TRACK_URL = '/media/derived/talking-head-1a2b3c4d/talking-head.face-track.source-v1-abc.mediapipe-face-landmarker-v1.fps-5_cell-128.json';
const ATLAS_URL = '/media/derived/talking-head-1a2b3c4d/talking-head.face-atlas.source-v1-abc.mediapipe-face-landmarker-v1.fps-5_cell-128.png';

function clip(extra: Record<string, unknown> = {}) {
  return {
    id: 'clip-1',
    kind: 'video',
    src: '/media/uploads/talking-head.mp4',
    start: 0,
    duration: 13,
    ...extra,
  };
}

function snapshot(items: readonly unknown[]) {
  return { id: 'timeline-1', items, transitions: [], fxDefs: {} };
}

function fieldsOf(references: readonly ExportMediaReference[]): string[] {
  return references.map((reference) => reference.field).sort();
}

// ── 1 + 2. both artifacts travel, owned by the item ─────────────────────────
{
  const plan = collectExportMediaPlan(snapshot([
    clip({ faceTrackUrl: TRACK_URL, faceAtlasUrl: ATLAS_URL }),
  ]));
  assert.deepEqual(plan.issues, [], 'a clip with both artifacts has no preflight issue');
  assert.deepEqual(fieldsOf(plan.references), ['item.faceAtlasUrl', 'item.faceTrackUrl', 'src'],
    `both artifacts are collected as item media (got ${fieldsOf(plan.references).join(', ')})`);
  const atlas = plan.references.find((reference) => reference.field === 'item.faceAtlasUrl');
  assert.ok(atlas, 'the atlas is a reference');
  assert.equal(atlas.source, ATLAS_URL, 'the atlas reference is the URL the renderer will fetch');
  assert.equal(atlas.owner, 'item', 'the atlas is owned by the clip, not by the effect');
  assert.equal(atlas.itemId, 'clip-1');
  assert.equal(atlas.timelineId, 'timeline-1');
  const track = plan.references.find((reference) => reference.field === 'item.faceTrackUrl');
  assert.equal(track?.source, TRACK_URL);
}

// ── 3. the planner is not the constraint — placement is a design decision ──
{
  const plan = collectExportMediaPlan(snapshot([
    clip({
      effects: [{
        id: 'fx-1',
        assetId: 'builtin:fx-face-retouch',
        props: { smoothness: 0.35 },
        faceTrackUrl: TRACK_URL,
        faceAtlasUrl: ATLAS_URL,
      }],
    }),
  ]));
  assert.deepEqual(fieldsOf(plan.references), ['effect.faceAtlasUrl', 'effect.faceTrackUrl', 'src'],
    'an effect-level face URL is collected too, owned by the effect — so neither placement '
    + 'silently loses the asset, and the choice is made on the model, not on the planner');
  const atlas = plan.references.find((reference) => reference.field === 'effect.faceAtlasUrl');
  assert.equal(atlas?.owner, 'effect');
  assert.equal(atlas?.assetId, 'builtin:fx-face-retouch', 'the effect reference carries its definition id');
  // The clip is where they live: the artifact is per source, so one copy is shared by
  // every trim and every instance of the effect rather than duplicated per instance.
  const clipPlan = collectExportMediaPlan(snapshot([clip({ faceTrackUrl: TRACK_URL, faceAtlasUrl: ATLAS_URL })]));
  assert.equal(clipPlan.references.filter((reference) => reference.field.startsWith('item.face')).length, 2,
    'the clip carries exactly one copy of each artifact');
}

// ── 4. missing artifacts refuse the export before it renders ────────────────
{
  const present = new Set([TRACK_URL, ATLAS_URL, '/media/uploads/talking-head.mp4']);
  const fetcher = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return present.has(url)
      ? new Response(new Uint8Array([0]), { status: 206, headers: { 'content-type': 'image/png' } })
      : new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  }) as unknown as typeof fetch;

  const ok = await assertExportMediaReadable(
    snapshot([clip({ faceTrackUrl: TRACK_URL, faceAtlasUrl: ATLAS_URL })]),
    fetcher,
  );
  assert.equal(ok.references.length, 3, 'all three sources pass the preflight');

  // The atlas was cleaned up (media clean-up removes the per-source directory) but the
  // clip still points at it: the export must refuse, naming the clip.
  present.delete(ATLAS_URL);
  await assert.rejects(
    assertExportMediaReadable(snapshot([clip({ faceTrackUrl: TRACK_URL, faceAtlasUrl: ATLAS_URL })]), fetcher),
    (error: unknown) => {
      const failure = error as { failure?: { code?: string; mediaIssues?: readonly { code: string; itemId?: string; field?: string }[] } };
      assert.equal(failure.failure?.code, 'export_media_preflight_failed');
      const issue = failure.failure?.mediaIssues?.find((entry) => entry.field === 'item.faceAtlasUrl');
      assert.ok(issue, 'the failure names the atlas field');
      assert.equal(issue.code, 'missing_source');
      assert.equal(issue.itemId, 'clip-1', 'and the clip it belongs to');
      return true;
    },
    'a missing atlas is a preflight failure, not a silently unmasked export',
  );
}

console.log('faceExportTravel.verify: the atlas and the track travel into export, and a missing atlas refuses it');
