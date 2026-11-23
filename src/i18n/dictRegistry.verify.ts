// The dictionary is a single lazy chunk (D-11), so t()/tData() read a table that may not
// be loaded yet. This pins the lookup semantics that used to be per-language:
//   t:     EN entry when the dictionary has the key, else the Chinese original (the key)
//   tData: EN_DATA entry, else the name unchanged
// and the "never go blank" contract while the dictionary is still in flight.
// npx tsx src/i18n/dictRegistry.verify.ts
import assert from 'node:assert/strict';

const { ensureLocaleDict, t, tData } = await import('./locale.ts');
const { localeDicts } = await import('./dictRegistry.ts');
const { EN } = await import('./dict/en');
const EN_DATA = (await import('./dict/en/templates-data')).default;

// ── in flight: the Chinese original stands in, never an empty string ─────────
{
  const key = Object.keys(EN)[0]!;
  assert.equal(t(key), key,
    'before the dictionary lands, t() returns the key rather than blank');
  assert.equal(tData('Bar Chart - Annual Sales'), 'Bar Chart - Annual Sales',
    'tData() likewise passes the original through');
  assert.deepEqual(localeDicts(), { ui: {}, data: {} },
    'an unloaded dictionary is an empty snapshot, not a missing one');
}

// ── loaded: one table, one language ─────────────────────────────────────────
{
  await ensureLocaleDict();
  const key = Object.keys(EN)[0]!;
  assert.equal(t(key), EN[key], 't() reads the English dictionary');
  assert.equal(t('这个键不存在于任何词典'), '这个键不存在于任何词典',
    'an unknown key falls back to the Chinese original');
  const dataKey = Object.keys(EN_DATA)[0]!;
  assert.equal(tData(dataKey), EN_DATA[dataKey], 'tData() reads the English data table');
  assert.equal(localeDicts().ui, EN, 'the loaded snapshot is the English table');
  assert.equal(localeDicts().data, EN_DATA, 'the loaded data snapshot is EN_DATA');
}

// ── placeholders survive the table swap ─────────────────────────────────────
{
  const single = Object.keys(EN).find((candidate) => {
    const marks = candidate.match(/\{n\}/g) ?? [];
    return marks.length === 1 && (EN[candidate]!.match(/\{n\}/g) ?? []).length === 1;
  });
  assert.ok(single, 'the fixture needs a key with exactly one {n} placeholder');
  assert.equal(t(single!, { n: 3 }), EN[single!]!.replace('{n}', '3'),
    'placeholders are substituted');
  assert.equal(t('缺少 {missing}', {}), '缺少 {missing}',
    'an absent param leaves the placeholder');
}

console.log('dictRegistry.verify: the single English dictionary preserves every lookup rule');
