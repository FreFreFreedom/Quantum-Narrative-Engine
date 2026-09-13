// npm run side:selftest — side talks (plan "side talks in the Room, and remember
// this"), the pure parts: no DB, no network, no model credits.
//
// Three things worth guarding directly:
//   - the side-talk subject id shape, which is what makes MANY side talks per
//     parent representable under idx_convos_subject's unique index
//   - the parent-conversation block a side talk's prompt gets assembled with
//   - the same-provider-only fallback a pinned lane (Gemini) now gets, so a
//     spent gemini-flash-latest retries on gemini-flash-lite-latest and never
//     quietly swaps to a different provider

import assert from 'node:assert/strict';
import { sideSubjectId, parentTranscriptBlock } from '../server/src/services/conversations.js';
import { getFallbackChain } from '../server/src/services/ai/text.js';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

console.log('side-talk subject id');

ok('carries the parent id and a uuid, never the same twice', () => {
  const parentId = 'convo-abc';
  const a = sideSubjectId(parentId);
  const b = sideSubjectId(parentId);
  assert.ok(a.startsWith(`${parentId}:`));
  assert.ok(b.startsWith(`${parentId}:`));
  assert.notEqual(a, b);
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  assert.ok(uuidRe.test(a.slice(parentId.length + 1)));
});

console.log('the parent block a side talk gets in its prompt');

const parent = { id: 'p1', recap: null, compacted_at: null };
const parentMsgs = [
  { kind: 'chat', role: 'user', text: 'What is the wound as shrine?', created_at: '1' },
  { kind: 'chat', role: 'assistant', text: 'The place the pattern first got named as sacred.', created_at: '2' },
];

ok('a non-side convo gets no block at all', () => {
  assert.equal(parentTranscriptBlock({ subject_type: 'open', parent_convo_id: null }, parent, parentMsgs), '');
});

ok('a side convo with no resolvable parent gets no block', () => {
  assert.equal(parentTranscriptBlock({ subject_type: 'side', parent_convo_id: 'gone' }, null, parentMsgs), '');
});

ok('a side convo with a parent gets the whole parent transcript, clearly labelled', () => {
  const block = parentTranscriptBlock({ subject_type: 'side', parent_convo_id: 'p1' }, parent, parentMsgs);
  assert.ok(block.includes('THE CONVERSATION THIS ONE STEPPED OUT OF'));
  assert.ok(block.includes('background, not the subject'));
  assert.ok(block.includes('wound as shrine'));
  assert.ok(block.includes('pattern first got named as sacred'));
});

console.log('\nsame-provider-only fallback for a pinned lane');

await (async () => {
  const chain = await getFallbackChain('studio', 'google-ai-studio', 'gemini-flash-latest', { noOpencodeBackup: true });
  ok('keeps the primary model first', () => {
    assert.equal(chain[0].provider, 'google-ai-studio');
    assert.equal(chain[0].model, 'gemini-flash-latest');
  });
  ok('falls back to the OTHER Gemini model, same provider', () => {
    const rest = chain.slice(1);
    assert.ok(rest.some((c) => c.provider === 'google-ai-studio' && c.model === 'gemini-flash-lite-latest'));
  });
  ok('never a different provider', () => {
    assert.ok(chain.every((c) => c.provider === 'google-ai-studio'));
  });
})();

console.log(`\n${n} checks passed — no model call, no credits.`);
