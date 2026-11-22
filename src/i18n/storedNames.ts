// Default names the app writes into a project are DATA, not interface copy: the
// base stores them in Chinese and every locale reads the same project file. They
// are therefore translated at DISPLAY time and never rewritten in the document
// (kit Milestone B: "stored data is not rewritten").
//
// The numbered ones are the names the app itself invents — the default sequence
// of a new project ("序列 1"), and the clip names the highlight tool and the
// "Add title" button produce. Everything else falls through t(), which returns
// the name unchanged unless it is a dictionary key — so a name the owner typed
// survives verbatim.
import { t } from './locale';

/** The name a new project's first sequence is stored with. */
export const DEFAULT_SEQUENCE_NAME = '序列 1';

const SEQUENCE = /^序列 (\d+)$/;
const HIGHLIGHT = /^精彩片段 (\d+)$/;
const CLIP = /^片段 (\d+)$/;
const VERSION = /^版本 (.+)$/;
const COPY = /^\[Copy\] (.+)$/;
const DUPLICATE = /^(.+) 副本$/;

/** How a stored sequence or clip name is shown in the current language. */
export function storedName(name: string): string {
  const sequence = SEQUENCE.exec(name);
  if (sequence) return t('序列 {n}', { n: sequence[1]! });
  const highlight = HIGHLIGHT.exec(name);
  if (highlight) return t('精彩片段 {n}', { n: highlight[1]! });
  const clip = CLIP.exec(name);
  if (clip) return t('片段 {n}', { n: clip[1]! });
  // The version store names a snapshot after the moment it was taken; the
  // moment itself is a locale-formatted timestamp, so only the prefix is ours.
  const version = VERSION.exec(name);
  if (version) return t('版本 {name}', { name: version[1]! });
  // duplicateProject prefixes the source name; the source may itself be a
  // generated name, so recurse before the fall-through.
  const copy = COPY.exec(name);
  if (copy) return t('[Copy] {name}', { name: storedName(copy[1]!) });
  // Duplicating a sequence or a clip appends a suffix instead of a prefix. The
  // source may itself be a default name, so recurse here too.
  const duplicate = DUPLICATE.exec(name);
  if (duplicate) return t('{name} 副本', { name: storedName(duplicate[1]!) });
  return t(name);
}
