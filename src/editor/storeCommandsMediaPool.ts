// Media-pool commands: folders, asset metadata and pool membership. Split out of
// storeCommandBuilder.ts along the responsibility seam — the pool is not the
// timeline, and the builder was at the 500-line ceiling (docs/engineering-rules.md).
//
// Relink stays in the builder because it is the one pool command that has to prove
// the document actually changed before it dispatches (commitRelink).
import type { ProjectDispatch } from './reduce';
import type { EditorCommands } from './storeCommands';
import type { ProjectDoc } from './types';

export type MediaPoolCommands = Pick<EditorCommands,
  | 'createMediaFolder' | 'renameMediaFolder' | 'deleteMediaFolder' | 'moveMediaAssets'
  | 'renameMediaAsset' | 'renameMediaAssets'
  | 'setMediaAssetFavorite' | 'setMediaAssetsFavorite' | 'editMediaAsset'
  | 'removeMediaAsset' | 'removeMediaAssets' | 'canonicalizeMediaAsset'>;

export function mediaPoolCommands(
  dispatch: ProjectDispatch,
  getDoc: () => ProjectDoc,
  uid: (prefix: string) => string,
): MediaPoolCommands {
  return {
    createMediaFolder: (name, parentId) => {
      const existing = getDoc().mediaFolders.find((folder) => folder.parentId === parentId && folder.name === name);
      if (existing) return existing.id;
      const id = uid('bin');
      dispatch({ type: 'pool.createFolder', folder: { id, name, parentId } });
      return id;
    },
    renameMediaFolder: (id, name) => dispatch({ type: 'pool.renameFolder', id, name }),
    deleteMediaFolder: (id) => dispatch({ type: 'pool.deleteFolder', id }),
    moveMediaAssets: (ids, folderId) => dispatch({ type: 'pool.moveAssets', ids, folderId }),
    renameMediaAsset: (id, name) => dispatch({ type: 'pool.updateAsset', id, patch: { name } }),
    renameMediaAssets: (entries) => dispatch({
      type: 'batch',
      actions: entries.map(({ id, name }) => ({ type: 'pool.updateAsset', id, patch: { name } })),
      label: 'Rename media',
    }),
    setMediaAssetFavorite: (id, favorite) => dispatch({ type: 'pool.updateAsset', id, patch: { favorite } }),
    setMediaAssetsFavorite: (ids, favorite) => dispatch({
      type: 'batch',
      actions: ids.map((id) => ({ type: 'pool.updateAsset', id, patch: { favorite } })),
      label: favorite ? 'Favorite media' : 'Unfavorite media',
    }),
    editMediaAsset: (id, patch) => dispatch({ type: 'pool.updateAsset', id, patch }),
    removeMediaAsset: (id) => dispatch({ type: 'pool.removeAsset', id }),
    removeMediaAssets: (ids) => dispatch({
      type: 'batch',
      actions: ids.map((id) => ({ type: 'pool.removeAsset', id })),
      label: 'Delete media',
    }),
    canonicalizeMediaAsset: (duplicateId, canonicalId) => dispatch({
      type: 'pool.canonicalizeAsset',
      duplicateId,
      canonicalId,
    }),
  };
}
