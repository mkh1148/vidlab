// Default names the app writes INTO a project are data, not interface copy: the
// base stores them in Chinese and every locale reads the same project file, so
// they are translated at display time (i18n/storedNames.ts) and never rewritten
// in the document. That makes them invisible to the dictionary check — t() is
// called with a variable, not a literal — so they get their own check.
//
// The names covered here are the ones the app itself invents: the default
// sequence of a new project, the clip names the highlight tool and "Add title"
// produce, and the two labels the version store writes into a snapshot.
import assert from 'node:assert/strict';

const documentElement = { lang: 'en' };
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: () => 'en', setItem: () => undefined },
});
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: { documentElement },
});

const { ensureLocaleDict } = await import('./locale');
await ensureLocaleDict();

const { storedName } = await import('./storedNames');

// Numbered defaults: the pattern is matched, the number is carried through.
assert.equal(storedName('序列 1'), 'Sequence 1');
assert.equal(storedName('序列 12'), 'Sequence 12');
assert.equal(storedName('精彩片段 3'), 'Highlight 3');
assert.equal(storedName('片段 7'), 'Clip 7');

// The version store's own labels (src/persist/versionStore.ts writes them).
assert.equal(storedName('自动保存'), 'Autosave');
assert.equal(storedName('未命名版本'), 'Untitled version');
// The snapshot an offline CLI apply takes before it edits the project.
assert.equal(storedName('离线编辑前自动版本'), 'Autosave before offline edit');

// A snapshot taken at a moment keeps the moment verbatim and translates only
// the prefix the app wrote.
assert.equal(storedName('版本 11/19 10:30'), 'Version 11/19 10:30');

// A caption style preset: the style menu's save-name prefill writes this name, and
// the menu renders the stored name back through the same channel — so a preset
// saved before the interface was English-only reads in English too.
assert.equal(storedName('我的样式 2026/11/22'), 'My style 2026/11/22');
assert.equal(storedName('我的样式 11/22/2026'), 'My style 11/22/2026');
// A name the user typed into the save box is theirs, not a default.
assert.equal(storedName('My own caption look'), 'My own caption look');

// duplicateProject prefixes the source name; the source may itself be a
// generated name, so the inner name is translated before the prefix is applied.
assert.equal(storedName('[Copy] 序列 1'), '[Copy] Sequence 1');
assert.equal(storedName('[Copy] My own cut'), '[Copy] My own cut');

// Duplicating a sequence or a clip appends a suffix, and the source may itself
// be a default name.
assert.equal(storedName('序列 1 副本'), 'Sequence 1 copy');
assert.equal(storedName('My own cut 副本'), 'My own cut copy');

// A name the owner typed survives verbatim — the fall-through is t(), which
// returns the input unchanged when it is not a dictionary key.
assert.equal(storedName('My own cut'), 'My own cut');
assert.equal(storedName('Vlog 2026-11-19'), 'Vlog 2026-11-19');

// A near miss must not be treated as a default: the anchored patterns are what
// keep a real name like "序列 A" or "第 2 片段" out of the translation path.
assert.equal(storedName('序列 A'), '序列 A');
assert.equal(storedName('第 2 片段'), '第 2 片段');

// Generated project names are stored as one Chinese word pair and translated at
// display time from the vocabulary in i18n/projectNames.ts. The switch is
// proven here: every name randomProjectName() can produce is covered, and the
// stored document is never touched.
const { displayProjectName, randomProjectName, PROJECT_NAME_ADJECTIVES, PROJECT_NAME_NOUNS } =
  await import('./projectNames');

assert.equal(displayProjectName('流光序曲'), 'Lumen Overture');
assert.equal(displayProjectName('星图穹顶'), '星图穹顶'); // two nouns: not a generated name
assert.equal(displayProjectName('静默星图'), 'Quiet Star Chart');
// A duplicated project keeps the prefix and translates the generated half.
assert.equal(displayProjectName('[Copy] 流光序曲'), '[Copy] Lumen Overture');
// A name the owner typed is not built from the vocabulary and survives verbatim.
assert.equal(displayProjectName('My own cut'), 'My own cut');
// A bare vocabulary word is a dictionary key in its own right, so it translates.
assert.equal(displayProjectName('流光'), 'Lumen');

// Exhaustive: no generated name may fall through untranslated.
for (const adjective of PROJECT_NAME_ADJECTIVES) {
  for (const noun of PROJECT_NAME_NOUNS) {
    const stored = `${adjective}${noun}`;
    const shown = displayProjectName(stored);
    assert.ok(!/[\u4e00-\u9fff]/.test(shown), `generated name ${stored} displayed as ${shown}`);
    assert.notEqual(shown, stored, `generated name ${stored} was not translated`);
    assert.ok(shown.includes(' '), `generated name ${stored} has no joiner: ${shown}`);
  }
}

// randomProjectName() is what a new project stores; it must be one of the pairs.
const generated = randomProjectName();
const matchedAdjective = PROJECT_NAME_ADJECTIVES.find((a) => generated.startsWith(a));
assert.ok(matchedAdjective, `randomProjectName returned ${generated}`);
assert.ok(
  PROJECT_NAME_NOUNS.includes(generated.slice(matchedAdjective.length)),
  `randomProjectName returned ${generated}`,
);

console.log(
  'storedNames.verify: default sequence/clip/highlight/version/copy names and every generated project name display in English, typed names unchanged',
);
