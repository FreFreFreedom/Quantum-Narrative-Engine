// The Room's two free, deterministic pieces, checked without a model or a network:
// the length-request detector, and forking a conversation.
// Run: npm run room:selftest
import assert from 'node:assert';
process.env.JWT_SECRET ||= 'selftest';
process.env.ADMIN_PASSWORD ||= 'selftest';
process.env.DB_PATH ||= '/tmp/qne-room-selftest.db';
import { rmSync } from 'node:fs';
rmSync(process.env.DB_PATH, { force: true }); // a fork test must start from an empty thread list

const { openDb } = await import('../server/src/db/schema.js');
const convos = await import('../server/src/services/conversations.js');
const { lengthRequest, forkConvo, createOpenConvo, listMessages, listOpenConvos } = convos;
convos.bindConversationsDb(openDb());

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

// ─── Fork ────────────────────────────────────────────────────────────────────
// A branch, never a move: the original keeps every message, and the copy inherits
// nothing that would make it look like work already sent somewhere.
const db = openDb();
const { convo } = createOpenConvo({ title: 'Civic structures' });
const ins = db.prepare('INSERT INTO convo_messages (id, convo_id, role, kind, text) VALUES (?,?,?,?,?)');
ins.run('m1', convo.id, 'user', 'chat', 'what is a civic structure');
ins.run('m2', convo.id, 'assistant', 'chat', 'A civic structure is …');
ins.run('m3', convo.id, 'user', 'chat', 'go deeper');
ins.run('m4', convo.id, 'assistant', 'chat', 'Deeper still …');

const whole = forkConvo(convo.id);
assert.ok(whole.ok, JSON.stringify(whole));
assert.equal(whole.copied, 4);
assert.equal(listMessages(whole.convo.id).length, 4);
assert.equal(whole.convo.title, 'Civic structures (fork)');
assert.equal(whole.convo.subject_type, 'open');
assert.equal(listMessages(convo.id).length, 4, 'the original must be untouched');

const part = forkConvo(convo.id, { throughMessageId: 'm2' });
assert.equal(part.copied, 2);
assert.deepEqual(listMessages(part.convo.id).map((m) => m.text), ['what is a civic structure', 'A civic structure is …']);
assert.equal(part.convo.work_prompt_id, null, 'a branch has not been sent to the queue');
assert.equal(part.convo.recap, null, 'a branch starts with a fresh context');

assert.equal(forkConvo(whole.convo.id).convo.title, 'Civic structures (fork)', 'a fork of a fork must not stack the suffix');
assert.equal(forkConvo(convo.id, { throughMessageId: 'nope' }).error, 'no_such_message');
assert.equal(forkConvo('missing').error, 'not_found');
assert.ok(listOpenConvos(50).some((c) => c.id === part.convo.id), 'a fork shows up in the Room');
console.log('fork OK — whole thread, from a point, no stacked suffix, original untouched');
