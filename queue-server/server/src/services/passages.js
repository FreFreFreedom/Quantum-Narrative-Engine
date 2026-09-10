// Passages — lines worth keeping, lifted out of a conversation.
//
// His ask, 2026-09-09: a sentence an answer produced ("the play asks: what happens
// to a people when the civic structure meant to hold them together becomes the
// instrument of their isolation?") is worth more than the turn it appeared in, and
// there was nowhere to put it. Quoting carries a line into the NEXT question and
// then it is gone; a seed (work_ideas) is a distilled intention to build something.
// A passage is neither: it is a found line, kept verbatim, with the thinking about
// it attached afterwards.
//
// Two things are attached, and the split is deliberate:
//   · a reading — one cheap model call, automatic on save, a few sentences on what
//     the line actually names and what it could become here. Free lane. It is the
//     thing he asked to see "in a short text" without doing anything.
//   · a world-look — the existing discovery pass, NOT automatic. It costs real
//     model time, so it stays a click, and it rides the generic source/source_id
//     shape that codeDiscovery already has (source 'passage'). Nothing new to build
//     there: the same reports, the same panel shape as the Room's Ideas.
import { randomUUID } from 'node:crypto';
import { generateText } from './ai/text.js';
import { paradigmVoiceBlock } from './ai/voice.js';
import { broadcastAll } from '../realtime.js';

let db = null;
export function bindPassagesDb(database) { db = database; }

const MAX_TEXT = 2000;

export function listPassages({ limit = 200 } = {}) {
  if (!db) return [];
  return db.prepare(
    `SELECT * FROM saved_passages WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ?`,
  ).all(Math.min(Math.max(Number(limit) || 200, 1), 500));
}

export function getPassage(id) {
  if (!db) return null;
  return db.prepare(`SELECT * FROM saved_passages WHERE id=? AND deleted_at IS NULL`).get(id) || null;
}

export function savePassage({ text, convoId = null, messageId = null, sourceTitle = null, createdBy = 'antoine' } = {}) {
  if (!db) return { error: 'no_db' };
  const body = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  if (!body) return { error: 'empty' };
  // The same line saved twice is one passage. Keeping both would quietly fill the
  // shelf with duplicates of whatever he re-reads most.
  const existing = db.prepare(`SELECT * FROM saved_passages WHERE text=? AND deleted_at IS NULL`).get(body);
  if (existing) return { ok: true, passage: existing, already: true };

  const id = randomUUID();
  db.prepare(
    `INSERT INTO saved_passages (id, text, convo_id, message_id, source_title, created_by) VALUES (?,?,?,?,?,?)`,
  ).run(id, body, convoId || null, messageId || null, sourceTitle || null, createdBy);
  broadcastAll('passages:updated', { passageId: id });
  return { ok: true, passage: getPassage(id) };
}

export function deletePassage(id) {
  if (!db) return { error: 'no_db' };
  if (!getPassage(id)) return { error: 'not_found' };
  db.prepare(`UPDATE saved_passages SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(id);
  broadcastAll('passages:updated', { passageId: id });
  return { ok: true };
}

// The reading. Short on purpose: this is a line on a shelf, not an essay — the
// long version is what the Room is for, and the world-look is one click away.
const READING_PROMPT = `A line was kept out of a conversation because it was worth keeping. Write a short reading of it — three or four sentences, no headings, no bullets, no preamble.

Say what the line actually names — the pattern under it, not a paraphrase of the words. Then say what it could become inside this platform: a way of reading entities, a lens, a measure, a view, a navigation move. Name the thing concretely enough to build, and say plainly if it would be new.

Never restate the line. Never open with "This passage" or "This quote".`;

export async function readPassage(id, { force = false } = {}) {
  const row = getPassage(id);
  if (!row) return { error: 'not_found' };
  if (row.reading && !force) return { ok: true, passage: row, cached: true };

  const context = row.source_title ? `\n\nIt came out of a conversation called "${row.source_title}".` : '';
  const out = await generateText({
    prompt: `${READING_PROMPT}${paradigmVoiceBlock({ lengthRuleWins: true })}\n\n=== THE LINE ===\n"${row.text}"${context}`,
    feature: 'summary',
    label: 'passages:reading',
    maxTokens: 320,
    allowLongOutput: true,
    timeoutMs: 90_000,
    // Someone pressed a button and is waiting: if every free lane is resting,
    // ask Claude on the Mac rather than show a failure. No runner attached means
    // this returns at once, so the ordinary path is unchanged.
    claudeLastResort: true,
  });
  if (out.error || !out.text) return { error: out.error || 'generation_failed', message: out.message };

  db.prepare(`UPDATE saved_passages SET reading=?, read_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
    .run(out.text.trim(), id);
  broadcastAll('passages:updated', { passageId: id });
  return { ok: true, passage: getPassage(id) };
}

// Fire-and-forget: called right after a save so the shelf fills itself in. Never
// throws into the caller — a passage with no reading yet is a passage, and the
// button to ask again is right there.
export function readPassageSoon(id) {
  setImmediate(() => {
    readPassage(id).catch((e) => console.error('[passages] reading failed:', e?.message || e));
  });
}
