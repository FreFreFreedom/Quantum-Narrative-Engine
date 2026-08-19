// "Idées" — a notebook that never auto-executes. Ported near-verbatim from the
// Orisha "Travaux" spec (§4); the only adaptation is calling FMCNS's own
// promptQueue.createPrompt() instead of a generic seam.
import { randomUUID } from 'node:crypto';
import * as queue from './promptQueue.js';
import { createNode } from './architectureNodes.js';

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

export async function promoteIdea(id, { userId = 'antoine', prompt = null, inspiration = null } = {}) {
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
    // Carry the seed's tree node onto the task. Without this the task landed with
    // component_id NULL, so it was invisible to everything that joins work to the
    // architecture: the component's own build history, the "never worked on"
    // signal, the Flow's per-component filter, and the ranked next-steps list
    // (which must know a piece is already under way to stop proposing it).
    component_id: idea.arch_node_id || null,
    inspiration: inspiration || null, // world-look already ran on the seed — no re-search
  });
  db.prepare(`UPDATE work_ideas SET work_prompt_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(promptRow.id, id);
  return { idea: getIdea(id), prompt: promptRow, already: false };
}
