// services/tagCommunities.js — theme clusters over the LIVE tag graph.
//
// Same computation as scripts/detect-tag-communities.js (the algorithm is lifted
// from it unchanged; that file's header documents the method and the reference
// implementations it follows), with one difference that is the whole point: the
// input is the `entity_tags` table rather than the seed JSON. The script's output,
// data-seed/tag_communities.json, is a frozen snapshot of one moment in August 2026
// and NOTHING in the running app reads it — retag an entity and the next boot
// re-clusters from the DB.
//
// Method, in one paragraph: tags are nodes; an edge (tag_a, tag_b) gains +1 weight
// for every entity carrying both. Communities come from a single-level Louvain-style
// greedy local-moving pass (no aggregation phase) — each tag starts alone, then
// repeatedly moves to whichever neighbouring community gives the largest modularity
// gain, until a full pass moves nothing.
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

function weightedDegree(adjacency, node) {
  let sum = 0;
  for (const w of adjacency.get(node).values()) sum += w;
  return sum;
}

function detectCommunities(adjacency) {
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
      method: 'louvain-single-level-greedy-modularity',
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
  }
  return cached;
}

// Built on first use if boot never got to it — an empty index would quietly remove
// the theme-cluster line from every entity, which is worse than a slightly late build.
export function getTagCommunities() {
  if (cached === null) buildTagCommunities();
  return cached;
}

export function communityForTag(tag) {
  const idx = getTagCommunities();
  const id = idx.tagCommunity[tag];
  if (!id) return null;
  return idx.communities.find((c) => c.id === id) || null;
}
