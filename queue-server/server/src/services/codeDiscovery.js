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
import { createNode, fallbackWitness } from './architectureNodes.js';
import { USER_FACING_STYLE } from './ai/style.js';
import { APP_BLURB, TERRITORY_LINES, TERRITORY_IDS, onSubjectRule } from './ai/appModel.js';
import { conciseQuestionPayload } from '../lib/concise.js';

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

// ─── World-look generation ────────────────────────────────────────────────────
// Bumped whenever the world-look prompts change in a way that makes older reports
// worth redoing. Generation 2 is the first that carries the asking task's own words
// and its subject all the way to the point where the ideas are chosen — before it,
// the picks pass only ever saw a 20-word part description, so the ideas drifted to
// whatever part of the app the model found most interesting.
//
// Reports are stamped with the generation that wrote them, and rewriteWorldLooks()
// redoes anything older. Bump this again next time the prompts change materially.
export const WORLD_LOOK_GEN = 2;

// ─── Idea box: decompose -> per-part search/pick AI pipeline ────────────────────

const MAX_PARTS = 4;
// Was a hand-written description of the app that listed the knowledge graph first and
// never said the app also builds itself. Every world-look read it, so every "how would
// FMCNS use this" answer leaned back toward the material even when the task was about
// the app's own build system. Now shared with every other engine — see ai/appModel.js.
const FMCNS_BLURB = APP_BLURB;

function buildDecomposePrompt(ideaText) {
  return `You are helping plan building blocks for ${FMCNS_BLURB}.

The idea: "${String(ideaText).trim()}"

Decide whether this idea is a single atomic building block, or whether it names or implies combining multiple distinct capabilities/repos/approaches (for example: "combine a graph library with a note editor" is two parts; "add a knowledge-graph viewer" is one part).

- If atomic: return exactly ONE part whose description restates the idea.
- If it combines distinct capabilities: return 2-4 parts, one per distinct capability, each independently searchable on GitHub.

Respond with ONLY a JSON object, no prose, no markdown fence:
{"project_name":"short name for the overall idea (only meaningful if more than one part)","project_territory":"one of ${TERRITORY_IDS.join('|')} — 'self' for anything about the app's own build system (the queue, the worker that codes, shipping, the app watching itself, what to build next, proposing work, the idea studio, the look at the world)","parts":[{"name":"short label","description":"one short sentence (max 20 words): what this part must do, specific enough to search GitHub for"}]}`;
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
  // Validated against the real list: plantProject() writes this straight onto a tree
  // node's territory, so an invented value would create a node in an area that does
  // not exist and never show up in any section.
  const projectTerritory = TERRITORY_IDS.includes(parsed0?.project_territory) ? parsed0.project_territory : null;

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
  try { db.prepare(`UPDATE discovery_reports SET rewrite_gen=? WHERE id=?`).run(WORLD_LOOK_GEN, id); } catch { /* older database without the column */ }

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

// Now does THREE jobs, not two. The third — naming which part of the app the idea
// touches — is the one that matters: everything downstream only ever saw a 20-word
// part description, so by the time the ideas were chosen, "in the section flow UI" had
// already been thrown away and the only thing left saying what the app is was the
// general blurb. That is how a task about the Core Architecture section came back with
// Content-navigator recommendations.
function buildInspireDecomposePrompt(ideaText) {
  return `You are helping plan an idea for ${FMCNS_BLURB}.

The idea: "${String(ideaText).trim()}"

Three jobs in one pass:
1. Say which area of the app this idea belongs to, as one of these ids:
${TERRITORY_LINES}
   Read the idea's own words for this — if it names the queue, the flow, the architecture view, the app's own thinking, the ideas or suggestions, its area is "self". Do not guess "knowledge" as a default.
2. Split the idea into 1-3 independently searchable parts IF it combines distinct capabilities (an atomic idea stays exactly ONE part). Each part's description must keep the idea's own subject visible — do not generalise it into something broader that would be easier to search for.
3. For each part, propose 1-2 GitHub repo-search query strings (the kind you would type into GitHub's search box) that would surface real, already-built open-source work relevant to that part. Be realistic about what a query would return.

The description is read by the app's owner, who is not a programmer — plain everyday words, no jargon, no internal component ids.

${USER_FACING_STYLE}

Respond with ONLY a JSON object, no prose, no markdown fence:
{"subject":"one of ${TERRITORY_IDS.join('|')}","subject_note":"one short sentence: what exactly in the app this idea is about","project_name":"short name for the overall idea","parts":[{"name":"short label","description":"one short sentence (max 20 words): what this part must do","queries":[{"q":"github search string","why":"one sentence on what this search is trying to find"}]}]}`;
}

// `taskText` and `subject` were added because this function used to receive ONLY
// `partDescription` — one sentence, max 20 words, produced by the decompose pass. The
// task's own words never reached the point where the ideas were actually chosen, so the
// model filled the gap with the app's general description and answered about the part of
// the app it found most interesting. Both new arguments are the fix.
function buildInspirePicksPrompt(partDescription, resultsByQuery, { taskText = '', subject = '', subjectNote = '' } = {}) {
  const hasLive = resultsByQuery.length > 0;
  const resultsBlock = resultsByQuery.map(({ q, why, results }) => {
    const lines = results.slice(0, 5).map(r => `  - ${r.repo_full_name} (${r.stars}★): ${r.description || '(no description)'}`).join('\n') || '  - (no results)';
    return `Query "${q.q}" (${q.why}):\n${lines}`;
  }).join('\n\n');
  const subjectLabel = [subject, subjectNote].filter(Boolean).join(' — ');
  return `You are the inspiration engine for ${FMCNS_BLURB}. A task is about to be planned into a real feature, and the plan will be written from your answer. Look at the world and produce inspiration on three shelves — with the BOLD shelf as the HEART of your answer.

${taskText ? `THE TASK, IN THE OWNER'S OWN WORDS (this is the subject; everything you answer must serve it):\n"${String(taskText).trim().slice(0, 600)}"\n` : ''}
${subjectLabel ? `The part of the app it is about: ${subjectLabel}\n` : ''}
${onSubjectRule(subjectLabel)}

The part of the idea you are inspiring for: "${String(partDescription).trim()}"

${hasLive ? `What a live GitHub search just returned for this part:\n\n${resultsBlock}\n\n` : 'No live GitHub results were available for this part — still produce shelves 2 and 3 at full strength.\n\n'}

SHELF 1 — "open": real open-source projects worth taking ideas from, chosen from the live results above. If the live results contain relevant repos, you MUST include an open pick for each relevant one (up to 3) — never return zero open picks when relevant repos exist.${hasLive ? '' : ' (no live results available, so produce zero open picks)'}. Fields: repo, stars, why_fits, use.
SHELF 2 — "hidden": things that exist in the world but whose code is not public — products or features inside companies, from your general knowledge. You cannot link them; give the name, what it does, what we can learn from it, and what FMCNS could do even better. Fields: name, what, lesson, use.
SHELF 3 — "bold" (the heart): ideas that may not exist anywhere yet. First understand the deep nature of the technologies involved in this idea and where they are heading. Then imagine the boldest PLAUSIBLE version of this idea — 2 to 3 bold ideas. Be innovative. Be visionary. Dare. Do not water them down. Each: name, vision (1-2 punchy short sentences), why_possible (why this is achievable with today's or near-future technology), how_fmcns (how FMCNS could be the first to build it).

Produce 2-3 open picks, 1-2 hidden picks, and 2-3 bold picks. Set recommended_index to the single pick that gives the best mix of boldness and feasibility — prefer a bold pick when it is strong.

Bold does NOT mean off-subject. A visionary idea about a different part of the app is useless here: the plan for THIS task gets written from your answer, so an idea it cannot act on is a wasted shelf. Be bold about the subject you were given.

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

  // What the model calls below actually get. This pass's job is to work out what the work
  // is ABOUT and search for related code — it needs the subject, not the implementation
  // detail. So the text handed to the models is capped here, while `ideaText` stays whole
  // for storage and display (discovery_reports.idea_text, the rewrite sweep, the UI).
  //
  // Without the cap this function resent the ENTIRE task text five times per run — once
  // to decompose, then once per part (INSPIRE_MAX_PARTS = 3) inside the picks prompt —
  // each with up to 3 attempts. Harmless while every task was a couple of hundred
  // characters, which was true until whole plans started arriving from a terminal session
  // (scripts/send-plan.js): an 11,700-character plan turned one world-look into a dozen
  // long-prompt calls and left it grinding at 'pending' for many minutes. Credit
  // discipline is a hard rule in this repo, not a preference — see CLAUDE.md.
  //
  // A plan states its subject at the top (title, then Context), so the head of the text
  // is the part worth reading. Cut on a newline so it does not end mid-word.
  const LOOK_MAX_CHARS = 1_500;
  let lookText = ideaText;
  if (lookText.length > LOOK_MAX_CHARS) {
    const cutHead = lookText.slice(0, LOOK_MAX_CHARS);
    const nl = cutHead.lastIndexOf('\n');
    lookText = (nl > LOOK_MAX_CHARS * 0.5 ? cutHead.slice(0, nl) : cutHead)
      + "\n\n[…the rest of this task's text is not shown here — this pass only needs to know what the work is about.]";
  }

  const pass0 = await generateTextByFeature({ prompt: buildInspireDecomposePrompt(lookText), feature: 'inspire', maxTokens: 700, label: 'inspire-decompose', maxAttempts: 3, timeoutMs: 45_000, claudeLastResort: true });
  if (pass0.error) return { error: pass0.error, message: pass0.message };
  const parsed0 = parseJsonObject(pass0.text);
  const rawParts = (parsed0?.parts || []).filter(p => p && p.description).slice(0, INSPIRE_MAX_PARTS);
  const parts = rawParts.length ? rawParts : [{ name: parsed0?.project_name || 'Idea', description: lookText, queries: [] }];
  const projectName = parsed0?.project_name || ideaText.slice(0, 60);
  // Which part of the app this look is FOR. Only accepted if it is a real area id, so a
  // hallucinated value degrades to "no subject named" rather than to a wrong subject —
  // and the picks pass still gets the task's own words either way.
  const subject = TERRITORY_IDS.includes(parsed0?.subject) ? parsed0.subject : '';
  const subjectNote = String(parsed0?.subject_note || '').trim().slice(0, 200);

  const builtParts = [];
  for (const part of parts) {
    const partDescription = String(part.description || lookText).trim();
    const queries = (part.queries || []).filter(q => q && q.q).slice(0, 2);
    const resultsByQuery = [];
    for (const q of queries) {
      const qId = queryHash(q.q);
      const out = await getResults(db, qId, q.q, { forceRefresh });
      if (!out.error) resultsByQuery.push({ q, why: q.why, results: out.results || [] });
    }
    const pass2 = await generateTextByFeature({ prompt: buildInspirePicksPrompt(partDescription, resultsByQuery, { taskText: lookText, subject, subjectNote }), feature: 'inspire', maxTokens: 1600, label: 'inspire-picks', maxAttempts: 3, timeoutMs: 45_000, claudeLastResort: true });
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
  // project_territory is the same column the idea box already fills with an idea's area;
  // the inspiration path used to write null into it. It now carries the task's subject, so
  // the quick-check editor and any later rewrite know what this report was about without
  // re-deriving it. No migration needed.
  db.prepare(`
    INSERT INTO discovery_reports (id, idea_text, source, source_id, queries_json, picks_json, project_name, project_territory, parts_json)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(id, ideaText, source, source_id, JSON.stringify(builtParts[0].queries || []), JSON.stringify(builtParts[0].picks || []), projectName, subject || null, JSON.stringify(builtParts));
  try { db.prepare(`UPDATE discovery_reports SET rewrite_gen=? WHERE id=?`).run(WORLD_LOOK_GEN, id); } catch { /* older database without the column */ }

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
  const fmt = {
    open: p => `- ${p.repo || '?'} (${p.stars || 0}★): ${p.why_fits || ''} Use: ${p.use || ''}`,
    hidden: p => `- ${p.name || '?'}: ${p.what || ''} Lesson: ${p.lesson || ''} For FMCNS: ${p.use || ''}`,
    bold: p => `- ${p.name || '?'}: ${p.vision || ''} Possible because: ${p.why_possible || ''} For FMCNS: ${p.how_fmcns || ''}`,
  };
  // Two separate jobs, and only one of them gets capped.
  //   chosen  — what the owner actually ticked. Never pooled, never capped, never
  //             trimmed: the caps used to be applied across the whole report, so a
  //             third ticked open-source project (one per part of a 3-part task,
  //             which is the normal case) was silently dropped before the agent
  //             ever saw it. "The owner's picks always win" has to be literal.
  //   context — the survivors nobody ticked, riding along as background. This is
  //             what the caps were for (cost control), so they stay exactly as
  //             they were: 2 open / 2 hidden / 3 bold across the report.
  // A chosen pick is never dropped, but one line is still bounded — a corrupt or
  // freakishly long field should not be able to blow up the prompt on its own.
  // The cut is far beyond anything the model writes (a sentence or two per field)
  // and keeps the head of the line, so the repo/product name always survives.
  const CHOSEN_LINE_MAX = 1200;
  const boundLine = (l) => (l.length > CHOSEN_LINE_MAX ? l.slice(0, CHOSEN_LINE_MAX).replace(/\s\S*$/, '') + '…' : l);
  const chosenByPart = new Map();
  const byShelf = { open: [], hidden: [], bold: [] };
  parts.forEach((part, pi) => {
    (part.picks || []).forEach((pick, i) => {
      if (!fmt[pick.kind]) return;
      const key = `${pi}:${i}`;
      if (chosen.has(key)) {
        if (!chosenByPart.has(pi)) chosenByPart.set(pi, { name: part.name || '', lines: [] });
        chosenByPart.get(pi).lines.push(boundLine(fmt[pick.kind](pick)));
        return;
      }
      // Survives as context when the review did not remove it and it is either
      // ungrouped or its group's recommended pick.
      if (removed.has(key) || (groupMembers.has(key) && !groupBest.has(key))) return;
      byShelf[pick.kind].push(pick);
    });
  });
  const caps = { open: 2, hidden: 2, bold: 3 };
  const chosenLines = [];
  if (chosenByPart.size) {
    chosenLines.push('CHOSEN BY THE OWNER — build with these:');
    for (const [pi, entry] of [...chosenByPart.entries()].sort((a, b) => a[0] - b[0])) {
      // Which part an idea belongs to only matters when there is more than one —
      // otherwise the heading is noise.
      if (parts.length > 1) chosenLines.push(`PART ${pi + 1}${entry.name ? ' — ' + entry.name : ''}:`);
      chosenLines.push(...entry.lines);
    }
  }
  const contextLines = [];
  for (const shelf of ['bold', 'open', 'hidden']) {
    const items = byShelf[shelf].slice(0, caps[shelf]);
    if (!items.length) continue;
    contextLines.push(shelf === 'bold'
      ? 'SHELF 3 — BOLD IDEAS (may not exist anywhere yet — design targets, not dependencies)'
      : shelf === 'open'
        ? 'SHELF 1 — OPEN SOURCE (real, verifiable projects)'
        : 'SHELF 2 — CLOSED PRODUCTS (exist in the world, code not public — match or beat them)');
    contextLines.push(...items.map(fmt[shelf]));
  }
  if (contextLines.length && chosenLines.length) contextLines.unshift('ALSO FOUND — context, not instructions:');
  // The ceiling drops whole context lines off the end rather than slicing
  // mid-sentence, and never touches a chosen line. A handful of ticked ideas is
  // small next to the draft response it feeds, so carrying them all is cheap —
  // far cheaper than an agent building the wrong thing because a pick vanished.
  const LIMIT = 4000;
  const chosenText = chosenLines.join('\n');
  const kept = [...contextLines];
  while (kept.length && [chosenText, kept.join('\n')].filter(Boolean).join('\n\n').length > LIMIT) kept.pop();
  return [chosenText, kept.join('\n')].filter(Boolean).join('\n\n');
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

function buildReviewPrompt(ideaText, reportJson, answer, allowQuestion, subject = '') {
  const subjectBlock = subject
    ? ` The world-look recorded this task's subject as: ${subject}.`
    : '';
  const answerBlock = answer
    ? `THE OWNER ALREADY ANSWERED A QUESTION ABOUT THESE IDEAS: "${String(answer).trim()}". Take it as their decision — incorporate it into your removals/recommendations, and do NOT ask any new question.`
    : '';
  const questionRule = allowQuestion
    ? `4. QUESTION: only if there is a real fork the owner must choose — two genuinely different directions for the task, or a bold idea that would make the task much bigger than asked. Then write ONE question with 2-3 short options. It is shown to him as a single short line with the options as buttons: 15 words or fewer, ending in a question mark, no preamble and no background; each option 8 words or fewer. Otherwise "question": null. When in doubt, decide alone.`
    : `4. QUESTION: do NOT ask any question this time — decide alone. "question": null always.`;
  return `You are the quick-check editor for ${FMCNS_BLURB}. A world-look just returned inspiration ideas for one task, and the task's plan will be written from what survives your check. Keep the report lean and honest: remove what does not earn its place, flag alternatives, and pick the best of each family.

The task: "${String(ideaText).trim()}"

The world-look report (parts with picks; every pick carries its part_index and pick_index):
${reportJson}

${answerBlock}

Do:
1. REMOVE picks that do not serve THIS task: off-topic, duplicates of another pick, or ideas that would blow the task up beyond one job. One short reason each (max 20 words), plain everyday words.
1b. OFF-SUBJECT IS OFF-TOPIC, and it is the most common failure here. A pick that improves a different part of the app than the task names must be removed even when it is a genuinely good idea — the plan for THIS task is written from what survives, so a good idea about the wrong part of the app just makes the plan wrong. Read the task's own words for what part of the app it is about, and hold every pick to it.${subjectBlock}
2. GROUP picks that are alternatives of each other — they would build the same thing, the owner only needs one. Do NOT group picks just because they are related or would work well together: if two picks could both be built and used at the same time without conflict, they are complementary, not alternatives — leave them ungrouped. Only group when picking one makes the other redundant. Give each group a short id ("A", "B"...) and a one-sentence note on why they are the same thing in different wrapping. A group of one is not a group.
3. RECOMMEND, for each group, the single best pick, with one short sentence why.
3b. FIT: score EVERY pick you did not remove from 0 to 100 for how well it serves THIS task — 100 means squarely what the task needs, 50 means useful but a stretch, under 30 means barely related. Use the whole range and be honest; most reports should not be all high. Score is a number only, no text.
${questionRule}

${USER_FACING_STYLE}

Respond with ONLY a JSON object, no prose, no markdown fence:
{"removed":[{"part_index":0,"pick_index":1,"reason":"short plain reason"}],"fit":[{"part_index":0,"pick_index":0,"score":85}],"groups":[{"id":"A","picks":[[0,2],[1,0]],"note":"why they are alternatives"}],"recommended":[{"group_id":"A","part_index":0,"pick_index":2,"why":"one short sentence"}],"question":null}`;
}

// Validate the model's review against the real report shape: indices must exist,
// groups need at least two surviving members, the question needs options. Returns
// a clean review object, or null when nothing usable came back.
function sanitizeReview(parsed, report, allowQuestion = true) {
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

  // How well each surviving pick fits, 0-100. Drives the colour of a row's left
  // bar in the UI — green squarely-relevant through amber to red barely-related.
  // Removed picks get no score: they already carry the quick check's reason.
  const fit = (Array.isArray(parsed.fit) ? parsed.fit : [])
    .filter(k => validKey(k) && Number.isFinite(Number(k.score)))
    .filter(k => !removedKeys.has(`${k.part_index}:${k.pick_index}`))
    .map(k => ({ part_index: k.part_index, pick_index: k.pick_index, score: Math.max(0, Math.min(100, Math.round(Number(k.score)))) }));

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
      question = conciseQuestionPayload({ question: String(parsed.question.question).trim(), options })
        || { question: String(parsed.question.question).trim().slice(0, 200), options };
    }
  }

  if (!removed.length && !groups.length && !question && !fit.length) return null;
  return { removed, fit, groups, recommended, question };
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
      prompt: buildReviewPrompt(ideaText, JSON.stringify(compact), answer, allowQuestion, report.project_territory || ''),
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
    return sanitizeReview(parseJsonObject(out.text), report, allowQuestion);
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

// ─── Writing back into a report ────────────────────────────────────────
// A pick has NO id: it is addressed by its position — (part_index, pick_index) —
// and those positions are referenced from work_prompts.inspire_picks_json, the
// report's own review_json (removed / groups / recommended) and the
// discovery_pick_plants table. So everything below only ever EDITS A PICK IN
// PLACE or APPENDS to the end of a part. Nothing here reorders or deletes: that
// would silently re-point every stored reference at a different idea.

// The text fields that belong to each kind of pick — the same contract the
// generator's prompt states (buildInspirePicksPrompt). Anything outside this
// list is ignored on the way in, so a model reply can't smuggle fields in.
const PICK_FIELDS = {
  open: ['repo', 'why_fits', 'use'],
  hidden: ['name', 'what', 'lesson', 'use'],
  bold: ['name', 'vision', 'why_possible', 'how_fmcns'],
};

function saveParts(db, reportId, parts) {
  db.prepare(`UPDATE discovery_reports SET parts_json=? WHERE id=?`).run(JSON.stringify(parts), reportId);
}

function pickTitleField(kind) {
  return kind === 'open' ? 'repo' : 'name';
}

// One incoming pick -> a stored pick, with only the fields its kind allows.
// Returns null when it has no title, which is the one field a row cannot render
// without.
function sanitizePick(raw, from = null) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = ['open', 'hidden', 'bold'].includes(raw.kind) ? raw.kind : 'bold';
  const out = { kind };
  for (const f of PICK_FIELDS[kind]) {
    const v = raw[f];
    if (v !== undefined && v !== null && String(v).trim()) out[f] = String(v).trim().slice(0, 2000);
  }
  if (!out[pickTitleField(kind)]) return null;
  if (kind === 'open' && Number.isFinite(Number(raw.stars))) out.stars = Number(raw.stars);
  if (from) out.from_convo = from;
  return out;
}

/**
 * Append picks to a report. Append-only, therefore index-safe: every existing
 * (part_index, pick_index) still points at the same idea afterwards.
 *
 * Give either `partIndex` (append into that part) or `partName` (find it, or
 * create it at the end). New picks land as loose rows, because review_json does
 * not mention them — the same behaviour a hand-added idea already has.
 */
export function appendPicks(db, { reportId, partIndex = null, partName = null, partDescription = '', picks = [], from = null } = {}) {
  const report = getReport(db, reportId);
  if (!report) return { error: 'no_report', message: 'That world-look report no longer exists.' };
  const clean = (Array.isArray(picks) ? picks : []).map((p) => sanitizePick(p, from)).filter(Boolean);
  if (!clean.length) return { error: 'empty', message: 'No usable idea in that reply.' };

  let part = Number.isInteger(partIndex) ? report.parts[partIndex] : null;
  if (!part && partName) {
    part = report.parts.find((p) => p.name === partName);
    if (!part) {
      part = { name: partName, description: partDescription, queries: [], picks: [], recommended_index: 0 };
      report.parts.push(part);
    }
  }
  if (!part) return { error: 'no_part', message: 'That part of the world-look no longer exists.' };

  part.picks = Array.isArray(part.picks) ? part.picks : [];
  part.picks.push(...clean);
  saveParts(db, reportId, report.parts);
  return getReport(db, reportId);
}

/**
 * Rewrite one pick's text where it stands — the "fold the conversation into this
 * idea" write. The pick keeps its kind and its position; `original` is stamped
 * ONCE so a second fold still shows what the idea looked like before any
 * conversation touched it. review_json is deliberately left alone.
 */
export function updatePickInPlace(db, { reportId, partIndex, pickIndex, fields = {}, convoId = null } = {}) {
  const report = getReport(db, reportId);
  if (!report) return { error: 'no_report', message: 'That world-look report no longer exists.' };
  const part = report.parts?.[Number(partIndex)];
  const pick = part?.picks?.[Number(pickIndex)];
  if (!pick) return { error: 'no_pick', message: 'That idea is no longer in the report.' };

  const allowed = PICK_FIELDS[pick.kind] || PICK_FIELDS.bold;
  const next = {};
  for (const f of allowed) {
    const v = fields[f];
    if (v !== undefined && v !== null && String(v).trim()) next[f] = String(v).trim().slice(0, 2000);
  }
  if (!Object.keys(next).length) return { error: 'empty', message: 'Nothing to fold in — the reply had no usable text.' };

  if (!pick.original) {
    const snap = {};
    for (const f of allowed) if (pick[f] !== undefined) snap[f] = pick[f];
    pick.original = snap;
  }
  Object.assign(pick, next);
  pick.developed_at = new Date().toISOString();
  if (convoId) pick.developed_by_convo = convoId;

  saveParts(db, reportId, report.parts);
  return getReport(db, reportId);
}

/**
 * Rewrite the question above the ideas — a part's name and description — when a
 * conversation shows we were answering the wrong one. No pick is touched, so
 * nothing moves. The first framing is kept as `original_description`.
 */
export function updatePartFraming(db, { reportId, partIndex, name = null, description = null, convoId = null } = {}) {
  const report = getReport(db, reportId);
  if (!report) return { error: 'no_report', message: 'That world-look report no longer exists.' };
  const part = report.parts?.[Number(partIndex)];
  if (!part) return { error: 'no_part', message: 'That part of the world-look no longer exists.' };
  if (!String(name || '').trim() && !String(description || '').trim()) {
    return { error: 'empty', message: 'Nothing to change — the reply had no usable text.' };
  }
  if (part.original_description === undefined) {
    part.original_name = part.name || '';
    part.original_description = part.description || '';
  }
  if (String(name || '').trim()) part.name = String(name).trim().slice(0, 200);
  if (String(description || '').trim()) part.description = String(description).trim().slice(0, 2000);
  part.reframed_at = new Date().toISOString();
  if (convoId) part.reframed_by_convo = convoId;

  saveParts(db, reportId, report.parts);
  return getReport(db, reportId);
}

/**
 * Take back the ideas a conversation added — the undo for "more ideas from here".
 *
 * Removing a pick normally shifts every position after it, which would re-point
 * stored references (inspire_picks_json, review_json, discovery_pick_plants) at
 * the wrong idea. So this only removes conversation-born picks sitting at the END
 * of a part, and refuses outright if any of them has an ordinary idea after it.
 * That keeps every surviving position exactly where it was.
 */
export function removeConvoPicks(db, { reportId, partIndex = null, convoId = null } = {}) {
  const report = getReport(db, reportId);
  if (!report) return { error: 'no_report', message: 'That world-look report no longer exists.' };
  const targets = Number.isInteger(partIndex) ? [partIndex] : report.parts.map((_, i) => i);
  let removed = 0;
  for (const pi of targets) {
    const part = report.parts[pi];
    if (!part || !Array.isArray(part.picks)) continue;
    const isConvoBorn = (p) => !!p.from_convo && (!convoId || p.from_convo === convoId);
    // Walk back from the end; stop at the first idea that did not come from a
    // conversation, so nothing in front of it can move.
    let cut = part.picks.length;
    while (cut > 0 && isConvoBorn(part.picks[cut - 1])) cut--;
    const strandedInside = part.picks.slice(0, cut).some(isConvoBorn);
    if (strandedInside) {
      return { error: 'would_shift', message: 'Some of those ideas have ordinary ideas after them — removing them would renumber the list, so nothing was touched.' };
    }
    if (cut < part.picks.length) {
      removed += part.picks.length - cut;
      part.picks = part.picks.slice(0, cut);
    }
  }
  if (!removed) return { error: 'none', message: 'There are no conversation-born ideas to take back here.' };
  saveParts(db, reportId, report.parts);
  return { report: getReport(db, reportId), removed };
}

// ─── Swapping ONE idea for a fresh one ────────────────────────────────────────
// "New ideas" redoes a whole report: every idea in the box is thrown away and
// the box comes back different, which is a heavy hammer when only one row is
// weak. This swaps a SINGLE idea where it stands — same part, same position,
// same kind of idea (open source / private / bold) — and leaves every other row
// exactly as it was.
//
// Position-safe by construction (it edits in place, like updatePickInPlace), but
// a position is also referenced from outside the report: applied picks on a task,
// planted tech-tree nodes, and conversations about that one idea. Replacing the
// text under any of those would silently re-point them at a different idea, so
// the guards below refuse the swap instead, with a reason a person can read.

function pickKeyRefusal(db, reportId, partIndex, pickIndex) {
  try {
    const planted = db.prepare(
      `SELECT 1 FROM discovery_pick_plants WHERE report_id=? AND part_index=? AND pick_index=? LIMIT 1`
    ).get(reportId, partIndex, pickIndex);
    if (planted) {
      return { error: 'planted', message: 'This idea is already in the tech tree — swapping it would leave the tree pointing at something else.' };
    }
  } catch { /* table missing on an older database — nothing planted */ }
  try {
    const convo = db.prepare(
      `SELECT 1 FROM convos WHERE subject_type='world_pick' AND deleted_at IS NULL AND subject_id=? LIMIT 1`
    ).get(`${reportId}~${partIndex}:${pickIndex}`);
    if (convo) {
      return { error: 'in_conversation', message: 'You already talked about this idea — swapping it would leave that conversation about something else.' };
    }
  } catch { /* no convos table — nothing to protect */ }
  try {
    const rows = db.prepare(
      `SELECT inspire_picks_json FROM work_prompts WHERE inspire_report_id=? AND inspire_picks_json IS NOT NULL`
    ).all(reportId);
    for (const r of rows) {
      let applied = [];
      try { applied = JSON.parse(r.inspire_picks_json || '[]'); } catch { applied = []; }
      if ((applied || []).some(k => Number(k?.part_index) === partIndex && Number(k?.pick_index) === pickIndex)) {
        return { error: 'applied', message: 'This idea is already baked into a plan — swapping it would change what that plan was built from.' };
      }
    }
  } catch { /* no work_prompts column on an older database — nothing applied */ }
  return null;
}

// The quick check's verdict is stored by position (removed / groups / recommended),
// so after a swap its opinion belongs to an idea that is gone. Drop just that
// position rather than leaving "the quick check wasn't sure" hanging on a brand-new
// idea. A group that falls below two members stops being a choice, and a group whose
// recommended member was the swapped one gets its recommendation moved to a survivor
// — the same shape sanitizeReview guarantees.
function reviewWithoutPick(review, partIndex, pickIndex) {
  if (!review || typeof review !== 'object') return null;
  const same = (k) => Number(k?.part_index) === partIndex && Number(k?.pick_index) === pickIndex;
  const removed = (review.removed || []).filter(k => !same(k));
  const groups = (review.groups || [])
    .map(g => ({ ...g, picks: (g.picks || []).filter(k => !same(k)) }))
    .filter(g => g.picks.length >= 2);
  const recommended = groups.map(g => {
    const kept = (review.recommended || []).find(r =>
      String(r?.group_id) === String(g.id) && !same(r) &&
      g.picks.some(p => Number(p.part_index) === Number(r.part_index) && Number(p.pick_index) === Number(r.pick_index)));
    return kept || { group_id: g.id, part_index: g.picks[0].part_index, pick_index: g.picks[0].pick_index, why: '' };
  });
  return { ...review, removed, groups, recommended };
}

// Forget the quick check's opinion of one position, everywhere it is stored: on the
// report itself, and on any task whose own copy of the review points at this report.
function forgetReviewForPick(db, reportId, partIndex, pickIndex) {
  try {
    const row = db.prepare(`SELECT review_json FROM discovery_reports WHERE id=?`).get(reportId);
    if (row?.review_json) {
      const next = reviewWithoutPick(JSON.parse(row.review_json), partIndex, pickIndex);
      db.prepare(`UPDATE discovery_reports SET review_json=? WHERE id=?`).run(JSON.stringify(next), reportId);
    }
  } catch (e) { console.error('forgetReviewForPick (report) —', e.message); }
  try {
    const rows = db.prepare(
      `SELECT id, inspire_review_json FROM work_prompts WHERE inspire_report_id=? AND inspire_review_json IS NOT NULL`
    ).all(reportId);
    for (const r of rows) {
      const next = reviewWithoutPick(JSON.parse(r.inspire_review_json), partIndex, pickIndex);
      if (next) db.prepare(`UPDATE work_prompts SET inspire_review_json=? WHERE id=?`).run(JSON.stringify(next), r.id);
    }
  } catch (e) { console.error('forgetReviewForPick (task) —', e.message); }
}

const SWAP_SHELF = {
  open: {
    label: 'a real open-source project',
    fields: 'repo (owner/name, copied exactly from the list below), stars, why_fits, use',
    shape: '{"pick":{"kind":"open","repo":"owner/name","stars":0,"why_fits":"one short sentence","use":"one short sentence on how FMCNS would use it"}}',
  },
  hidden: {
    label: 'something that exists in the world but whose code is not public — a product or a feature inside a company, from your general knowledge',
    fields: 'name, what, lesson, use',
    shape: '{"pick":{"kind":"hidden","name":"product or company","what":"what it does, one short sentence","lesson":"what we can learn, one short sentence","use":"what FMCNS could do even better, one short sentence"}}',
  },
  bold: {
    label: 'a bold idea that may not exist anywhere yet — understand where these technologies are heading and imagine the boldest PLAUSIBLE version. Be visionary. Dare. Do not water it down',
    fields: 'name, vision, why_possible, how_fmcns',
    shape: '{"pick":{"kind":"bold","name":"short idea name","vision":"1-2 punchy short sentences","why_possible":"one short sentence","how_fmcns":"one short sentence"}}',
  },
};

function buildSwapPickPrompt({ kind, ideaText, partDescription, subject, subjectNote, keepAway, replacing, repoBlock }) {
  const shelf = SWAP_SHELF[kind] || SWAP_SHELF.bold;
  const subjectLabel = [subject, subjectNote].filter(Boolean).join(' — ');
  return `You are the inspiration engine for ${FMCNS_BLURB}. A list of ideas for one task already exists and the owner wants ONE of them replaced — the one below did not earn its place. Give exactly ONE fresh idea to stand in for it. Everything else in the list stays, so your idea must not repeat any of them.

${ideaText ? `THE TASK, IN THE OWNER'S OWN WORDS (this is the subject; everything you answer must serve it):\n"${String(ideaText).trim().slice(0, 600)}"\n` : ''}
${subjectLabel ? `The part of the app it is about: ${subjectLabel}\n` : ''}
${onSubjectRule(subjectLabel)}

The part of the idea you are inspiring for: "${String(partDescription).trim()}"

THE IDEA BEING REPLACED (do not return it again, and do not return a rewording of it):
${replacing}

ALREADY IN THE LIST — every one of these is off limits, including close variations:
${keepAway || '(nothing else yet)'}

${repoBlock || ''}Your one idea must be ${shelf.label}. Fields: ${shelf.fields}.

It must be genuinely different from what is already there — a different angle, not the same thought in new words. Bold does NOT mean off-subject: an idea about a different part of the app is useless here.

Every text field must be ONE short sentence, maximum 20 words. Never write paragraphs.

${USER_FACING_STYLE}

Respond with ONLY a JSON object, no prose, no markdown fence:
${shelf.shape}`;
}

// One line per pick, for the "already in the list" block — enough for the model to
// recognise an idea and avoid it, without resending the whole report.
function pickOneLine(pick) {
  const title = pick.repo || pick.name || 'idea';
  const gist = pick.why_fits || pick.what || pick.vision || pick.use || '';
  return `- ${title}${gist ? ` — ${String(gist).slice(0, 140)}` : ''}`;
}

/**
 * Replace ONE idea with a fresh one, in place. One model call (plus cached GitHub
 * lookups for an open-source row), against the same part and the same shelf, told
 * to avoid every idea already in the list.
 *
 * @returns the fresh report, or {error, message} — never throws.
 */
export async function swapOnePick(db, { reportId, partIndex, pickIndex } = {}) {
  const pi = Number(partIndex);
  const ii = Number(pickIndex);
  if (!Number.isInteger(pi) || !Number.isInteger(ii)) return { error: 'bad_index', message: 'That idea could not be found.' };

  const report = getReport(db, reportId);
  if (!report) return { error: 'no_report', message: 'That world-look report no longer exists.' };
  const part = report.parts?.[pi];
  const pick = part?.picks?.[ii];
  if (!pick) return { error: 'no_pick', message: 'That idea is no longer in the report.' };

  const refusal = pickKeyRefusal(db, reportId, pi, ii);
  if (refusal) return refusal;

  const kind = ['open', 'hidden', 'bold'].includes(pick.kind) ? pick.kind : 'bold';
  const partDescription = String(part.description || report.idea_text || '').trim();
  const others = (part.picks || []).filter((_, i) => i !== ii);
  const keepAway = others.map(pickOneLine).join('\n');

  // Open-source rows are only ever as good as the live search behind them, so a
  // swap picks a DIFFERENT real repo out of the same (day-cached, therefore free)
  // results — never a repo the model invented.
  let repoBlock = '';
  let allowedRepos = null;
  if (kind === 'open') {
    const taken = new Set((part.picks || []).map(p => String(p.repo || '').toLowerCase()).filter(Boolean));
    const seen = new Set();
    const candidates = [];
    for (const q of (part.queries || []).slice(0, 2)) {
      if (!q?.q) continue;
      const out = await getResults(db, queryHash(q.q), q.q);
      if (out.error) continue;
      for (const r of (out.results || [])) {
        const name = String(r.repo_full_name || '');
        const low = name.toLowerCase();
        if (!name || taken.has(low) || seen.has(low)) continue;
        seen.add(low);
        candidates.push(`  - ${name} (${r.stars}★): ${r.description || '(no description)'}`);
      }
    }
    if (!candidates.length) {
      return { error: 'no_other_repo', message: 'The search found no other real project for this part — every one it returned is already in the list.' };
    }
    allowedRepos = seen;
    repoBlock = `Real projects a live GitHub search returned for this part, with the ones already in the list taken out. Choose ONE of these and nothing else:\n${candidates.slice(0, 12).join('\n')}\n\n`;
  }

  const out = await generateTextByFeature({
    prompt: buildSwapPickPrompt({
      kind,
      ideaText: report.idea_text,
      partDescription,
      subject: report.project_territory || '',
      subjectNote: '',
      keepAway,
      replacing: pickOneLine(pick),
      repoBlock,
    }),
    feature: 'inspire',
    maxTokens: 500,
    label: 'inspire-swap-pick',
    maxAttempts: 3,
    timeoutMs: 35_000,
    claudeLastResort: true,
  });
  if (out.error) return { error: out.error, message: out.message || 'The swap did not come back with anything usable.' };

  const parsed = parseJsonObject(out.text);
  const fresh = sanitizePick({ ...(parsed?.pick || parsed || {}), kind });
  if (!fresh) return { error: 'unparseable', message: 'The swap did not come back with a usable idea — try it again.' };
  // An open-source row promises a link that works. If the model named a repo that
  // was not in the live results, it made it up — refuse rather than ship a dead link.
  if (allowedRepos && !allowedRepos.has(String(fresh.repo || '').toLowerCase())) {
    return { error: 'invented_repo', message: 'The swap named a project the search never returned — try it again.' };
  }

  // Same position, same kind, brand-new text. Anything the old idea carried about
  // its own history goes with it: `original` described text that is gone, and a
  // swapped row was never developed out of a conversation.
  const live = getReport(db, reportId);
  const target = live?.parts?.[pi]?.picks?.[ii];
  if (!target) return { error: 'no_pick', message: 'That idea is no longer in the report.' };
  for (const f of ['repo', 'stars', ...PICK_FIELDS[kind], 'original', 'developed_at', 'developed_by_convo', 'from_convo']) delete target[f];
  Object.assign(target, fresh);
  target.swapped_at = new Date().toISOString();
  saveParts(db, reportId, live.parts);
  forgetReviewForPick(db, reportId, pi, ii);
  return getReport(db, reportId);
}

// Has anyone brainstormed this report — a conversation about one of its ideas, a
// pick folded from a conversation, a reframed part? The rewrite sweep replaces a
// report wholesale, and a conversation is the most expensive thing in it, so a
// brainstormed report is protected from the sweep (see staleWorldLooks).
export function reportIsBrainstormed(db, reportId) {
  try {
    const c = db.prepare(
      `SELECT 1 FROM convos WHERE subject_type='world_pick' AND deleted_at IS NULL AND subject_id LIKE ? LIMIT 1`
    ).get(`${reportId}~%`);
    if (c) return true;
  } catch { /* convos table missing on an older DB — fall through */ }
  try {
    const row = db.prepare(`SELECT parts_json FROM discovery_reports WHERE id=?`).get(reportId);
    if (row?.parts_json && /"(developed_at|from_convo|reframed_at)":/.test(row.parts_json)) return true;
  } catch { /* unreadable — treat as not brainstormed */ }
  return false;
}

// Add a custom bold pick to an existing world-look report for a task. Thin
// wrapper over appendPicks now, so there is one append path and not two.
export function addCustomBoldPick(db, { source, source_id, pick } = {}) {
  const report = findReportBySource(db, source, source_id);
  if (!report) return { error: 'no_report', message: 'No world-look report exists for this task yet. Run a world-look first.' };
  return appendPicks(db, {
    reportId: report.id,
    partName: 'Custom ideas',
    partDescription: 'Manually added bold ideas',
    picks: [{ kind: 'bold', ...pick }],
  });
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

// ─── Rewriting the world-looks that already exist ─────────────────────────────
// The prompt fixes above only change looks taken FROM NOW ON. Every report already
// in the database was written by the old prompts — the ones that never saw the asking
// task's own words at the point the ideas were chosen — so the shelves Antoine reads
// today on existing tasks, suggestions, components and seeds are still the drifting
// ones. This redoes them in place.
//
// Four rules, each one there for a reason:
//   · It only redoes the LATEST report per item, because that is the only one any
//     screen shows.
//   · It skips owners where the ideas can no longer be acted on (a finished or deleted
//     task, a dismissed suggestion, a piece already built) — those cost model calls and
//     change nothing anyone will read.
//   · It stamps each redone report with WORLD_LOOK_GEN, so a run that is interrupted
//     resumes instead of starting over, and running it twice is free.
//   · It clears the owner's applied picks, because picks are stored as positions in the
//     report (part 0, pick 2) and the rewritten report has different ideas in those
//     positions. Keeping them would silently point Antoine's own choices at ideas he
//     never chose.
//
// Sequential on purpose: one item at a time keeps GitHub and the model lane gentle,
// and this walks the whole backlog.

// What each source's owner row is, and whether its ideas are still worth money.
const REWRITE_SOURCES = {
  prompt: {
    label: 'tasks',
    live: (db, id) => db.prepare(`
      SELECT id, title, prompt FROM work_prompts
      WHERE id=? AND deleted_at IS NULL AND status NOT IN ('done','cancelled')
    `).get(id),
    ideaText: (r) => [r.title, r.prompt].filter(Boolean).join('\n'),
    // A task points at its report by id, so the pointer has to move with the rewrite.
    reattach: (db, id, reportId) => db.prepare(`
      UPDATE work_prompts SET inspire_report_id=?, inspire_state='ready', inspire_picks_json=NULL
      WHERE id=?
    `).run(reportId, id),
  },
  suggestion: {
    label: 'suggestions',
    live: (db, id) => db.prepare(`
      SELECT id, title, prompt FROM work_suggestions
      WHERE id=? AND deleted_at IS NULL AND status='new'
    `).get(id),
    ideaText: (r) => [r.title, r.prompt].filter(Boolean).join('\n'),
  },
  component: {
    label: 'pieces of the architecture',
    live: (db, id) => db.prepare(`
      SELECT id, name, what, next FROM architecture_nodes
      WHERE id=? AND deleted_at IS NULL AND status NOT IN ('Working','Validated','Advanced')
    `).get(id),
    ideaText: (r) => [r.name, r.what, r.next].filter(Boolean).join('\n'),
  },
  idea: {
    label: 'seeds',
    live: (db, id) => db.prepare(`
      SELECT id, title, notes FROM work_ideas WHERE id=? AND deleted_at IS NULL
    `).get(id),
    ideaText: (r) => [r.title, r.notes].filter(Boolean).join('\n'),
  },
};

// The latest report per item, for every item whose latest report predates the current
// generation. Newest first so the things most recently looked at are fixed first.
export function staleWorldLooks(db, { sources = null } = {}) {
  let rows;
  try {
    rows = db.prepare(`
      SELECT r.id, r.source, r.source_id, r.idea_text, COALESCE(r.rewrite_gen, 0) AS gen, r.created_at
      FROM discovery_reports r
      WHERE r.source_id IS NOT NULL
        AND r.created_at = (
          SELECT MAX(r2.created_at) FROM discovery_reports r2
          WHERE r2.source = r.source AND r2.source_id = r.source_id
        )
      ORDER BY r.created_at DESC
    `).all();
  } catch { return []; }
  const wanted = Array.isArray(sources) && sources.length ? new Set(sources) : null;
  const candidates = rows
    .filter((r) => r.gen < WORLD_LOOK_GEN)
    .filter((r) => REWRITE_SOURCES[r.source])
    .filter((r) => !wanted || wanted.has(r.source));
  // A rewrite replaces the report wholesale, which would throw away a
  // conversation and every idea folded out of it. Brainstormed reports are left
  // exactly as they are, and the skip is logged rather than silent.
  const keep = candidates.filter((r) => !reportIsBrainstormed(db, r.id));
  const skipped = candidates.length - keep.length;
  if (skipped) console.log(`world-look rewrite: skipping ${skipped} brainstormed report(s) — a conversation or a folded idea lives in them`);
  return keep;
}

/**
 * Redo the world-look for everything whose ideas were written by an older generation
 * of the prompts. Never throws — a single failure is recorded and the sweep moves on,
 * because a run over a hundred items must not be lost to one bad row.
 *
 * @param {object} opts
 * @param {number} opts.limit       most items to redo in this run (resume for the rest)
 * @param {string[]} opts.sources   restrict to 'prompt' | 'suggestion' | 'component' | 'idea'
 * @param {boolean} opts.dryRun     count and list only — no model calls, no writes
 * @param {Function} opts.onProgress called with each item's outcome, for CLI output
 */
export async function rewriteWorldLooks(db, { limit = 25, sources = null, dryRun = false, onProgress = null } = {}) {
  const stale = staleWorldLooks(db, { sources });
  const byLabel = {};
  for (const r of stale) {
    const label = REWRITE_SOURCES[r.source].label;
    byLabel[label] = (byLabel[label] || 0) + 1;
  }

  if (dryRun) {
    return {
      dry_run: true, generation: WORLD_LOOK_GEN, stale: stale.length, by_kind: byLabel,
      would_do: stale.slice(0, limit).map((r) => ({ source: r.source, source_id: r.source_id, idea: String(r.idea_text || '').slice(0, 80) })),
    };
  }

  const done = [], skipped = [], failed = [];
  for (const r of stale) {
    if (done.length >= limit) break;
    const spec = REWRITE_SOURCES[r.source];
    const owner = (() => { try { return spec.live(db, r.source_id); } catch { return null; } })();
    if (!owner) {
      // Gone, finished, turned down or already built. Stamp the old report so the
      // next run does not keep re-examining it forever.
      try { db.prepare(`UPDATE discovery_reports SET rewrite_gen=? WHERE id=?`).run(WORLD_LOOK_GEN, r.id); } catch {}
      skipped.push({ source: r.source, source_id: r.source_id, why: 'nothing left to act on' });
      if (onProgress) onProgress({ state: 'skipped', source: r.source, source_id: r.source_id });
      continue;
    }
    const ideaText = spec.ideaText(owner) || r.idea_text;
    if (onProgress) onProgress({ state: 'running', source: r.source, source_id: r.source_id, idea: String(ideaText).slice(0, 80) });
    let out;
    try {
      out = await runWorldLookGuarded(db, { idea_text: ideaText, source: r.source, source_id: r.source_id, forceRefresh: false });
    } catch (e) {
      out = { error: 'threw', message: e.message };
    }
    if (!out || out.error || out.running || !out.id) {
      failed.push({ source: r.source, source_id: r.source_id, why: out?.message || out?.error || 'no report came back' });
      if (onProgress) onProgress({ state: 'failed', source: r.source, source_id: r.source_id, why: out?.message || out?.error });
      continue;
    }
    // The new report is now the latest for this item, so findReportBySource finds it
    // everywhere. Tasks are the exception — they hold the id — hence reattach.
    if (spec.reattach) { try { spec.reattach(db, r.source_id, out.id); } catch { /* the report still stands */ } }
    done.push({ source: r.source, source_id: r.source_id, report_id: out.id, subject: out.project_territory || null });
    if (onProgress) onProgress({ state: 'done', source: r.source, source_id: r.source_id, subject: out.project_territory || null });
  }

  return {
    generation: WORLD_LOOK_GEN,
    rewritten: done.length, skipped: skipped.length, failed: failed.length,
    remaining: Math.max(0, stale.length - done.length - skipped.length),
    done, skipped_items: skipped, failed_items: failed,
  };
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
  const name = target.name || pick.repo || pick.name || 'Discovery pick';
  const out = createNode(db, {
    name,
    territory: target.territory,
    what: pick.use || pick.vision || '',
    why: pick.why_fits || pick.how_fmcns || '',
    depends: target_node_id ? [target_node_id] : [],
    status: 'Concept',
    provenance: 'speculative',
    parent_node_id: target_node_id,
    // Every node needs a witness (architectureNodes.js). A pick is something not
    // adopted yet, so it starts on the derived slug rather than blocking the plant.
    ...fallbackWitness(name),
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

  const projectName = report.project_name || report.idea_text.slice(0, 60);
  const parentOut = createNode(db, {
    name: projectName,
    territory: report.project_territory,
    what: report.idea_text,
    why: '',
    depends: [],
    status: 'Concept',
    provenance: 'speculative',
    parent_node_id: null,
    ...fallbackWitness(projectName),
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
