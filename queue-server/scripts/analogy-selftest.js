// npm run analogy:selftest — the analogy engine's pure parts (steering, parsing,
// index selection) plus a throwaway-SQLite integration pass over the request
// engine, all with canned model replies: no network, no credits.
//
// Every arrival now goes through TWO independent model calls — a generator that
// proposes candidates broadly, and a critic that judges them — so the scripted
// stub below distinguishes the two by a marker each prompt carries
// ("ANALOGY GENERATOR" / "ANALOGY CRITIC"), not by call order.

import assert from 'node:assert/strict';
process.env.JWT_SECRET ||= 'selftest';
process.env.ADMIN_PASSWORD ||= 'selftest';
process.env.DB_PATH ||= '/tmp/qne-analogy-selftest.db';
import { rmSync } from 'node:fs';
rmSync(process.env.DB_PATH, { force: true });

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };
const okAsync = async (name, fn) => { await fn(); n++; console.log('  ✓ ' + name); };

// ─── Pure parts: no DB ────────────────────────────────────────────────────────

const { normalizeSteer, parseCandidates, STEER_DEFAULT } = await import('../server/src/services/roomAnalogies.js');

console.log('steering');

ok('nothing given falls back to the default', () => {
  assert.deepEqual(normalizeSteer(null), STEER_DEFAULT);
  assert.deepEqual(normalizeSteer('nonsense'), STEER_DEFAULT);
});

ok('the legacy "every" value means the same as "pause"', () => {
  assert.equal(normalizeSteer({ when: 'every' }).when, 'pause');
});

ok('old moves/domains/reach fields are ignored, never treated as an unknown-when crash', () => {
  assert.deepEqual(normalizeSteer({ moves: ['vertical'], domains: ['biology'], reach: 'here', when: 'asked' }), { when: 'asked' });
});

ok('an unrecognised when falls back to the default', () => {
  assert.equal(normalizeSteer({ when: 'whenever' }).when, 'pause');
});

console.log('parsing a candidate pool');

const good = JSON.stringify({ candidates: [{
  left: 'household', right: 'guild',
  title: 'Loyalty that forbids change',
  reading: 'Both make belonging depend on staying the same.',
  question: 'What would let belonging survive a change?',
  left_scale: 'family', right_scale: 'institution',
  structural_frame: { positions: ['member', 'elder'], relations: ['staying earns belonging'] },
}] });

ok('a clean answer parses', () => {
  const [a] = parseCandidates(good);
  assert.equal(a.left, 'household');
  assert.equal(a.title, 'Loyalty that forbids change');
  assert.equal(a.left_scale, 'family');
  assert.equal(a.right_scale, 'institution');
  assert.deepEqual(a.structural_frame.positions, ['member', 'elder']);
});

ok('prose and a code fence around the JSON do not stop it', () => {
  const wrapped = 'Here is what I found.\n```json\n' + good + '\n```\nHope that helps.';
  assert.equal(parseCandidates(wrapped).length, 1);
});

ok('a half-written candidate is dropped and its siblings survive', () => {
  const mixed = JSON.stringify({ candidates: [
    { left: 'a', right: 'b', title: 'keeps' },
    { left: '', right: 'b', title: 'no left' },
    { left: 'a', right: 'b', title: '' },
  ] });
  const out = parseCandidates(mixed);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'keeps');
});

ok('an answer with no JSON at all is nothing, not a crash', () => {
  assert.deepEqual(parseCandidates('I could not find anything this time.'), []);
  assert.deepEqual(parseCandidates(''), []);
  assert.deepEqual(parseCandidates(null), []);
  assert.deepEqual(parseCandidates('{"candidates": [ broken'), []);
});

ok('long fields are cut, not rejected; scale and frame fields are length-limited too', () => {
  const big = JSON.stringify({ candidates: [{
    left: 'a', right: 'b', title: 'x'.repeat(500), reading: 'y'.repeat(5000),
    left_scale: 'z'.repeat(200),
    structural_frame: { positions: ['p'.repeat(200)], relations: ['r'.repeat(500)] },
  }] });
  const [a] = parseCandidates(big);
  assert.equal(a.title.length, 120);
  assert.equal(a.reading.length, 600);
  assert.equal(a.left_scale.length, 40);
  assert.equal(a.structural_frame.positions[0].length, 60);
  assert.equal(a.structural_frame.relations[0].length, 160);
});

ok('missing scale/frame fields default to empty, not a crash — older shapes still parse', () => {
  const bare = JSON.stringify({ candidates: [{ left: 'a', right: 'b', title: 't' }] });
  const [a] = parseCandidates(bare);
  assert.equal(a.left_scale, '');
  assert.deepEqual(a.structural_frame, { positions: [], relations: [] });
});

console.log(`\n${n} pure checks passed — no model call, no credits.`);

// ─── Integration: a throwaway SQLite database, mocked model replies ──────────

const { openDb } = await import('../server/src/db/schema.js');
const convosSvc = await import('../server/src/services/conversations.js');
const ana = await import('../server/src/services/roomAnalogies.js');

const db = openDb();
convosSvc.bindConversationsDb(db);
ana.bindRoomAnalogiesDb(db);

function makeRoom(title) {
  const { convo } = convosSvc.createOpenConvo({ title });
  return convo;
}

function say(convoId, role, text) {
  const id = 'm-' + Math.random().toString(36).slice(2);
  db.prepare(`INSERT INTO convo_messages (id, convo_id, role, kind, text) VALUES (?,?,?,'chat',?)`).run(id, convoId, role, text);
  return id;
}

function completeExchange(convoId, userText, assistantText) {
  say(convoId, 'user', userText);
  say(convoId, 'assistant', assistantText);
  db.prepare(`UPDATE convos SET turns=turns+1 WHERE id=?`).run(convoId);
}

// A pool of candidates for the generator to hand back. `scale` defaults to a
// social pair so tests don't have to spell it out every time.
function candidatesJson(titles, { requestedCount, scale = ['family', 'institution'] } = {}) {
  const body = {
    candidates: titles.map((t, i) => ({
      left: 'l' + i, right: 'r' + i, title: t, reading: 'reads', question: 'q',
      left_scale: scale[0], right_scale: scale[1],
    })),
  };
  if (requestedCount !== undefined) body.requested_count = requestedCount;
  return JSON.stringify(body);
}

function acceptedJson(indices) { return JSON.stringify({ accepted: indices }); }

// A scripted model: a FIFO queue of {test, reply} entries. Each call finds the
// FIRST still-unconsumed entry whose `test` matches the prompt and removes it —
// this keeps a whole test's script readable top-to-bottom in the order calls are
// expected to happen, while still letting a generator call and a critic call be
// told apart by what their prompt actually says, not by counting.
function scripted(entries) {
  const queue = entries.slice();
  return async ({ prompt }) => {
    const idx = queue.findIndex((e) => e.test(prompt));
    if (idx === -1) return { text: '{"candidates":[]}' };
    const [entry] = queue.splice(idx, 1);
    return typeof entry.reply === 'function' ? entry.reply() : entry.reply;
  };
}
const isGenerator = (p) => p.startsWith('ANALOGY GENERATOR');
const isCritic = (p) => p.startsWith('ANALOGY CRITIC');
const isFirstBatch = (p) => isGenerator(p) && p.includes('work out how many');
const isContinuation = (p) => isGenerator(p) && !p.includes('work out how many') && p.includes('directly asked');
const isUnasked = (p) => isGenerator(p) && p.includes('No direct request was made this time');
const isContext = (p) => p.includes('STANDING SUBJECT');

async function waitFor(fn, { timeoutMs = 3000, stepMs = 10 } = {}) {
  const start = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

function requestOf(convoId) {
  const items = ana.listAnalogies(convoId).items;
  return items.find((i) => i.request)?.request || null;
}

console.log('\nprompt contract: every generator prompt Antoine can end up reading carries the shared style and voice');

await okAsync('the generator prompt carries USER_FACING_STYLE and the QNE voice block; the critic prompt does not need to', async () => {
  const captured = [];
  ana.__setGenerateTextForTest(async ({ prompt }) => { captured.push(prompt); return { text: '{"candidates":[]}' }; });
  ana.askAnalogies(makeRoom('contract').id, 'find me some analogies');
  await waitFor(() => captured.length > 0);
  const gen = captured.find(isGenerator);
  assert.ok(gen, 'a generator prompt was issued');
  assert.ok(gen.includes('Write in English'), 'USER_FACING_STYLE is present');
  assert.ok(gen.includes('=== HOW TO THINK AND WRITE ==='), 'the QNE voice block is present');
});

console.log('\nsocial-first: the default search is social, not scientific');

await okAsync('a discussion of a court expelling internal conflict produces social candidates, no biology by default', async () => {
  const room = makeRoom('t-social');
  completeExchange(room.id, 'the court keeps sending its own scandal onto one junior member', 'yes, exactly');
  ana.__setGenerateTextForTest(scripted([
    { test: isFirstBatch, reply: { text: candidatesJson(['a family scapegoats one child', 'a company culture that punishes dissent', 'a species immune response'], { requestedCount: 2, scale: ['institution', 'family'] }) } },
    { test: isCritic, reply: { text: acceptedJson([0, 1]) } }, // the biology one (index 2) is never picked
  ]));
  ana.askAnalogies(room.id, 'find me some analogies for this');
  await waitFor(() => requestOf(room.id)?.status === 'complete');
  const cards = ana.listAnalogies(room.id).items.filter((i) => i.card).map((i) => i.card);
  assert.equal(cards.length, 2);
  assert.ok(cards.every((c) => c.left_scale === 'institution' && c.right_scale === 'family'));
});

console.log('\nrequests: default count, exact counts, batching');

await okAsync('no number stated defaults to exactly three, in one reviewed batch', async () => {
  const room = makeRoom('t1');
  completeExchange(room.id, 'tell me about loyalty and change', 'sure, here is a reading');
  ana.__setGenerateTextForTest(scripted([
    { test: isFirstBatch, reply: { text: candidatesJson(['a', 'b', 'c', 'd'], { requestedCount: null }) } },
    { test: isCritic, reply: { text: acceptedJson([0, 1, 2]) } },
  ]));
  ana.askAnalogies(room.id, 'find me some analogies for this');
  await waitFor(() => requestOf(room.id)?.status === 'complete');
  const req = requestOf(room.id);
  assert.equal(req.requested_count, 3);
  assert.equal(req.delivered_count, 3);
});

await okAsync('an explicit count over the batch cap arrives across several batches', async () => {
  const room = makeRoom('t2');
  completeExchange(room.id, 'talk about guilds', 'sure');
  ana.__setGenerateTextForTest(scripted([
    { test: isFirstBatch, reply: { text: candidatesJson(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'], { requestedCount: 10 }) } },
    { test: isCritic, reply: { text: acceptedJson([0, 1, 2, 3, 4, 5]) } },
    { test: isContinuation, reply: { text: candidatesJson(['b1-1', 'b1-2', 'b1-3', 'b1-4']) } },
    { test: isCritic, reply: { text: acceptedJson([0, 1, 2, 3]) } },
  ]));
  ana.askAnalogies(room.id, 'give me ten analogies');
  await waitFor(() => requestOf(room.id)?.status === 'complete');
  const req = requestOf(room.id);
  assert.equal(req.requested_count, 10);
  assert.equal(req.delivered_count, 10);
  const cards = ana.listAnalogies(room.id).items.filter((i) => i.card).map((i) => i.card);
  assert.equal(cards.length, 10);
  assert.deepEqual(cards.map((c) => c.ordinal), [1,2,3,4,5,6,7,8,9,10]);
});

await okAsync('"five-act structure" is not read as a request for five', async () => {
  const room = makeRoom('t3');
  completeExchange(room.id, 'what about five-act tragedy', 'a classic shape');
  ana.__setGenerateTextForTest(scripted([
    { test: isFirstBatch, reply: { text: candidatesJson(['a', 'b', 'c'], { requestedCount: null }) } },
    { test: isCritic, reply: { text: acceptedJson([0, 1, 2]) } },
  ]));
  ana.askAnalogies(room.id, 'analogies for five-act tragedy');
  await waitFor(() => requestOf(room.id)?.status === 'complete');
  assert.equal(requestOf(room.id).requested_count, 3);
});

console.log('\nexplicit domain requests still work');

await okAsync('"give me twelve from biology" is honored end to end', async () => {
  const room = makeRoom('t-biology');
  completeExchange(room.id, 'x', 'y');
  ana.__setGenerateTextForTest(scripted([
    { test: isFirstBatch, reply: { text: candidatesJson(Array.from({ length: 8 }, (_, i) => 'bio' + i), { requestedCount: 12, scale: ['organism', 'organ'] }) } },
    { test: isCritic, reply: { text: acceptedJson([0, 1, 2, 3, 4, 5]) } },
    { test: isContinuation, reply: { text: candidatesJson(Array.from({ length: 6 }, (_, i) => 'bio-b1-' + i), { scale: ['organism', 'organ'] }) } },
    { test: isCritic, reply: { text: acceptedJson([0, 1, 2, 3, 4, 5]) } },
  ]));
  ana.askAnalogies(room.id, 'give me twelve from biology');
  await waitFor(() => requestOf(room.id)?.status === 'complete');
  const req = requestOf(room.id);
  assert.equal(req.requested_count, 12);
  assert.equal(req.delivered_count, 12);
});

console.log('\nrequests: malformed output, pause, resume, duplicates');

await okAsync('malformed requested_count falls back to the default of three', async () => {
  const room = makeRoom('t4');
  completeExchange(room.id, 'x', 'y');
  ana.__setGenerateTextForTest(scripted([
    { test: isFirstBatch, reply: { text: '{"requested_count":"lots","candidates":[{"left":"a","right":"b","title":"t"}]}' } },
    { test: isCritic, reply: { text: acceptedJson([0]) } },
  ]));
  ana.askAnalogies(room.id, 'find me some');
  await waitFor(() => requestOf(room.id)?.status !== 'queued' && requestOf(room.id)?.status !== 'running');
  assert.equal(requestOf(room.id).requested_count, 3);
});

await okAsync('a failed critic call pauses the request at its true delivered count; resume continues without duplicates', async () => {
  const room = makeRoom('t5');
  completeExchange(room.id, 'x', 'y');
  ana.__setGenerateTextForTest(scripted([
    { test: isFirstBatch, reply: { text: candidatesJson(['a1','a2','a3','a4','a5','a6'], { requestedCount: 8 }) } },
    { test: isCritic, reply: { text: acceptedJson([0,1,2,3,4,5]) } },
    { test: isContinuation, reply: { text: candidatesJson(['b1', 'b2']) } },
    { test: isCritic, reply: { error: 'provider_down' } }, // the batch this pool feeds fails
    { test: isContinuation, reply: { text: candidatesJson(['b1', 'b2']) } }, // resume re-generates the same need
    { test: isCritic, reply: { text: acceptedJson([0, 1]) } },
  ]));
  const { request } = ana.askAnalogies(room.id, 'give me eight');
  await waitFor(() => requestOf(room.id)?.status === 'paused');
  assert.equal(requestOf(room.id).delivered_count, 6);
  assert.equal(requestOf(room.id).last_error, 'provider_down');

  ana.resumeRequest(room.id, request.id);
  await waitFor(() => requestOf(room.id)?.status === 'complete');
  const req = requestOf(room.id);
  assert.equal(req.delivered_count, 8);
  const ordinals = ana.listAnalogies(room.id).items.filter((i) => i.card).map((i) => i.card.ordinal).sort((a, b) => a - b);
  assert.deepEqual(ordinals, [1,2,3,4,5,6,7,8]);
});

await okAsync('a candidate that duplicates one already accepted is filtered before the critic ever sees it', async () => {
  const room = makeRoom('t6');
  completeExchange(room.id, 'x', 'y');
  ana.__setGenerateTextForTest(scripted([
    { test: isFirstBatch, reply: { text: candidatesJson(['keep1', 'keep2'], { requestedCount: 4 }) } },
    { test: isCritic, reply: { text: acceptedJson([0, 1]) } },
    // This pool repeats "keep1" verbatim plus one genuinely new title — "keep1" is
    // filtered out before the critic ever sees it, leaving one candidate at index 0.
    { test: isContinuation, reply: { text: candidatesJson(['keep1', 'new1']) } },
    { test: isCritic, reply: { text: acceptedJson([0]) } },
    { test: isContinuation, reply: { text: candidatesJson(['new2']) } },
    { test: isCritic, reply: { text: acceptedJson([0]) } },
  ]));
  ana.askAnalogies(room.id, 'give me four');
  await waitFor(() => requestOf(room.id)?.status === 'complete');
  const req = requestOf(room.id);
  assert.equal(req.delivered_count, 4);
  const titles = ana.listAnalogies(room.id).items.filter((i) => i.card).map((i) => i.card.title);
  assert.deepEqual(new Set(titles).size, titles.length, 'no exact duplicate title made it through');
});

await okAsync('a critic returning fewer than needed causes another pool to be generated', async () => {
  const room = makeRoom('t-underfill');
  completeExchange(room.id, 'x', 'y');
  ana.__setGenerateTextForTest(scripted([
    { test: isFirstBatch, reply: { text: candidatesJson(['a1', 'a2'], { requestedCount: 4 }) } },
    { test: isCritic, reply: { text: acceptedJson([0, 1]) } }, // only 2 of the wanted 4 land first
    { test: isContinuation, reply: { text: candidatesJson(['x1', 'y1']) } },
    { test: isCritic, reply: { text: acceptedJson([0, 1]) } },
  ]));
  ana.askAnalogies(room.id, 'give me four');
  await waitFor(() => requestOf(room.id)?.status === 'complete');
  assert.equal(requestOf(room.id).delivered_count, 4);
});

console.log('\nrequests: queueing and cancellation');

await okAsync('two quick asks run in order; cancelling the first lets the second start', async () => {
  const room = makeRoom('t7');
  completeExchange(room.id, 'x', 'y');
  let released = false;
  ana.__setGenerateTextForTest(scripted([
    { test: isFirstBatch, reply: () => new Promise((resolve) => {
      const wait = () => released ? resolve({ text: candidatesJson(['a','b','c'], { requestedCount: 3 }) }) : setTimeout(wait, 5);
      wait();
    }) },
    { test: isCritic, reply: { text: acceptedJson([0, 1, 2]) } }, // consumed by the first ask, once released — then discarded as cancelled
    { test: isFirstBatch, reply: { text: candidatesJson(['x','y'], { requestedCount: 2 }) } },
    { test: isCritic, reply: { text: acceptedJson([0, 1]) } },
  ]));
  const first = ana.askAnalogies(room.id, 'first ask');
  const second = ana.askAnalogies(room.id, 'second ask');
  const statusesBefore = ana.listAnalogies(room.id).items.filter((i) => i.request).map((i) => i.request.status);
  assert.ok(statusesBefore.includes('queued'), 'the second ask waits behind the first');

  ana.cancelRequest(room.id, first.request.id);
  released = true;
  await waitFor(() => {
    const items = ana.listAnalogies(room.id).items.filter((i) => i.request);
    const s = items.find((i) => i.request.id === second.request.id)?.request.status;
    return s === 'complete';
  });
  const items = ana.listAnalogies(room.id).items.filter((i) => i.request);
  assert.equal(items.find((i) => i.request.id === first.request.id).request.status, 'cancelled');
  assert.equal(items.find((i) => i.request.id === second.request.id).request.status, 'complete');
});

console.log('\nrestart resume');

await okAsync('a request left "running" by a simulated restart resumes once, with no duplicate worker', async () => {
  const room = makeRoom('t8');
  completeExchange(room.id, 'x', 'y');
  const side = ana.sideThread(room.id, { create: true });
  const requestId = 'stranded-1';
  db.prepare(`INSERT INTO convo_messages (id, convo_id, role, kind, text, meta) VALUES (?,?,?,'chat',?,?)`).run(
    'req-' + requestId, side.id, 'user', 'left stranded',
    JSON.stringify({ kind: 'analogy_request', request_id: requestId, requested_count: 3, delivered_count: 1, status: 'running', context_snapshot: null, instruction: 'left stranded', last_error: null }),
  );
  db.prepare(`INSERT INTO convo_messages (id, convo_id, role, kind, text, meta) VALUES (?,?,?,'chat',?,?)`).run(
    'arr-' + requestId, side.id, 'assistant', 'kept1',
    JSON.stringify({ kind: 'arrival', left: 'l', right: 'r', title: 'kept1', request_id: requestId, ordinal: 1, requested_count: 3 }),
  );
  ana.__setGenerateTextForTest(scripted([
    { test: isContinuation, reply: { text: candidatesJson(['new1', 'new2']) } },
    { test: isCritic, reply: { text: acceptedJson([0, 1]) } },
  ]));
  // GET /analogies is exactly what calls this path in production.
  ana.listAnalogies(room.id);
  await waitFor(() => requestOf(room.id)?.status === 'complete');
  assert.equal(requestOf(room.id).delivered_count, 3);
  ana.listAnalogies(room.id);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(requestOf(room.id).delivered_count, 3);
});

console.log('\nliving context and the unasked pass');

await okAsync('the living subject keeps updating even when unasked arrivals are off', async () => {
  const room = makeRoom('t9');
  ana.setSteer(room.id, { when: 'asked' });
  completeExchange(room.id, 'we keep talking about loyalty that forbids change', 'yes, exactly that');
  ana.__setGenerateTextForTest(scripted([
    { test: isContext, reply: { text: JSON.stringify({ subject: 'Loyalty vs change', central_relation: 'belonging that punishes change', focus: 'why loyalty resists change', background_threads: [], open_question: '', frame: { positions: ['member', 'group'], relations: ['staying earns belonging'] } }) } },
  ]));
  ana.analogyLook(room.id);
  await waitFor(() => !!ana.getContext(room.id));
  assert.equal(ana.getContext(room.id).subject, 'Loyalty vs change');
  assert.equal(ana.listAnalogies(room.id).items.filter((i) => i.card).length, 0);
});

await okAsync('"as you talk" offers at most one unasked arrival, generated then reviewed', async () => {
  const room = makeRoom('t10');
  completeExchange(room.id, 'a guild forbids leaving', 'a household does too');
  ana.__setGenerateTextForTest(scripted([
    { test: isContext, reply: { text: '{}' } },
    { test: isUnasked, reply: { text: candidatesJson(['one', 'two', 'three', 'four']) } },
    { test: isCritic, reply: { text: acceptedJson([2]) } }, // critic picks the third, ranked strongest
  ]));
  ana.analogyLook(room.id);
  await waitFor(() => ana.listAnalogies(room.id).items.filter((i) => i.card).length > 0);
  const cards = ana.listAnalogies(room.id).items.filter((i) => i.card).map((i) => i.card);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, 'three');
});

await okAsync('an unsolicited pass stays silent when the critic accepts nothing', async () => {
  const room = makeRoom('t11');
  completeExchange(room.id, 'a guild forbids leaving', 'a household does too');
  ana.__setGenerateTextForTest(scripted([
    { test: isContext, reply: { text: '{}' } },
    { test: isUnasked, reply: { text: candidatesJson(['one', 'two']) } },
    { test: isCritic, reply: { text: acceptedJson([]) } },
  ]));
  ana.analogyLook(room.id);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(ana.listAnalogies(room.id).items.filter((i) => i.card).length, 0);
});

console.log('\nregenerate');

await okAsync('regenerate replaces one card only after the replacement passes the critic, and keeps its slot', async () => {
  const room = makeRoom('t12');
  completeExchange(room.id, 'x', 'y');
  ana.__setGenerateTextForTest(scripted([
    { test: isFirstBatch, reply: { text: candidatesJson(['first-card'], { requestedCount: 1 }) } },
    { test: isCritic, reply: { text: acceptedJson([0]) } },
  ]));
  ana.askAnalogies(room.id, 'find me one');
  await waitFor(() => requestOf(room.id)?.status === 'complete');
  const before = ana.listAnalogies(room.id).items.find((i) => i.card);
  assert.equal(before.card.title, 'first-card');

  ana.__setGenerateTextForTest(scripted([
    { test: isGenerator, reply: { text: candidatesJson(['second-card'], { scale: ['city', 'nation'] }) } },
    { test: isCritic, reply: { text: acceptedJson([0]) } },
  ]));
  const out = await ana.regenerateAnalogy(room.id, before.id);
  assert.equal(out.card.title, 'second-card');
  assert.equal(out.card.ordinal, before.card.ordinal);
  assert.equal(out.card.request_id, before.card.request_id);
  const after = ana.listAnalogies(room.id).items.find((i) => i.id === before.id);
  assert.equal(after.card.title, 'second-card');
});

console.log('\nforget, clear and legacy shapes');

await okAsync('forgetting one card removes only that row', async () => {
  const room = makeRoom('t13');
  completeExchange(room.id, 'x', 'y');
  ana.__setGenerateTextForTest(scripted([
    { test: isFirstBatch, reply: { text: candidatesJson(['a', 'b'], { requestedCount: 2 }) } },
    { test: isCritic, reply: { text: acceptedJson([0, 1]) } },
  ]));
  ana.askAnalogies(room.id, 'find me two');
  await waitFor(() => requestOf(room.id)?.status === 'complete');
  const cards = ana.listAnalogies(room.id).items.filter((i) => i.card);
  assert.equal(cards.length, 2);
  ana.forgetAnalogy(room.id, cards[0].id);
  const remaining = ana.listAnalogies(room.id).items.filter((i) => i.card);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].card.title, 'b');
});

ok('a legacy card stored without scale/frame fields still renders (old shape survives)', () => {
  const room = makeRoom('t14');
  const side = ana.sideThread(room.id, { create: true });
  db.prepare(`INSERT INTO convo_messages (id, convo_id, role, kind, text, meta) VALUES (?,?,?,'chat',?,?)`).run(
    'legacy-1', side.id, 'assistant', 'an old card',
    JSON.stringify({ kind: 'arrival', left: 'l', right: 'r', title: 'an old card', reading: 'reads', question: 'q', asked: false }),
  );
  const items = ana.listAnalogies(room.id).items.filter((i) => i.card);
  assert.equal(items.length, 1);
  assert.equal(items[0].card.title, 'an old card');
  assert.equal(items[0].card.left_scale, undefined);
});

await okAsync('clearing the pane cancels any in-flight request and removes every row', async () => {
  const room = makeRoom('t15');
  completeExchange(room.id, 'x', 'y');
  ana.__setGenerateTextForTest(scripted([
    { test: isFirstBatch, reply: () => new Promise(() => {}) }, // never resolves — the request stays "running"
  ]));
  ana.askAnalogies(room.id, 'find me some');
  await waitFor(() => requestOf(room.id)?.status === 'running');
  const out = ana.clearAnalogies(room.id);
  assert.ok(out.cleared >= 1);
  assert.equal(ana.listAnalogies(room.id).items.length, 0);
});

console.log(`\n${n} checks passed total — no model call, no credits.`);
