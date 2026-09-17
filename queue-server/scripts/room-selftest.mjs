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
const passages = await import('../server/src/services/passages.js');
const convos = await import('../server/src/services/conversations.js');
const {
  lengthRequest, answerWordCount, completeRequestedLength,
  forkConvo, createOpenConvo, listMessages, listOpenConvos, addMark, listMarks, deleteMark,
  getClarificationMode, setClarificationMode, attachConvoReference, refreshConvoReference,
  detachConvoReference, listConvoLinks, listLinkSources, createSideTalk, createMergedConvo,
} = convos;
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

// A numeric request is verified after generation. If the first answer is short,
// every continuation goes straight back to the exact provider/model that wrote
// it; the general fallback ladder is deliberately not involved.
assert.equal(answerWordCount('One **clear** [linked phrase](https://example.com/a-long-url) here.'), 5);
{
  const calls = [];
  const wordBlock = (n, name) => Array.from({ length: n }, () => name).join(' ');
  const repaired = await completeRequestedLength({
    text: wordBlock(600, 'opening'), target: 1500,
    provider: 'google-ai-studio', model: 'gemini-flash-latest',
    generate: async (opts) => {
      calls.push(opts);
      return { text: wordBlock(450, calls.length === 1 ? 'middle' : 'ending') };
    },
  });
  assert.equal(repaired.wordCount, 1500);
  assert.equal(repaired.passes, 2);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.provider === 'google-ai-studio' && c.model === 'gemini-flash-latest'));
  assert.ok(calls[0].prompt.includes('only 600 words'));
  assert.ok(calls[1].prompt.includes('only 1050 words'));
}
console.log('requested length OK — short answers continue on the exact model until the requested count is reached');

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

// ─── Conversation references ────────────────────────────────────────────────
// A link freezes the source. Later additions and even a rewind cannot quietly
// change what the destination used; Refresh is the only operation that moves it.
const { convo: destination } = createOpenConvo({ title: 'Destination' });
const { convo: source } = createOpenConvo({ title: 'Source thread' });
ins.run('s1', source.id, 'user', 'chat', 'the source fact');
ins.run('s2', source.id, 'assistant', 'chat', 'the source answer');
const linked = attachConvoReference(destination.id, source.id);
assert.ok(linked.ok, JSON.stringify(linked));
assert.equal(linked.links.length, 1);
const firstLink = db.prepare('SELECT * FROM convo_links WHERE id=?').get(linked.link.id);
assert.match(firstLink.snapshot_text, /the source fact/);
assert.match(firstLink.snapshot_text, /the source answer/);

ins.run('s3', source.id, 'user', 'chat', 'a later addition');
assert.doesNotMatch(db.prepare('SELECT snapshot_text FROM convo_links WHERE id=?').get(firstLink.id).snapshot_text, /later addition/, 'a source growing does not alter a reference');
assert.ok(refreshConvoReference(destination.id, firstLink.id).ok);
assert.match(db.prepare('SELECT snapshot_text FROM convo_links WHERE id=?').get(firstLink.id).snapshot_text, /later addition/, 'Refresh deliberately moves the snapshot');

const duplicate = attachConvoReference(destination.id, source.id);
assert.ok(duplicate.already);
assert.equal(listConvoLinks(destination.id).length, 1, 'the same source is one reference');
assert.equal(attachConvoReference(destination.id, destination.id).error, 'cannot_link_self');
assert.equal(attachConvoReference(source.id, destination.id).error, 'link_cycle', 'A -> B prevents B -> A');

// Rewind removes source rows physically, but the refreshed snapshot remains.
assert.ok(convos.rewindConvo(source.id, 's3').ok);
assert.match(db.prepare('SELECT snapshot_text FROM convo_links WHERE id=?').get(firstLink.id).snapshot_text, /later addition/);

// Merge origins share the storage but are lineage, not removable attachments.
db.prepare(`INSERT INTO convo_links (id,target_convo_id,source_convo_id,kind,source_title,snapshot_text,digest_text) VALUES ('origin-test',?,?,'merge_origin','Origin','x','x')`).run(destination.id, convo.id);
assert.equal(detachConvoReference(destination.id, 'origin-test').error, 'immutable_origin');
assert.equal(refreshConvoReference(destination.id, 'origin-test').error, 'immutable_origin');
assert.ok(detachConvoReference(destination.id, firstLink.id).ok);

const side = createSideTalk(convo.id).convo;
assert.ok(listLinkSources(destination.id).some((x) => x.id === side.id && x.subject_type === 'side'), 'Side Talks are eligible sources');
const sourceBeforeMerge = listMessages(source.id).length;
const merged = createMergedConvo([convo.id, source.id, side.id]);
assert.ok(merged.ok, JSON.stringify(merged));
assert.equal(merged.links.length, 3);
assert.ok(merged.links.every((x) => x.kind === 'merge_origin'));
assert.equal(listMessages(merged.convo.id).length, 0, 'sources are lineage, never pasted into the new transcript');
assert.equal(listMessages(source.id).length, sourceBeforeMerge, 'merging does not alter a source');
assert.equal(createMergedConvo([convo.id]).error, 'invalid_merge_count');
assert.equal(createMergedConvo([convo.id, 'missing']).error, 'not_found');
console.log('conversation references and merges OK — frozen, refreshable, cycle-safe, rewind-safe, origins immutable, Side Talks included, transcripts untouched');

// ─── Chapters ────────────────────────────────────────────────────────────────
// A saved place, its label falling back to the passage, and a fork that carries
// its chapters onto the copied messages rather than losing them.
const m = addMark(convo.id, { messageId: 'm2', snippet: '  A civic  structure   is …  ' });
assert.ok(m.ok, JSON.stringify(m));
assert.equal(m.mark.snippet, 'A civic structure is …', 'whitespace is normalised so the anchor can be matched later');
assert.equal(m.mark.label, 'A civic structure is …', 'no label given falls back to the passage');
assert.equal(addMark(convo.id, { messageId: 'm4', snippet: 'Deeper still …', label: 'the good bit' }).mark.label, 'the good bit');
assert.equal(listMarks(convo.id).length, 2);
assert.equal(addMark(convo.id, {}).error, 'empty');
assert.equal(addMark('missing', { messageId: 'm2' }).error, 'not_found');

const branched = forkConvo(convo.id, { throughMessageId: 'm2' });
const carried = listMarks(branched.convo.id);
assert.equal(carried.length, 1, 'only the chapter whose message was copied comes along');
assert.equal(carried[0].snippet, 'A civic structure is …');
assert.notEqual(carried[0].message_id, 'm2', 'it points at the copy, not the original message');
assert.ok(listMessages(branched.convo.id).some((x) => x.id === carried[0].message_id), 'and that copy really exists');

assert.ok(deleteMark(convo.id, m.mark.id).ok);
assert.equal(listMarks(convo.id).length, 1);
assert.equal(deleteMark(convo.id, m.mark.id).error, 'not_found', 'deleting twice is a 404, not a silent ok');

// Two conversations keep two independent chapter shelves. Even a direct request
// cannot file conversation A's message under conversation B.
const { convo: otherChapterConvo } = createOpenConvo({ title: 'Another chapter shelf' });
ins.run('other-m1', otherChapterConvo.id, 'assistant', 'chat', 'A different conversation and passage.');
const otherMark = addMark(otherChapterConvo.id, { messageId: 'other-m1', snippet: 'different conversation', label: 'Other thread' });
assert.ok(otherMark.ok);
assert.equal(listMarks(otherChapterConvo.id).length, 1);
assert.equal(listMarks(otherChapterConvo.id)[0].label, 'Other thread');
assert.equal(listMarks(convo.id).length, 1, 'adding a chapter elsewhere does not enter this conversation');
assert.equal(addMark(otherChapterConvo.id, { messageId: 'm4', snippet: 'wrong shelf' }).error, 'no_such_message');
assert.equal(deleteMark(otherChapterConvo.id, listMarks(convo.id)[0].id).error, 'not_found', 'one conversation cannot delete another conversation\'s chapter');
console.log('chapters OK — saved, labelled, carried into a fork, deleted, and isolated between conversations');

// ─── Passages ────────────────────────────────────────────────────────────────
// The shelf of kept lines. No model here: the reading is a separate call, and
// this checks only the free, deterministic half.
passages.bindPassagesDb(db);
const line = 'the play asks: what happens to a people when the civic structure meant to hold them together becomes the instrument of their isolation?';
const kept = passages.savePassage({ text: '  ' + line.replace('play', 'play  ') + ' ', convoId: convo.id, sourceTitle: 'Civic structures' });
assert.ok(kept.ok);
assert.equal(kept.passage.text, line, 'whitespace is collapsed so the same line saved twice is the same text');
assert.equal(kept.passage.source_title, 'Civic structures');
assert.equal(kept.passage.reading, null, 'the reading is written afterwards, not on save');

const again = passages.savePassage({ text: line });
assert.ok(again.already, 'the same line twice is one passage, not two');
assert.equal(again.passage.id, kept.passage.id);
assert.equal(passages.listPassages().length, 1);
assert.equal(passages.savePassage({ text: '   ' }).error, 'empty');

assert.ok(passages.deletePassage(kept.passage.id).ok);
assert.equal(passages.listPassages().length, 0, 'a forgotten passage leaves the shelf');
assert.equal(passages.deletePassage(kept.passage.id).error, 'not_found');
console.log('passages OK — kept, de-duplicated, listed, forgotten');

// ─── Lane tag ────────────────────────────────────────────────────────────────
// The tag must name what ANSWERED, not what was asked for: a pinned paid lane
// that fell back to the free lane used to keep printing the paid model's name.
const { computeLaneTag } = await import('../server/src/services/turnRouter.js');
const pinned = { provider: 'openai', model: 'gpt-4.1', tag: 'ChatGPT · gpt-4.1' };
assert.equal(computeLaneTag('forced', pinned, 'openai'), 'ChatGPT · gpt-4.1', 'the pinned lane answered');
assert.equal(computeLaneTag('forced', pinned, 'groq'), 'Groq', 'it fell back to Groq');
assert.equal(computeLaneTag('forced', pinned, 'claude-side'), 'claude', 'it fell back to Claude');
assert.equal(computeLaneTag('forced', { provider: 'claude-code', tag: 'claude' }, 'claude-main'), 'claude');
assert.equal(computeLaneTag('about_app', pinned, 'groq'), 'git', 'the repo lane is still the repo lane');
console.log('lane tag OK — names the model that actually answered');

// ─── Prompt budget ───────────────────────────────────────────────────────────
// OpenAI counts the question and the answer against one per-minute ceiling, so
// a long answer must leave room for itself. Only that lane has the ceiling.
const { promptCharBudget } = await import('../server/src/services/ai/text.js');
assert.equal(promptCharBudget({ feature: 'studio', provider: 'google-ai-studio', maxTokens: 8400 }), null, 'a free lane has no ceiling');
const budget = promptCharBudget({ feature: 'studio', provider: 'openai', maxTokens: 8400 });
// 30000 - 8400 answer - 3000 headroom = 18600 tokens of question.
assert.equal(budget, Math.round(18600 * 3.6));
assert.ok(budget + 8400 * 3.6 < 30000 * 3.6, 'question + answer must fit under the ceiling');
// A huge answer must never drive the budget negative — the floor holds.
assert.equal(promptCharBudget({ feature: 'studio', provider: 'openai', maxTokens: 32000 }), 20000);
console.log(`prompt budget OK — ${budget} chars for the question when the answer may run 8400 tokens`);

// ─── A cut answer carries on ─────────────────────────────────────────────────
// An answer stopped by the output ceiling ends mid-word. The loop must ask for
// the rest and join it seamlessly — never hand over half a sentence.
const { runCatalogueToolLoop } = await import('../server/src/services/ai/text.js');
const { turnMaxTokens } = convos;
let calls = 0;
const fakeMod = {
  chatCompletion: async () => {
    calls += 1;
    if (calls === 1) return { text: 'the grace we extend will return decades later to prot', truncated: true, content: [] };
    return { text: 'ect a child.', truncated: false, content: [] };
  },
};
const rejoined = await runCatalogueToolLoop({
  mod: fakeMod, providerId: 'google-ai-studio', model: 'gemini-flash-latest',
  prompt: 'x', maxTokens: 8400, timeoutMs: 1000, tools: null, dispatchTool: null,
  maxRounds: 6, toolResultCap: 4000, label: 'selftest',
});
assert.equal(calls, 2, 'the cut answer is continued exactly once');
assert.equal(rejoined.text, 'the grace we extend will return decades later to protect a child.', 'the join falls inside the cut word');

// It must give up rather than loop forever on a model that is always truncated.
let endless = 0;
const alwaysCut = { chatCompletion: async () => { endless += 1; return { text: ' more', truncated: true, content: [] }; } };
const gaveUp = await runCatalogueToolLoop({
  mod: alwaysCut, providerId: 'google-ai-studio', model: 'm', prompt: 'x', maxTokens: 100,
  timeoutMs: 1000, tools: null, dispatchTool: null, maxRounds: 6, toolResultCap: 100, label: 'selftest',
});
assert.equal(endless, 3, 'one first try plus two continuations, then it stops');
assert.equal(gaveUp.text, 'more more more');

// And the ceiling itself has to be big enough that the cut is rare: a thinking
// model spends part of the budget before it writes a word.
const db2 = openDb();
const { convo: lengthy } = createOpenConvo({ title: 'Length' });
db2.prepare('INSERT INTO convo_messages (id, convo_id, role, kind, text) VALUES (?,?,?,?,?)')
  .run('L1', lengthy.id, 'user', 'chat', 'give me 4000 words on this');
const roof = turnMaxTokens(lengthy.id);
assert.ok(roof >= 4000 * 1.4 + 2000, `4000 words needs room to actually write them, got ${roof}`);
assert.equal(turnMaxTokens(convo.id), 4000, 'no length asked -> the standing ceiling');
console.log(`cut answers OK — continued and joined; a 4000-word ask now gets ${roof} tokens`);

// ─── Folding a long thread ───────────────────────────────────────────────────
// The cut is placed BEFORE the last few exchanges, not at "now": a recap is a
// summary of what was settled, and the live edge of a conversation is where the
// half-finished thought is. Summarising that edge is how a fold loses the thread.
{
  const msg = (i) => ({ id: 'x' + i, kind: 'chat', text: 't' + i });
  const long = Array.from({ length: 20 }, (_, i) => msg(i));
  const foldedLong = convos.foldCut(long);
  assert.equal(foldedLong.length, 14, 'the last six messages stay word for word');
  assert.equal(foldedLong[foldedLong.length - 1].id, 'x13');

  const short = Array.from({ length: 4 }, (_, i) => msg(i));
  const foldedShort = convos.foldCut(short);
  assert.equal(foldedShort.length, 3, 'a short thread still folds all but its last message');
  assert.ok(convos.foldCut(Array.from({ length: 7 }, (_, i) => msg(i))).length === 1);
  console.log('fold cut OK — the newest exchanges are never summarised away');
}

// ─── Clarifying questions & Interview mode ───────────────────────────────────
{
  // Mode normalisation: a fresh conversation reads as 'normal' (the default, not
  // app-wide — a new thread never opens in Interview), a set mode round-trips,
  // an invalid one is rejected, and a missing conversation is a clean not_found —
  // same shape as the lane helpers this mirrors.
  const { convo: clarifyConvo } = createOpenConvo({ title: 'Clarify test' });
  assert.equal(getClarificationMode(clarifyConvo.id), 'normal', 'a new thread starts normal');
  assert.equal(convos.getConvo(clarifyConvo.id).clarification_mode, 'normal', 'and reads that way straight off the row');
  assert.deepEqual(setClarificationMode(clarifyConvo.id, 'interview'), { ok: true, mode: 'interview' });
  assert.equal(getClarificationMode(clarifyConvo.id), 'interview');
  assert.equal(setClarificationMode(clarifyConvo.id, 'bogus').error, 'invalid_mode');
  assert.equal(getClarificationMode(clarifyConvo.id), 'interview', 'a rejected mode does not clobber the one already set');
  assert.equal(setClarificationMode('missing', 'normal').error, 'not_found');
  assert.equal(getClarificationMode('missing'), 'not_found');
  console.log('clarification mode OK — normalised, round-trips, invalid input rejected, missing thread is not_found');

  // Narrow natural-language detection: the fixed phrases hit (with a little slack
  // for "please"/"can you"/trailing punctuation), but a sentence that merely
  // discusses the feature — or buries the phrase in more words — must not.
  const startHits = ['ask me questions', 'Interview me about this.', 'help me clarify what I mean', 'question me before answering', 'Can you ask me questions about it?'];
  const startMisses = ['does the room ever ask me questions', 'I want you to ask me questions about something and then explain it', 'what happens if I interview me'];
  for (const s of startHits) assert.ok(convos.INTERVIEW_START_RE.test(s), `should start: ${s}`);
  for (const s of startMisses) assert.ok(!convos.INTERVIEW_START_RE.test(s), `should NOT start: ${s}`);

  const endHits = ['answer now', 'You can answer now.', 'ok answer now', 'Okay, answer now!'];
  const endMisses = ['can you answer now eventually', 'answer now please give me the detail', 'I will answer now'];
  for (const s of endHits) assert.ok(convos.ANSWER_NOW_RE.test(s), `should answer now: ${s}`);
  for (const s of endMisses) assert.ok(!convos.ANSWER_NOW_RE.test(s), `should NOT answer now: ${s}`);
  console.log('interview phrase detection OK — narrow enough to skip a discussion ABOUT the feature');

  // The invariant that matters most: a synthesis that never ran (or failed before
  // saving) must never clear the mode. answerNow on a conversation that does not
  // exist fails before any model call or save — cheapest possible proof that the
  // error path takes no side effect. (The success path — clearing the mode only
  // after saveAssistantTurn — is a live-model call and is instead exercised by
  // hand against the Room; see the plan's "How to verify".)
  const before = getClarificationMode(clarifyConvo.id);
  const failed = await convos.answerNow('missing-convo-id', {});
  assert.equal(failed.error, 'not_found');
  assert.equal(getClarificationMode(clarifyConvo.id), before, 'a failed/absent answer-now leaves every mode untouched');
  console.log('answer-now failure invariant OK — no save, no mode change');
}
