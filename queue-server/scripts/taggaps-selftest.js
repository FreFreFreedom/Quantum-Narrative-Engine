// npm run gaps:selftest — the gap measure, proven with no database, no network and
// no model credit.
//
// Three things can quietly break it:
//   1. the ranking itself — if the thinnest link between two clumps does not come
//      out as the widest gap, the measure is saying the opposite of what it means,
//   2. the small-cluster rule — a two-tag cluster is a lone tag, not a hole, and it
//      would otherwise flood the top of every ranking,
//   3. the empty case — this runs off the boot-time index, so an empty graph must
//      answer an empty list rather than throw.

import assert from 'node:assert/strict';
import { gapsFrom } from '../server/src/services/tagGaps.js';

let passed = 0;
function ok(name) { passed++; console.log(`  ✓ ${name}`); }

// Build Map<tag, Map<tag, weight>> from a list of [a, b, weight].
function graph(edges) {
  const adj = new Map();
  const link = (a, b, w) => {
    if (!adj.has(a)) adj.set(a, new Map());
    adj.get(a).set(b, w);
  };
  for (const [a, b, w] of edges) { link(a, b, w); link(b, a, w); }
  return adj;
}

// Three dense clumps: A and B joined by ONE thin edge, everything else thickly
// seamed — so the thin pair has real competitors to beat rather than winning by
// being the only pair on the board.
const edges = [
  // clump A
  ['a1', 'a2', 5], ['a2', 'a3', 5], ['a1', 'a3', 5],
  // clump B
  ['b1', 'b2', 5], ['b2', 'b3', 5], ['b1', 'b3', 5],
  // clump C
  ['c1', 'c2', 5], ['c2', 'c3', 5], ['c1', 'c3', 5],
  // the one bridge A—B, against thick seams A—C and B—C
  ['a1', 'b1', 1],
  ['a2', 'c1', 6], ['a3', 'c2', 6],
  ['b2', 'c3', 6], ['b3', 'c1', 6],
];

const idx = {
  communities: [
    { id: 'C1', name: 'clump A', size: 3, tags: ['a1', 'a2', 'a3'] },
    { id: 'C2', name: 'clump B', size: 3, tags: ['b1', 'b2', 'b3'] },
    { id: 'C3', name: 'clump C', size: 3, tags: ['c1', 'c2', 'c3'] },
  ],
  tagCommunity: {
    a1: 'C1', a2: 'C1', a3: 'C1',
    b1: 'C2', b2: 'C2', b3: 'C2',
    c1: 'C3', c2: 'C3', c3: 'C3',
  },
};

const out = gapsFrom(graph(edges), idx);

// ─── 1. the ranking ───────────────────────────────────────────────────────────
const widest = out.gaps[0];
assert.deepEqual([widest.a.id, widest.b.id], ['C1', 'C2']);
ok('the pair joined by one thin edge ranks as the widest gap');

assert.equal(widest.between, 1);
assert.equal(widest.internalA, 15);
assert.equal(widest.internalB, 15);
assert.equal(widest.score, 1 / 15);
ok('between / sqrt(internal × internal) is what the score reports');

assert.equal(out.gaps[out.gaps.length - 1].between, 12);
ok('a thickly seamed pair ranks last');

assert.deepEqual(widest.bridges, [{ a: 'a1', b: 'b1', weight: 1 }]);
ok('the edges that DO cross come back — one thin bridge is not the same as none');

// Nothing crossing at all is a wider hole than one thin bridge. Same three clumps,
// with the A—B edge removed.
const severed = gapsFrom(graph(edges.filter(([a, b]) => !(a === 'a1' && b === 'b1'))), idx);
assert.deepEqual([severed.gaps[0].a.id, severed.gaps[0].b.id], ['C1', 'C2']);
assert.equal(severed.gaps[0].between, 0);
assert.deepEqual(severed.gaps[0].bridges, []);
ok('a pair with nothing crossing is the widest hole there is, and reports no bridges');

// What each cluster is furthest from — the line the detail panel shows.
assert.equal(out.farthest.C1.id, 'C2');
assert.equal(out.farthest.C2.id, 'C1');
assert.equal(out.farthest.C3.id, 'C1');
ok('every cluster names what it is furthest from');

// ─── 2. the small-cluster rule ────────────────────────────────────────────────
const withTiny = {
  communities: [
    ...idx.communities,
    { id: 'C4', name: 'a pair', size: 2, tags: ['d1', 'd2'] },
  ],
  tagCommunity: { ...idx.tagCommunity, d1: 'C4', d2: 'C4' },
};
const tinyOut = gapsFrom(graph([...edges, ['d1', 'd2', 4]]), withTiny);
assert.equal(tinyOut.consideredCommunities, 3);
assert.ok(!tinyOut.gaps.some((g) => g.a.id === 'C4' || g.b.id === 'C4'));
assert.ok(!tinyOut.farthest.C4);
ok('a two-tag cluster is a lone tag, not a hole — it never enters the ranking');

// A cluster big enough but with no inside edges cannot be normalised against, and is
// dropped rather than dividing by zero.
const hollow = {
  communities: [...idx.communities, { id: 'C5', name: 'hollow', size: 3, tags: ['e1', 'e2', 'e3'] }],
  tagCommunity: { ...idx.tagCommunity, e1: 'C5', e2: 'C5', e3: 'C5' },
};
const hollowOut = gapsFrom(graph([...edges, ['e1', 'a1', 2]]), hollow);
assert.equal(hollowOut.consideredCommunities, 3);
assert.ok(hollowOut.gaps.every((g) => Number.isFinite(g.score)));
ok('a cluster with nothing inside it is dropped instead of dividing by zero');

// ─── 3. the empty case ────────────────────────────────────────────────────────
assert.deepEqual(gapsFrom(new Map(), idx).gaps, []);
assert.deepEqual(gapsFrom(graph(edges), { communities: [], tagCommunity: {} }).gaps, []);
assert.deepEqual(gapsFrom(null, null).gaps, []);
ok('an empty graph or an empty index answers an empty list, never a throw');

console.log(`\n${passed} checks passed — the gap measure holds.`);
