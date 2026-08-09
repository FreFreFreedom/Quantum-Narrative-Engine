// "Idées" — a notebook that never auto-executes. Ported near-verbatim from the
// Orisha "Travaux" spec (§4); the only adaptation is calling FMCNS's own
// promptQueue.createPrompt() instead of a generic seam.
import { randomUUID } from 'node:crypto';
import * as queue from './promptQueue.js';

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

export function promoteIdea(id, { userId = 'antoine', prompt = null } = {}) {
  const idea = getIdea(id);
  if (!idea) return null;
  if (idea.work_prompt_id) {
    // Idempotent — re-clicking "promote" on an already-promoted idea just returns
    // the existing queue item rather than creating a duplicate.
    return { idea, prompt: queue.getPrompt(idea.work_prompt_id), already: true };
  }
  const body = prompt || [idea.title, idea.notes].filter(Boolean).join('\n\n');
  const promptRow = queue.createPrompt({
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
