// Keywords — a bank of subjects to explore later (his ask, 2026-10-21). Saved from
// the dictionary card anywhere (the Room, a web page, a PDF on the Mac) with its
// Keyword button, and shown in the Library under Keywords. Not a passage (a line kept
// verbatim) and not a seed (an intention to build): a word or a few, a door to a
// future conversation. Where it was met and what it meant there ride along.
import { randomUUID } from 'node:crypto';

let db = null;
export function bindKeywordsDb(database) {
  db = database;
  db.exec(`CREATE TABLE IF NOT EXISTS saved_keywords (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    term TEXT NOT NULL,
    norm TEXT NOT NULL,
    meaning TEXT,
    source_title TEXT,
    line TEXT,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    deleted_at TEXT
  )`);
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_saved_keywords ON saved_keywords(owner, norm)`); } catch {}
}

const normOf = (t) => String(t || '').toLowerCase().replace(/[’']s$/, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function saveKeyword(owner, { term, meaning = '', sourceTitle = '', line = '' } = {}) {
  if (!db) return { error: 'no_db' };
  const t = String(term || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const norm = normOf(t);
  if (!norm) return { error: 'empty' };
  // The same word saved twice is one keyword.
  const existing = db.prepare('SELECT * FROM saved_keywords WHERE owner=? AND norm=? AND deleted_at IS NULL').get(owner, norm);
  if (existing) return { ok: true, keyword: existing, already: true };
  const id = randomUUID();
  db.prepare('INSERT INTO saved_keywords(id,owner,term,norm,meaning,source_title,line) VALUES(?,?,?,?,?,?,?)')
    .run(id, owner, t, norm, String(meaning || '').slice(0, 2000) || null,
      String(sourceTitle || '').slice(0, 300) || null, String(line || '').slice(0, 1000) || null);
  return { ok: true, keyword: db.prepare('SELECT * FROM saved_keywords WHERE id=?').get(id), already: false };
}

export function listKeywords(owner) {
  if (!db) return [];
  return db.prepare('SELECT id,term,meaning,source_title,line,created_at FROM saved_keywords WHERE owner=? AND deleted_at IS NULL ORDER BY created_at DESC').all(owner);
}

export function getKeyword(owner, id) {
  if (!db) return null;
  return db.prepare('SELECT * FROM saved_keywords WHERE id=? AND owner=? AND deleted_at IS NULL').get(id, owner) || null;
}

export function removeKeyword(owner, id) {
  if (!db) return;
  db.prepare('UPDATE saved_keywords SET deleted_at=CURRENT_TIMESTAMP WHERE id=? AND owner=?').run(id, owner);
}
