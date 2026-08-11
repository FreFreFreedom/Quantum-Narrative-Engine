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
