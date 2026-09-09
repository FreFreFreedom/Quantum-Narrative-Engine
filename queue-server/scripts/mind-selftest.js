// npm run mind:selftest — the Room's memory reaching the repo, proven without a
// database, a network call or a model credit.
//
// Three things can quietly break and cost real memory:
//   1. the unseen-turns slice — off by one and a conversation's ideas are either
//      read twice or missed entirely,
//   2. the split between the two mirror files — a paradigm idea landing in the
//      "what he is like" list, or worse, in neither,
//   3. filename stability — the runner re-derives the file list every few minutes
//      and commits when it differs, so a name or body that varies run to run would
//      push (and redeploy) forever.

import assert from 'node:assert/strict';
import { unseenTurns } from '../server/src/services/mind.js';
import { renderMindFrom, renderVisionFrom, mindFiles, MEMORY_REPO_PATH } from '../server/src/services/mindMirror.js';

let passed = 0;
function ok(name) { passed++; console.log(`  ✓ ${name}`); }

// ─── 1. the unseen slice ──────────────────────────────────────────────────────
const thread = [
  { role: 'user', text: 'q1' }, { role: 'assistant', text: 'a1' },
  { role: 'user', text: 'q2' }, { role: 'assistant', text: 'a2' },
  { role: 'user', text: 'q3' }, { role: 'assistant', text: 'a3' },
];

assert.deepEqual(unseenTurns(thread, 0).map((m) => m.text), ['q1', 'a1', 'q2', 'a2', 'q3', 'a3']);
ok('a thread never harvested is read whole');

// Two of his messages already seen: the slice starts at his THIRD question, and
// carries the answers after it.
assert.deepEqual(unseenTurns(thread, 2).map((m) => m.text), ['q3', 'a3']);
ok('the slice starts at his first unseen question, answers included');

assert.deepEqual(unseenTurns(thread, 3), []);
ok('a fully harvested thread yields nothing (no re-reading, no re-charging)');

// The watermark can exceed the message count — a thread whose messages were
// deleted. Must be empty, never a negative slice that re-reads everything.
assert.deepEqual(unseenTurns(thread, 99), []);
ok('a watermark past the end of the thread is empty, not a wrap-around');

// An answer arriving before any question of his (a greeting turn) must not be
// swallowed: his first message is still the cut point.
const leadingAnswer = [{ role: 'assistant', text: 'a0' }, ...thread];
assert.deepEqual(unseenTurns(leadingAnswer, 0).map((m) => m.text)[0], 'q1');
ok('a leading answer does not shift the cut point');

// ─── 2. the split between the two files ───────────────────────────────────────
const facts = [
  { id: 'f1', kind: 'taste', text: 'Prefers interactive graph visualization', detail: null },
  { id: 'f2', kind: 'vision', text: 'Analogy is a morphogenetic operator', detail: 'The generative mechanism by which archetypal patterns propagate across scales.' },
  { id: 'f3', kind: 'style', text: 'Short replies everywhere', detail: null },
  { id: 'f4', kind: 'vision', text: 'Policies are universal across scales', detail: 'Families and organizations run policies too, not only civic entities.' },
  { id: 'f5', kind: 'newkind', text: 'A kind added later', detail: null },
];

const mind = renderMindFrom(facts);
const vision = renderVisionFrom(facts);

assert.ok(mind.includes('Prefers interactive graph visualization'));
assert.ok(!mind.includes('morphogenetic'), 'the paradigm must not be duplicated into the mind file');
assert.ok(!mind.includes('Policies are universal'), 'the paradigm must not be duplicated into the mind file');
ok('what he is like goes to mind.md, the paradigm does not');

assert.ok(vision.includes('Analogy is a morphogenetic operator'));
assert.ok(vision.includes('archetypal patterns propagate across scales'), 'the reasoning must survive, not just the headline');
assert.ok(!vision.includes('Prefers interactive graph'), 'his preferences do not belong in the vision file');
ok('the paradigm goes to the vision file, reasoning attached');

// A kind added to mind.js later must never silently vanish.
assert.ok(mind.includes('A kind added later'), 'an unknown kind must still appear');
ok('a kind nobody wrote a heading for still reaches the repo');

// Empty in, honest out — and never a claim that nothing was recorded when the
// other half has something.
assert.ok(renderMindFrom([]).includes('Nothing recorded yet'));
assert.ok(renderVisionFrom([]).includes('Nothing recorded yet'));
assert.ok(renderMindFrom(facts.filter((f) => f.kind === 'vision')).includes('Nothing recorded yet'));
ok('an empty half says so');

// ─── 3. the file list the runner commits ──────────────────────────────────────
const files = mindFiles(facts);
assert.equal(files.length, 2);
assert.deepEqual(files.map((f) => f.path), [
  `${MEMORY_REPO_PATH}/mind.md`,
  `${MEMORY_REPO_PATH}/vision-from-the-room.md`,
]);
ok('two files, at the paths the runner prunes around');

// Pure function of the facts: same input, byte-identical output. Anything else
// (a timestamp, a count, a random id) makes the runner push on every tick and
// redeploy the app forever.
assert.deepEqual(mindFiles(facts), files);
assert.equal(JSON.stringify(mindFiles(facts)), JSON.stringify(files));
ok('same facts render byte-identically (no clock, no randomness)');

// Order of the facts is the caller's (weight, then recency) and must be preserved,
// not re-sorted — otherwise two identical memories can render differently.
const visionOrder = renderVisionFrom(facts).indexOf('morphogenetic') < renderVisionFrom(facts).indexOf('Policies are universal');
assert.ok(visionOrder, 'the order handed in is the order written out');
ok('the given order is kept');

console.log(`\n${passed} checks passed — the Room's memory reaches the repo intact.`);
