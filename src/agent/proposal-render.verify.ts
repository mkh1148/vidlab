// A proposal is stored data, so the English-coverage dictionary check cannot see
// it: the verb comes from a table, the impact is a counted fragment, the target
// and title/summary have Chinese fallbacks. scripts/i18n-english.verify.mjs
// proves every one of those keys HAS an English entry; this proves the render
// path actually asks for it — that ProposalCard.tsx and AgentChangeLogMenu.tsx
// send each field through src/i18n/proposalText.ts instead of interpolating the
// stored Chinese, and that the helpers produce English for every shape the
// builder can emit.
//
// Reads the components as text for the same reason i18n-english.verify.mjs does:
// the leak is an unwrapped interpolation, which no runtime assertion on the
// helpers can catch.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/;

const documentElement = { lang: 'en' };
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: () => 'en', setItem: () => undefined },
});
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: { documentElement },
});

const { ensureLocaleDict } = await import('../i18n/locale');
await ensureLocaleDict();

const { VERB, buildOperation, buildProposal } = await import('./proposal');
const {
  IMPACT_FRAGMENTS,
  IMPACT_WORDS,
  PROPOSAL_FALLBACKS,
  CHANGE_SESSION_SUMMARIES,
  proposalAction,
  proposalImpact,
  proposalSummary,
  proposalTarget,
  proposalTitle,
  changeSessionSummary,
} = await import('../i18n/proposalText');

const assertEnglish = (label: string, text: string) => {
  assert.ok(!CJK.test(text), `${label} still renders Chinese: ${JSON.stringify(text)}`);
  assert.ok(text.length > 0, `${label} rendered empty`);
};

// ── 1. every verb the tool table can emit ───────────────────────────────────
for (const [tool, verb] of Object.entries(VERB)) {
  assertEnglish(`verb for ${tool}`, proposalAction(verb));
  // An unknown tool id falls through t() unchanged; that is the tool's own name.
  assertEnglish(`unknown tool ${tool}`, proposalAction(tool));
}

// ── 2. every counted impact shape, plus the no-change word ──────────────────
const impactShapes = [
  '+1 序列', '−1 序列', '+2 序列', '−3 序列',
  '+1 片段', '−1 片段', '+12 片段', '−12 片段',
  '1 处改动', '7 处改动',
  '+2 序列 · +12 片段 · 3 处改动',
  '−1 序列 · −4 片段',
  ...IMPACT_WORDS,
];
for (const shape of impactShapes) {
  assertEnglish(`impact ${JSON.stringify(shape)}`, proposalImpact(shape));
}
for (const fragment of IMPACT_FRAGMENTS) {
  assertEnglish(`impact fragment ${JSON.stringify(fragment)}`, proposalImpact(fragment.replace('{n}', '4')));
}

// ── 3. title, summary and target fallbacks ──────────────────────────────────
for (const fallback of PROPOSAL_FALLBACKS) {
  assertEnglish(`fallback ${JSON.stringify(fallback)}`, proposalTitle(fallback));
}
assertEnglish('target fallback', proposalTarget('时间线'));
assertEnglish('summary fallback', proposalSummary('2 项编辑'));
assertEnglish('title fallback', proposalTitle('Agent 编辑提案'));
assertEnglish('title fallback (short)', proposalTitle('编辑提案'));

// ── 4. a synthetic proposal through the real builder ────────────────────────
// buildProposal only reads the document and state it is handed, so empty shells
// are enough: the display fields are what this check is about.
const doc = {} as never;
const state = {} as never;
const operations = [
  buildOperation('update_item_props', { id: 'item-1', rationale: 'Tighten the cut' }, [{ type: 'update', id: 'item-1' } as never]),
  buildOperation('add_audio', { name: 'Room tone' }, [{ type: 'add', item: { name: 'Room tone' } } as never]),
  buildOperation('remove_item', { id: 'item-2' }, [{ type: 'remove', id: 'item-2' } as never]),
  buildOperation('manage_timelines', {}, [{ type: 'tl.create', timeline: { name: 'Sequence 2' } } as never]),
  buildOperation('clear_timeline', {}, [{ type: 'tl.delete', id: 'tl-1' } as never]),
  buildOperation('unknown_tool', {}, []),
];
const proposal = buildProposal(operations, '', doc, state);

const rendered: [string, string][] = [
  ['title', proposalTitle(proposal.title)],
  ['summary', proposalSummary(proposal.summary)],
  ['total impact', proposalImpact(proposal.totalImpact)],
];
// Only `options[0].operations` is rendered (ProposalCard.tsx:18); the option's
// own label/summary/totalImpact are stored but never displayed, so they are not
// asserted here.
for (const operation of proposal.options[0]!.operations) {
  rendered.push(['operation action', proposalAction(operation.action)]);
  rendered.push(['operation target', proposalTarget(operation.target)]);
  rendered.push(['operation impact', proposalImpact(operation.impact)]);
}
for (const [label, text] of rendered) assertEnglish(`synthetic proposal ${label}`, text);

// The builder's own fallbacks are the interesting rows: no model sentence, so
// the summary is the counted placeholder. The builder translates it where it
// originates (B2), so the stored value is already in the session language while
// proposalSummary still maps the Chinese form a stored proposal can carry — the
// assertion above covers that direction.
assert.equal(proposal.summary, `${operations.length} edits`);
assert.equal(proposalSummary(proposal.summary), `${operations.length} edits`);
assertEnglish('synthetic proposal target fallback', proposalTarget('时间线'));

// Model-authored text is not interface copy and must survive verbatim, Chinese
// included: the agent's own sentence is data the user asked for.
assert.equal(proposalSummary('Trim the intro and add a title'), 'Trim the intro and add a title');
assert.equal(proposalSummary('把片头剪短一点'), '把片头剪短一点');
assert.equal(changeSessionSummary('Reworked the intro'), 'Reworked the intro');

// ── 5. change-log summaries ────────────────────────────────────────────────
for (const summary of CHANGE_SESSION_SUMMARIES) {
  assertEnglish(`change-log summary ${JSON.stringify(summary)}`, changeSessionSummary(summary));
}

// ── 6. the render path itself ──────────────────────────────────────────────
// Every stored field that reaches ProposalCard.tsx or AgentChangeLogMenu.tsx has
// to arrive through its helper. A field used only as a truthiness guard is fine;
// anything else is the Chinese original going straight to the screen.
const RENDER_PATHS: [string, [string, string][]][] = [
  [
    'src/components/chat/ProposalCard.tsx',
    [
      ['proposal.title', 'proposalTitle('],
      ['proposal.summary', 'proposalSummary('],
      ['proposal.totalImpact', 'proposalImpact('],
      ['op.action', 'proposalAction('],
      ['op.target', 'proposalTarget('],
      ['op.impact', 'proposalImpact('],
    ],
  ],
  [
    'src/components/chat/AgentChangeLogMenu.tsx',
    [
      ['session.summary', 'changeSessionSummary('],
      ['operation.action', 'proposalAction('],
      ['operation.target', 'proposalTarget('],
      ['operation.impact', 'proposalImpact('],
    ],
  ],
];

for (const [file, fields] of RENDER_PATHS) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  for (const [field, helper] of fields) {
    let index = source.indexOf(field);
    assert.ok(index >= 0, `${file} no longer renders ${field} — update this check`);
    while (index >= 0) {
      const before = source.slice(Math.max(0, index - helper.length), index);
      const after = source.slice(index + field.length, index + field.length + 2);
      const wrapped = before === helper;
      const guardOnly = after === ' ?' || after === ' &';
      assert.ok(
        wrapped || guardOnly,
        `${file} interpolates ${field} without ${helper}) — it renders the stored Chinese`,
      );
      index = source.indexOf(field, index + field.length);
    }
  }
}

console.log(
  `proposal-render.verify: ${Object.keys(VERB).length} verbs, ${impactShapes.length} impact shapes, `
  + `${rendered.length} synthetic-proposal fields and ${RENDER_PATHS.length} render paths display in English`,
);
