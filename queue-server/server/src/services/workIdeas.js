// "Idées" — a notebook that never auto-executes. Ported near-verbatim from the
// Orisha "Travaux" spec (§4); the only adaptation is calling FMCNS's own
// promptQueue.createPrompt() instead of a generic seam.
import { randomUUID } from 'node:crypto';
import * as queue from './promptQueue.js';
import { createNode } from './architectureNodes.js';
import { generateText } from './ai/text.js';
import { runIdeaDiscovery } from './codeDiscovery.js';
import { draftPlan } from './taskPlanner.js';

let db = null;
export function bindWorkIdeasDb(database) { db = database; }

function row(r) { return r ? { ...r, deleted_at: undefined } : r; }

function nextPosition() {
  const r = db.prepare(`SELECT MAX(position) AS m FROM work_ideas WHERE deleted_at IS NULL`).get();
  return (r?.m ?? 0) + 1;
}

export function listIdeas() {
  return db.prepare(`SELECT * FROM work_ideas WHERE deleted_at IS NULL ORDER BY position ASC`).all().map(row);
}

export function getIdea(id) {
  return row(db.prepare(`SELECT * FROM work_ideas WHERE id = ? AND deleted_at IS NULL`).get(id));
}

export function createIdea({ title, notes = '', tag = null, created_by = 'antoine' } = {}) {
  const t = String(title || '').trim();
  if (!t) throw new Error('title is required');
  const id = randomUUID();
  db.prepare(`
    INSERT INTO work_ideas (id, title, notes, tag, position, created_by)
    VALUES (?,?,?,?,?,?)
  `).run(id, t, notes, tag, nextPosition(), created_by);
  return getIdea(id);
}

export function updateIdea(id, patch = {}) {
  const idea = getIdea(id);
  if (!idea) return null;
  const next = { ...idea, ...patch };
  // Refuses to blank the title — an idea with no title is unusable and this field
  // autosaves on every keystroke, so a transient empty value must never persist.
  const title = String(next.title || '').trim();
  if (!title) return idea;
  db.prepare(`
    UPDATE work_ideas SET title=?, notes=?, tag=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=?
  `).run(title, next.notes ?? '', next.tag ?? null, id);
  return getIdea(id);
}

export function deleteIdea(id) {
  const info = db.prepare(`UPDATE work_ideas SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND deleted_at IS NULL`).run(id);
  return info.changes > 0;
}

export function reorderIdeas(ids) {
  if (!Array.isArray(ids) || !ids.length) return listIdeas();
  const tx = db.prepare(`UPDATE work_ideas SET position=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`);
  ids.forEach((id, i) => tx.run(i + 1, id));
  return listIdeas();
}

// Plant a Seed into the tech tree: the idea becomes a real node, and keeps a
// back-reference so Idées reads as the list view of the same objects the tree shows
// spatially. Idempotent like promoteIdea — re-planting returns the existing link.
export function plantIdea(id, { territory = 'reasoning', depends = [] } = {}) {
  const idea = getIdea(id);
  if (!idea) return null;
  if (idea.arch_node_id) return { idea, node_id: idea.arch_node_id, already: true };
  const out = createNode(db, {
    name: idea.title,
    territory,
    what: idea.notes || '',
    why: 'Planted from a Seed in Idées.',
    depends,
    status: 'Concept',
    provenance: 'canon',
  });
  if (out.error) return { error: out.error };
  db.prepare(`UPDATE work_ideas SET arch_node_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(out.node.id, id);
  return { idea: getIdea(id), node: out.node, already: false };
}

export async function promoteIdea(id, { userId = 'antoine', prompt = null } = {}) {
  const idea = getIdea(id);
  if (!idea) return null;
  if (idea.work_prompt_id) {
    // Idempotent — re-clicking "promote" on an already-promoted idea just returns
    // the existing queue item rather than creating a duplicate.
    return { idea, prompt: queue.getPrompt(idea.work_prompt_id), already: true };
  }
  const body = prompt || [idea.title, idea.notes].filter(Boolean).join('\n\n');
  const promptRow = await queue.createPrompt({
    title: idea.title,
    prompt: body,
    mode: 'implement',
    preset: 'deep',
    status: 'paused', // set aside — nothing launches until the user starts it
    created_by: userId,
  });
  db.prepare(`UPDATE work_ideas SET work_prompt_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(promptRow.id, id);
  return { idea: getIdea(id), prompt: promptRow, already: false };
}

// ─── Frankenstein idea composition (plan "plan-first-queue-and-idea-composition"
// Part B): break a Seed into concrete parts, resolve each via a real GitHub repo
// or a build-it-ourselves decision (using codeDiscovery.js's engine, scoped to
// one part instead of a whole idea), then package the whole idea once every
// part is covered. ───────────────────────────────────────────────────────────
function rowToPart(r) {
  return {
    id: r.id, idea_id: r.idea_id, label: r.label, status: r.status,
    resolution_kind: r.resolution_kind, chosen_repo: r.chosen_repo, why: r.why,
    position: r.position, created_at: r.created_at, updated_at: r.updated_at,
  };
}

export function listParts(ideaId) {
  return db.prepare(`SELECT * FROM idea_parts WHERE idea_id=? ORDER BY position`).all(ideaId).map(rowToPart);
}

function buildDecomposePrompt(idea) {
  return `Break the following idea into 3 to 6 concrete parts it would actually need to be built — each part a distinct piece of work, not a restatement of the whole idea.

IDEA TITLE: ${idea.title}
IDEA NOTES: ${idea.notes || '(none)'}

Return ONLY JSON, no prose, no markdown fence:
{"parts":["<short label for part 1>","<short label for part 2>"]}`;
}

function parsePartLabels(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return [];
  try {
    const obj = JSON.parse(m[0]);
    return Array.isArray(obj.parts) ? obj.parts.filter((p) => typeof p === 'string' && p.trim()).slice(0, 6) : [];
  } catch { return []; }
}

// Idempotent — re-decomposing an idea that already has parts just returns them,
// rather than creating a second overlapping set.
export async function decomposeIdea(id) {
  const idea = getIdea(id);
  if (!idea) return { error: 'not_found' };
  const existing = listParts(id);
  if (existing.length) return { parts: existing, already: true };
  const out = await generateText({ prompt: buildDecomposePrompt(idea), feature: 'discovery', maxTokens: 400, label: 'idea-decompose' });
  const labels = out?.text ? parsePartLabels(out.text) : [];
  if (!labels.length) return { error: 'decompose_failed', message: 'Could not break this idea into parts — try adding more detail to the notes.' };
  const stmt = db.prepare(`INSERT INTO idea_parts (id, idea_id, label, position) VALUES (?,?,?,?)`);
  labels.forEach((label, i) => stmt.run(randomUUID(), id, label, i + 1));
  return { parts: listParts(id), already: false };
}

// Runs the discovery engine (codeDiscovery.js) scoped to one part's label —
// same two-pass pipeline the Idea box uses for a whole idea, just shorter,
// more specific input. Returns a report for the UI to present; resolving the
// part (picking one option, or building it ourselves) is a separate call.
export async function searchPart(ideaId, partId) {
  const part = db.prepare(`SELECT * FROM idea_parts WHERE id=? AND idea_id=?`).get(partId, ideaId);
  if (!part) return { error: 'not_found' };
  const report = await runIdeaDiscovery(part.label, { source: 'idea_box', sourceId: partId });
  if (report?.error) return report;
  return { part: rowToPart(part), report };
}

export function resolvePart(ideaId, partId, { resolution_kind, chosen_repo = null, why = '' } = {}) {
  const part = db.prepare(`SELECT * FROM idea_parts WHERE id=? AND idea_id=?`).get(partId, ideaId);
  if (!part) return { error: 'not_found' };
  if (!['github', 'build'].includes(resolution_kind)) return { error: 'invalid_resolution' };
  db.prepare(`
    UPDATE idea_parts SET status='covered', resolution_kind=?, chosen_repo=?, why=?,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?
  `).run(resolution_kind, resolution_kind === 'github' ? chosen_repo : null, why, partId);
  return { part: rowToPart(db.prepare(`SELECT * FROM idea_parts WHERE id=?`).get(partId)), parts: listParts(ideaId) };
}

function buildPackageBrief(idea, parts) {
  const partLines = parts.map((p) => p.resolution_kind === 'github'
    ? `- ${p.label}: use ${p.chosen_repo}${p.why ? ' — ' + p.why : ''}`
    : `- ${p.label}: build from scratch${p.why ? ' — ' + p.why : ''}`).join('\n');
  return `${idea.title}\n\n${idea.notes || ''}\n\nParts:\n${partLines}`;
}

// Packaging is a deliberate action, not automatic on the last part being
// resolved — matches the "nothing launches until you act" pattern already
// used by promoteIdea/plantIdea. Idempotent the same way: a second call
// returns the existing queue item instead of duplicating it.
export async function packageIdea(id) {
  const idea = getIdea(id);
  if (!idea) return { error: 'not_found' };
  if (idea.work_prompt_id) return { idea, prompt: queue.getPrompt(idea.work_prompt_id), already: true };
  const parts = listParts(id);
  if (!parts.length) return { error: 'no_parts' };
  if (parts.some((p) => p.status !== 'covered')) return { error: 'parts_incomplete' };

  // The brief is already drafted directly (not left to createPrompt's own
  // plan-first stage), so createPrompt is told plan_source:'skip' to avoid a
  // redundant second drafting pass on text that's already a plan.
  const rawBrief = buildPackageBrief(idea, parts);
  const draft = await draftPlan({ title: idea.title, prompt: rawBrief, mode: 'implement' });
  const finalTitle = draft?.title || idea.title;
  const finalPrompt = draft?.brief || rawBrief;

  const promptRow = await queue.createPrompt({
    title: finalTitle, prompt: finalPrompt, mode: 'implement', preset: 'deep',
    status: 'paused', plan_source: 'skip', created_by: 'antoine',
  });
  db.prepare(`UPDATE work_ideas SET work_prompt_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(promptRow.id, id);

  // Plant a tech-tree node for the packaged idea (unless one already exists via
  // plantIdea), plus one evidence row per GitHub-sourced part — same
  // architecture_node_evidence table github-code-discovery.md's Idea box uses.
  let node = null;
  if (!idea.arch_node_id) {
    const out = createNode(db, {
      name: idea.title, territory: 'reasoning', what: idea.notes || '',
      why: 'Packaged from a Seed broken into parts in Idées.', status: 'Concept', provenance: 'speculative',
    });
    if (out.node) {
      node = out.node;
      db.prepare(`UPDATE work_ideas SET arch_node_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(node.id, id);
      for (const p of parts) {
        if (p.resolution_kind === 'github' && p.chosen_repo) {
          db.prepare(`INSERT INTO architecture_node_evidence (id, node_id, repo_full_name, stars, why, report_id) VALUES (?,?,?,?,?,?)`)
            .run(randomUUID(), node.id, p.chosen_repo, 0, p.why || '', null);
        }
      }
    }
  }

  return { idea: getIdea(id), prompt: promptRow, node, already: false };
}
