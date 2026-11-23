import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SOUND_EFFECTS, SOUND_GROUPS } from '../audio/soundLibrary';
import { EN } from '../i18n/dict/en';
import { ensureLocaleDict, tData } from '../i18n/locale';

// The interface language is English and the catalog's names already are, so the display
// path must return each name unchanged instead of looking for a Chinese name table that
// no longer ships (D-11). A sound that came back renamed would mean tData() is still
// reading a second language.
await ensureLocaleDict();
const renamedNames = SOUND_EFFECTS
  .filter((sound) => tData(sound.name) !== sound.name)
  .map((sound) => sound.name);

assert.deepEqual(
  renamedNames,
  [],
  'every built-in sound effect must display its English name unchanged',
);

const mismatchedGroupNames = SOUND_GROUPS
  .filter((group) => EN[group.name] !== group.nameEn)
  .map((group) => group.name);

assert.deepEqual(
  mismatchedGroupNames,
  [],
  'every sound group must have an English display name',
);

const browserSource = readFileSync(new URL('./SoundBrowser.tsx', import.meta.url), 'utf8');

assert.match(browserSource, /\{t\(g\.name\)\}/, 'sound group chips must render through the dictionary');
assert.doesNotMatch(browserSource, /\{g\.name\}/, 'sound group chips must not render the data name directly');
assert.match(browserSource, /tData\(s\.name\)/, 'sound names must participate in search through the display path');
assert.match(browserSource, /const displayName = tData\(sound\.name\)/, 'sound rows must derive a display name through tData');
assert.match(browserSource, /cc-sound-name[^>]*>\{displayName\}/, 'sound rows must render the display name');
assert.match(browserSource, /\{ n: list\.length \}/, 'the footer must report the active search/category result count');
assert.doesNotMatch(
  browserSource,
  /\{ n: SOUND_EFFECTS\.length \}/,
  'the filtered result footer must not keep reporting the full library size',
);

assert.match(
  browserSource,
  /function toAsset[\s\S]*?name: s\.name/,
  'adding a sound must preserve its canonical data name',
);
assert.match(
  browserSource,
  /setLibraryDrag\([\s\S]*?name: sound\.name/,
  'dragging a sound must preserve its canonical data name',
);

console.log(`sound-localization.verify: ${SOUND_EFFECTS.length} built-in sound names display unchanged; the catalog is not mutated`);
