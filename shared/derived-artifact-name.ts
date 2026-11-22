// P7: one naming function for every derived artifact.
//
// The pitfall is a name that silently fails to be written: the job reports
// "applied", no file exists, the log says ENAMETOOLONG. The recipe is fixed:
//
//   * short names stay byte-identical, so a cache keyed by file name keeps
//     hitting after this module is adopted;
//   * a name that would exceed the cap collapses to a readable prefix plus a
//     hash of the FULL identity, so it stays deterministic and distinct;
//   * the cap is counted in BYTES, because NTFS counts bytes and a travel-vlog
//     source name is multi-byte before it is long.
//
// Host-agnostic on purpose (like shared/file-name.ts): no node: imports and no
// async, so the inspector surface can preview exactly the name the server
// writes. The hash is FNV-1a over the UTF-8 bytes rather than node:crypto for
// that reason; 64 bits is ample for distinguishing one user's artifact
// identities.
import { sanitizeFileName } from './file-name.ts';

/** Byte budget for the whole name, extension included. NTFS allows 255; the
 *  headroom covers a writer's own temporary suffix (`<name>.part`). */
export const DERIVED_ARTIFACT_MAX_BYTES = 240;

/** Hex characters of the identity hash kept in a collapsed name. */
export const DERIVED_ARTIFACT_HASH_HEX = 16;

/**
 * Byte budget for the extension of a COLLAPSED name.
 *
 * The extension is not trusted to be short: `sanitizeFileName` only replaces
 * forbidden characters, so `a.eeee…` (250 characters) passes through it intact
 * and a collapsed name that preserved the extension verbatim reached 268 bytes —
 * past both the 240 design cap and the 255-byte NTFS limit. Truncating it here
 * cannot lose identity: the hash covers the full readable name, extension
 * included, so two identities that differ only past this budget still get
 * different names.
 */
export const DERIVED_ARTIFACT_COLLAPSED_EXTENSION_BYTES = 24;

const encoder = new TextEncoder();
const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

export type DerivedArtifactOptionValue = string | number | boolean | null | undefined;

/** Everything that makes two artifacts of the same source different files. */
export interface DerivedArtifactIdentity {
  /** Source file name. A path is accepted and flattened; its extension is
   *  inherited unless `extension` says otherwise (a matte of a .mov is .webm). */
  readonly sourceName: string;
  /** Feature/kind markers in order, e.g. `['voice', 's90']`. */
  readonly segments?: readonly string[];
  /** Source revision the artifact was derived from (cache key half one). */
  readonly revision?: string | number;
  /** Engine/model version (cache key half two). */
  readonly engineVersion?: string;
  /** Options that change the output; a record is canonicalised by sorted key. */
  readonly options?: string | Readonly<Record<string, DerivedArtifactOptionValue>> | null;
  /** Overrides the inherited source extension. */
  readonly extension?: string;
}

function utf8Bytes(value: string): number {
  return encoder.encode(value).length;
}

/** Split off the last extension; a leading dot is part of the name, not one. */
function splitExtension(name: string): { stem: string; extension: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return { stem: name, extension: '' };
  return { stem: name.slice(0, dot), extension: name.slice(dot + 1) };
}

/** Sorted `key-value` pairs joined by `_`, so option order cannot change a name. */
function optionsSlug(options: DerivedArtifactIdentity['options']): string {
  if (!options) return '';
  if (typeof options === 'string') return options;
  return Object.keys(options)
    .sort()
    .flatMap((key) => {
      const value = options[key];
      if (value === undefined || value === null || value === '') return [];
      return [`${key}-${String(value)}`];
    })
    .join('_');
}

/** 16 hex characters of FNV-1a over the UTF-8 bytes of the full identity. */
function identityHash(value: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (const byte of encoder.encode(value)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash.toString(16).padStart(DERIVED_ARTIFACT_HASH_HEX, '0');
}

/** Longest whole-codepoint prefix of `value` that fits in `budget` bytes. */
function truncateToBytes(value: string, budget: number): string {
  if (budget <= 0) return '';
  let used = 0;
  let end = 0;
  for (const character of value) {
    const width = utf8Bytes(character);
    if (used + width > budget) break;
    used += width;
    end += character.length;
  }
  return value.slice(0, end).replace(/[._-]+$/, '');
}

/**
 * Name of a derived artifact, safe for the filesystem and stable across runs.
 *
 * Under the cap the name is exactly `<stem>.<segments…>.<revision>.<engine>.<options>.<ext>`
 * with no hash, so an existing cache keyed by name still hits. Over the cap it
 * becomes `<readable prefix>~<16 hex>.<ext>`, where the extension is itself
 * bounded by `DERIVED_ARTIFACT_COLLAPSED_EXTENSION_BYTES` so a pathological
 * extension cannot push the name past the cap. The whole name — extension
 * included — never exceeds `DERIVED_ARTIFACT_MAX_BYTES`.
 */
export function deriveArtifactName(identity: DerivedArtifactIdentity): string {
  const source = splitExtension(identity.sourceName.trim());
  const extension = sanitizeFileName(identity.extension ?? source.extension, '')
    .replace(/^\.+/, '');
  const parts = [
    sanitizeFileName(source.stem, 'artifact'),
    ...(identity.segments ?? []).map((segment) => sanitizeFileName(String(segment), '')),
    identity.revision === undefined ? '' : sanitizeFileName(String(identity.revision), ''),
    sanitizeFileName(identity.engineVersion ?? '', ''),
    sanitizeFileName(optionsSlug(identity.options), ''),
  ].filter((part) => part.length > 0);
  const body = parts.join('.');
  const readable = extension ? `${body}.${extension}` : body;
  if (utf8Bytes(readable) <= DERIVED_ARTIFACT_MAX_BYTES) return readable;

  // The hash covers the readable name, which already carries every identity
  // field: revision, engine version, options and the full extension all move it.
  // That is what lets the collapsed form truncate the extension instead of
  // carrying it verbatim.
  const collapsedExtension = extension
    ? truncateToBytes(extension, DERIVED_ARTIFACT_COLLAPSED_EXTENSION_BYTES)
    : '';
  const suffix = `~${identityHash(readable)}${collapsedExtension ? `.${collapsedExtension}` : ''}`;
  const prefix = truncateToBytes(body, DERIVED_ARTIFACT_MAX_BYTES - utf8Bytes(suffix));
  return `${prefix}${suffix}`;
}
