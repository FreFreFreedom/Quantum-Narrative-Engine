// Growth surface for the Architecture tech tree.
//
// The tree's trunk (ARCH_DATA) is a hardcoded array in fmcns_navigator.html and
// cannot grow at runtime. This module owns everything that grows on top of it:
// nodes authored by hand, and speculative branches proposed by Claude. Both live
// in `architecture_nodes` and are merged over the trunk by the frontend, keyed by
// id, so a stored node can also override a trunk node's status.
//
// Speculation deliberately goes through services/claudeText.js (subscription CLI
// first, metered API only as fallback) rather than the raw api.anthropic.com fetch
// used by services/architecture.js — that path requires ANTHROPIC_API_KEY and bills
// per token. Results are persisted immediately and never regenerated automatically:
// a second speculation on the same node is an explicit user click, per the cost
// rules in CLAUDE.md.
import crypto from 'node:crypto';
import { generateText } from './ai/text.js';
import { USER_FACING_STYLE } from './ai/style.js';

const TERRITORIES = ['perception', 'knowledge', 'reasoning', 'experience', 'interface'];
const STATUS_LEVELS = ['Concept', 'Designed', 'Prototype', 'Working', 'Validated', 'Advanced'];

// Note the unique index is (parent_node_id, fingerprint), and SQLite treats NULLs as
// distinct — so this dedups repeated speculation under a parent (always non-null)
// without ever blocking you from hand-adding two root nodes that share a name.
const fingerprint = (parentId, name) =>
  crypto.createHash('sha1').update(`${parentId || ''}::${String(name).trim().toLowerCase()}`).digest('hex');

// Ids are derived from the name so a node reads as `graph-diffusion` in depends
// arrays rather than a uuid. Collisions get a numeric suffix rather than failing.
function makeId(db, name) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'node';
  let id = base, n = 2;
  while (db.prepare(`SELECT 1 FROM architecture_nodes WHERE id=?`).get(id)) id = `${base}-${n++}`;
  return id;
}

function rowToNode(r) {
  return {
    id: r.id,
    territory: r.territory,
    name: r.name,
    what: r.what || '',
    why: r.why || '',
    next: r.next || '',
    depends: JSON.parse(r.depends_json || '[]'),
    status: r.status,
    provenance: r.provenance,
    parent_node_id: r.parent_node_id,
    created_at: r.created_at,
  };
}

export function listNodes(db) {
  const rows = db.prepare(
    `SELECT * FROM architecture_nodes WHERE deleted_at IS NULL ORDER BY created_at`,
  ).all();
  return rows.map(rowToNode);
}

// The fallback must itself be a known territory — passing the unvalidated input
// value in as its own fallback would let anything through, and the frontend looks
// territory up in a fixed table to colour and label the node.
function sanitize(input, fallbackTerritory) {
  const safeFallback = TERRITORIES.includes(fallbackTerritory) ? fallbackTerritory : 'reasoning';
  const territory = TERRITORIES.includes(input.territory) ? input.territory : safeFallback;
  const status = STATUS_LEVELS.includes(input.status) ? input.status : 'Concept';
  const depends = Array.isArray(input.depends) ? input.depends.filter(d => typeof d === 'string' && d) : [];
  return { territory, status, depends };
}

export function createNode(db, input) {
  const name = String(input.name || '').trim();
  if (!name) return { error: 'name_required' };
  const { territory, status, depends } = sanitize(input);
  const provenance = input.provenance === 'speculative' ? 'speculative' : 'canon';
  const parentId = input.parent_node_id || null;
  const id = makeId(db, name);
  try {
    db.prepare(`
      INSERT INTO architecture_nodes (id, territory, name, what, why, next, depends_json, status, provenance, parent_node_id, fingerprint)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(id, territory, name, input.what || '', input.why || '', input.next || '',
      JSON.stringify(depends), status, provenance, parentId, fingerprint(parentId, name));
  } catch (e) {
    // Unique fingerprint per parent — a duplicate proposal is a no-op, not an error.
    if (String(e.message || '').includes('UNIQUE')) return { error: 'duplicate' };
    throw e;
  }
  return { node: rowToNode(db.prepare(`SELECT * FROM architecture_nodes WHERE id=?`).get(id)) };
}

export function updateNode(db, id, input) {
  const row = db.prepare(`SELECT * FROM architecture_nodes WHERE id=? AND deleted_at IS NULL`).get(id);
  if (!row) return { error: 'not_found' };
  const merged = {
    territory: input.territory !== undefined ? input.territory : row.territory,
    status: input.status !== undefined ? input.status : row.status,
    depends: input.depends !== undefined ? input.depends : JSON.parse(row.depends_json || '[]'),
  };
  const { territory, status, depends } = sanitize(merged, row.territory);
  const name = input.name !== undefined ? String(input.name).trim() || row.name : row.name;
  // Accepting a speculation is a provenance flip in place, so the node keeps its id
  // and anything already depending on it stays wired up.
  const provenance = input.provenance === 'canon' || input.provenance === 'speculative'
    ? input.provenance : row.provenance;
  db.prepare(`
    UPDATE architecture_nodes SET territory=?, name=?, what=?, why=?, next=?, depends_json=?,
      status=?, provenance=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?
  `).run(territory, name,
    input.what !== undefined ? input.what : row.what,
    input.why !== undefined ? input.why : row.why,
    input.next !== undefined ? input.next : row.next,
    JSON.stringify(depends), status, provenance, id);
  return { node: rowToNode(db.prepare(`SELECT * FROM architecture_nodes WHERE id=?`).get(id)) };
}

// Soft delete, so dismissing a speculation keeps its fingerprint row out of the way
// while still letting the same idea be re-proposed later if you change your mind.
export function deleteNode(db, id) {
  const row = db.prepare(`SELECT * FROM architecture_nodes WHERE id=? AND deleted_at IS NULL`).get(id);
  if (!row) return { error: 'not_found' };
  db.prepare(`UPDATE architecture_nodes SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), fingerprint=NULL WHERE id=?`).run(id);
  return { ok: true, id };
}

// ─── Speculation ────────────────────────────────────────────────────────────────
// The frontend supplies the node's own text plus its prereqs and the surrounding
// built state, because the trunk data lives in the HTML file, not on the server.
// Without that context the model produces generic software-roadmap filler instead
// of proposals that are actually about FMCNS.
function buildPrompt(ctx) {
  const n = ctx.node || {};
  const prereqs = (ctx.prereqs || []).map(p => `- ${p.name} (${p.status}): ${p.what || ''}`).join('\n') || '- (none)';
  const built = (ctx.built || []).map(p => `- ${p.name}`).join('\n') || '- (none yet)';
  return `You are extending the technology tree of FMCNS (Fractal Mythic Consciousness Navigation System), a personal research tool that maps characters, films and countries as one ontology of "characters" — universal ontological units — and lets its owner navigate the patterns between them fractally.

The tree has five territories: perception (how anything gets in), knowledge (ontological/semantic/analogical layers), reasoning (inference over the graph), experience (how it feels to explore), interface (what you touch).

We are speculating about what could grow directly out of ONE node:

NODE: ${n.name} (territory: ${n.territory}, status: ${n.status})
What it is: ${n.what || '(not described)'}
Why it matters: ${n.why || '(not described)'}
Next step planned: ${n.next || '(none)'}

Its prerequisites:
${prereqs}

Already built elsewhere in the system:
${built}

Propose 3 distinct capabilities that could be built ON TOP of this node — things that only become possible once it works. Each must be specific to FMCNS's actual subject matter (ontology of characters, fractal navigation, cross-corpus pattern inference, the graph itself), not generic software features like "add caching" or "improve testing". Prefer proposals that open a new kind of thinking for the user, not incremental polish.

${USER_FACING_STYLE}

Respond with ONLY a JSON array, no prose, no markdown fence:
[{"name":"Short Title","territory":"one of perception|knowledge|reasoning|experience|interface","what":"one sentence on what it is","why":"one sentence on why it matters","next":"the concrete first step to build it"}]`;
}

function parseProposals(text) {
  if (!text) return null;
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return null;
  try {
    const arr = JSON.parse(m[0]);
    return Array.isArray(arr) ? arr.filter(p => p && p.name).slice(0, 3) : null;
  } catch { return null; }
}

export async function speculate(db, parentId, ctx) {
  const out = await generateText({
    prompt: buildPrompt({ ...ctx, node: { ...(ctx.node || {}), id: parentId } }),
    feature: 'quick',
    maxTokens: 900,
    label: 'arch-speculate',
  });
  if (out.error) return { error: out.error, message: out.message };
  const proposals = parseProposals(out.text);
  if (!proposals || !proposals.length) return { error: 'unparseable', message: 'Claude did not return usable proposals.' };

  const created = [];
  for (const p of proposals) {
    // Every speculative child depends on the node it was speculated from — that is
    // what makes it appear one tier below the parent and stay locked until the
    // parent is actually built.
    const r = createNode(db, {
      name: p.name,
      territory: p.territory,
      what: p.what,
      why: p.why,
      next: p.next,
      depends: [parentId],
      status: 'Concept',
      provenance: 'speculative',
      parent_node_id: parentId,
    });
    if (r.node) created.push(r.node);
  }
  // All three already existed (same fingerprints) — say so rather than silently
  // returning an empty list that looks like a failure.
  if (!created.length) return { error: 'all_duplicates', message: 'Those branches were already proposed for this node.' };
  return { nodes: created };
}

// ─── Auto-placement ("Add an idea") ───────────────────────────────────────────
// One free-text idea in, one structurally-placed speculative node out. The model
// decides the territory and the existing components it depends on; proposed ids
// are validated against the live catalog the frontend sent (the trunk lives in
// the HTML file, not in the database) and anything unknown is dropped — all
// unknown means root, so a hallucinated id can never dangle.
function catalogLines(catalog) {
  return catalog.map(c =>
    `- ${c.id} — ${c.name} (${c.territory}, ${c.status})${Array.isArray(c.depends) && c.depends.length ? `, depends on: ${c.depends.join(', ')}` : ''}: ${String(c.what || '').slice(0, 140)}`
  ).join('\n') || '- (no components yet)';
}

function buildAutoPrompt(concept, catalog) {
  return `You are extending the technology tree of FMCNS (Fractal Mythic Consciousness Navigation System), a personal research tool that maps characters, films and countries as one ontology of "characters" — universal ontological units — and lets its owner navigate the patterns between them fractally.

The tree has five territories: perception (how anything gets in), knowledge (ontological/semantic/analogical layers), reasoning (inference over the graph), experience (how it feels to explore), interface (what you touch). A new node belongs to exactly one of those territory ids.

Existing components in the graph (id — name (territory, status), depends on: ids: description):
${catalogLines(catalog)}

The owner proposes this idea:
"${concept}"

Decide where it fits. Give it a short name (as written in the idea, trimmed), place it in one territory, and pick which existing components it depends on — only ids from the list above, the most natural prerequisites, 0 to 3 of them (none if it is a root idea). "what" is one sentence on what it is, "why" one sentence on why it matters, "next" one concrete first step to build it.

${USER_FACING_STYLE}

Respond with ONLY JSON, no prose, no markdown fence:
{"name":"Short Title","territory":"one of perception|knowledge|reasoning|experience|interface","what":"one sentence","why":"one sentence","next":"one concrete first step","depends":["existing-id-1"]}`;
}

function parseAuto(text) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    return o && o.name ? o : null;
  } catch { return null; }
}

// Explicit user click only — never on load (cost control, CLAUDE.md).
export async function autoPlaceNode(db, conceptInput, ctx = {}) {
  const concept = String(conceptInput || '').trim();
  if (!concept) return { error: 'concept_required', message: 'An idea is required.' };
  const catalog = Array.isArray(ctx.catalog) ? ctx.catalog.filter(c => c && c.id) : [];
  const out = await generateText({
    prompt: buildAutoPrompt(concept, catalog),
    feature: 'quick',
    maxTokens: 900,
    label: 'arch-node-auto',
  });
  if (out.error) return { error: out.error, message: out.message };
  const p = parseAuto(out.text);
  if (!p) return { error: 'unparseable', message: 'Claude did not return a usable placement.' };
  const known = new Set(catalog.map(c => c.id));
  const depends = Array.isArray(p.depends) ? p.depends.filter(id => known.has(id)) : [];
  const r = createNode(db, {
    name: p.name, territory: p.territory, what: p.what, why: p.why, next: p.next,
    depends, status: 'Concept', provenance: 'speculative',
  });
  if (r.error) return { error: r.error, message: r.error === 'duplicate' ? 'This idea is already in the tree.' : 'Could not add the node.' };
  return { node: r.node };
}

// ─── Graph intelligence ("Ask about this architecture") ───────────────────────
// A question about the owner's own architecture. The model reasons over the
// catalog (components, statuses, dependency edges) and answers; the set of ids
// it names defines the trail the frontend lights up on the canvas.
function buildAskPrompt(question, catalog) {
  return `You are looking at the technology tree of FMCNS (Fractal Mythic Consciousness Navigation System) — the owner's own research system: characters, films and countries mapped as one ontology of "characters" (universal ontological units), navigated fractally.

The tree has five territories: perception (how anything gets in), knowledge (ontological/semantic/analogical layers), reasoning (inference over the graph), experience (how it feels to explore), interface (what you touch). Statuses: Concept, Designed, Prototype, Working, Validated, Advanced. A node depends on the components listed after "depends on:".

Existing components (id — name (territory, status): description):
${catalogLines(catalog)}

Answer the owner's question about THIS architecture — be concrete, reference the components by id, and go beyond the single node when relevant (what it touches, what depends on it, what is missing for it to work, how it fits the territories). Answer in the owner's language. Keep it under ~120 words.

Respond with ONLY JSON, no prose, no markdown fence:
{"answer":"your answer","ids":["ids of the components your answer mentions or is about — up to 6, only ids from the list above"]}`;
}

function parseAsk(text) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    return o && o.answer ? o : null;
  } catch { return null; }
}

export async function askGraph(questionInput, ctx = {}) {
  const question = String(questionInput || '').trim();
  if (!question) return { error: 'question_required', message: 'A question is required.' };
  const catalog = Array.isArray(ctx.catalog) ? ctx.catalog.filter(c => c && c.id) : [];
  const out = await generateText({
    prompt: buildAskPrompt(question, catalog),
    feature: 'quick',
    maxTokens: 1000,
    label: 'arch-graph-ask',
  });
  if (out.error) return { error: out.error, message: out.message };
  const p = parseAsk(out.text);
  if (!p) return { error: 'unparseable', message: 'Claude did not return a usable answer.' };
  const known = new Set(catalog.map(c => c.id));
  const ids = Array.isArray(p.ids) ? p.ids.filter(id => known.has(id)) : [];
  return { answer: p.answer, ids };
}

// ─── One idea door ("New idea") ───────────────────────────────────────────────
// Every entry point (header button, architecture toolbar, Flow top) funnels into
// this single router: one AI call decides whether the idea is about building
// FMCNS itself — placed in the tree as a speculative node — or any other idea —
// saved as a Seed. Two kinds of surfaces, one brain, one placement engine.
import { createIdea } from './workIdeas.js';

function buildRoutePrompt(concept, catalog) {
  return `You are the idea router of FMCNS (Fractal Mythic Consciousness Navigation System) — the owner's research system: characters, films and countries mapped as one ontology of "characters" (universal ontological units), navigated fractally.

The architecture tree has five territories: perception (how anything gets in), knowledge (ontological/semantic/analogical layers), reasoning (inference over the graph), experience (how it feels to explore), interface (what you touch).

Two kinds of ideas exist:
- ARCHITECTURE ideas: about extending or improving FMCNS itself — a new capability, a change to how a part works, a fix, a new component. These become speculative nodes in the architecture tree.
- SEEDS: any other idea — a research direction, an exploration, a question, something to think about later. These become a simple titled note.

Existing components in the tree (id — name (territory, status), depends on: ids: description):
${catalogLines(catalog)}

The owner proposes:
"${concept}"

Decide the kind. If it is an architecture idea, return isArchitecture true with a short name, the ONE territory it belongs to, one-sentence what/why, one concrete next step, and 0 to 3 existing ids it depends on (none if it is a root idea). If it is a seed, return isArchitecture false with a short title and a one-line note.

${USER_FACING_STYLE}

Respond with ONLY JSON, no prose, no markdown fence.
Architecture idea: {"isArchitecture":true,"name":"Short Title","territory":"one of perception|knowledge|reasoning|experience|interface","what":"one sentence","why":"one sentence","next":"one concrete first step","depends":["existing-id-1"]}
Seed: {"isArchitecture":false,"title":"Short title","notes":"one line"}`;
}

function parseRoute(text) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// One model call per explicit click only (cost control, CLAUDE.md).
export async function routeIdea(db, conceptInput, ctx = {}) {
  const concept = String(conceptInput || '').trim();
  if (!concept) return { error: 'concept_required', message: 'An idea is required.' };
  const catalog = Array.isArray(ctx.catalog) ? ctx.catalog.filter(c => c && c.id) : [];
  const out = await generateText({
    prompt: buildRoutePrompt(concept, catalog),
    feature: 'quick',
    maxTokens: 1100,
    label: 'arch-idea-route',
  });
  if (out.error) return { error: out.error, message: out.message };
  const p = parseRoute(out.text);
  if (!p || (p.isArchitecture === undefined && p.isArchitecture !== false)) {
    return { error: 'unparseable', message: 'Claude did not return a usable routing.' };
  }
  if (p.isArchitecture) {
    if (!p.name) return { error: 'unparseable', message: 'Claude did not return a usable placement.' };
    const known = new Set(catalog.map(c => c.id));
    const depends = Array.isArray(p.depends) ? p.depends.filter(id => known.has(id)) : [];
    const r = createNode(db, {
      name: p.name, territory: p.territory, what: p.what, why: p.why, next: p.next,
      depends, status: 'Concept', provenance: 'speculative',
    });
    if (r.error) return r.error === 'duplicate'
      ? { error: 'duplicate', message: 'This idea is already in the tree.' }
      : { error: r.error, message: 'Could not add the node.' };
    return { kind: 'node', node: r.node };
  }
  const title = String(p.title || '').trim();
  if (!title) return { error: 'unparseable', message: 'Claude did not return a usable seed.' };
  const idea = createIdea({ title: title.slice(0, 200), notes: p.notes || concept, created_by: 'antoine' });
  return { kind: 'seed', idea };
}

// ─── "Not built" list — AI-recommended order ───────────────────────────────────
// The list itself renders client-side (the trunk lives in the HTML file); this
// only ranks. The frontend sends its items in, we return their ids in the order
// the model recommends. Explicit click only — one model call per use.
export async function rankUnbuilt(itemsInput = []) {
  const items = Array.isArray(itemsInput) ? itemsInput.filter(it => it && it.id) : [];
  if (!items.length) return { error: 'empty', message: 'Nothing to rank.' };
  const catalog = items.map(it =>
    `${it.id} — ${it.name} (${it.territory || '?'}, ${it.status || '?'})${it.buildable ? ', READY TO BUILD' : ', waiting on prerequisites'}: ${String(it.what || '').slice(0, 160)} ${it.next ? 'Next: ' + String(it.next).slice(0, 120) : ''}`).join('\n');
  const out = await generateText({
    prompt: `You are the tech-tree advisor of FMCNS — the owner's personal research system (characters, films, countries as one ontology, navigated fractally).

These components of the architecture are NOT built yet. The owner wants to know the best order to build them in — the smartest next moves for the project, balancing impact on the research system, readiness (READY TO BUILD beats waiting on prerequisites), and how much each one unlocks.

${catalog}

Return ONLY JSON, no prose: {"order": ["id1", "id2", ...]} — every id exactly once, best first. Prefer buildable items early unless a locked one unlocks much more.`,
    feature: 'studio',
    maxTokens: 400,
    label: 'arch-rank-unbuilt',
  });
  if (out.error) return { error: out.error, message: out.message };
  const m = out.text?.match(/\{[\s\S]*\}/);
  let parsed = null;
  if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
  const ordered = parsed?.order && Array.isArray(parsed.order) ? parsed.order : [];
  const known = new Set(items.map(it => it.id));
  const ids = ordered.filter(id => known.has(id));
  // Model misses -> keep the input order for the rest (the client re-ranks anyway).
  const seen = new Set(ids);
  items.forEach(it => { if (!seen.has(it.id)) { ids.push(it.id); seen.add(it.id); } });
  return { order: ids };
}

// "Show my next 3" — one call that picks a 3-item shortlist with a one-line
// plain-English reason each, instead of reordering the whole list. Explicit
// click only, same cost discipline as rankUnbuilt.
export async function shortlistUnbuilt(itemsInput = []) {
  const items = Array.isArray(itemsInput) ? itemsInput.filter(it => it && it.id) : [];
  if (!items.length) return { error: 'empty', message: 'Nothing to pick from.' };
  const catalog = items.map(it =>
    `${it.id} — ${it.name} (${it.territory || '?'}, ${it.status || '?'})${it.buildable ? ', READY TO BUILD' : ', waiting on prerequisites'}: ${String(it.what || '').slice(0, 160)}`).join('\n');
  const out = await generateText({
    prompt: `You are the tech-tree advisor of FMCNS — the owner's personal research system (characters, films, countries as one ontology, navigated fractally).

These components are NOT built yet. Pick the THREE best next moves for the project — balancing impact, readiness (READY TO BUILD beats waiting on prerequisites), and how much each one unlocks. The owner is not a programmer: every reason must be plain everyday language, no jargon, no internal ids.

${catalog}

Return ONLY JSON, no prose: {"picks":[{"id":"...","reason":"one short plain-English sentence — why build this one now"}]} — exactly 3 picks, best first.`,
    feature: 'studio',
    maxTokens: 400,
    label: 'arch-notbuilt-shortlist',
  });
  if (out.error) return { error: out.error, message: out.message };
  const m = out.text?.match(/\{[\s\S]*\}/);
  let parsed = null;
  if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
  const picks = Array.isArray(parsed?.picks) ? parsed.picks.filter(p => p && p.id) : [];
  const known = new Set(items.map(it => it.id));
  const valid = picks.filter(p => known.has(p.id)).slice(0, 3)
    .map(p => ({ id: p.id, reason: String(p.reason || '').slice(0, 240) }));
  // Model came back short -> backfill from the input order so the panel is never empty.
  const seen = new Set(valid.map(p => p.id));
  for (const it of items) {
    if (valid.length >= 3) break;
    if (!seen.has(it.id)) { valid.push({ id: it.id, reason: '' }); seen.add(it.id); }
  }
  return { picks: valid };
}
