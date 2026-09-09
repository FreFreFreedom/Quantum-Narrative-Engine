// The interaction-graph maths, shared — plans/civic-structures-and-loops.md, Stage 6.
//
// Given turns (who spoke, in what order, standing how toward the previous turn), this
// builds the signed adjacency, partitions it, tests it for structural balance, and blurs
// it two ways. It is the deterministic half of an anatomy: no model, no network, no
// randomness, and no threshold tuned after seeing a result.
//
// WHY THIS EXISTS SEPARATELY FROM THE TWO SCRIPTS THAT ALREADY DO IT.
// `scripts/interior-one-film.js` (Dogville, 2026-09-07) and `scripts/interior-fences.js`
// (the Maxson household, 2026-09-09) each carry their own copy. Those are dated records of
// two hand runs, and their value is that they still reproduce exactly what their findings
// documents report — so they are deliberately left frozen rather than refactored onto this
// module. New callers use this one. If a third script ever wants to be a record too, copy
// the call, not the maths.
//
// Rules the module holds so its callers cannot quietly break them:
//   • The gap threshold and both blurs are parameters with declared defaults, never fitted.
//   • Unsigned edges are ignored by the balance test rather than coerced to a side — an
//     edge whose exchanges were mostly neutral makes no claim, and making one for it would
//     be inventing evidence.
//   • Balance is solved exhaustively, which is exact, and refuses to run past a size where
//     that stops being true rather than silently switching to a heuristic.

import { detectCommunities } from './tagCommunities.js';

export const DEFAULT_GAP_THRESHOLD = 3;
// 2^20 splits is about a million — instant. Past that an exhaustive search stops being
// honest to promise, so the caller is told rather than handed an approximation labelled as
// an exact answer.
export const MAX_EXACT_BALANCE_NODES = 20;

// turns: [{ speaker, block, stance }] in source order. `block` is any monotonic position
// (a subtitle index, a line number, a character offset) — the units only have to be
// consistent with `gapThreshold`.
export function buildAdjacency(turns, { gapThreshold = DEFAULT_GAP_THRESHOLD } = {}) {
  const adjacency = new Map();
  const signs = new Map();
  const touch = (n) => { if (!adjacency.has(n)) adjacency.set(n, new Map()); };
  const addEdge = (a, b, stance) => {
    if (a === b) return;
    touch(a); touch(b);
    adjacency.get(a).set(b, (adjacency.get(a).get(b) || 0) + 1);
    adjacency.get(b).set(a, (adjacency.get(b).get(a) || 0) + 1);
    const key = [a, b].sort().join('|');
    if (!signs.has(key)) signs.set(key, { opp: 0, ally: 0, neu: 0 });
    signs.get(key)[stance === 'opp' ? 'opp' : stance === 'ally' ? 'ally' : 'neu'] += 1;
  };
  for (const t of turns) touch(t.speaker);
  for (let i = 0; i < turns.length - 1; i++) {
    // A gap wider than the threshold is a beat, not an exchange, and no edge crosses it.
    if (turns[i + 1].block - turns[i].block <= gapThreshold) {
      addEdge(turns[i].speaker, turns[i + 1].speaker, turns[i + 1].stance);
    }
  }
  return { adjacency, signs };
}

export function signOf(tally) {
  if (tally.opp > tally.ally && tally.opp >= tally.neu) return 'opp';
  if (tally.ally > tally.opp && tally.ally >= tally.neu) return 'ally';
  return 'unsigned';
}

export function adjacencyToJSON(adjacency, signs = null) {
  const nodes = [...adjacency.keys()].sort();
  const edges = [];
  const seen = new Set();
  for (const a of nodes) {
    for (const [b, w] of adjacency.get(a).entries()) {
      const key = [a, b].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      const tally = signs ? signs.get(key) : null;
      edges.push({ a, b, weight: w, ...(tally ? { sign: signOf(tally), stances: tally } : {}) });
    }
  }
  return { nodes, edges };
}

export function partitionOf(adjacency) {
  const community = detectCommunities(adjacency);
  const groups = new Map();
  for (const [node, comm] of community.entries()) {
    if (!groups.has(comm)) groups.set(comm, []);
    groups.get(comm).push(node);
  }
  return [...groups.values()].map((g) => g.sort());
}

// Balanced means the nodes split into two camps with every positive edge inside a camp and
// every negative edge between them: a clean fracture. Frustration counts the edges that
// must break for that to hold, and it is the number worth keeping — balance is a yes/no,
// frustration is a measurement of how far from clean the entity is.
export function structuralBalance(nodes, edges) {
  const signed = edges.filter((e) => e.sign === 'opp' || e.sign === 'ally');
  if (!signed.length) return { testable: false, reason: 'no signed edges' };
  if (nodes.length > MAX_EXACT_BALANCE_NODES) {
    return { testable: false, reason: `exhaustive balance refuses past ${MAX_EXACT_BALANCE_NODES} nodes; ${nodes.length} given` };
  }
  let best = null;
  for (let mask = 0; mask < (1 << nodes.length); mask++) {
    const camp = new Map(nodes.map((n, i) => [n, (mask >> i) & 1]));
    const violations = signed.filter((e) => {
      const same = camp.get(e.a) === camp.get(e.b);
      return e.sign === 'ally' ? !same : same;
    });
    if (!best || violations.length < best.violations.length) {
      best = {
        violations: violations.map((v) => `${v.a}-${v.b} (${v.sign})`),
        camps: [nodes.filter((n) => camp.get(n) === 0), nodes.filter((n) => camp.get(n) === 1)],
      };
    }
    if (best.violations.length === 0) break;
  }
  return {
    testable: true,
    signedEdges: signed.length,
    balanced: best.violations.length === 0,
    frustration: best.violations.length,
    violations: best.violations,
    bestSplit: best.camps,
  };
}

export function blurDropWeakEdges(adjacency, minWeight = 2) {
  const out = new Map();
  for (const a of adjacency.keys()) out.set(a, new Map());
  for (const a of adjacency.keys()) {
    for (const [b, w] of adjacency.get(a).entries()) if (w >= minWeight) out.get(a).set(b, w);
  }
  return out;
}

export function blurCollapseDegreeOne(adjacency) {
  const degree = (n) => [...adjacency.get(n).values()].reduce((s, w) => s + w, 0);
  const merges = new Map();
  for (const n of adjacency.keys()) {
    const neighbors = [...adjacency.get(n).keys()];
    if (neighbors.length === 1 && degree(n) === adjacency.get(n).get(neighbors[0])) {
      merges.set(n, neighbors[0]);
    }
  }
  const resolve_ = (n) => {
    let cur = n;
    const guard = new Set();
    while (merges.has(cur) && !guard.has(cur)) { guard.add(cur); cur = merges.get(cur); }
    return cur;
  };
  const out = new Map();
  for (const a of adjacency.keys()) if (!out.has(resolve_(a))) out.set(resolve_(a), new Map());
  // adjacency stores both directions — visit each undirected pair once (a < b on the
  // ORIGINAL ids, before resolving) or a merge double-counts every edge it touches.
  for (const a of adjacency.keys()) {
    for (const [b, w] of adjacency.get(a).entries()) {
      if (a >= b) continue;
      const ra = resolve_(a), rb = resolve_(b);
      if (ra === rb) continue;
      out.get(ra).set(rb, (out.get(ra).get(rb) || 0) + w);
      out.get(rb).set(ra, (out.get(rb).get(ra) || 0) + w);
    }
  }
  return { adjacency: out, merges: Object.fromEntries(merges) };
}

// Everything above, in one call, so a caller cannot accidentally skip the blurs — which
// are the step that separates structure from noise and the step easiest to leave out.
export function analyseTurns(turns, { gapThreshold = DEFAULT_GAP_THRESHOLD } = {}) {
  const { adjacency, signs } = buildAdjacency(turns, { gapThreshold });
  const graph = adjacencyToJSON(adjacency, signs);
  const blurA = blurDropWeakEdges(adjacency, 2);
  const { adjacency: blurBAdj, merges } = blurCollapseDegreeOne(adjacency);
  return {
    gapThreshold,
    graph,
    partition: partitionOf(adjacency),
    structuralBalance: structuralBalance(graph.nodes, graph.edges),
    blurA: { minWeight: 2, graph: adjacencyToJSON(blurA), partition: partitionOf(blurA) },
    blurB: { merges, graph: adjacencyToJSON(blurBAdj), partition: partitionOf(blurBAdj) },
  };
}
