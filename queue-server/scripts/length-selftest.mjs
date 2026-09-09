// Does an explicit length request in Antoine's own words get recognised?
// (His ask, 2026-09-09: "if I say I want a thousand words, they really give me
// the length I want".) No network, no model, no credits — run: npm run length:selftest
import assert from 'node:assert';
process.env.JWT_SECRET ||= 'selftest';
process.env.ADMIN_PASSWORD ||= 'selftest';
process.env.DB_PATH ||= '/tmp/qne-length-selftest.db';

const { lengthRequest } = await import('../server/src/services/conversations.js');

const HITS = {
  'give me 1000 words on this': 1000,
  'I want a 1500 word answer': 1500,
  'write 2000+ words': 2000,
  'can you do a thousand words': 1000,
  'two thousand words please': 2000,
  'about five hundred words': 500,
  'GIVE ME 800 WORDS': 800,
  'donne-moi 1200 mots': 1200,
};
// Vague asks stay vague on purpose: "make it long" has no number to obey, and a
// count that is about the subject rather than the answer must not raise the roof.
const MISSES = ['make it long', 'the 12 words in the title', 'in a word, no', 'give me 50 words', ''];

for (const [text, words] of Object.entries(HITS)) assert.equal(lengthRequest(text), words, text);
for (const text of MISSES) assert.equal(lengthRequest(text), null, text);
console.log(`length detector OK — ${Object.keys(HITS).length} recognised, ${MISSES.length} correctly ignored`);
