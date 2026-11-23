import assert from 'node:assert/strict';
import { ensureLocaleDict } from '../i18n/dictRegistry';
import { t } from '../i18n/locale';
import {
  CONTEXT_OVERFLOW_GUIDANCE_ZH,
  contextOverflowGuidance,
  extractOverflowOriginal,
} from './context-overflow-guidance';

assert.equal(
  contextOverflowGuidance('some unrelated provider error'),
  null,
  'non-overflow errors must pass through untouched',
);
const firstRound = 'The current request is too large for this model context window. Remove large attachments.';
const compacted = 'The recent conversation is still too large after context compaction. Start a new chat.';

// ── the one interface language: guidance leads, original retained, round-trip exact ──
await ensureLocaleDict();
assert.notEqual(t(CONTEXT_OVERFLOW_GUIDANCE_ZH), CONTEXT_OVERFLOW_GUIDANCE_ZH,
  'the English dictionary must translate the overflow guidance');
{
  const mapped = contextOverflowGuidance(firstRound);
  assert.ok(mapped, 'first-round overflow must map to guidance');
  assert.ok(mapped!.startsWith(`${t(CONTEXT_OVERFLOW_GUIDANCE_ZH)}\n\n`),
    'guidance leads, original is retained after it');
  assert.ok(mapped!.includes(firstRound), 'the original message must be preserved for diagnostics');
  assert.equal(extractOverflowOriginal(mapped!), firstRound, 'the original must round-trip exactly');
  assert.ok(contextOverflowGuidance(compacted)?.startsWith(t(CONTEXT_OVERFLOW_GUIDANCE_ZH)),
    'post-compaction overflow must map too');
  assert.doesNotMatch(mapped!, /[\u4e00-\u9fff]/, 'the guidance is English, not the Chinese original');
}

assert.equal(extractOverflowOriginal('plain error text'), null, 'plain text has no embedded original');

console.log('context-overflow-guidance.verify: ok');
