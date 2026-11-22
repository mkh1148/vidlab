// C-review condition 1 (D-entry): manage_media_pool {action:"create_folder"} used
// to mutate the media pool and THEN fail. It created the folder through
// ctx.commands.createMediaFolder, read the folder back with
// `ctx.getDoc().mediaFolders.find(...)!`, and built the returned path from that
// read-back. The live bridge hands out the snapshot from before the dispatch, so
// the read-back was undefined, `pathOf(undefined)` threw, and the tool reported an
// error for a folder that already existed. The caller saw isError with a changed
// pool — the one shape a mutating tool must never produce.
//
// This check pins the invariant directly: isError implies the pool is unchanged.
// It drives the tool with a getDoc() that is deliberately STALE (the pre-command
// snapshot, exactly what the bridge can hand back) so the old code fails here.
import assert from 'node:assert/strict';
import { makeDraft } from '../../editor/store';
import type { MediaAsset } from '../../editor/types';
import { docFromTimeline } from '../../persist/projectStore';
import type { AgentContext } from '../context';
import { execMediaPoolTool } from './media-pool-tools';

const asset: MediaAsset = { id: 'asset_hero', name: 'hero.mp4', kind: 'video', src: '/hero.mp4', durationInFrames: 90 };

function freshDraft() {
  const base = docFromTimeline({
    fps: 30, width: 1920, height: 1080, items: [], selectedId: null, assets: [asset],
  });
  return makeDraft(base);
}

/** A context whose getDoc() never sees the dispatch — the stale-snapshot bridge. */
function staleContext() {
  const draft = freshDraft();
  const before = draft.getDoc();
  let created = 0;
  const ctx = {
    commands: {
      ...draft.commands,
      createMediaFolder: (name: string, parentId?: string) => {
        created += 1;
        return draft.commands.createMediaFolder(name, parentId);
      },
    },
    getState: draft.getState,
    getDoc: () => before,
    getCreativeMode: () => null,
    templates: [],
    audio: [],
  } as unknown as AgentContext;
  return { ctx, draft, mutations: () => created };
}

// ── the happy path must not fail on a read-back it cannot trust ─────────────
{
  const { ctx, draft, mutations } = staleContext();
  const result = await execMediaPoolTool('manage_media_pool', { action: 'create_folder', name: 'B-roll' }, ctx) as {
    ok?: boolean; error?: string; created?: boolean; folder?: { id: string; path: string };
  };
  assert.equal(result.error, undefined, 'create_folder must not report an error after creating the folder');
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.folder?.path, 'Master/B-roll', 'the path is derived from the parent, not from a read-back');
  assert.ok(result.folder?.id, 'the id is the one the command returned');
  assert.equal(mutations(), 1);
  // The pool really did change, and it changed by exactly the folder we reported.
  const folders = draft.getDoc().mediaFolders;
  assert.equal(folders.length, 1);
  assert.equal(folders[0]!.id, result.folder?.id);
  assert.equal(folders[0]!.name, 'B-roll');
}

// A nested folder derives its path from the resolved parent, still without a read-back.
// (A live context here: resolving a parent that a previous call created needs a
// getDoc() that sees the dispatch, which is the bridge's job, not this tool's.)
{
  const draft = freshDraft();
  const ctx = {
    commands: draft.commands,
    getState: draft.getState,
    getDoc: draft.getDoc,
    getCreativeMode: () => null,
    templates: [],
    audio: [],
  } as unknown as AgentContext;
  const parent = await execMediaPoolTool('manage_media_pool', { action: 'create_folder', name: 'Rushes' }, ctx) as {
    folder: { id: string; path: string };
  };
  assert.equal(parent.folder.path, 'Master/Rushes');
  const child = await execMediaPoolTool(
    'manage_media_pool',
    { action: 'create_folder', name: 'Day 1', parentPath: 'Master/Rushes' },
    ctx,
  ) as { folder: { path: string } };
  assert.equal(child.folder.path, 'Master/Rushes/Day 1');
  assert.equal(draft.getDoc().mediaFolders.length, 2);
}

// ── isError implies the pool is unchanged ──────────────────────────────────
{
  const { ctx, draft, mutations } = staleContext();
  const before = draft.getDoc();
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ action: 'create_folder' }, 'name is required and cannot contain /'],
    [{ action: 'create_folder', name: 'a/b' }, 'name is required and cannot contain /'],
    [{ action: 'create_folder', name: 'B-roll', parentPath: 'Master/Nope' }, 'parent folder not found: Master/Nope'],
  ];
  for (const [args, error] of cases) {
    assert.deepEqual(await execMediaPoolTool('manage_media_pool', args, ctx), { error });
    assert.equal(mutations(), 0, `no folder may be created for ${JSON.stringify(args)}`);
    assert.equal(draft.getDoc(), before, 'the pool must be untouched after an error');
    assert.equal(draft.getDoc().mediaFolders.length, 0);
  }
}

console.log('media-pool-tools.create-folder.verify: create_folder is atomic — isError implies the pool is unchanged');
