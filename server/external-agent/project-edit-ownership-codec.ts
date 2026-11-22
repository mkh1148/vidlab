const OWNERSHIP_VERSION = 1;
const OWNERSHIP_LEASE_MS = 90_000;
// How long a live claim stays unquestioned without any sign of life. An owner
// renews its lease on every call, so `updatedAt` doubles as a heartbeat: once a
// claim has been quiet for this long, another client may take the project over
// instead of waiting out the full lease. A returning owner that renews first
// refreshes the heartbeat and keeps its session.
const OWNERSHIP_QUIET_MS = 30_000;
const VALID_PROJECT_ID = /^[a-zA-Z0-9_-]{1,160}$/;
const VALID_OWNER_ID = /^[a-zA-Z0-9_-]{1,200}$/;

export type ProjectEditOwnerKind = 'browser' | 'offline';

export interface ProjectEditOwnershipClaim {
  readonly projectId: string;
  readonly ownerKind: ProjectEditOwnerKind;
  readonly ownerId: string;
  readonly epoch: number;
  readonly baseRevision: string;
}

export interface ProjectEditOwnershipRow extends ProjectEditOwnershipClaim {
  readonly version: typeof OWNERSHIP_VERSION;
  readonly leaseExpiresAt: number;
  readonly updatedAt: number;
}

export const projectEditOwnershipKey = (projectId: string): string =>
  `project-edit-ownership:${projectId}`;

export function validProjectEditOwnershipIdentity(projectId: string, ownerId: string): boolean {
  return VALID_PROJECT_ID.test(projectId) && VALID_OWNER_ID.test(ownerId);
}

export function parseProjectEditOwnership(
  value: unknown,
  projectId: string,
): ProjectEditOwnershipRow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.version !== OWNERSHIP_VERSION || row.projectId !== projectId
    || (row.ownerKind !== 'browser' && row.ownerKind !== 'offline')
    || typeof row.ownerId !== 'string' || !VALID_OWNER_ID.test(row.ownerId)
    || typeof row.epoch !== 'number' || !Number.isSafeInteger(row.epoch) || row.epoch < 1
    || typeof row.baseRevision !== 'string' || !row.baseRevision
    || typeof row.leaseExpiresAt !== 'number' || !Number.isFinite(row.leaseExpiresAt)
    || row.leaseExpiresAt < 0
    || typeof row.updatedAt !== 'number' || !Number.isFinite(row.updatedAt)
    || row.updatedAt < 0) return null;
  return {
    version: OWNERSHIP_VERSION,
    projectId,
    ownerKind: row.ownerKind,
    ownerId: row.ownerId,
    epoch: row.epoch,
    baseRevision: row.baseRevision,
    leaseExpiresAt: row.leaseExpiresAt,
    updatedAt: row.updatedAt,
  };
}

export function renewedProjectEditOwnership(
  claim: ProjectEditOwnershipClaim,
  baseRevision: string,
  now = Date.now(),
): ProjectEditOwnershipRow {
  return {
    version: OWNERSHIP_VERSION,
    ...claim,
    baseRevision,
    leaseExpiresAt: now + OWNERSHIP_LEASE_MS,
    updatedAt: now,
  };
}

/**
 * True when a live claim has gone quiet long enough that its owner is presumed
 * gone (a crashed agent process), so another client may take the project over.
 */
export function projectEditOwnershipRecoverable(
  row: ProjectEditOwnershipRow,
  now = Date.now(),
): boolean {
  return row.leaseExpiresAt > now && now - row.updatedAt >= OWNERSHIP_QUIET_MS;
}

export function projectEditOwnershipMatches(
  value: unknown,
  claim: ProjectEditOwnershipClaim,
  now = Date.now(),
): boolean {
  const row = parseProjectEditOwnership(value, claim.projectId);
  // CAS removed: the base revision is no longer compared (a concurrent save
  // must not fail with a revision mismatch); ownership still gates on
  // owner identity, epoch and lease so writes stay fenced to the editor.
  return Boolean(row
    && row.ownerKind === claim.ownerKind
    && row.ownerId === claim.ownerId
    && row.epoch === claim.epoch
    && row.leaseExpiresAt > now);
}
