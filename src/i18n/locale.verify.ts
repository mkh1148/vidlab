// One interface language (owner decision D-11).
//
// This pins the migration semantics the owner asked for: a browser that stored
// cc.locale='zh' (or 'it'/'ru') in an older build boots English AND has that stored value
// rewritten to 'en' on load — read-and-migrate, not ignore. A regression here is the
// whole-UI-Chinese sighting coming back.
import assert from 'node:assert/strict';

const documentElement = { lang: 'zh-CN' };
const store = new Map<string, string>([['cc.locale', 'zh']]);
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
  },
});
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: { documentElement },
});

const {
  ALL_LOCALES, ensureLocaleDict, getLocale, localeLanguageName, localizedCatalogText, t,
} = await import('./locale');

assert.deepEqual([...ALL_LOCALES], ['en'], 'the locale list is exactly English');
assert.equal(getLocale(), 'en', 'a stored zh preference must boot English');
assert.equal(documentElement.lang, 'en',
  'the document language is English no matter what the stored preference says');
assert.equal(store.get('cc.locale'), 'en',
  'the stored preference is migrated to English on load, not left as residue');

assert.equal(localeLanguageName('en'), 'English', 'the agent prompt asks for English');
assert.equal(localizedCatalogText('Write a script', '写脚本'), 'Write a script',
  'catalog data renders its English half');
assert.equal(localizedCatalogText('Write a script', '写脚本', 'en'), 'Write a script',
  'the optional locale argument cannot select anything else');

// The zh-as-key architecture is untouched: an untranslated key still renders itself
// rather than blank, which is what the coverage verifies are there to prevent.
assert.equal(t('这个键不存在于任何词典'), '这个键不存在于任何词典',
  'an unknown key still falls back to the Chinese original');

await ensureLocaleDict();
assert.equal(t('导出'), 'Export', 'the English dictionary translates a known key');

console.log('locale.verify: one interface language — a stored non-English preference boots English');
