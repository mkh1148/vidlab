import assert from 'node:assert/strict';
import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { ensureLocaleDict, tData } from '../../i18n/locale.ts';
import { TEMPLATES } from '../../editor/initial.ts';
import type { RefItem } from './ChatComposer.tsx';

// Dictionaries are fetched lazily (see i18n/dictRegistry.ts); tData() only resolves once
// the dictionary has landed, exactly as main.tsx awaits at boot.
await ensureLocaleDict();
// The interface is English and the built-in template names already are, so the catalog
// lookup must return each name unchanged instead of reaching for a Chinese name table
// that no longer ships (D-11).
for (const template of TEMPLATES) {
  assert.equal(
    tData(template.name),
    template.name,
    `built-in MG template name must display unchanged: ${template.name}`,
  );
}

const noop = () => undefined;
const selectedRefs: RefItem[] = [
  { id: 'builtin-template', kind: 'template', name: 'Bar Chart - Annual Sales' },
  { id: 'custom-template', kind: 'template', name: '我的自定义模板' },
  { id: 'video-asset', kind: 'video', name: '7月7日.mp4' },
];
const originalRefs = structuredClone(selectedRefs);
const testLocaleId = '\0template-reference-localization-test-locale';
const vite = await createServer({
  appType: 'custom',
  plugins: [{
    name: 'template-reference-localization-test-locale',
    enforce: 'pre',
    resolveId(id) {
      return id.endsWith('/i18n/locale') || id.endsWith('/i18n/locale.ts') ? testLocaleId : null;
    },
    load(id) {
      if (id !== testLocaleId) return null;
      return `
        export const getLocale = () => 'en';
        export const t = (text) => text;
        export const tData = (text) =>
          text === 'Bar Chart - Annual Sales' ? 'Bar chart · annual sales' : text;
        export const useT = () => t;
        export const localizedCatalogText = (english) => english;
      `;
    },
  }],
  server: { middlewareMode: true },
});

let composerMarkup = '';
try {
  const { ChatComposer } = await vite.ssrLoadModule('/src/components/chat/ChatComposer.tsx');
  composerMarkup = renderToStaticMarkup(createElement(ChatComposer, {
    value: '',
    onChange: noop,
    onSubmit: noop,
    onStop: noop,
    onEnhance: noop,
    enhancing: false,
    running: false,
    mode: 'agent',
    onModeChange: noop,
    autoApply: false,
    onAutoApplyChange: noop,
    selecting: false,
    onToggleSelecting: noop,
    creativeMode: null,
    onCreativeModeChange: noop,
    references: selectedRefs,
    onInsertRef: noop,
    selectedRefs,
    taRef: createRef<HTMLTextAreaElement>(),
  }));
} finally {
  await vite.close();
}

assert.match(composerMarkup, /@Bar chart · annual sales/, 'built-in template chips should show their catalog display name');
assert.match(composerMarkup, /@我的自定义模板/, 'unmatched custom template chips should keep their original name');
assert.match(composerMarkup, /@7月7日\.mp4/, 'non-template references should keep the media asset name');
assert.deepEqual(selectedRefs, originalRefs, 'localized display must not mutate the underlying references');

console.log('template-reference-localization.verify: template chips use the catalog display name');
