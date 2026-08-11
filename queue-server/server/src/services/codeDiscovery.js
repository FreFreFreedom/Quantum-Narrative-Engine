// "Building blocks" — evidence-backed discovery for FMCNS. Two independent flows:
//
//   1. Discover: a curated, GitHub-only materials library. Fixed queries, cached
//      results, re-ranked by "useful"/"not useful" feedback. No AI involved.
//   2. Idea box: free-text idea -> AI decomposes it into 1-4 sub-parts -> per part,
//      AI picks a handful of GitHub searches -> AI looks at the real results and
//      returns BOTH already-built options (real repos, kind:'proven') and
//      build-it-ourselves options (pure speculative proposals, kind:'imagined')
//      when nothing good exists, plus which pick it recommends per part. An
//      atomic idea decomposes to exactly one part, so simple ideas behave the
//      same as before. (1 + 2*parts) AI calls total, only on an explicit click —
//      never on page load (see CLAUDE.md cost rules).
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

// ─── Idea box: decompose -> per-part search/pick AI pipeline ────────────────────

const MAX_PARTS = 4;
const FMCNS_BLURB = 'FMCNS (Fractal Mythic Consciousness Navigation System), a personal research tool: single-file vanilla-JS frontend, Node/Express + SQLite backend, a knowledge graph of "characters" (universal ontological units — people, films, countries all share one schema), agent-orchestration task queue, fractal navigation UI, and recommender-system ambitions';

function buildDecomposePrompt(ideaText) {
  return `You are helping plan building blocks for ${FMCNS_BLURB}.

The idea: "${String(ideaText).trim()}"

Decide whether this idea is a single atomic building block, or whether it names or implies combining multiple distinct capabilities/repos/approaches (for example: "combine a graph library with a note editor" is two parts; "add a knowledge-graph viewer" is one part).

- If atomic: return exactly ONE part whose description restates the idea.
- If it combines distinct capabilities: return 2-4 parts, one per distinct capability, each independently searchable on GitHub.

Respond with ONLY a JSON object, no prose, no markdown fence:
{"project_name":"short name for the overall idea (only meaningful if more than one part)","project_territory":"one of perception|knowledge|reasoning|experience|interface","parts":[{"name":"short label","description":"one paragraph: what this part must do, specific enough to search GitHub for"}]}`;
}

function buildQueryPrompt(partDescription) {
  const catalog = CURATED_QUERIES.map(q => `- [${q.category}] ${q.query}`).join('\n');
  return `You are helping search for building blocks for ${FMCNS_BLURB}.

Existing curated search categories (for reference, you are not limited to these):
${catalog}

The idea to search for: "${String(partDescription).trim()}"

Propose 1-3 distinct GitHub search queries (the kind you'd type into GitHub's repo search) that would surface real, already-built code relevant to this idea. Each query should be specific enough to return relevant repos, not so narrow it returns nothing.

Respond with ONLY a JSON object, no prose, no markdown fence:
{"queries":[{"q":"github search string","category":"one short word","why":"one sentence on what this search is trying to find"}]}`;
}

function buildPicksPrompt(partDescription, resultsByQuery) {
  const resultsBlock = resultsByQuery.map(({ q, why, results }) => {
    const lines = results.slice(0, 5).map(r => `  - ${r.repo_full_name} (${r.stars}★): ${r.description || '(no description)'}`).join('\n') || '  - (no results)';
    return `Query "${q.q}" (${q.why}):\n${lines}`;
  }).join('\n\n');
  return `You are helping ${FMCNS_BLURB} evaluate building blocks for this idea:

"${String(partDescription).trim()}"

Here is what GitHub search actually returned for the searches run on this idea:

${resultsBlock}

For each of the above real repos worth using, and for anything you judge is NOT well covered by these results (propose your own build-it-ourselves approach instead), produce a pick. Mix both kinds freely — if the results are good, mostly 'proven'; if nothing fits, mostly 'imagined'.

Respond with ONLY a JSON object, no prose, no markdown fence:
{"picks":[{"repo":"owner/name or null if imagined","stars":0,"why_fits":"one sentence","use":"one sentence on how FMCNS would actually use this","kind":"proven or imagined","tree_target":{"territory":"one of perception|knowledge|reasoning|experience|interface","name":"a short node name for the tech tree"}}],"recommended_index":0}`;
}

// Tolerant JSON extraction — strips a ```json fence if present (models occasionally
// add one to these newer prompts), else falls back to the first {...} block.
function parseJsonObject(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

async function searchAndPick(partDescription) {
  const pass1 = await generateText({ prompt: buildQueryPrompt(partDescription), maxTokens: 500, label: 'discovery-queries' });
  if (pass1.error) return { error: pass1.error, message: pass1.message };
  const parsed1 = parseJsonObject(pass1.text);
  const queries = (parsed1?.queries || []).filter(q => q && q.q).slice(0, 3);
  if (!queries.length) return { error: 'unparseable', message: 'Claude did not return usable search queries.' };
  return { queries };
}

export async function runIdeaSearch(db, { idea_text, source = 'idea_box', source_id = null } = {}) {
  const ideaText = String(idea_text || '').trim();
  if (!ideaText) return { error: 'idea_text_required' };

  const pass0 = await generateText({ prompt: buildDecomposePrompt(ideaText), maxTokens: 600, label: 'discovery-decompose' });
  if (pass0.error) return { error: pass0.error, message: pass0.message };
  const parsed0 = parseJsonObject(pass0.text);
  const rawParts = (parsed0?.parts || []).filter(p => p && p.description).slice(0, MAX_PARTS);
  const parts = rawParts.length ? rawParts : [{ name: parsed0?.project_name || 'Idea', description: ideaText }];
  const projectName = parsed0?.project_name || ideaText.slice(0, 60);
  const projectTerritory = parsed0?.project_territory || null;

  const builtParts = [];
  for (const part of parts) {
    const partDescription = String(part.description || ideaText).trim();
    const searchOut = await searchAndPick(partDescription);
    if (searchOut.error) {
      builtParts.push({ name: part.name || partDescription.slice(0, 40), description: partDescription, queries: [], picks: [], recommended_index: 0, error: searchOut.error });
      continue;
    }
    const resultsByQuery = [];
    for (const q of searchOut.queries) {
      const qId = queryHash(q.q);
      const out = await getResults(db, qId, q.q, {});
      resultsByQuery.push({ q, why: q.why, results: out.results || [] });
    }
    const pass2 = await generateText({ prompt: buildPicksPrompt(partDescription, resultsByQuery), maxTokens: 1200, label: 'discovery-picks' });
    const parsed2 = pass2.error ? null : parseJsonObject(pass2.text);
    const picks = (parsed2?.picks || []).filter(p => p && p.kind && (p.kind === 'proven' || p.kind === 'imagined'));
    const recommendedIndex = Number.isInteger(parsed2?.recommended_index) && parsed2.recommended_index < picks.length ? parsed2.recommended_index : 0;
    builtParts.push({
      name: part.name || partDescription.slice(0, 40),
      description: partDescription,
      queries: searchOut.queries,
      picks,
      recommended_index: picks.length ? recommendedIndex : 0,
    });
  }

  if (!builtParts.some(p => p.picks.length)) {
    return { error: 'unparseable', message: 'Claude did not return usable picks for any part.' };
  }

  const id = randomUUID();
  db.prepare(`
    INSERT INTO discovery_reports (id, idea_text, source, source_id, queries_json, picks_json, project_name, project_territory, parts_json)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(id, ideaText, source, source_id, JSON.stringify(builtParts[0].queries), JSON.stringify(builtParts[0].picks), projectName, projectTerritory, JSON.stringify(builtParts));

  return getReport(db, id);
}

export function getReport(db, id) {
  const row = db.prepare(`SELECT * FROM discovery_reports WHERE id=?`).get(id);
  if (!row) return null;
  const parts = row.parts_json
    ? JSON.parse(row.parts_json)
    : [{ name: 'Idea', description: row.idea_text, queries: JSON.parse(row.queries_json || '[]'), picks: JSON.parse(row.picks_json || '[]'), recommended_index: 0 }];
  return {
    id: row.id,
    idea_text: row.idea_text,
    source: row.source,
    source_id: row.source_id,
    project_name: row.project_name || row.idea_text.slice(0, 60),
    project_territory: row.project_territory || null,
    parts,
    created_at: row.created_at,
    rerun_count: row.rerun_count,
  };
}

export function listReports(db) {
  return db.prepare(`SELECT id, idea_text, source, picks_json, parts_json, created_at FROM discovery_reports ORDER BY created_at DESC`)
    .all()
    .map(r => {
      const parts = r.parts_json ? JSON.parse(r.parts_json) : [{ picks: JSON.parse(r.picks_json || '[]') }];
      return {
        id: r.id, idea_text: r.idea_text, source: r.source, created_at: r.created_at,
        pick_count: parts.reduce((n, p) => n + (p.picks?.length || 0), 0),
      };
    });
}

// Plant a single discovery pick into the tech tree. Provenance is 'speculative'
// (the same value the existing Claude speculation feature uses) rather than a new
// discovery-specific value — architectureNodes.createNode only ever preserves the
// literal string 'speculative', so a new value would silently be coerced to
// 'canon' and lose the dashed-outline treatment the tree already renders for it.
export function plant(db, { report_id, part_index = 0, pick_index, target_node_id = null } = {}) {
  const report = getReport(db, report_id);
  if (!report) return { error: 'report_not_found' };
  const part = report.parts[part_index];
  const pick = part?.picks?.[pick_index];
  if (!pick) return { error: 'pick_not_found' };

  const out = plantPick(db, pick, { target_node_id, report_id });
  return out.error ? out : { node: out.node };
}

function plantPick(db, pick, { target_node_id = null, report_id = null } = {}) {
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

// Plant an entire multi-part report as one tech-tree group: a parent "project" node
// for the overall idea, and one child per part using that part's AI-recommended pick.
// Tech-tree grouping only — no Dispatch Queue tasks are created here.
export function plantProject(db, { report_id } = {}) {
  const report = getReport(db, report_id);
  if (!report) return { error: 'report_not_found' };
  if (!report.parts || report.parts.length < 2) return { error: 'not_a_project' };

  const parentOut = createNode(db, {
    name: report.project_name || report.idea_text.slice(0, 60),
    territory: report.project_territory,
    what: report.idea_text,
    why: '',
    depends: [],
    status: 'Concept',
    provenance: 'speculative',
    parent_node_id: null,
  });
  if (parentOut.error) return parentOut;
  const projectNode = parentOut.node;

  const childNodes = [];
  for (const part of report.parts) {
    const pick = part.picks?.[part.recommended_index] || part.picks?.[0];
    if (!pick) continue;
    const out = plantPick(db, pick, { target_node_id: projectNode.id, report_id });
    if (!out.error) childNodes.push(out.node);
  }

  return { project_node: projectNode, child_nodes: childNodes };
}
