// services/tagGaps.js — where the corpus does NOT connect.
//
// The theme clusters (services/tagCommunities.js) say what travels together. This
// says the opposite thing over the same graph: for every pair of clusters, how thin
// the traffic between them is. The default view of a body of knowledge should be its
// holes, and we had never once looked at what falls between our own clusters.
//
// The measure, per unordered pair (A, B):
//   between(A,B) = summed weight of edges with one end in A and one in B
//   internal(X)  = summed weight of edges with both ends in X
//   gap          = between / sqrt(internal(A) * internal(B))     — low means a hole
//
// Ranked ascending. There is NO threshold and no knob: nothing here ever answers
// "this is a gap" as a boolean, because an answer that moves when you move a cutoff
// is measuring the cutoff. Ranking is allowed; a tuned line is not.
//
// Pairs where either cluster holds fewer than 3 tags are dropped — a lone tag is not
// a hole, it is a lone tag.
//
// Pure arithmetic over the graph that is already in memory: no model call, nothing to
// pay for, no DB read of its own. Same failure discipline as its neighbour — every
// failure path returns an empty list and logs, never throws.

import { getTagCommunities, getTagGraph } from './tagCommunities.js';

const MIN_COMMUNITY_TAGS = 3;
const TOP_GAPS = 10;
const MAX_BRIDGES = 5; // a gap with one thin bridge is a different object from a gap with none

const EMPTY = {
  method: 'between-over-sqrt-internal',
  minCommunityTags: MIN_COMMUNITY_TAGS,
  consideredCommunities: 0,
  gaps: [],
  farthest: {},
  pairsConsidered: 0,
  pairsTouching: 0,
};

// The whole measure, over a graph and a clustering handed in — no DB, no cache, no
// module state, so the self-test exercises the shipped arithmetic rather than a copy.
// `adjacency` is Map<tag, Map<tag, weight>>; `idx` is what getTagCommunities() returns.
export function gapsFrom(adjacency, idx) {
  if (!adjacency || !adjacency.size || !idx || !idx.communities || !idx.communities.length) {
    return { ...EMPTY };
  }
  const commOfTag = idx.tagCommunity || {};

  const internal = new Map();  // communityId -> summed weight of its inside edges
  const between = new Map();   // "A|B" (A<B) -> summed weight of crossing edges
  const bridges = new Map();   // "A|B" -> [{ a, b, weight }]

  for (const [u, neighbours] of adjacency.entries()) {
    const cu = commOfTag[u];
    if (!cu) continue;
    for (const [v, w] of neighbours.entries()) {
      if (u >= v) continue; // each undirected edge counted once
      const cv = commOfTag[v];
      if (!cv) continue;
      if (cu === cv) {
        internal.set(cu, (internal.get(cu) || 0) + w);
      } else {
        const key = cu < cv ? `${cu}|${cv}` : `${cv}|${cu}`;
        between.set(key, (between.get(key) || 0) + w);
        if (!bridges.has(key)) bridges.set(key, []);
        bridges.get(key).push({ a: u, b: v, weight: w });
      }
    }
  }

  // Only clusters big enough to be a side of a hole, and with something inside to
  // normalise against.
  const eligible = idx.communities.filter(
    (c) => c.size >= MIN_COMMUNITY_TAGS && (internal.get(c.id) || 0) > 0,
  );

  const pairs = [];
  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      const A = eligible[i];
      const B = eligible[j];
      const key = A.id < B.id ? `${A.id}|${B.id}` : `${B.id}|${A.id}`;
      const bw = between.get(key) || 0;
      const iA = internal.get(A.id);
      const iB = internal.get(B.id);
      const scale = Math.sqrt(iA * iB);
      pairs.push({
        a: { id: A.id, name: A.name, size: A.size },
        b: { id: B.id, name: B.name, size: B.size },
        between: bw,
        internalA: iA,
        internalB: iB,
        score: bw / scale,
        scale,
        bridges: (bridges.get(key) || []).sort((x, y) => y.weight - x.weight).slice(0, MAX_BRIDGES),
      });
    }
  }

  // Widest hole first. Pairs with nothing crossing all tie at zero, so the tie goes to
  // the pair with the most substance on either side — a hole between two dense clusters
  // says more than one between two sparse ones. Ids last, so the order is stable.
  pairs.sort((x, y) => (x.score - y.score)
    || (y.scale - x.scale)
    || x.a.id.localeCompare(y.a.id)
    || x.b.id.localeCompare(y.b.id));

  // What each cluster is furthest from, over the whole ranking rather than the top
  // slice — the detail panel asks this of whatever cluster the entity happens to be in.
  const farthest = {};
  for (const p of pairs) {
    if (!farthest[p.a.id]) farthest[p.a.id] = { id: p.b.id, name: p.b.name, score: p.score, between: p.between };
    if (!farthest[p.b.id]) farthest[p.b.id] = { id: p.a.id, name: p.a.name, score: p.score, between: p.between };
  }

  return {
    method: EMPTY.method,
    minCommunityTags: MIN_COMMUNITY_TAGS,
    consideredCommunities: eligible.length,
    // Reported, not tuned: when almost no pair touches at all, the top of the ranking
    // is a field of ties at zero, and these two numbers say so rather than letting the
    // slice imply a ranking it does not have.
    pairsConsidered: pairs.length,
    pairsTouching: pairs.filter((p) => p.between > 0).length,
    gaps: pairs.slice(0, TOP_GAPS).map(({ scale, ...rest }) => rest),
    farthest,
  };
}

// Rebuilt exactly when the communities are: the cache is keyed on the identity of the
// object getTagCommunities() hands back, so a rebuild invalidates this for free and a
// request never recomputes.
let cachedFor = null;
let cached = null;

export function getTagGaps() {
  try {
    const idx = getTagCommunities();
    if (cached && cachedFor === idx) return cached;
    cached = gapsFrom(getTagGraph().adjacency, idx);
    cachedFor = idx;
    return cached;
  } catch (e) {
    console.error('[tag-gaps] measure failed (serving an empty list):', e.message);
    return { ...EMPTY };
  }
}
