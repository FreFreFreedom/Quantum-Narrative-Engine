// v1 GraphRAG: one-shot ("static") community detection over the tag co-occurrence
// graph built from queue-server/data-seed/fmcns_ontology.json (the same seed file
// bootstrapData.js loads into entity_tags on every boot). No dependency on a live
// DB or the app's own graph/UI code — this reads the seed JSON directly and writes
// its result back out as a new seed-adjacent file.
//
// THE RUNNING APP NO LONGER READS THIS SCRIPT'S OUTPUT. Since the "theme clusters
// that do something" task, the same clustering runs inside the server against the
// live entity_tags table (server/src/services/tagCommunities.js), rebuilt at every
// boot. This file and data-seed/tag_communities.json are kept as a manual/offline
// tool — useful for inspecting the seed's own clustering without a server — but
// editing either one changes nothing in the app.
//
// Method: tags are nodes; an edge (tag_a, tag_b) gets +1 weight for every entity
// (character or country) that carries both tags. Communities are found with a
// single-level Louvain-style greedy local-moving pass (no aggregation phase) —
// each tag starts in its own community, then repeatedly moves to whichever
// neighboring community yields the largest modularity gain, until a full pass
// produces no more moves. This is the standard Louvain "phase 1" move rule; see
// graphology-communities / jLouvain for the reference implementation this follows.
//
// Run: node queue-server/scripts/detect-tag-communities.js
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = resolve(__dirname, '../data-seed/fmcns_ontology.json');
const OUT_PATH = resolve(__dirname, '../data-seed/tag_communities.json');

function buildGraph(seed) {
  const tagLists = [
    ...seed.characters.map((c) => c.tags || []),
    ...seed.countries.map((c) => c.tags || []),
  ].filter((tags) => tags.length > 0);

  const freq = new Map(); // tag -> number of entities carrying it
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
    const degA = weightedDegree(adjacency, a) * freq.get(a);
    const degB = weightedDegree(adjacency, b) * freq.get(b);
    if (degB !== degA) return degB - degA;
    return a.localeCompare(b);
  });
  const top = ranked.slice(0, 4);
  return top.map((t) => t.replace(/-/g, ' ')).join(' / ');
}

export function run() {
  const seed = JSON.parse(readFileSync(SEED_PATH, 'utf8'));
  const { freq, adjacency } = buildGraph(seed);
  const community = detectCommunities(adjacency);

  const groups = new Map(); // communityLabel -> [tags]
  for (const [tag, comm] of community.entries()) {
    if (!groups.has(comm)) groups.set(comm, []);
    groups.get(comm).push(tag);
  }

  // Stable, human-facing IDs: largest communities first, ties broken alphabetically
  // by their first (most central) tag, so re-running produces the same C1/C2/... order.
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

  const tagToCommunityId = new Map();
  communities.forEach((c) => c.tags.forEach((t) => tagToCommunityId.set(t, c.id)));

  const result = {
    // Rewritten on every run, so the "this is not live data" warning survives a
    // regeneration instead of being silently dropped from the output.
    _note:
      'Snapshot only — NOT live data. The running app computes theme clusters from the entity_tags table at boot (server/src/services/tagCommunities.js) and reads this file nowhere. Regenerate with scripts/detect-tag-communities.js if you want the seed JSON\'s own clustering.',
    method: 'louvain-single-level-greedy-modularity',
    generatedFrom: 'queue-server/data-seed/fmcns_ontology.json',
    generatedAt: new Date().toISOString(),
    totalTags: adjacency.size,
    totalCommunities: communities.length,
    communities,
    tagCommunity: Object.fromEntries(tagToCommunityId),
  };

  writeFileSync(OUT_PATH, JSON.stringify(result, null, 2) + '\n');
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = run();
  console.log(`Detected ${result.totalCommunities} communities over ${result.totalTags} tags.`);
  console.log(`Written to ${OUT_PATH}`);
  console.log('Top 10 communities by size:');
  for (const c of result.communities.slice(0, 10)) {
    console.log(`  ${c.id} (${c.size} tags) — ${c.name}`);
  }
}
