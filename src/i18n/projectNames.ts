// Generated project names are DATA too: a new project is stored with a
// two-word Chinese name, the document is never rewritten, and the dashboard
// shows it in the current language. This module owns the vocabulary and the
// display path, so the word lists live next to the rule that translates them
// instead of inside the store.
//
// The stored form is ADJECTIVE + NOUN with no separator ("流光序曲"). The
// display form is the two translated halves joined the way the target language
// joins them ("Lumen Overture"). A name that is not built from the vocabulary —
// anything the owner typed — falls through storedName(), which returns it
// unchanged unless it is a dictionary key.
import { t } from './locale';
import { storedName } from './storedNames';

export const PROJECT_NAME_ADJECTIVES = [
  '流光', '静默', '暖阳', '深蓝', '轻盈', '锋利', '柔和', '斑斓', '清冽', '灼热', '朦胧', '澄澈',
];

export const PROJECT_NAME_NOUNS = [
  '序曲', '航迹', '棱镜', '潮汐', '织机', '回响', '飞羽', '砂丘', '苔原', '穹顶', '流域', '星图',
];

/** The prefix duplicateProject puts in front of the source name. */
const COPY_PREFIX = '[Copy] ';

/** The stored name of a brand-new project. */
export function randomProjectName(): string {
  const pick = (list: readonly string[]) => list[Math.floor(Math.random() * list.length)]!;
  return `${pick(PROJECT_NAME_ADJECTIVES)}${pick(PROJECT_NAME_NOUNS)}`;
}

/** How a stored project name is shown in the current language. */
export function displayProjectName(name: string): string {
  // duplicateProject prefixes the source name; the source may itself be a
  // generated name, so strip the prefix, translate the rest, re-apply it.
  if (name.startsWith(COPY_PREFIX)) {
    return t('[Copy] {name}', { name: displayProjectName(name.slice(COPY_PREFIX.length)) });
  }
  for (const adjective of PROJECT_NAME_ADJECTIVES) {
    if (!name.startsWith(adjective)) continue;
    const noun = name.slice(adjective.length);
    if (!PROJECT_NAME_NOUNS.includes(noun)) continue;
    return t('{adjective}{noun}', { adjective: t(adjective), noun: t(noun) });
  }
  return storedName(name);
}
