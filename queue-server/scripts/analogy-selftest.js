// npm run analogy:selftest — the analogy engine's pure parts (steering, parsing)
// plus a throwaway-SQLite integration pass over the request engine, all with
// canned model replies: no network, no credits.
//
// The integration half is the part worth guarding. A manual ask now runs as a
// durable, resumable, cancellable background job instead of one inline call, and
// that state machine is exactly the kind of thing that looks right until a
// restart, a failure mid-batch, or two quick asks in a row expose it.

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

const { normalizeSteer, parseArrivals, STEER_DEFAULT } = await import('../server/src/services/roomAnalogies.js');

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

console.log('parsing an answer');

const good = JSON.stringify({ arrivals: [{
  left: 'household', right: 'guild',
  title: 'Loyalty that forbids change',
  reading: 'Both make belonging depend on staying the same.',
  question: 'What would let belonging survive a change?',
}] });

ok('a clean answer parses', () => {
  const [a] = parseArrivals(good);
  assert.equal(a.kind, 'arrival');
  assert.equal(a.left, 'household');
  assert.equal(a.title, 'Loyalty that forbids change');
});

ok('prose and a code fence around the JSON do not stop it', () => {
  const wrapped = 'Here is what I found.\n```json\n' + good + '\n```\nHope that helps.';
  assert.equal(parseArrivals(wrapped).length, 1);
});

ok('a half-written card is dropped and its siblings survive', () => {
  const mixed = JSON.stringify({ arrivals: [
    { left: 'a', right: 'b', title: 'keeps' },
    { left: '', right: 'b', title: 'no left' },
    { left: 'a', right: 'b', title: '' },
  ] });
  const out = parseArrivals(mixed);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'keeps');
});

ok('a cap trims the list, and no cap leaves it whole', () => {
  const many = JSON.stringify({ arrivals: Array.from({ length: 9 }, (_, i) => ({ left: 'a', right: 'b', title: 't' + i })) });
  assert.equal(parseArrivals(many, { cap: 3 }).length, 3);
  assert.equal(parseArrivals(many).length, 9);
});

ok('an answer with no JSON at all is nothing, not a crash', () => {
  assert.deepEqual(parseArrivals('I could not find anything this time.'), []);
  assert.deepEqual(parseArrivals(''), []);
  assert.deepEqual(parseArrivals(null), []);
  assert.deepEqual(parseArrivals('{"arrivals": [ broken'), []);
});

ok('the anchor and the asked flag ride along', () => {
  const [a] = parseArrivals(good, { anchorMessageId: 'msg-7', asked: true });
  assert.equal(a.anchor_message_id, 'msg-7');
  assert.equal(a.asked, true);
  assert.equal(parseArrivals(good)[0].asked, false);
});

ok('long fields are cut, not rejected', () => {
  const big = JSON.stringify({ arrivals: [{ left: 'a', right: 'b', title: 'x'.repeat(500), reading: 'y'.repeat(5000) }] });
  const [a] = parseArrivals(big);
  assert.equal(a.title.length, 120);
  assert.equal(a.reading.length, 600);
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

function arrivalsJson(items) {
  return JSON.stringify({ arrivals: items.map((t, i) => ({ left: 'l' + i, right: 'r' + i, title: t, reading: 'reads', question: 'q' })) });
}

// A scripted model: each call pops the next canned reply. Replies are functions
// of the prompt so a test can tell first-batch prompts from continuation prompts
// apart without guessing call order.
function scripted(handlers) {
  let calls = 0;
  return async ({ prompt }) => {
    calls++;
    for (const h of handlers) {
      const out = h(prompt, calls);
      if (out !== undefined) return out;
    }
    return { text: '{"arrivals":[]}' };
  };
}
const isFirstBatch = (p) => p.includes('First work out how many');
const isContinuation = (p) => p.includes('Already offered');
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

console.log('\nrequests: default count, exact counts, batching');

await okAsync('no number stated defaults to exactly three, in one batch', async () => {
  const room = makeRoom('t1');
  completeExchange(room.id, 'tell me about loyalty and change', 'sure, here is a reading');
  ana.__setGenerateTextForTest(scripted([
    (p) => isFirstBatch(p) ? { text: JSON.stringify({ requested_count: null, arrivals: JSON.parse(arrivalsJson(['a', 'b', 'c'])).arrivals }) } : undefined,
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
  let batchNo = 0;
  ana.__setGenerateTextForTest(scripted([
    (p) => isFirstBatch(p) ? { text: JSON.stringify({ requested_count: 10, arrivals: JSON.parse(arrivalsJson(['a1', 'a2', 'a3', 'a4', 'a5', 'a6'])).arrivals }) } : undefined,
    (p) => { if (!isContinuation(p)) return undefined; batchNo++; return { text: arrivalsJson([`b${batchNo}-1`, `b${batchNo}-2`, `b${batchNo}-3`, `b${batchNo}-4`]) }; },
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
    (p) => isFirstBatch(p) ? { text: JSON.stringify({ requested_count: null, arrivals: JSON.parse(arrivalsJson(['a', 'b', 'c'])).arrivals }) } : undefined,
  ]));
  ana.askAnalogies(room.id, 'analogies for five-act tragedy');
  await waitFor(() => requestOf(room.id)?.status === 'complete');
  assert.equal(requestOf(room.id).requested_count, 3);
});

console.log('\nrequests: malformed output, pause, resume, duplicates');

await okAsync('malformed requested_count falls back to the default of three', async () => {
  const room = makeRoom('t4');
  completeExchange(room.id, 'x', 'y');
  ana.__setGenerateTextForTest(scripted([
    (p) => isFirstBatch(p) ? { text: '{"requested_count":"lots","arrivals":[{"left":"a","right":"b","title":"t"}]}' } : undefined,
  ]));
  ana.askAnalogies(room.id, 'find me some');
  await waitFor(() => requestOf(room.id)?.status !== 'queued' && requestOf(room.id)?.status !== 'running');
  assert.equal(requestOf(room.id).requested_count, 3);
});

await okAsync('a failed batch pauses the request at its true delivered count; resume continues without duplicates', async () => {
  const room = makeRoom('t5');
  completeExchange(room.id, 'x', 'y');
  let secondCallShouldFail = true;
  ana.__setGenerateTextForTest(scripted([
    (p) => isFirstBatch(p) ? { text: JSON.stringify({ requested_count: 8, arrivals: JSON.parse(arrivalsJson(['a1','a2','a3','a4','a5','a6'])).arrivals }) } : undefined,
    (p) => {
      if (!isContinuation(p)) return undefined;
      if (secondCallShouldFail) { secondCallShouldFail = false; return { error: 'provider_down' }; }
      return { text: arrivalsJson(['b1', 'b2']) };
    },
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

await okAsync('an exact duplicate is rejected; the request keeps asking for what is still missing', async () => {
  const room = makeRoom('t6');
  completeExchange(room.id, 'x', 'y');
  let round = 0;
  ana.__setGenerateTextForTest(scripted([
    (p) => isFirstBatch(p) ? { text: JSON.stringify({ requested_count: 4, arrivals: JSON.parse(arrivalsJson(['keep1', 'keep2'])).arrivals }) } : undefined,
    (p) => {
      if (!isContinuation(p)) return undefined;
      round++;
      // First continuation repeats an existing title (must be dropped) plus one
      // genuinely new one; second continuation supplies the last one.
      if (round === 1) return { text: arrivalsJson(['keep1', 'new1']) };
      return { text: arrivalsJson(['new2']) };
    },
  ]));
  ana.askAnalogies(room.id, 'give me four');
  await waitFor(() => requestOf(room.id)?.status === 'complete');
  const req = requestOf(room.id);
  assert.equal(req.delivered_count, 4);
  const titles = ana.listAnalogies(room.id).items.filter((i) => i.card).map((i) => i.card.title);
  assert.deepEqual(new Set(titles).size, titles.length, 'no exact duplicate title made it through');
});

console.log('\nrequests: queueing and cancellation');

await okAsync('two quick asks run in order; cancelling the first lets the second start', async () => {
  const room = makeRoom('t7');
  completeExchange(room.id, 'x', 'y');
  let released = false;
  ana.__setGenerateTextForTest(scripted([
    (p, call) => isFirstBatch(p) && call === 1 ? new Promise((resolve) => {
      const wait = () => released ? resolve({ text: JSON.stringify({ requested_count: 3, arrivals: JSON.parse(arrivalsJson(['a','b','c'])).arrivals }) }) : setTimeout(wait, 5);
      wait();
    }) : undefined,
    (p) => isFirstBatch(p) ? { text: JSON.stringify({ requested_count: 2, arrivals: JSON.parse(arrivalsJson(['x','y'])).arrivals }) } : undefined,
  ]));
  const first = ana.askAnalogies(room.id, 'first ask');
  const second = ana.askAnalogies(room.id, 'second ask');
  // The first ask's model call is already blocked (pending on `released`) by the
  // time askAnalogies returns, so the second request's status is settled already.
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
  // Simulate a request that a dead process left mid-flight: write the row
  // directly rather than going through askAnalogies, so nothing is generating.
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
    (p) => isContinuation(p) ? { text: arrivalsJson(['new1', 'new2']) } : undefined,
  ]));
  // GET /analogies is exactly what calls this path in production.
  ana.listAnalogies(room.id);
  await waitFor(() => requestOf(room.id)?.status === 'complete');
  assert.equal(requestOf(room.id).delivered_count, 3);
  // A second GET while it is already resumed must not start a second worker —
  // proven by the delivered count staying put rather than overshooting.
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
    (p) => isContext(p) ? { text: JSON.stringify({ subject: 'Loyalty vs change', central_relation: 'belonging that punishes change', focus: 'why loyalty resists change', background_threads: [], open_question: '', frame: { positions: ['member', 'group'], relations: ['staying earns belonging'] } }) } : undefined,
  ]));
  ana.analogyLook(room.id);
  await waitFor(() => !!ana.getContext(room.id));
  assert.equal(ana.getContext(room.id).subject, 'Loyalty vs change');
  // No unasked card must have appeared — the toggle is off.
  assert.equal(ana.listAnalogies(room.id).items.filter((i) => i.card).length, 0);
});

await okAsync('"as you talk" offers at most one unasked arrival per exchange', async () => {
  const room = makeRoom('t10');
  completeExchange(room.id, 'a guild forbids leaving', 'a household does too');
  ana.__setGenerateTextForTest(scripted([
    (p) => isContext(p) ? { text: '{}' } : undefined,
    (p) => !isContext(p) ? { text: arrivalsJson(['one', 'two', 'three']) } : undefined,
  ]));
  ana.analogyLook(room.id);
  await waitFor(() => ana.listAnalogies(room.id).items.filter((i) => i.card).length > 0);
  assert.equal(ana.listAnalogies(room.id).items.filter((i) => i.card).length, 1);
});

console.log(`\n${n} checks passed total — no model call, no credits.`);
