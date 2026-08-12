// Building blocks — evidence-backed discovery (plan "github-code-discovery.md").
//
// Two independent surfaces share this module:
// - Discover (curated, GitHub-only): a fixed list of ~10 queries, cached 24h,
//   re-ranked by useful/not-useful feedback. The materials library.
// - Idea box (hybrid): free-text idea in, a two-channel report out — repos
//   actually found on GitHub ("proven"), or a proposal to build the piece
//   from scratch when nothing fits ("imagined"). Also the engine Part B
//   (plan-first-queue-and-idea-composition) reuses per-part, scoped to one
//   part's label instead of a whole idea — same function, shorter input.
//
// Zero AI calls happen just from opening a view — every model call here is a
// direct result of an explicit action (Search, Refresh, Rerun), per CLAUDE.md's
// cost-control rules.

import { randomUUID } from 'node:crypto';
import { generateText } from './ai/text.js';
import { createNode } from './architectureNodes.js';

let db = null;
export function bindDiscoveryDb(database) { db = database; }

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export const CURATED_QUERIES = [
  { id: 'graph_knowledge_graph', category: 'graph', query: 'knowledge graph language:javascript', description: 'Knowledge-graph libraries and viewers' },
  { id: 'agents_orchestration', category: 'agents', query: 'multi-agent orchestration mcp', description: 'Multi-agent orchestration frameworks' },
  { id: 'data_recommender', category: 'data', query: 'recommender system language:go', description: 'Recommender-system engines' },
  { id: 'backend_node_sqlite', category: 'backend', query: 'node express sqlite', description: 'Node/Express + SQLite backend patterns' },
  { id: 'frontend_fractal_viz', category: 'frontend', query: 'fractal graph layout d3', description: 'Fractal/graph layout visualization' },
  { id: 'agents_mcp_github', category: 'agents', query: 'mcp server github', description: 'MCP servers integrating GitHub' },
  { id: 'graph_graphrag', category: 'graph', query: 'graphrag knowledge graph', description: 'RAG over knowledge graphs' },
  { id: 'frontend_spa_vanilla', category: 'frontend', query: 'single page application vanilla js', description: 'Vanilla-JS single-page app patterns' },
  { id: 'recommender_embeddings', category: 'recommender', query: 'embeddings similarity search', description: 'Embedding-based similarity search' },
  { id: 'data_graph_db', category: 'data', query: 'graph database embedded', description: 'Embedded graph databases' },
];

export function listQueries() { return CURATED_QUERIES; }

function githubHeaders() {
  const h = { 'User-Agent': 'fmcns-discovery', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

async function fetchFromGithub(query, { perPage = 5 } = {}) {
  const text = String(query || '').trim();
  if (!text) return { items: [] };
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(text)}&sort=stars&per_page=${perPage}`;
  try {
    const resp = await fetch(url, { headers: githubHeaders() });
    if (!resp.ok) return { error: `github_${resp.status}` };
    const data = await resp.json();
    return { items: data.items || [] };
  } catch (e) {
    return { error: 'github_fetch_failed', message: e.message };
  }
}

function cacheRowOut(r) {
  return {
    repo_full_name: r.repo_full_name, stars: r.stars, description: r.description,
    html_url: r.html_url, topics: JSON.parse(r.topics_json || '[]'), rank_boost: r.rank_boost,
  };
}

function rankedResults(queryId) {
  return db.prepare(`SELECT * FROM github_discovery_cache WHERE query_id=? ORDER BY (stars+rank_boost) DESC`)
    .all(queryId).map(cacheRowOut);
}

async function refreshQuery(q) {
  const r = await fetchFromGithub(q.query, { perPage: 5 });
  if (r.error) return r;
  for (const item of r.items) {
    const existing = db.prepare(`SELECT rank_boost FROM github_discovery_cache WHERE query_id=? AND repo_full_name=?`).get(q.id, item.full_name);
    db.prepare(`
      INSERT INTO github_discovery_cache (id, query_id, repo_full_name, stars, description, html_url, topics_json, rank_boost, fetched_at)
      VALUES (?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(query_id, repo_full_name) DO UPDATE SET
        stars=excluded.stars, description=excluded.description, html_url=excluded.html_url,
        topics_json=excluded.topics_json, fetched_at=excluded.fetched_at
    `).run(randomUUID(), q.id, item.full_name, item.stargazers_count || 0, item.description || '',
      item.html_url || '', JSON.stringify(item.topics || []), existing?.rank_boost || 0);
  }
  return { ok: true, count: r.items.length };
}

// Curated Discover view: cache-first, refreshed past the 24h TTL or on demand.
export async function getResults(queryId, { forceRefresh = false } = {}) {
  const q = CURATED_QUERIES.find((x) => x.id === queryId);
  if (!q) return { error: 'unknown_query' };
  const newest = db.prepare(`SELECT MAX(fetched_at) AS at FROM github_discovery_cache WHERE query_id=?`).get(queryId);
  const stale = !newest?.at || (Date.now() - new Date(newest.at).getTime()) > CACHE_TTL_MS;
  if (forceRefresh || stale) {
    const r = await refreshQuery(q);
    if (r.error && !newest?.at) return r; // nothing cached to fall back on either
  }
  return { query: q, results: rankedResults(queryId) };
}

export function submitFeedback({ repo_full_name, verdict }) {
  if (!repo_full_name || !['useful', 'not_useful'].includes(verdict)) return { error: 'invalid' };
  db.prepare(`INSERT INTO github_discovery_feedback (id, repo_full_name, verdict) VALUES (?,?,?)`)
    .run(randomUUID(), repo_full_name, verdict);
  const delta = verdict === 'useful' ? 10 : -20;
  db.prepare(`UPDATE github_discovery_cache SET rank_boost = rank_boost + ? WHERE repo_full_name=?`).run(delta, repo_full_name);
  return { ok: true };
}

// ─── Idea box: two-pass AI pipeline ────────────────────────────────────────
function extractJson(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function buildQueriesPrompt(ideaText) {
  return `You help find existing, real GitHub projects for an idea being considered for FMCNS (a personal ontology/graph research tool — Node/Express + SQLite backend, single-file vanilla-JS frontend).

IDEA: ${ideaText}

Return ONLY JSON, no prose, no markdown fence:
{"queries":[{"q":"<a real GitHub repository search query, using qualifiers like language: or topic: where useful>","why":"<one line: what this query is trying to find>"}]}

Return 1 to 3 queries. Make them specific enough to find real, relevant repositories — not generic single words.`;
}

function parseQueries(text) {
  const arr = extractJson(text)?.queries;
  return Array.isArray(arr) ? arr.filter((q) => q && q.q).slice(0, 3) : [];
}

function buildPicksPrompt(ideaText, candidates) {
  const list = candidates.map((c) => `- ${c.full_name} (${c.stargazers_count || 0}★): ${c.description || '(no description)'} [${(c.topics || []).join(', ')}]`).join('\n') || '(no candidates found)';
  return `You are choosing how to address one idea for FMCNS using the real GitHub repositories found below, or by proposing to build the piece from scratch when nothing fits.

IDEA: ${ideaText}

CANDIDATE REPOSITORIES FOUND ON GITHUB:
${list}

Return ONLY JSON, no prose, no markdown fence:
{"picks":[{"repo":"<owner/name>","stars":<int>,"why_fits":"<one line>","use":"<how it would be used/integrated>","territory":"<one of perception|knowledge|reasoning|experience|interface>"}],"imagined":[{"why_fits":"<why nothing existing fits and this should be built instead>","use":"<what to build>","territory":"<same 5 options>"}]}

Use "picks" only for repos actually listed above — never invent a repo. Use "imagined" when no candidate is a good fit for some part of the idea. Include at most 3 items total across both arrays; omit an array entirely if you have nothing for it.`;
}

function parsePicks(text) {
  const obj = extractJson(text);
  if (!obj) return { picks: [], imagined: [] };
  return {
    picks: Array.isArray(obj.picks) ? obj.picks : [],
    imagined: Array.isArray(obj.imagined) ? obj.imagined : [],
  };
}

function rowToReport(r) {
  return {
    id: r.id, idea_text: r.idea_text, source: r.source, source_id: r.source_id,
    queries: JSON.parse(r.queries_json || '[]'), picks: JSON.parse(r.picks_json || '[]'),
    rerun_count: r.rerun_count, created_at: r.created_at, updated_at: r.updated_at,
  };
}

export function getReport(id) {
  const r = db.prepare(`SELECT * FROM discovery_reports WHERE id=?`).get(id);
  return r ? rowToReport(r) : null;
}

export function listReports() {
  return db.prepare(`SELECT * FROM discovery_reports ORDER BY created_at DESC`).all().map(rowToReport);
}

async function fetchCandidates(queries) {
  const byRepo = new Map();
  for (const q of queries.slice(0, 3)) {
    const r = await fetchFromGithub(q.q, { perPage: 5 });
    if (r.items) for (const item of r.items) byRepo.set(item.full_name, item);
  }
  return Array.from(byRepo.values());
}

function toPickList(parsed) {
  return [
    ...parsed.picks.map((p) => ({ ...p, kind: 'proven' })),
    ...parsed.imagined.map((p) => ({ ...p, kind: 'imagined' })),
  ];
}

// The idea-box engine. Also reused by Part B's per-part resolution, scoped to
// a part's label instead of a whole idea — no pipeline change needed, just a
// shorter/more specific `ideaText`.
export async function runIdeaDiscovery(ideaText, { source = 'idea_box', sourceId = null } = {}) {
  const text = String(ideaText || '').trim();
  if (!text) return { error: 'idea_text_required' };

  const qResult = await generateText({ prompt: buildQueriesPrompt(text), feature: 'discovery', maxTokens: 500, label: 'discovery-queries' });
  const queries = qResult?.text ? parseQueries(qResult.text) : [];

  const candidates = queries.length ? await fetchCandidates(queries) : [];

  const pResult = await generateText({ prompt: buildPicksPrompt(text, candidates), feature: 'discovery', maxTokens: 900, label: 'discovery-picks' });
  const picks = pResult?.text ? toPickList(parsePicks(pResult.text)) : [];

  const id = randomUUID();
  db.prepare(`
    INSERT INTO discovery_reports (id, idea_text, source, source_id, queries_json, picks_json)
    VALUES (?,?,?,?,?,?)
  `).run(id, text, source, sourceId, JSON.stringify(queries), JSON.stringify(picks));

  return getReport(id);
}

export async function rerunReport(id) {
  const row = db.prepare(`SELECT * FROM discovery_reports WHERE id=?`).get(id);
  if (!row) return { error: 'not_found' };
  const queries = JSON.parse(row.queries_json || '[]');
  const candidates = queries.length ? await fetchCandidates(queries) : [];
  const pResult = await generateText({ prompt: buildPicksPrompt(row.idea_text, candidates), feature: 'discovery', maxTokens: 900, label: 'discovery-picks-rerun' });
  const picks = pResult?.text ? toPickList(parsePicks(pResult.text)) : [];
  db.prepare(`UPDATE discovery_reports SET picks_json=?, rerun_count=rerun_count+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
    .run(JSON.stringify(picks), id);
  return getReport(id);
}

// Plants a report pick into the tech tree — reuses architectureNodes.createNode
// with provenance:'speculative' (the tree already renders that with a dashed
// outline, so no new provenance value or node styling is needed). A 'proven'
// pick also gets an evidence row linking the node back to the repo that
// justified it.
export function plantPick(reportId, pickIndex, { targetNodeId = null } = {}) {
  const report = getReport(reportId);
  if (!report) return { error: 'report_not_found' };
  const pick = report.picks[pickIndex];
  if (!pick) return { error: 'pick_not_found' };
  const name = pick.kind === 'proven' ? (pick.repo || 'Untitled building block') : (pick.use || pick.why_fits || 'Untitled building block');
  const result = createNode(db, {
    name, territory: pick.territory, what: pick.use || '', why: pick.why_fits || '',
    status: 'Concept', provenance: 'speculative', parent_node_id: targetNodeId,
  });
  if (result.error) return result;
  if (pick.kind === 'proven' && pick.repo) {
    db.prepare(`INSERT INTO architecture_node_evidence (id, node_id, repo_full_name, stars, why, report_id) VALUES (?,?,?,?,?,?)`)
      .run(randomUUID(), result.node.id, pick.repo, pick.stars || 0, pick.why_fits || '', reportId);
  }
  return { node: result.node };
}

export function evidenceForNode(nodeId) {
  return db.prepare(`SELECT * FROM architecture_node_evidence WHERE node_id=? ORDER BY created_at`).all(nodeId);
}
