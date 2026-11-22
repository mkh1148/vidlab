import { flushProjectSaves } from './projectStore';
import { browserProjectOwnership } from './projectStoreTransport';

/**
 * Ordering between a tool result and the autosave it caused (P1).
 *
 * The editor autosaves on a debounce, so a tool result reported right after a
 * command can reach the MCP client while the store still holds the previous
 * revision. The next call then carries an outdated revision and the session is
 * refused as stale. Flushing the save queue is not enough on its own: when the
 * debounce has not fired yet the queue is empty and the flush is a no-op, so the
 * pending save must be queued from the live document first.
 */

/** Queues a save of the live document, or returns null when the store already has it. */
export type LiveProjectSaveEnqueuer = () => Promise<unknown> | null;

export interface ProjectChangeSettlement {
  settled: boolean;
  attempts: number;
  waitedMs: number;
  /** Why there was nothing to order, when the store is not owned by this editor. */
  skipped?: 'no-ownership';
}

export interface ProjectChangeSettlementOptions {
  attempts?: number;
  intervalMs?: number;
  /** The revision the tool call was dispatched against. */
  dispatchRevision?: string;
  /** Test seam: the committed store revision for a project. */
  storeRevision?: (projectId: string) => string | undefined;
  /** Test seam: the live document revision the editor holds. */
  liveRevision?: () => string;
  /** Test seam: wait for the renderer to commit the tool's change. */
  nextFrame?: () => Promise<void>;
  /** Test seam: drain the save queue. */
  flush?: (projectId: string) => Promise<unknown>;
}

const liveSaves = new Map<string, LiveProjectSaveEnqueuer>();

/** Registered by the editor's persistence hook; one live enqueuer per project. */
export function registerLiveProjectSave(
  projectId: string,
  enqueue: LiveProjectSaveEnqueuer,
): () => void {
  liveSaves.set(projectId, enqueue);
  return () => {
    if (liveSaves.get(projectId) === enqueue) liveSaves.delete(projectId);
  };
}

export function resetLiveProjectSavesForTest(): void {
  liveSaves.clear();
}

/** One paint, so the renderer has committed the tool's change. Bounded: a
 *  hidden tab never paints, and a tool result must not wait on it forever. */
const nextFrame = (): Promise<void> => new Promise((resolve) => {
  let settled = false;
  const finish = (): void => {
    if (settled) return;
    settled = true;
    resolve();
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(finish);
  setTimeout(finish, 20);
});
const wait = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Wait until the store carries the change the editor is holding, forcing the
 * pending autosave to be queued and flushed. Bounded: a save that cannot land
 * must not hold a tool result open forever.
 */
export async function settleProjectChange(
  projectId: string,
  liveRevision: () => string,
  options: ProjectChangeSettlementOptions = {},
): Promise<ProjectChangeSettlement> {
  const attempts = options.attempts ?? 40;
  const intervalMs = options.intervalMs ?? 25;
  const storeRevision = options.storeRevision
    ?? ((id: string) => browserProjectOwnership(id)?.baseRevision);
  const live = options.liveRevision ?? liveRevision;
  const frame = options.nextFrame ?? nextFrame;
  const flush = options.flush ?? ((id: string) => flushProjectSaves(id));
  const dispatchRevision = options.dispatchRevision;
  const startedAt = Date.now();
  if (!storeRevision(projectId)) {
    // No browser ownership: the store is not this editor's to order.
    return { settled: true, attempts: 0, waitedMs: 0, skipped: 'no-ownership' };
  }
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // Let the renderer commit the tool's change before asking for its revision.
    await frame();
    const revision = live();
    const stored = storeRevision(projectId);
    if (revision && stored === revision) {
      // A change the tool made is committed; an unchanged document is only
      // trusted after a second look, because the first can precede the commit.
      if (revision !== dispatchRevision || attempt > 1) {
        return { settled: true, attempts: attempt, waitedMs: Date.now() - startedAt };
      }
    } else {
      liveSaves.get(projectId)?.();
      await flush(projectId);
      if (revision && storeRevision(projectId) === revision) {
        return { settled: true, attempts: attempt, waitedMs: Date.now() - startedAt };
      }
    }
    await wait(intervalMs);
  }
  return { settled: false, attempts, waitedMs: Date.now() - startedAt };
}
