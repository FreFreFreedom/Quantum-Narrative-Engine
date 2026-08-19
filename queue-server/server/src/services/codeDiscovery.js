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
// AI calls go through services/ai/text.js on the FREE lane. They used to call
// claudeText.js (always-Claude), which meant the world-look quietly spent
// subscription quota on every implement task. Antoine's rule (2026-08-18): the
// Claude subscription belongs to the QUEUE — the engine that writes real code —
// and nothing else in the app may draw on it. Everything here is short helper
// text, exactly what the free lane is for.
import { randomUUID, createHash } from 'node:crypto';
import { generateText as generateTextByFeature } from './ai/text.js';
import { createNode } from './architectureNodes.js';
import { USER_FACING_STYLE } from './ai/style.js';

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
  const attempt = async () => {
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
  };
  let out = await attempt();
  // Rate limits and server hiccups are transient — one cheap second try before
  // the caller falls back to the cache or reports the shelf empty.
  if (out.error === 'github_error' && /HTTP (403|429|5\d\d)/.test(out.message || '')) {
    await new Promise(r => setTimeout(r, 2500));
    out = await attempt();
  }
  return out;
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
{"project_name":"short name for the overall idea (only meaningful if more than one part)","project_territory":"one of perception|knowledge|reasoning|experience|interface","parts":[{"name":"short label","description":"one short sentence (max 20 words): what this part must do, specific enough to search GitHub for"}]}`;
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
export function parseJsonObject(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

async function searchAndPick(partDescription) {
  const pass1 = await generateTextByFeature({ prompt: buildQueryPrompt(partDescription), feature: 'inspire', maxTokens: 500, label: 'discovery-queries', maxAttempts: 3 });
  if (pass1.error) return { error: pass1.error, message: pass1.message };
  const parsed1 = parseJsonObject(pass1.text);
  const queries = (parsed1?.queries || []).filter(q => q && q.q).slice(0, 3);
  if (!queries.length) return { error: 'unparseable', message: 'Claude did not return usable search queries.' };
  return { queries };
}

export async function runIdeaSearch(db, { idea_text, source = 'idea_box', source_id = null } = {}) {
  const ideaText = String(idea_text || '').trim();
  if (!ideaText) return { error: 'idea_text_required' };

  const pass0 = await generateTextByFeature({ prompt: buildDecomposePrompt(ideaText), feature: 'inspire', maxTokens: 600, label: 'discovery-decompose', maxAttempts: 3 });
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
    const pass2 = await generateTextByFeature({ prompt: buildPicksPrompt(partDescription, resultsByQuery), feature: 'inspire', maxTokens: 1200, label: 'discovery-picks', maxAttempts: 3 });
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

  // Same quick check the queue/section world-looks get, so alternative picks are
  // grouped and marked here too — the idea box gets the same substitute-vs-
  // complementary clarity as every other world-look surface.
  try {
    const review = await reviewInspiration({ report: getReport(db, id), prompt: ideaText, allowQuestion: false });
    if (review) storeReportReview(db, id, review);
  } catch (e) { console.error('quick check after idea-box search failed —', e.message); }

  return getReport(db, id);
}

// ─── Inspiration pass: three shelves for every queue task ─────────────────────
//
// Distinct from the idea box on purpose: where the idea box is an explicit,
// GitHub-first exploration, this pass runs automatically for every implement-mode
// task BEFORE its plan is drafted (plan "inspiration-before-planning"). It asks
// the model for three shelves per part:
//
//   open   — real open-source projects (backed by live GitHub results)
//   hidden — products/features that exist in the world but whose code is not
//            public (the model's general knowledge — labeled as unverifiable)
//   bold   — ideas that may not exist anywhere yet. THE HEART of the pass: the
//            model is pushed to understand the deep nature of the technologies
//            and envision the boldest plausible version, not to play it safe.
//
// One decompose(+queries) call plus one picks call per part — cheaper than the
// idea box's three passes, and it must be, because it runs unattended.
// The stored report is indistinguishable from an idea-box report (same table,
// same parts/picks JSON shape, source='prompt', source_id=<prompt id>), so the
// tech tree, evidence and report views all work on it without new schema.

const INSPIRE_MAX_PARTS = 3;

function buildInspireDecomposePrompt(ideaText) {
  return `You are helping plan an idea for ${FMCNS_BLURB}.

The idea: "${String(ideaText).trim()}"

Two jobs in one pass:
1. Split the idea into 1-3 independently searchable parts IF it combines distinct capabilities (an atomic idea stays exactly ONE part).
2. For each part, propose 1-2 GitHub repo-search query strings (the kind you would type into GitHub's search box) that would surface real, already-built open-source work relevant to that part. Be realistic about what a query would return.

The description is read by the app's owner, who is not a programmer — plain everyday words, no jargon, no internal component ids.

${USER_FACING_STYLE}

Respond with ONLY a JSON object, no prose, no markdown fence:
{"project_name":"short name for the overall idea","parts":[{"name":"short label","description":"one short sentence (max 20 words): what this part must do","queries":[{"q":"github search string","why":"one sentence on what this search is trying to find"}]}]}`;
}

function buildInspirePicksPrompt(partDescription, resultsByQuery) {
  const hasLive = resultsByQuery.length > 0;
  const resultsBlock = resultsByQuery.map(({ q, why, results }) => {
    const lines = results.slice(0, 5).map(r => `  - ${r.repo_full_name} (${r.stars}★): ${r.description || '(no description)'}`).join('\n') || '  - (no results)';
    return `Query "${q.q}" (${q.why}):\n${lines}`;
  }).join('\n\n');
  return `You are the inspiration engine for ${FMCNS_BLURB}. A task is about to be planned into a real feature, and the plan will be written from your answer. Look at the world and produce inspiration on three shelves — with the BOLD shelf as the HEART of your answer.

The part of the idea you are inspiring for: "${String(partDescription).trim()}"

${hasLive ? `What a live GitHub search just returned for this part:\n\n${resultsBlock}\n\n` : 'No live GitHub results were available for this part — still produce shelves 2 and 3 at full strength.\n\n'}

SHELF 1 — "open": real open-source projects worth taking ideas from, chosen from the live results above. If the live results contain relevant repos, you MUST include an open pick for each relevant one (up to 3) — never return zero open picks when relevant repos exist.${hasLive ? '' : ' (no live results available, so produce zero open picks)'}. Fields: repo, stars, why_fits, use.
SHELF 2 — "hidden": things that exist in the world but whose code is not public — products or features inside companies, from your general knowledge. You cannot link them; give the name, what it does, what we can learn from it, and what FMCNS could do even better. Fields: name, what, lesson, use.
SHELF 3 — "bold" (the heart): ideas that may not exist anywhere yet. First understand the deep nature of the technologies involved in this idea and where they are heading. Then imagine the boldest PLAUSIBLE version of this idea — 2 to 3 bold ideas. Be innovative. Be visionary. Dare. Do not water them down. Each: name, vision (1-2 punchy short sentences), why_possible (why this is achievable with today's or near-future technology), how_fmcns (how FMCNS could be the first to build it).

Produce 2-3 open picks, 1-2 hidden picks, and 2-3 bold picks. Set recommended_index to the single pick that gives the best mix of boldness and feasibility — prefer a bold pick when it is strong.

Every text field must be ONE short sentence, maximum 20 words. Never write paragraphs.

${USER_FACING_STYLE}

Respond with ONLY a JSON object, no prose, no markdown fence:
{"picks":[{"kind":"open","repo":"owner/name","stars":0,"why_fits":"one short sentence","use":"one short sentence on how FMCNS would use it"},{"kind":"hidden","name":"product or company","what":"what it does, one short sentence","lesson":"what we can learn, one short sentence","use":"what FMCNS could do even better, one short sentence"},{"kind":"bold","name":"short idea name","vision":"1-2 punchy short sentences","why_possible":"one short sentence","how_fmcns":"one short sentence"}],"recommended_index":0}`;
}

// The automatic inspiration pass. Never throws — a failure returns {error} and
// the caller marks the task inspire_state='failed' so the human gets a retry
// button, and the plan is drafted without inspiration (the queue never blocks).
// Bounds note: these calls used to pass neither maxAttempts nor timeoutMs, so
// they inherited generateText's defaults — Infinity attempts at 90s each, over
// the primary chain PLUS the whole free catalogue, three parts deep. One pass
// could quietly occupy tens of minutes walking dead free models. They now use
// the same 3-attempt / 45s bound runIdeaSearch already uses, with Claude as a
// last resort (one cheap haiku call via the local runner) so a fully cooled-down
// free lane produces an answer instead of a stall.
export async function runInspiration(db, { idea_text, source = 'prompt', source_id = null, forceRefresh = false } = {}) {
  const ideaText = String(idea_text || '').trim();
  if (!ideaText) return { error: 'idea_text_required' };

  const pass0 = await generateTextByFeature({ prompt: buildInspireDecomposePrompt(ideaText), feature: 'inspire', maxTokens: 700, label: 'inspire-decompose', maxAttempts: 3, timeoutMs: 45_000, claudeLastResort: true });
  if (pass0.error) return { error: pass0.error, message: pass0.message };
  const parsed0 = parseJsonObject(pass0.text);
  const rawParts = (parsed0?.parts || []).filter(p => p && p.description).slice(0, INSPIRE_MAX_PARTS);
  const parts = rawParts.length ? rawParts : [{ name: parsed0?.project_name || 'Idea', description: ideaText, queries: [] }];
  const projectName = parsed0?.project_name || ideaText.slice(0, 60);

  const builtParts = [];
  for (const part of parts) {
    const partDescription = String(part.description || ideaText).trim();
    const queries = (part.queries || []).filter(q => q && q.q).slice(0, 2);
    const resultsByQuery = [];
    for (const q of queries) {
      const qId = queryHash(q.q);
      const out = await getResults(db, qId, q.q, { forceRefresh });
      if (!out.error) resultsByQuery.push({ q, why: q.why, results: out.results || [] });
    }
    const pass2 = await generateTextByFeature({ prompt: buildInspirePicksPrompt(partDescription, resultsByQuery), feature: 'inspire', maxTokens: 1600, label: 'inspire-picks', maxAttempts: 3, timeoutMs: 45_000, claudeLastResort: true });
    const parsed2 = pass2.error ? null : parseJsonObject(pass2.text);
    const picks = (parsed2?.picks || []).filter(p => p && ['open', 'hidden', 'bold'].includes(p.kind));
    const recommendedIndex = Number.isInteger(parsed2?.recommended_index) && parsed2.recommended_index < picks.length ? parsed2.recommended_index : 0;
    builtParts.push({
      name: part.name || partDescription.slice(0, 40),
      description: partDescription,
      queries,
      picks,
      recommended_index: picks.length ? recommendedIndex : 0,
    });
  }

  if (!builtParts.some(p => p.picks.length)) {
    return { error: 'unparseable', message: 'The model did not return usable inspiration for any part.' };
  }

  const id = randomUUID();
  db.prepare(`
    INSERT INTO discovery_reports (id, idea_text, source, source_id, queries_json, picks_json, project_name, project_territory, parts_json)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(id, ideaText, source, source_id, JSON.stringify(builtParts[0].queries || []), JSON.stringify(builtParts[0].picks || []), projectName, null, JSON.stringify(builtParts));

  return getReport(db, id);
}

// Compact digest of a report for the plan-drafting pass: what the world has, what
// it hides, and the bold ideas — bold first (it is the heart). When the human
// applied specific picks, those are emphasized as the chosen direction while a
// couple of others stay as context. When a review (see reviewInspiration) exists,
// removed picks drop out entirely and each group of alternatives contributes only
// its recommended pick — the owner's applied picks always override the review.
// Capped so the drafting call stays cheap.
export function inspirationDigestFor(report, appliedPicks = [], review = null) {
  if (!report) return null;
  const chosen = new Set((appliedPicks || []).map(p => `${p.part_index}:${p.pick_index}`));
  const removed = new Set((review?.removed || []).map(r => `${r.part_index}:${r.pick_index}`));
  const groupMembers = new Set();
  const groupBest = new Set();
  for (const g of (review?.groups || [])) {
    const rec = (review.recommended || []).find(r => r.group_id === g.id);
    const best = rec && (g.picks || []).some(p => p.part_index === rec.part_index && p.pick_index === rec.pick_index)
      ? rec : (g.picks || [])[0] || null;
    (g.picks || []).forEach(p => groupMembers.add(`${p.part_index}:${p.pick_index}`));
    if (best) groupBest.add(`${best.part_index}:${best.pick_index}`);
  }
  const parts = (report.parts || []).slice(0, 3);
  const byShelf = { open: [], hidden: [], bold: [] };
  parts.forEach((part, pi) => {
    (part.picks || []).forEach((pick, i) => {
      if (!byShelf[pick.kind]) return;
      const key = `${pi}:${i}`;
      // Survives when: the owner applied it, or the review did not remove it and
      // (it is not part of an alternative group, or it is the group's best).
      const kept = chosen.has(key) || (!removed.has(key) && (!groupMembers.has(key) || groupBest.has(key)));
      if (!kept) return;
      byShelf[pick.kind].push({ ...pick, mark: chosen.has(key) });
    });
  });
  const fmt = {
    open: p => `- ${p.repo || '?'} (${p.stars || 0}★): ${p.why_fits || ''} Use: ${p.use || ''}`,
    hidden: p => `- ${p.name || '?'}: ${p.what || ''} Lesson: ${p.lesson || ''} For FMCNS: ${p.use || ''}`,
    bold: p => `- ${p.name || '?'}: ${p.vision || ''} Possible because: ${p.why_possible || ''} For FMCNS: ${p.how_fmcns || ''}`,
  };
  const caps = { open: 2, hidden: 2, bold: 3 };
  const mark = p => (p.mark ? ' (CHOSEN)' : '');
  const lines = [];
  for (const shelf of ['bold', 'open', 'hidden']) {
    const items = byShelf[shelf];
    if (!items.length) continue;
    const chosenFirst = [...items.filter(p => p.mark), ...items.filter(p => !p.mark)].slice(0, caps[shelf]);
    const label = shelf === 'bold'
      ? 'SHELF 3 — BOLD IDEAS (may not exist anywhere yet — design targets, not dependencies)'
      : shelf === 'open'
        ? 'SHELF 1 — OPEN SOURCE (real, verifiable projects)'
        : 'SHELF 2 — CLOSED PRODUCTS (exist in the world, code not public — match or beat them)';
    lines.push(label + ':');
    lines.push(...chosenFirst.map(p => fmt[shelf](p) + mark(p)));
  }
  const out = lines.join('\n');
  return out.length > 2600 ? out.slice(0, 2600) : out;
}

// ─── Quick check: between world-look and plan draft ───────────────────────────
//
// One cheap pass over a finished inspiration report, before the plan is drafted.
// It keeps the report lean: removes picks that do not earn their place, clusters
// substitutes into groups (the owner only needs one of each), and names the best
// pick per group. It decides alone on anything it can; it asks the owner at most
// ONE question, only when the answer genuinely changes what gets built (a real
// fork, or a bold idea that would grow the task far beyond its original scope).
// Never throws — a failure returns null and the caller uses the full report.

function compactReportForReview(report) {
  return (report.parts || []).slice(0, 3).map((part, pi) => ({
    name: part.name,
    description: part.description,
    picks: (part.picks || []).map((pick, i) => {
      const key = { part_index: pi, pick_index: i };
      // Idea-box reports use kind 'proven'/'imagined' (same repo/why_fits/use shape
      // as the inspiration pass's 'open' shelf) instead of open/hidden/bold.
      if (pick.kind === 'open' || pick.kind === 'proven' || pick.kind === 'imagined') {
        return { ...key, kind: pick.kind, repo: pick.repo, why_fits: pick.why_fits, use: pick.use };
      }
      if (pick.kind === 'hidden') return { ...key, kind: 'hidden', name: pick.name, what: pick.what, use: pick.use };
      return { ...key, kind: 'bold', name: pick.name, vision: pick.vision, how_fmcns: pick.how_fmcns };
    }),
  }));
}

function buildReviewPrompt(ideaText, reportJson, answer, allowQuestion) {
  const answerBlock = answer
    ? `THE OWNER ALREADY ANSWERED A QUESTION ABOUT THESE IDEAS: "${String(answer).trim()}". Take it as their decision — incorporate it into your removals/recommendations, and do NOT ask any new question.`
    : '';
  const questionRule = allowQuestion
    ? `4. QUESTION: only if there is a real fork the owner must choose — two genuinely different directions for the task, or a bold idea that would make the task much bigger than asked. Then write ONE question with 2-3 short options. Otherwise "question": null. When in doubt, decide alone.`
    : `4. QUESTION: do NOT ask any question this time — decide alone. "question": null always.`;
  return `You are the quick-check editor for ${FMCNS_BLURB}. A world-look just returned inspiration ideas for one task, and the task's plan will be written from what survives your check. Keep the report lean and honest: remove what does not earn its place, flag alternatives, and pick the best of each family.

The task: "${String(ideaText).trim()}"

The world-look report (parts with picks; every pick carries its part_index and pick_index):
${reportJson}

${answerBlock}

Do:
1. REMOVE picks that do not serve THIS task: off-topic, duplicates of another pick, or ideas that would blow the task up beyond one job. One short reason each (max 20 words), plain everyday words.
2. GROUP picks that are alternatives of each other — they would build the same thing, the owner only needs one. Do NOT group picks just because they are related or would work well together: if two picks could both be built and used at the same time without conflict, they are complementary, not alternatives — leave them ungrouped. Only group when picking one makes the other redundant. Give each group a short id ("A", "B"...) and a one-sentence note on why they are the same thing in different wrapping. A group of one is not a group.
3. RECOMMEND, for each group, the single best pick, with one short sentence why.
${questionRule}

${USER_FACING_STYLE}

Respond with ONLY a JSON object, no prose, no markdown fence:
{"removed":[{"part_index":0,"pick_index":1,"reason":"short plain reason"}],"groups":[{"id":"A","picks":[[0,2],[1,0]],"note":"why they are alternatives"}],"recommended":[{"group_id":"A","part_index":0,"pick_index":2,"why":"one short sentence"}],"question":null}`;
}

// Validate the model's review against the real report shape: indices must exist,
// groups need at least two surviving members, the question needs options. Returns
// a clean review object, or null when nothing usable came back.
function sanitizeReview(parsed, report) {
  if (!parsed || typeof parsed !== 'object') return null;
  const parts = report.parts || [];
  const counts = parts.map(p => (p.picks || []).length);
  const validKey = k => Number.isInteger(k?.part_index) && Number.isInteger(k?.pick_index)
    && k.part_index >= 0 && k.part_index < parts.length
    && k.pick_index >= 0 && k.pick_index < counts[k.part_index];

  const removed = (Array.isArray(parsed.removed) ? parsed.removed : [])
    .filter(k => validKey(k) && String(k.reason || '').trim())
    .map(k => ({ part_index: k.part_index, pick_index: k.pick_index, reason: String(k.reason).trim().slice(0, 180) }));
  const removedKeys = new Set(removed.map(r => `${r.part_index}:${r.pick_index}`));

  const groups = [];
  const usedIds = new Set();
  const usedKeys = new Set(); // a pick can only be a substitute in one group at a time
  for (const g of (Array.isArray(parsed.groups) ? parsed.groups : [])) {
    const keys = (Array.isArray(g?.picks) ? g.picks : [])
      .filter(p => Array.isArray(p) && validKey({ part_index: p[0], pick_index: p[1] }))
      .map(p => ({ part_index: p[0], pick_index: p[1] }))
      .filter(k => !removedKeys.has(`${k.part_index}:${k.pick_index}`))
      .filter(k => !usedKeys.has(`${k.part_index}:${k.pick_index}`));
    if (keys.length < 2) continue; // a group of one is not a group
    keys.forEach(k => usedKeys.add(`${k.part_index}:${k.pick_index}`));
    let id = String(g.id || '').trim().slice(0, 2).toUpperCase();
    if (!id || usedIds.has(id)) id = String.fromCharCode(65 + groups.length);
    usedIds.add(id);
    groups.push({ id, picks: keys, note: String(g.note || '').trim().slice(0, 180) });
  }

  const recommended = [];
  for (const g of groups) {
    const rec = (Array.isArray(parsed.recommended) ? parsed.recommended : [])
      .find(r => String(r?.group_id || '').toUpperCase() === g.id
        && validKey({ part_index: r.part_index, pick_index: r.pick_index })
        && g.picks.some(p => p.part_index === r.part_index && p.pick_index === r.pick_index));
    const key = rec || g.picks[0];
    recommended.push({
      group_id: g.id,
      part_index: key.part_index,
      pick_index: key.pick_index,
      why: rec ? String(rec.why || '').trim().slice(0, 180) : '',
    });
  }

  let question = null;
  if (allowQuestion && parsed.question && typeof parsed.question === 'object' && String(parsed.question.question || '').trim()) {
    const options = (Array.isArray(parsed.question.options) ? parsed.question.options : [])
      .map(o => String(o || '').trim()).filter(Boolean).slice(0, 3);
    if (options.length >= 2) {
      question = { question: String(parsed.question.question).trim().slice(0, 300), options };
    }
  }

  if (!removed.length && !groups.length && !question) return null;
  return { removed, groups, recommended, question };
}

/**
 * Quick check over a world-look report, before the plan is drafted.
 * @returns {Promise<{removed, groups, recommended, question}|null>} — null on any
 *   failure or when the model returns nothing usable (full report is then used).
 */
export async function reviewInspiration({ report, prompt, answer = null, allowQuestion = true } = {}) {
  if (!report || !(report.parts || []).length) return null;
  const compact = compactReportForReview(report);
  if (!compact.some(p => (p.picks || []).length)) return null;
  const ideaText = String(prompt || report.idea_text || '').trim() || 'the task';
  try {
    const out = await generateTextByFeature({
      prompt: buildReviewPrompt(ideaText, JSON.stringify(compact), answer, allowQuestion),
      feature: 'inspire',
      maxTokens: 800,
      label: 'inspire-review',
      maxAttempts: 3,
      timeoutMs: 45_000,
      claudeLastResort: true,
    });
    if (out.error) {
      console.error('inspireReview failed —', out.message);
      return null;
    }
    return sanitizeReview(parseJsonObject(out.text), report);
  } catch (e) {
    console.error('inspireReview threw —', e.message);
    return null;
  }
}

export function getReport(db, id) {
  const row = db.prepare(`SELECT * FROM discovery_reports WHERE id=?`).get(id);
  if (!row) return null;
  const parts = row.parts_json
    ? JSON.parse(row.parts_json)
    : [{ name: 'Idea', description: row.idea_text, queries: JSON.parse(row.queries_json || '[]'), picks: JSON.parse(row.picks_json || '[]'), recommended_index: 0 }];
  let review = null;
  try { review = row.review_json ? JSON.parse(row.review_json) : null; } catch {}
  return {
    id: row.id,
    idea_text: row.idea_text,
    source: row.source,
    source_id: row.source_id,
    project_name: row.project_name || row.idea_text.slice(0, 60),
    project_territory: row.project_territory || null,
    parts,
    review,
    created_at: row.created_at,
    rerun_count: row.rerun_count,
  };
}

// Persist the quick check's structural verdict on the report row — the report is
// the canonical home: every surface that shows the report (task panel, sections,
// promote/accept reuse) reads the same review. Transient bits (owner_note) stay
// on the task row; this stores only removed/groups/recommended.
export function storeReportReview(db, reportId, review) {
  if (!db || !reportId || !review) return;
  const structural = {
    removed: review.removed || [],
    groups: review.groups || [],
    recommended: review.recommended || [],
  };
  db.prepare(`UPDATE discovery_reports SET review_json=? WHERE id=?`).run(JSON.stringify(structural), reportId);
}

// Add a custom bold pick to an existing world-look report for a task.
export function addCustomBoldPick(db, { source, source_id, pick } = {}) {
  const report = findReportBySource(db, source, source_id);
  if (!report) return { error: 'no_report', message: 'No world-look report exists for this task yet. Run a world-look first.' };

  const customPartName = 'Custom ideas';
  let customPart = report.parts.find(p => p.name === customPartName);

  const newPick = {
    kind: 'bold',
    name: pick.name,
    vision: pick.vision || '',
    why_possible: pick.why_possible || '',
    how_fmcns: pick.how_fmcns || '',
  };

  if (!customPart) {
    customPart = {
      name: customPartName,
      description: 'Manually added bold ideas',
      queries: [],
      picks: [newPick],
      recommended_index: 0,
    };
    report.parts.push(customPart);
  } else {
    customPart.picks.push(newPick);
  }

  db.prepare(`UPDATE discovery_reports SET parts_json=? WHERE id=?`).run(JSON.stringify(report.parts), report.id);

  return getReport(db, report.id);
}

// Latest world-look report attached to any item (suggestion, seed, component —
// anything that stores its look under a source + item id pair).
export function findReportBySource(db, source, source_id) {
  if (!source || !source_id) return null;
  const row = db.prepare(`SELECT id FROM discovery_reports WHERE source=? AND source_id=? ORDER BY created_at DESC LIMIT 1`).get(source, source_id);
  return row ? getReport(db, row.id) : null;
}

// ─── Shared in-flight guard + background sweeper ─────────────────────────────
// One look per item at a time, anywhere it is triggered from (the section
// panels' routes OR the background sweep) — the GET endpoint reports it, and
// nothing ever double-runs.
const _worldLookRunning = new Set();
export function isWorldLookRunning(source, id) {
  return _worldLookRunning.has(`${source}:${id}`);
}

export async function runWorldLookGuarded(db, { idea_text, source, source_id, forceRefresh = false } = {}) {
  const key = `${source}:${source_id}`;
  if (_worldLookRunning.has(key)) return { running: true };
  _worldLookRunning.add(key);
  try {
    const report = await runInspiration(db, { idea_text, source, source_id, forceRefresh });
    if (report?.error) return report;
    // The quick check runs on every look — sections never ask the owner (no
    // question card exists there): it decides alone and the verdict is stored
    // on the report so every surface shows the filtered ideas.
    let review = null;
    try { review = await reviewInspiration({ report, prompt: idea_text, allowQuestion: false }); }
    catch (e) { console.error('quick check after world-look failed —', e.message); }
    if (review) storeReportReview(db, report.id, review);
    return { ...report, review };
  } finally {
    _worldLookRunning.delete(key);
  }
}

// Background sweep: every suggestion that has no world-look yet gets one,
// sequentially (one at a time keeps GitHub and model traffic gentle). Reports
// persist forever, so each suggestion costs this once and the sweep is
// idempotent across restarts. Never throws. Runs through the same free-model-
// first seam the queue's inspiration pass uses.
export async function autoWorldLookSuggestions(db) {
  const rows = db.prepare(`SELECT id, title, prompt FROM work_suggestions WHERE deleted_at IS NULL AND status='new'`).all();
  let ran = 0, skipped = 0;
  for (const s of rows) {
    if (findReportBySource(db, 'suggestion', s.id) || isWorldLookRunning('suggestion', s.id)) { skipped++; continue; }
    const out = await runWorldLookGuarded(db, {
      idea_text: [s.title, s.prompt].filter(Boolean).join('\n'),
      source: 'suggestion',
      source_id: s.id,
    });
    if (out?.error) console.error(`Auto world-look failed for suggestion ${s.id}: ${out.message || out.error}`);
    else ran++;
  }
  return { ran, skipped };
}

// Same sweep for the Not built list: every unbuilt tech-tree component gets its
// look + quick check in the background (boot + every 6h), so opening the list —
// or any component in it — shows the shelves instantly, like the queue does.
// Built = the same statuses the Not built list treats as done.
const BUILT_NODE_STATUSES = `('Working','Validated','Advanced')`;

export async function autoWorldLookComponents(db) {
  const rows = db.prepare(`SELECT id, name, what, next FROM architecture_nodes WHERE deleted_at IS NULL AND status NOT IN ${BUILT_NODE_STATUSES}`).all();
  let ran = 0, skipped = 0;
  for (const c of rows) {
    if (findReportBySource(db, 'component', c.id) || isWorldLookRunning('component', c.id)) { skipped++; continue; }
    const out = await runWorldLookGuarded(db, {
      idea_text: [c.name, c.what, c.next].filter(Boolean).join('\n'),
      source: 'component',
      source_id: c.id,
    });
    if (out?.error) console.error(`Auto world-look failed for component ${c.id}: ${out.message || out.error}`);
    else ran++;
  }
  return { ran, skipped };
}

// And the same for Seeds — every idea in the notebook gets its look + check
// without any click, so the panel is already ready when the seed is opened.
export async function autoWorldLookIdeas(db) {
  const rows = db.prepare(`SELECT id, title, notes FROM work_ideas WHERE deleted_at IS NULL`).all();
  let ran = 0, skipped = 0;
  for (const i of rows) {
    if (findReportBySource(db, 'idea', i.id) || isWorldLookRunning('idea', i.id)) { skipped++; continue; }
    const out = await runWorldLookGuarded(db, {
      idea_text: [i.title, i.notes].filter(Boolean).join('\n'),
      source: 'idea',
      source_id: i.id,
    });
    if (out?.error) console.error(`Auto world-look failed for seed ${i.id}: ${out.message || out.error}`);
    else ran++;
  }
  return { ran, skipped };
}

export function listReports(db) {
  // The blocks-tab "Past reports" library shows idea-box runs only — automatic
  // per-task inspiration reports (source='prompt') belong to the task detail
  // view, where they are served through the task's inspiration endpoint.
  return db.prepare(`SELECT id, idea_text, source, picks_json, parts_json, created_at FROM discovery_reports WHERE COALESCE(source,'idea_box')='idea_box' ORDER BY created_at DESC`)
    .all()
    .map(r => {
      const parts = r.parts_json ? JSON.parse(r.parts_json) : [{ picks: JSON.parse(r.picks_json || '[]') }];
      return {
        id: r.id, idea_text: r.idea_text, source: r.source, created_at: r.created_at,
        pick_count: parts.reduce((n, p) => n + (p.picks?.length || 0), 0),
      };
    });
}

// Every bold/imagined idea that came out of ANY world-look (queue task, suggestion,
// seed, component, idea box) but was never planted into the tech tree — these are
// the "speculations not yet in the tree" the On the Horizon section surfaces
// alongside real unbuilt architecture_nodes. Excludes picks the quick check
// removed, since those never earned a place in the first place.
export function listUnplantedBoldPicks(db) {
  const planted = new Set(
    db.prepare(`SELECT report_id, part_index, pick_index FROM discovery_pick_plants`).all()
      .map(r => `${r.report_id}:${r.part_index}:${r.pick_index}`)
  );
  const rows = db.prepare(`
    SELECT id, idea_text, source, source_id, project_name, parts_json, review_json
    FROM discovery_reports WHERE parts_json IS NOT NULL ORDER BY created_at DESC
  `).all();
  const out = [];
  for (const row of rows) {
    let parts;
    try { parts = JSON.parse(row.parts_json || '[]'); } catch { continue; }
    let review = null;
    try { review = row.review_json ? JSON.parse(row.review_json) : null; } catch {}
    const removed = new Set((review?.removed || []).map(r => `${r.part_index}:${r.pick_index}`));
    parts.forEach((part, pi) => {
      (part.picks || []).forEach((pick, i) => {
        if (pick.kind !== 'bold' && pick.kind !== 'imagined') return;
        if (planted.has(`${row.id}:${pi}:${i}`)) return;
        if (removed.has(`${pi}:${i}`)) return;
        out.push({
          report_id: row.id,
          part_index: pi,
          pick_index: i,
          source: row.source,
          source_id: row.source_id,
          idea_text: row.project_name || row.idea_text,
          part_name: parts.length > 1 ? (part.name || null) : null,
          name: pick.name || pick.tree_target?.name || 'Bold idea',
          summary: pick.vision || pick.use || pick.why_fits || '',
        });
      });
    });
  }
  return out;
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

  const out = plantPick(db, pick, { target_node_id, report_id, part_index, pick_index });
  return out.error ? out : { node: out.node };
}

function plantPick(db, pick, { target_node_id = null, report_id = null, part_index = null, pick_index = null } = {}) {
  const target = pick.tree_target || {};
  const out = createNode(db, {
    name: target.name || pick.repo || pick.name || 'Discovery pick',
    territory: target.territory,
    what: pick.use || pick.vision || '',
    why: pick.why_fits || pick.how_fmcns || '',
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
  if (report_id && Number.isInteger(part_index) && Number.isInteger(pick_index)) {
    try {
      db.prepare(`
        INSERT OR REPLACE INTO discovery_pick_plants (report_id, part_index, pick_index, node_id)
        VALUES (?,?,?,?)
      `).run(report_id, part_index, pick_index, out.node.id);
    } catch (e) { console.error('discovery_pick_plants insert failed —', e.message); }
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
  report.parts.forEach((part, part_index) => {
    const pickIdx = Number.isInteger(part.recommended_index) && part.picks?.[part.recommended_index] ? part.recommended_index : 0;
    const pick = part.picks?.[pickIdx];
    if (!pick) return;
    const out = plantPick(db, pick, { target_node_id: projectNode.id, report_id, part_index, pick_index: pickIdx });
    if (!out.error) childNodes.push(out.node);
  });

  return { project_node: projectNode, child_nodes: childNodes };
}
