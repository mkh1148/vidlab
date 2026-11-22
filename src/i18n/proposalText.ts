// The propose→apply surface is DATA before it is interface copy.
//
// `src/agent/proposal.ts` builds a proposal out of an agent run: the verb comes
// from a tool→verb table, the impact is a counted fragment ("+2 片段"), the
// target is a name or a fallback noun, and the title/summary have Chinese
// fallbacks. Those strings are stored — a proposal event is durable, and the
// change log persists sessions through `parseAgentChangeLog` — so they are
// translated at DISPLAY time here and never rewritten at build time. Same rule
// as i18n/storedNames.ts: the canonical form stays Chinese, the renderer asks
// for the current language.
//
// Everything that reaches ProposalCard.tsx or AgentChangeLogMenu.tsx goes
// through one of these functions; src/agent/proposal-render.verify.ts asserts
// that on a synthetic proposal, and scripts/i18n-english.verify.mjs asserts
// every fragment key has an English entry.
import { t } from './locale';

/** The counted impact fragments `impactOf()` composes, in canonical order. */
export const IMPACT_FRAGMENTS: readonly string[] = [
  '+{n} 序列',
  '−{n} 序列',
  '+{n} 片段',
  '−{n} 片段',
  '{n} 处改动',
];

/** Non-counted impact words. */
export const IMPACT_WORDS: readonly string[] = ['无变化'];

/** Title, summary and target fallbacks the proposal builder writes. */
export const PROPOSAL_FALLBACKS: readonly string[] = [
  'Agent 编辑提案',
  '编辑提案',
  '{n} 项编辑',
  '时间线',
];

/** Change-log row summaries that are ours rather than the model's own text. */
export const CHANGE_SESSION_SUMMARIES: readonly string[] = [
  'Agent 修改',
  'Agent 修改（进行中）',
];

const COUNTED: readonly (readonly [RegExp, string])[] = [
  [/^\+(\d+) 序列$/, '+{n} 序列'],
  [/^−(\d+) 序列$/, '−{n} 序列'],
  [/^\+(\d+) 片段$/, '+{n} 片段'],
  [/^−(\d+) 片段$/, '−{n} 片段'],
  [/^(\d+) 处改动$/, '{n} 处改动'],
];

/**
 * `'+2 片段 · 1 处改动'` in the current language.
 *
 * The fragments are matched, not translated wholesale, because the number is
 * carried through and the separator is part of the composition.
 */
export function proposalImpact(impact: string): string {
  if (!impact) return impact;
  return impact
    .split(' · ')
    .map((part) => {
      for (const [pattern, key] of COUNTED) {
        const match = pattern.exec(part);
        if (match) return t(key, { n: match[1]! });
      }
      return t(part);
    })
    .join(' · ');
}

/** A tool verb ("改属性") or an unknown tool id, which t() returns unchanged. */
export function proposalAction(action: string): string {
  return t(action);
}

/** A name/id the agent acted on, or the `时间线` fallback noun. */
export function proposalTarget(target: string): string {
  return t(target);
}

export function proposalTitle(title: string): string {
  return t(title);
}

const SUMMARY_FALLBACK = /^(\d+) 项编辑$/;

/**
 * The proposal summary is usually the model's own sentence, which is not
 * interface copy and must survive verbatim; only the counted fallback the
 * builder writes when the model said nothing is translated.
 */
export function proposalSummary(summary: string): string {
  const match = SUMMARY_FALLBACK.exec(summary);
  return match ? t('{n} 项编辑', { n: match[1]! }) : summary;
}

/**
 * A change-log row's summary: the model's own sentence again, or one of the two
 * placeholders this app writes (`Agent 修改`, `Agent 修改（进行中）`).
 */
export function changeSessionSummary(summary: string): string {
  return CHANGE_SESSION_SUMMARIES.includes(summary) ? t(summary) : summary;
}
