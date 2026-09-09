// npm run traffic:selftest — proves the verbatim gate in services/trafficExtraction.js
// against a model that deliberately lies. No network, no real model, no credits.
//
// This is the test that matters most in the whole civic build. Everything downstream — the
// anatomy, the signed seam, the relations asserted from it — rests on the claim that a line
// attributed to somebody was actually said. A model asked "who said this" answers every
// time, fluently, and will happily improve a quote's punctuation on the way past. So the
// gate must drop:
//   • a quote that appears nowhere in the source
//   • a quote that is nearly right — a fixed apostrophe, a joined line, a trimmed space
//   • a quote that exists elsewhere in the document but not in the window being read
//   • a turn with no speaker, or with a stance outside the three allowed values
// and it must report every one of them rather than quietly returning a smaller graph.

import assert from 'node:assert/strict';
import {
  extractTraffic, verifyTurns, codifySpeakers, windowsOf, buildTrafficPrompt,
} from '../server/src/services/trafficExtraction.js';

const SOURCE = [
  'Hey, pop.',
  "What you come\n\"hey, poppin'\" me for?",
  'How you doing, rose?',
  'I got some chicken\ncooking in the oven.',
  'No, rose, thanks.',
  'Let me have $10.',
  "I'll be damned.",
].join('\n\n');

// ── the gate, directly ──────────────────────────────────────────────────────
const candidates = [
  { quote: 'Hey, pop.', speaker: 'Lyons', stance: 'ally', cue: 'calls him pop' },
  // fabricated outright — the failure the whole gate exists for
  { quote: 'Pop, I have always loved you.', speaker: 'Lyons', stance: 'ally' },
  // nearly right: a straight apostrophe where the source has a curly-free one, plus a
  // helpfully "fixed" line break. This is the realistic failure, not the obvious one.
  { quote: 'What you come "hey, poppin\'" me for?', speaker: 'Troy', stance: 'opp' },
  // exact, so it passes
  { quote: 'How you doing, rose?', speaker: 'Lyons', stance: 'ally' },
  // no speaker
  { quote: 'Let me have $10.', speaker: '', stance: 'neu' },
  // a stance the vocabulary does not have
  { quote: "I'll be damned.", speaker: 'Troy', stance: 'furious' },
  // a real line, but padded — dropping this is the point
  { quote: '  No, rose, thanks. ', speaker: 'Lyons', stance: 'ally' },
];

const { kept, dropped } = verifyTurns(candidates, SOURCE);
assert.deepEqual(kept.map((k) => k.quote), ['Hey, pop.', 'How you doing, rose?'],
  'only the two exact quotes survive');
assert.equal(dropped.notVerbatim.length, 3, 'the fabrication, the "fixed" one and the padded one');
assert.equal(dropped.noSpeaker.length, 1);
assert.equal(dropped.badStance.length, 1);

// position comes from the source, never from the model
assert.ok(kept[0].block < kept[1].block, 'turns are ordered by where they actually appear');
assert.equal(kept[0].block, SOURCE.indexOf('Hey, pop.'));

// a model that supplies its own position cannot reorder the conversation
const reordered = verifyTurns([
  { quote: 'How you doing, rose?', speaker: 'Lyons', stance: 'ally', block: 0 },
  { quote: 'Hey, pop.', speaker: 'Lyons', stance: 'ally', block: 999 },
], SOURCE).kept;
assert.equal(reordered[0].quote, 'Hey, pop.', 'source order wins over anything the model said');

// ── a quote from elsewhere in the document cannot enter through the wrong window ──
const win = windowsOf(SOURCE, 40);
assert.ok(win.length > 1, 'the source splits into several windows at this size');
const lastWin = win[win.length - 1];
const smuggled = verifyTurns([{ quote: 'Hey, pop.', speaker: 'Lyons', stance: 'ally' }], lastWin.text);
assert.equal(smuggled.kept.length, 0, 'a real line from another window is still not in this one');
assert.equal(smuggled.dropped.notVerbatim.length, 1);

// ── naming is an exit ───────────────────────────────────────────────────────
const coded = codifySpeakers([
  { speaker: 'Troy Maxson', to: 'Rose Maxson', stance: 'opp', quote: 'x', block: 1 },
  { speaker: 'Rose Maxson', to: 'Troy Maxson', stance: 'opp', quote: 'y', block: 2 },
  { speaker: 'Troy Maxson', to: null, stance: 'neu', quote: 'z', block: 3 },
]);
assert.deepEqual(coded.turns.map((t) => t.speaker), ['p1', 'p2', 'p1'], 'names become codes');
assert.deepEqual(coded.names, { p1: 'Troy Maxson', p2: 'Rose Maxson' }, 'and the map comes back beside them');
assert.ok(!JSON.stringify(coded.turns.map((t) => ({ s: t.speaker, to: t.to }))).includes('Maxson'),
  'no name reaches the graph');

// ── the prompt says the things the gate depends on ──────────────────────────
const prompt = buildTrafficPrompt('some text', { windowIndex: 0, windowCount: 2, cast: ['Troy', 'Rose'] });
assert.match(prompt, /COPIED EXACTLY/);
assert.match(prompt, /DROP a line rather than guess/);
assert.match(prompt, /Troy, Rose/, 'a supplied cast is passed through');
assert.match(buildTrafficPrompt('t', { windowIndex: 0, windowCount: 1, cast: null }), /Do not invent a name/);

// ── end to end, against a liar ──────────────────────────────────────────────
// Half of what this model returns is invented. The extraction must still produce a correct
// graph from the half that is real, and must say plainly how much it threw away.
let asked = 0;
const liar = async () => {
  asked += 1;
  return '```json\n' + JSON.stringify([
    { quote: 'Hey, pop.', speaker: 'Lyons', stance: 'ally' },
    { quote: 'How you doing, rose?', speaker: 'Lyons', stance: 'ally' },
    { quote: 'I got some chicken\ncooking in the oven.', speaker: 'Rose', stance: 'ally' },
    { quote: 'No, rose, thanks.', speaker: 'Lyons', stance: 'ally' },
    { quote: 'Rose then left the room in tears.', speaker: 'Rose', stance: 'opp' },
    { quote: 'Troy raised his hand.', speaker: 'Troy', stance: 'opp' },
  ]) + '\n```';
};

const res = await extractTraffic(SOURCE, { callModel: liar, pauseMs: 0, gapThreshold: 100 });
assert.equal(asked, 1, 'this source is one window');
assert.equal(res.proposed, 6);
assert.equal(res.accepted, 4, 'the two invented lines are gone');
assert.equal(res.dropped.count, 2);
assert.equal(res.rejectionRate, 0.333, 'and the share thrown away is stated, not buried');
assert.deepEqual(Object.values(res.names).sort(), ['Lyons', 'Rose']);
assert.ok(res.graph.nodes.length === 2, 'two speakers survived, so two nodes');
assert.ok(res.graph.edges.length >= 1);
assert.ok(res.partition, 'the deterministic half ran');
assert.ok(res.blurA && res.blurB, 'including both blurs — the step easiest to leave out');
assert.ok(!JSON.stringify(res.graph).includes('Lyons'), 'the graph carries codes, not names');

// a model that returns nothing usable is not an error, it is an empty answer
const mute = async () => 'I could not find any dialogue.';
const empty = await extractTraffic(SOURCE, { callModel: mute, pauseMs: 0 });
assert.equal(empty.accepted, 0);
assert.equal(empty.proposed, 0);
assert.equal(empty.rejectionRate, 0, 'nothing proposed is not the same as everything rejected');

assert.deepEqual(await extractTraffic('   ', { callModel: liar }), { error: 'empty_source' });

console.log(`traffic extraction selftest: OK (verbatim gate drops fabricated, near-miss, cross-window, unsigned and unattributed turns; names never reach the graph)`);
