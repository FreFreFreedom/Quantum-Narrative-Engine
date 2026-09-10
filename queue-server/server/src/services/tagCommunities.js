// services/tagCommunities.js — theme clusters over the LIVE tag graph.
//
// Same computation as scripts/detect-tag-communities.js — that script now IMPORTS
// detectCommunities from here rather than carrying a second copy, so the two cannot
// drift — with one difference that is the whole point: the input is the `entity_tags`
// table rather than the seed JSON. The script's output,
// data-seed/tag_communities.json, is a frozen snapshot of one moment in August 2026
// and NOTHING in the running app reads it — retag an entity and the next boot
// re-clusters from the DB.
//
// Method, in one paragraph: tags are nodes; an edge (tag_a, tag_b) gains +1 weight
// for every entity carrying both. Communities come from multi-level Louvain — each
// tag starts alone and repeatedly moves to whichever neighbouring community gives the
// largest modularity gain until a full pass moves nothing (the local-moving pass),
// then every community is collapsed into one super-node carrying its internal weight
// as a self-loop and the same pass runs again on that smaller graph, until a level
// merges nothing.
//
// The aggregation phase used to be skipped, and the header used to call that
// deliberate. It was not defensible: 651 tags fell into 104 communities with a median
// size of 3, only 156 of 4,278 cluster pairs touched at all, and everything reading
// this — the entity panel's "theme cluster", services/tagGaps.js — was reading noise.
// Three tags is not a theme. Fixed 2026-09-10.
//
// Built ONCE at boot and held in memory, in the spirit of services/projectMap.js:
// it is pure arithmetic over a few thousand rows (no model calls, nothing to pay
// for), but there is no reason to redo it per request either. Every failure mode —
// no tags, one tag, an unreadable table — answers an empty result and logs, never
// throws. This runs on the boot path and must never be able to break it.

let db = null;
export function bindTagCommunitiesDb(database) { db = database; }

const EMPTY = { totalTags: 0, totalCommunities: 0, communities: [], tagCommunity: {} };

let cached = null;
// The graph the clustering was computed from, kept so a second reading of the SAME
// grouping (services/tagGaps.js — what falls BETWEEN the clusters) can reach it
// without rebuilding. Held beside the index rather than on it: getTagCommunities()'s
// shape is read by three other modules and served as JSON, and two Maps would ride
// into that payload as `{}`.
let cachedGraph = { freq: new Map(), adjacency: new Map() };

function buildGraph(tagLists) {
  const freq = new Map();      // tag -> number of entities carrying it
  const adjacency = new Map(); // tag -> Map<neighborTag, weight>

  const addEdge = (a, b) => {
    if (a === b) return;
    if (!adjacency.has(a)) adjacency.set(a, new Map());
    if (!adjacency.has(b)) adjacency.set(b, new Map());
    adjacency.get(a).set(b, (adjacency.get(a).get(b) || 0) + 1);
    adjacency.get(b).set(a, (adjacency.get(b).get(a) || 0) + 1);
  };

  for (const tags of tagLists) {
    const unique = [...new Set(tags)];
    for (const t of unique) freq.set(t, (freq.get(t) || 0) + 1);
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) addEdge(unique[i], unique[j]);
      // A tag nobody shares still gets a node, so it lands in a community of its own
      // instead of disappearing from the index.
      if (!adjacency.has(unique[i])) adjacency.set(unique[i], new Map());
    }
  }

  return { freq, adjacency };
}

// A self-loop is one end of the edge at each end of itself, so it counts TWICE toward
// a node's degree — standard modularity, and load-bearing here: the aggregated graph's
// super-nodes carry their community's internal weight as a self-loop, and counting it
// once would silently understate every super-node's degree and quietly wreck the next
// level's arithmetic. The raw tag graph has no self-loops (buildGraph refuses a === b),
// so this is identical to a plain row sum at level 0.
function weightedDegree(adjacency, node) {
  let sum = 0;
  for (const [neighbor, w] of adjacency.get(node).entries()) sum += (neighbor === node ? 2 * w : w);
  return sum;
}

function localMoving(adjacency) {
  const nodes = [...adjacency.keys()].sort();
  const degree = new Map(nodes.map((n) => [n, weightedDegree(adjacency, n)]));
  const m = nodes.reduce((s, n) => s + degree.get(n), 0) / 2;

  const community = new Map(nodes.map((n) => [n, n])); // tag -> community label (starts as itself)
  const communityTot = new Map(nodes.map((n) => [n, degree.get(n)])); // sum of degrees of members

  if (m === 0) return community; // no co-occurrence edges at all

  let improved = true;
  let pass = 0;
  const MAX_PASSES = 100;

  while (improved && pass < MAX_PASSES) {
    improved = false;
    pass++;
    for (const node of nodes) {
      const currentComm = community.get(node);
      const kNode = degree.get(node);

      // Remove node from its current community's totals for fair comparison.
      communityTot.set(currentComm, communityTot.get(currentComm) - kNode);

      // Weight from node into each neighboring community (k_i,in).
      const neighborWeights = new Map();
      for (const [neighbor, w] of adjacency.get(node).entries()) {
        if (neighbor === node) continue;
        const c = community.get(neighbor);
        neighborWeights.set(c, (neighborWeights.get(c) || 0) + w);
      }
      // Staying put is always a candidate, even with zero cross-community neighbors.
      if (!neighborWeights.has(currentComm)) neighborWeights.set(currentComm, 0);

      let bestComm = currentComm;
      let bestScore = -Infinity;
      const candidates = [...neighborWeights.keys()].sort();
      for (const c of candidates) {
        const kIn = neighborWeights.get(c);
        const totC = communityTot.get(c) || 0;
        const score = kIn - (totC * kNode) / (2 * m);
        if (score > bestScore + 1e-12) {
          bestScore = score;
          bestComm = c;
        }
      }

      communityTot.set(bestComm, (communityTot.get(bestComm) || 0) + kNode);
      if (bestComm !== currentComm) {
        community.set(node, bestComm);
        improved = true;
      }
    }
  }

  return community;
}

// One node per community: edges between two communities summed, and each community's
// own internal weight kept as a SELF-LOOP on its super-node. Without that self-loop the
// next level has no idea how much substance is already inside a super-node, and its
// modularity is nonsense.
function aggregateGraph(adjacency, community) {
  const agg = new Map();
  const row = (c) => {
    if (!agg.has(c)) agg.set(c, new Map());
    return agg.get(c);
  };
  for (const c of community.values()) row(c);

  for (const [u, neighbours] of adjacency.entries()) {
    for (const [v, w] of neighbours.entries()) {
      if (v < u) continue; // each undirected edge once; a self-loop (v === u) is kept once
      const cu = community.get(u);
      const cv = community.get(v);
      if (cu === cv) {
        row(cu).set(cu, (row(cu).get(cu) || 0) + w);
      } else {
        row(cu).set(cv, (row(cu).get(cv) || 0) + w);
        row(cv).set(cu, (row(cv).get(cu) || 0) + w);
      }
    }
  }
  return agg;
}

const MAX_LEVELS = 10;

// Multi-level Louvain. Returns exactly what the single-level pass used to return —
// Map<node, communityLabel>, the label being one of the original node names — so every
// caller is untouched.
export function detectCommunities(adjacency) {
  let graph = adjacency;
  // Sorted, like the local-moving pass's own node order: callers that group by this
  // Map's iteration order (services/interactionGraph.js#partitionOf) get the same
  // ordering they got from the single-level version, so the frozen anatomy records in
  // data-seed/interiors still reproduce byte-for-byte.
  const mapping = new Map([...adjacency.keys()].sort().map((n) => [n, n]));

  for (let level = 0; level < MAX_LEVELS; level++) {
    const part = localMoving(graph);
    const merged = graph.size - new Set(part.values()).size;
    // Unroll this level onto the original nodes before deciding to stop, so the last
    // level's moves are never thrown away.
    for (const [node, label] of mapping) mapping.set(node, part.get(label) ?? label);
    if (merged === 0) break; // a level that merges nothing will merge nothing next time either
    graph = aggregateGraph(graph, part);
  }

  return mapping;
}

function nameCommunity(tags, adjacency, freq) {
  const ranked = [...tags].sort((a, b) => {
    const degA = weightedDegree(adjacency, a) * (freq.get(a) || 0);
    const degB = weightedDegree(adjacency, b) * (freq.get(b) || 0);
    if (degB !== degA) return degB - degA;
    return a.localeCompare(b);
  });
  const top = ranked.slice(0, 4);
  return top.map((t) => t.replace(/-/g, ' ')).join(' / ');
}

// One row per (entity, tag) — grouped here rather than in SQL so the shape handed to
// buildGraph is identical to the script's (one array of tags per entity).
function tagListsFromDb() {
  const rows = db.prepare(`SELECT entity_id, tag FROM entity_tags`).all();
  const byEntity = new Map();
  for (const r of rows) {
    if (!r || !r.tag) continue;
    if (!byEntity.has(r.entity_id)) byEntity.set(r.entity_id, []);
    byEntity.get(r.entity_id).push(r.tag);
  }
  return [...byEntity.values()].filter((tags) => tags.length > 0);
}

export function buildTagCommunities() {
  try {
    if (!db) throw new Error('no db bound');
    const tagLists = tagListsFromDb();
    const { freq, adjacency } = buildGraph(tagLists);
    cachedGraph = { freq, adjacency };
    if (adjacency.size === 0) {
      cached = { ...EMPTY };
      console.log('[tag-communities] no tags in entity_tags — nothing to cluster');
      return cached;
    }

    const community = detectCommunities(adjacency);

    const groups = new Map(); // communityLabel -> [tags]
    for (const [tag, comm] of community.entries()) {
      if (!groups.has(comm)) groups.set(comm, []);
      groups.get(comm).push(tag);
    }

    // Stable, human-facing IDs: largest communities first, ties broken alphabetically
    // by their first (most central) tag, so a rebuild produces the same C1/C2/... order.
    const ordered = [...groups.entries()].sort((a, b) => {
      if (b[1].length !== a[1].length) return b[1].length - a[1].length;
      return a[0].localeCompare(b[0]);
    });

    const communities = ordered.map(([, tags], idx) => {
      const rankedTags = [...tags].sort((a, b) => {
        const degA = weightedDegree(adjacency, a);
        const degB = weightedDegree(adjacency, b);
        if (degB !== degA) return degB - degA;
        return a.localeCompare(b);
      });
      return {
        id: `C${idx + 1}`,
        name: nameCommunity(tags, adjacency, freq),
        size: tags.length,
        tags: rankedTags,
      };
    });

    const tagCommunity = {};
    communities.forEach((c) => c.tags.forEach((t) => { tagCommunity[t] = c.id; }));

    cached = {
      method: 'louvain-multilevel-greedy-modularity',
      source: 'entity_tags',
      totalTags: adjacency.size,
      totalCommunities: communities.length,
      communities,
      tagCommunity,
    };
    console.log(`[tag-communities] ${cached.totalTags} tags → ${cached.totalCommunities} communities from entity_tags`);
  } catch (e) {
    console.error('[tag-communities] build failed (serving an empty index):', e.message);
    cached = { ...EMPTY };
    cachedGraph = { freq: new Map(), adjacency: new Map() };
  }
  return cached;
}

// Built on first use if boot never got to it — an empty index would quietly remove
// the theme-cluster line from every entity, which is worse than a slightly late build.
export function getTagCommunities() {
  if (cached === null) buildTagCommunities();
  return cached;
}

// The co-occurrence graph behind the current index, built with it.
export function getTagGraph() {
  getTagCommunities();
  return cachedGraph;
}

export function communityForTag(tag) {
  const idx = getTagCommunities();
  const id = idx.tagCommunity[tag];
  if (!id) return null;
  return idx.communities.find((c) => c.id === id) || null;
}
