// npm run analogy:selftest — the analogy engine's two pure parts, with no DB, no
// network and no model credits: how a steering object is normalised, and what
// survives parsing a model's answer into arrival cards.
//
// The parse is the part worth guarding. A model that answers with prose, with a
// fenced code block, with a move nobody asked for, or with a card missing a side
// must never put a broken card in the pane — and must never lose the good cards
// that came back in the same answer.

import assert from 'node:assert/strict';
import { normalizeSteer, parseArrivals, STEER_DEFAULT, MOVES } from '../server/src/services/roomAnalogies.js';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

console.log('steering');

ok('nothing given falls back to the defaults', () => {
  assert.deepEqual(normalizeSteer(null), { ...STEER_DEFAULT, domains: [] });
  assert.deepEqual(normalizeSteer('nonsense').moves, STEER_DEFAULT.moves);
});

ok('an unknown move is dropped, the known ones kept', () => {
  assert.deepEqual(normalizeSteer({ moves: ['vertical', 'sideways'] }).moves, ['vertical']);
});

ok('all moves invalid means the defaults, never an empty list', () => {
  // An empty move list would be read downstream as "no kinds allowed" and the
  // prompt would ask for nothing at all.
  assert.deepEqual(normalizeSteer({ moves: ['sideways'] }).moves, STEER_DEFAULT.moves);
  assert.deepEqual(normalizeSteer({ moves: [] }).moves, STEER_DEFAULT.moves);
});

ok('reach and when only accept what they know', () => {
  assert.equal(normalizeSteer({ reach: 'here' }).reach, 'here');
  assert.equal(normalizeSteer({ reach: 'mars' }).reach, 'anywhere');
  assert.equal(normalizeSteer({ when: 'asked' }).when, 'asked');
  assert.equal(normalizeSteer({ when: 'whenever' }).when, 'pause');
});

ok('domains are lowercased, de-duplicated and capped', () => {
  const d = normalizeSteer({ domains: ['Biology', 'biology', ' LAW ', ''] }).domains;
  assert.deepEqual(d, ['biology', 'law']);
  assert.equal(normalizeSteer({ domains: Array.from({ length: 40 }, (_, i) => 'd' + i) }).domains.length, 12);
});

console.log('parsing an answer');

const good = JSON.stringify({ arrivals: [{
  move: 'vertical', left: 'household', right: 'guild',
  title: 'Loyalty that forbids change',
  reading: 'Both make belonging depend on staying the same.',
  breaks: 'One bond is personal, the other a formal role.',
  question: 'What would let belonging survive a change?',
}] });

ok('a clean answer parses', () => {
  const [a] = parseArrivals(good);
  assert.equal(a.kind, 'arrival');
  assert.equal(a.move, 'vertical');
  assert.equal(a.left, 'household');
  assert.equal(a.title, 'Loyalty that forbids change');
});

ok('prose and a code fence around the JSON do not stop it', () => {
  const wrapped = 'Here is what I found.\n```json\n' + good + '\n```\nHope that helps.';
  assert.equal(parseArrivals(wrapped).length, 1);
});

ok('an unasked-for move falls back to a steered one', () => {
  const odd = good.replace('"vertical"', '"sideways"');
  assert.equal(parseArrivals(odd, { steer: { ...STEER_DEFAULT, moves: ['antidote'] } })[0].move, 'antidote');
  assert.ok(MOVES.includes(parseArrivals(odd)[0].move));
});

ok('a half-written card is dropped and its siblings survive', () => {
  const mixed = JSON.stringify({ arrivals: [
    { move: 'vertical', left: 'a', right: 'b', title: 'keeps' },
    { move: 'vertical', left: '', right: 'b', title: 'no left' },
    { move: 'vertical', left: 'a', right: 'b', title: '' },
  ] });
  const out = parseArrivals(mixed);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'keeps');
});

ok('no more than three arrivals reach the pane', () => {
  const many = JSON.stringify({ arrivals: Array.from({ length: 9 }, (_, i) => ({ move: 'vertical', left: 'a', right: 'b', title: 't' + i })) });
  assert.equal(parseArrivals(many).length, 3);
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
  const big = JSON.stringify({ arrivals: [{ move: 'vertical', left: 'a', right: 'b', title: 'x'.repeat(500), reading: 'y'.repeat(5000) }] });
  const [a] = parseArrivals(big);
  assert.equal(a.title.length, 120);
  assert.equal(a.reading.length, 600);
});

console.log(`\n${n} checks passed — no model call, no credits.`);
