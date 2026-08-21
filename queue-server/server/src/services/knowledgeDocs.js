// knowledge_docs — read helpers plus the FIRST write path outside boot.
//
// Until now services/bootstrapData.js#seedKnowledge was the only writer: it
// re-seeds the three reference documents from data-seed/docs on every boot. This
// module adds `/note` (plan "roaming-conversations-backend" §3) — a conversation
// can save what it worked out as a document, and because every AI feature that
// can list/read knowledge docs then sees it, a saved vision becomes context for
// everything else.
//
// TWO THINGS KEEP THAT SAFE:
//
// 1. seedKnowledge upserts ON CONFLICT(title) and never DELETEs, so a note
//    written here survives every redeploy. The one way to lose one is a TITLE
//    COLLISION with a seeded doc, which the next boot would silently overwrite.
//    Notes are therefore namespaced with a `Note: ` prefix — seeded titles are
//    markdown file basenames (`ontology`, `films_master_list`,
//    `chatgpt_archive`), which can never take that shape — and the three
//    reserved titles are refused outright as a second belt.
// 2. A note never overwrites an existing doc of any kind. Same title twice gets
//    a numbered suffix, so nothing a conversation saved is ever lost to a
//    later conversation choosing the same words.

import { randomUUID } from 'node:crypto';

// Basenames of the files in data-seed/docs. Kept in sync with
// bootstrapData.js#KNOWLEDGE_DESCRIPTIONS.
const RESERVED_TITLES = new Set(['ontology', 'films_master_list', 'chatgpt_archive']);

export const NOTE_PREFIX = 'Note: ';

export function listKnowledgeDocs(db) {
  if (!db) return [];
  return db.prepare(`SELECT title, description, length(content) AS chars FROM knowledge_docs ORDER BY title`).all();
}

export function readKnowledgeDoc(db, title, offset = 0, length = 20000) {
  if (!db) return { error: 'no_db' };
  const row = db.prepare(`SELECT content FROM knowledge_docs WHERE title=?`).get(title);
  if (!row) {
    return { error: 'not_found', available: db.prepare(`SELECT title FROM knowledge_docs`).all().map((r) => r.title) };
  }
  const content = row.content;
  const start = Math.max(0, Number(offset) || 0);
  const len = Math.max(1, Number(length) || 20000);
  return {
    title,
    offset: start,
    length: Math.min(len, Math.max(0, content.length - start)),
    total_chars: content.length,
    has_more: start + len < content.length,
    text: content.slice(start, start + len),
  };
}

function uniqueTitle(db, base) {
  let title = base;
  let n = 2;
  while (db.prepare(`SELECT 1 FROM knowledge_docs WHERE title=?`).get(title)) {
    title = `${base} (${n})`;
    n += 1;
    if (n > 50) { title = `${base} (${randomUUID().slice(0, 8)})`; break; }
  }
  return title;
}

// Write a conversation's understanding into the knowledge base.
// Returns { title, description, chars } | { error, message }.
export function createKnowledgeNote(db, { title, description = '', content } = {}) {
  if (!db) return { error: 'no_db' };
  const raw = String(title || '').trim().replace(/\s+/g, ' ');
  const body = String(content || '').trim();
  if (!raw) return { error: 'title_required', message: 'A note needs a title.' };
  if (!body) return { error: 'content_required', message: 'A note needs something in it.' };
  if (RESERVED_TITLES.has(raw.toLowerCase())) {
    return { error: 'reserved_title', message: `"${raw}" is one of the standing reference documents — pick another name.` };
  }

  const base = raw.startsWith(NOTE_PREFIX) ? raw.slice(0, 160) : `${NOTE_PREFIX}${raw}`.slice(0, 160);
  const finalTitle = uniqueTitle(db, base);
  // description is what list_knowledge_docs shows, and therefore the only thing
  // that decides whether this note ever gets read again. A missing one falls back
  // to the opening of the note rather than to an empty string.
  const desc = String(description || '').trim().replace(/\s+/g, ' ').slice(0, 400)
    || body.replace(/\s+/g, ' ').slice(0, 200);

  db.prepare(`
    INSERT INTO knowledge_docs (id, title, description, content, updated_at)
    VALUES (?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  `).run(randomUUID(), finalTitle, desc, body);

  return { title: finalTitle, description: desc, chars: body.length };
}
