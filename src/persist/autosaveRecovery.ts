export interface AutosaveDocumentObservation<T> {
  projectId: string;
  doc: T;
  /**
   * Document revision from the history reducer (src/editor/reducerHistory.ts).
   * It advances only for actions that change the document, so selection and
   * timeline switching — which do produce a new document object — cannot queue
   * a save (P4).
   */
  revision?: number;
}

/**
 * Hydration establishes the baseline for a project. Only a later document
 * revision from the same project represents an edit that should be autosaved.
 *
 * Without a revision (a caller that only has the document) the identity
 * comparison is the fallback, exactly as before.
 */
export function pendingAutosaveAfterObservation<T>(
  previous: AutosaveDocumentObservation<T> | null,
  next: AutosaveDocumentObservation<T>,
): AutosaveDocumentObservation<T> | null {
  if (previous === null || previous.projectId !== next.projectId) return null;
  if (previous.revision !== undefined && next.revision !== undefined) {
    return next.revision > previous.revision ? next : null;
  }
  return previous.doc === next.doc ? null : next;
}

export interface FailedAutosaveRecovery<T> {
  currentUnsaved: T | null;
  failedSnapshot: T;
  failedAttempt: number;
  latestEnqueuedAttempt: number;
}

/**
 * Restore only the latest enqueued snapshot. An older completion must not
 * repopulate the pending slot after a newer snapshot has already been queued.
 */
export function recoverFailedAutosave<T>({
  currentUnsaved,
  failedSnapshot,
  failedAttempt,
  latestEnqueuedAttempt,
}: FailedAutosaveRecovery<T>): T | null {
  if (currentUnsaved !== null || failedAttempt !== latestEnqueuedAttempt) {
    return currentUnsaved;
  }
  return failedSnapshot;
}
