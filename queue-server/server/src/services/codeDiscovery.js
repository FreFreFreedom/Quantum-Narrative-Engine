// "Building blocks" — evidence-backed discovery for FMCNS. Two independent flows:
//
//   1. Discover: a curated, GitHub-only materials library. Fixed queries, cached
//      results, re-ranked by "useful"/"not useful" feedback. No AI involved.
//   2. Idea box: free-text idea -> AI picks a handful of GitHub searches -> AI
//      looks at the real results and returns BOTH already-built options (real
//      repos, kind:'proven') and build-it-ourselves options (pure speculative
//      proposals, kind:'imagined') when nothing good exists. Two AI calls total,
//      only on an explicit click — never on page load (see CLAUDE.md cost rules).
//
// AI calls go through services/claudeText.js (subscription CLI first, metered API
// fallback), same seam as architectureNodes.js#speculate — not the raw
// api.anthropic.com fetch used elsewhere, and not billed per token unless the
// subscription path is down.
import { randomUUID, createHash } from 'node:crypto';
import { generateText } from './claudeText.js';
import { createNode } from './architectureNodes.js';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export const CURATED_QUERIES = [
  { id: 'graph_knowledge_graph', category: 'graph', query: 'knowledge graph language:javascript', description: 'Knowledge-graph implementations in JS — structure/traversal ideas for the ontology graph.' },
  { id: 'graph_graphrag', category: 'graph', query: 'graphrag knowledge graph', description: 'RAG-over-graph approaches — retrieval patterns that could inform cross-corpus inference.' },
  { id: 'backend_node_sqlite', category: 'backend', query: 'node express sqlite', description: 'Node/Express + SQLite backend patterns matching our own stack.' },
  { id: 'backend_mcp_server', category: 'backend', query: 'mcp server github', description: 'MCP server integration pieces — relevant if FMCNS ever exposes its own tools.' },
  { id: 'agents_orchestration', category: 'agents', query: 'multi-agent orchestration mcp', description: 'Multi-agent orchestration frameworks — relevant to the Dispatch Queue subsystem.' },
  { id: 'frontend_fractal_d3', category: 'frontend', query: 'fractal graph layout d3', description: 'Fractal / recursive graph-layout viz pieces for the Content and Tech Tree views.' },
  { id: 'frontend_spa_vanilla', category: 'frontend', query: 'single page application vanilla js', description: 'No-build-step vanilla-JS SPA patterns matching fmcns_navigator.html.' },
  { id: 'data_recommender_go', category: 'recommender', query: 'recommender system language:go', description: 'Standalone recommender-system engines — relevant to any future "nearby on axis" recommender needs.' },
  { id: 'data_embeddings_search', category: 'data', query: 'semantic search embeddings sqlite', description: 'Embedding-backed search over SQLite — an alternative to the current keyword/facet search.' },
  { id: 'reasoning_analogical', category: 'data', query: 'analogical reasoning graph', description: 'Analogical-reasoning-over-graphs projects — relevant to cross-entity pattern inference.' },
];

const CATEGORIES = [...new Set(CURATED_QUERIES.map(q => q.category))];

export function listQueries() {
  return CURATED_QUERIES.map(({ id, category, query, description }) => ({ id, category, query, description }));
}

function queryHash(q) {
  return 'adhoc_' + createHash('sha1').update(String(q).trim().toLowerCase()).digest('hex').slice(0, 16);
}

async function searchGithub(query) {
  const headers = { 'User-Agent': 'fmcns-discovery', Accept: 'application/vnd.github+json' };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&per_page=5`;
  let resp;
  try {
    resp = await fetch(url, { headers });
  } catch (e) {
    return { error: 'network_error', message: e.message };
  }
  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.text()).slice(0, 300); } catch {}
    return { error: 'github_error', message: `HTTP ${resp.status}: ${detail}` };
  }
  const data = await resp.json();
  const items = (data.items || []).map(r => ({
    repo_full_name: r.full_name,
    stars: r.stargazers_count || 0,
    description: r.description || '',
    html_url: r.html_url,
    topics: r.topics || [],
  }));
  return { items };
}

function cacheRow(r) {
  return {
    repo_full_name: r.repo_full_name,
    stars: r.stars,
    description: r.description,
    html_url: r.html_url,
    topics: JSON.parse(r.topics_json || '[]'),
    fetched_at: r.fetched_at,
    rank_boost: r.rank_boost,
  };
}

function readCache(db, queryId) {
  return db.prepare(
    `SELECT * FROM github_discovery_cache WHERE query_id=? ORDER BY (stars + rank_boost) DESC`,
  ).all(queryId).map(cacheRow);
}

function isFresh(rows) {
  if (!rows.length) return false;
  const oldest = Math.min(...rows.map(r => new Date(r.fetched_at).getTime()));
  return Date.now() - oldest < CACHE_TTL_MS;
}

async function refreshCache(db, queryId, query) {
  const out = await searchGithub(query);
  if (out.error) return out;
  const upsert = db.prepare(`
    INSERT INTO github_discovery_cache (query_id, repo_full_name, stars, description, html_url, topics_json, fetched_at, rank_boost)
    VALUES (?,?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      COALESCE((SELECT rank_boost FROM github_discovery_cache WHERE query_id=? AND repo_full_name=?), 0))
    ON CONFLICT(query_id, repo_full_name) DO UPDATE SET
      stars=excluded.stars, description=excluded.description, html_url=excluded.html_url,
      topics_json=excluded.topics_json, fetched_at=excluded.fetched_at
  `);
  for (const item of out.items) {
    upsert.run(queryId, item.repo_full_name, item.stars, item.description, item.html_url,
      JSON.stringify(item.topics), queryId, item.repo_full_name);
  }
  return { items: out.items };
}

// Curated queries (Discover view) and ad-hoc idea-box queries share this cache/TTL
// path, distinguished only by queryId shape ('graph_...' vs 'adhoc_<hash>').
export async function getResults(db, queryId, query, { forceRefresh = false } = {}) {
  const cached = readCache(db, queryId);
  if (!forceRefresh && isFresh(cached)) return { results: cached, stale: false };
  const out = await refreshCache(db, queryId, query);
  if (out.error) {
    // GitHub failed (rate limit, network) — serve whatever's cached, even if stale,
    // rather than an empty result.
    if (cached.length) return { results: cached, stale: true, warning: out.message };
    return { error: out.error, message: out.message };
  }
  return { results: readCache(db, queryId), stale: false };
}

export function recordFeedback(db, { repo_full_name, verdict }) {
  if (!repo_full_name || !['useful', 'not_useful'].includes(verdict)) return { error: 'invalid_input' };
  db.prepare(`INSERT INTO github_discovery_feedback (id, repo_full_name, verdict) VALUES (?,?,?)`)
    .run(randomUUID(), repo_full_name, verdict);
  const delta = verdict === 'useful' ? 10 : -20;
  db.prepare(`UPDATE github_discovery_cache SET rank_boost = rank_boost + ? WHERE repo_full_name=?`)
    .run(delta, repo_full_name);
  return { ok: true };
}

// ─── Idea box: 2-pass AI pipeline ────────────────────────────────────────────────

function buildQueryPrompt(ideaText) {
  const catalog = CURATED_QUERIES.map(q => `- [${q.category}] ${q.query}`).join('\n');
  return `You are helping search for building blocks for FMCNS (Fractal Mythic Consciousness Navigation System), a personal research tool: single-file vanilla-JS frontend, Node/Express + SQLite backend, a knowledge graph of "characters" (universal ontological units — people, films, countries all share one schema), agent-orchestration task queue, fractal navigation UI, and recommender-system ambitions.

Existing curated search categories (for reference, you are not limited to these):
${catalog}

The idea to search for: "${String(ideaText).trim()}"

Propose 1-3 distinct GitHub search queries (the kind you'd type into GitHub's repo search) that would surface real, already-built code relevant to this idea. Each query should be specific enough to return relevant repos, not so narrow it returns nothing.

Respond with ONLY a JSON object, no prose, no markdown fence:
{"queries":[{"q":"github search string","category":"one short word","why":"one sentence on what this search is trying to find"}]}`;
}

function buildPicksPrompt(ideaText, resultsByQuery) {
  const resultsBlock = resultsByQuery.map(({ q, why, results }) => {
    const lines = results.slice(0, 5).map(r => `  - ${r.repo_full_name} (${r.stars}★): ${r.description || '(no description)'}`).join('\n') || '  - (no results)';
    return `Query "${q.q}" (${q.why}):\n${lines}`;
  }).join('\n\n');
  return `You are helping FMCNS (a personal research tool: single-file vanilla-JS frontend, Node/Express + SQLite backend, a knowledge-graph ontology, agent-orchestration task queue, fractal navigation UI) evaluate building blocks for this idea:

"${String(ideaText).trim()}"

Here is what GitHub search actually returned for the searches run on this idea:

${resultsBlock}

For each of the above real repos worth using, and for anything you judge is NOT well covered by these results (propose your own build-it-ourselves approach instead), produce a pick. Mix both kinds freely — if the results are good, mostly 'proven'; if nothing fits, mostly 'imagined'.

Respond with ONLY a JSON object, no prose, no markdown fence:
{"picks":[{"repo":"owner/name or null if imagined","stars":0,"why_fits":"one sentence","use":"one sentence on how FMCNS would actually use this","kind":"proven or imagined","tree_target":{"territory":"one of perception|knowledge|reasoning|experience|interface","name":"a short node name for the tech tree"}}]}`;
}

function parseJsonObject(text) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

export async function runIdeaSearch(db, { idea_text, source = 'idea_box', source_id = null } = {}) {
  const ideaText = String(idea_text || '').trim();
  if (!ideaText) return { error: 'idea_text_required' };

  const pass1 = await generateText({ prompt: buildQueryPrompt(ideaText), maxTokens: 500, label: 'discovery-queries' });
  if (pass1.error) return { error: pass1.error, message: pass1.message };
  const parsed1 = parseJsonObject(pass1.text);
  const queries = (parsed1?.queries || []).filter(q => q && q.q).slice(0, 3);
  if (!queries.length) return { error: 'unparseable', message: 'Claude did not return usable search queries.' };

  const resultsByQuery = [];
  for (const q of queries) {
    const qId = queryHash(q.q);
    const out = await getResults(db, qId, q.q, {});
    resultsByQuery.push({ q, why: q.why, results: out.results || [] });
  }

  const pass2 = await generateText({ prompt: buildPicksPrompt(ideaText, resultsByQuery), maxTokens: 1200, label: 'discovery-picks' });
  if (pass2.error) return { error: pass2.error, message: pass2.message };
  const parsed2 = parseJsonObject(pass2.text);
  const picks = (parsed2?.picks || []).filter(p => p && p.kind && (p.kind === 'proven' || p.kind === 'imagined'));
  if (!picks.length) return { error: 'unparseable', message: 'Claude did not return usable picks.' };

  const id = randomUUID();
  db.prepare(`
    INSERT INTO discovery_reports (id, idea_text, source, source_id, queries_json, picks_json)
    VALUES (?,?,?,?,?,?)
  `).run(id, ideaText, source, source_id, JSON.stringify(queries), JSON.stringify(picks));

  return getReport(db, id);
}

export function getReport(db, id) {
  const row = db.prepare(`SELECT * FROM discovery_reports WHERE id=?`).get(id);
  if (!row) return null;
  return {
    id: row.id,
    idea_text: row.idea_text,
    source: row.source,
    source_id: row.source_id,
    queries: JSON.parse(row.queries_json || '[]'),
    picks: JSON.parse(row.picks_json || '[]'),
    created_at: row.created_at,
    rerun_count: row.rerun_count,
  };
}

export function listReports(db) {
  return db.prepare(`SELECT id, idea_text, source, picks_json, created_at FROM discovery_reports ORDER BY created_at DESC`)
    .all()
    .map(r => ({
      id: r.id, idea_text: r.idea_text, source: r.source, created_at: r.created_at,
      pick_count: JSON.parse(r.picks_json || '[]').length,
    }));
}

// Plant a discovery pick into the tech tree. Provenance is 'speculative' (the same
// value the existing Claude speculation feature uses) rather than a new
// discovery-specific value — architectureNodes.createNode only ever preserves the
// literal string 'speculative', so a new value would silently be coerced to
// 'canon' and lose the dashed-outline treatment the tree already renders for it.
export function plant(db, { report_id, pick_index, target_node_id = null } = {}) {
  const report = getReport(db, report_id);
  if (!report) return { error: 'report_not_found' };
  const pick = report.picks[pick_index];
  if (!pick) return { error: 'pick_not_found' };

  const target = pick.tree_target || {};
  const out = createNode(db, {
    name: target.name || pick.repo || 'Discovery pick',
    territory: target.territory,
    what: pick.use || '',
    why: pick.why_fits || '',
    depends: target_node_id ? [target_node_id] : [],
    status: 'Concept',
    provenance: 'speculative',
    parent_node_id: target_node_id,
  });
  if (out.error) return out;

  if (pick.kind === 'proven' && pick.repo) {
    db.prepare(`
      INSERT INTO architecture_node_evidence (id, node_id, repo_full_name, stars, why, report_id)
      VALUES (?,?,?,?,?,?)
    `).run(randomUUID(), out.node.id, pick.repo, pick.stars || 0, pick.why_fits || '', report_id);
  }
  return { node: out.node };
}
