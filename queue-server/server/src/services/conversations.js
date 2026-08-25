// Idea Studio conversations (plan "universal-conversations-core-architecture",
// extended by "roaming-conversations-backend").
// A conversation about one or more subjects (seed / suggestion / arch component /
// tech-tree node / task / world idea — or 'open', which is a room to think in with
// no card at all), stored in convos + convo_messages + convo_subjects. Each turn
// calls the model fresh with the windowed history + every attached subject's
// context — never a persistent session.
//
// Cost controls: nothing bills until you type; chat turns use a cheap model by
// default, the plan turn a stronger one; history is windowed and older turns are
// folded into a recap. Commands (/grill-me, /plan, /handoff, /help) are handled
// here, before anything hits the model. Tools are read-only — the advisor can say
// "this already exists" but never edits anything.

import { randomUUID } from 'node:crypto';
import { broadcastAll } from '../realtime.js';
import { runToolLoop } from './anthropicLoop.js';
import {
  registerSubject, subjectSpec, buildSubjectContext, parseWorldPickId,
} from './subjectContext.js';
import {
  getReport, updatePickInPlace, appendPicks, updatePartFraming, runWorldLookGuarded,
} from './codeDiscovery.js';
import { writeTarget, writeActsFor, applySubjectWrite, subjectEdits } from './subjectWrite.js';
import { createIdea } from './workIdeas.js';
import { generateText, generateTextStream, studioPersonaText } from './ai/text.js';
import { resolveTurn, computeLaneTag, tagFromVia } from './turnRouter.js';
import { getComponents } from './architecture.js';
import { projectMapBlock } from './projectMap.js';
import { listSuggestions } from './workSuggestions.js';
import { listIdeas, getIdea } from './workIdeas.js';
import { STUDIO_TOOLS, dispatchStudioTool, TOOLS_PROMPT_BLOCK } from './studioTools.js';
import { createKnowledgeNote, uniqueTitle } from './knowledgeDocs.js';
import { deliverNoteToRepo } from './gitOps.js';
import { mindBlock, harvest as harvestMind } from './mind.js';
import { extractCandidates, formatRepoFacts } from './repoProbe.js';

// keep SubjectContext's module-level registrations loaded (imported above)
import './subjectContext.js';

let db = null;
export function bindConversationsDb(database) { db = database; }

// Plans live in knowledge_docs under the `Plan: ` prefix (seeded by
// bootstrapData.js#seedPlans from the project-docs/plans/ mirror). This returns
// just {id, title, status} so a picker can draw a list without downloading the
// 400-line files. `id` is the plan's basename; `status` is parsed back out of the
// description (which seeds as "STATUS date — …"). See plans/plans-in-the-room.md.
export function listPlans() {
  if (!db) return [];
  const rows = db.prepare(`SELECT title, description FROM knowledge_docs WHERE title LIKE ? ESCAPE '\\' ORDER BY title`).all('Plan: %');
  return rows.map((r) => {
    const id = r.title.replace(/^Plan: /, '');
    const status = (/^([A-Z ]+? \d{4}-\d{2}-\d{2})/.exec(r.description || '') || [])[1] || '';
    return { id, title: id, status };
  });
}

// Files live in knowledge_docs under the `File: ` prefix (seeded by
// bootstrapData.js#seedFiles from data-seed/files/). This returns just
// {id, title, status} so a picker can draw a list without downloading the
// full document. `id` is the file's basename; `status` is parsed from the
// description prefix.
export function listFiles() {
  if (!db) return [];
  const rows = db.prepare(`SELECT title, description FROM knowledge_docs WHERE title LIKE ? ESCAPE '\\' ORDER BY title`).all('File: %');
  return rows.map((r) => {
    const id = r.title.replace(/^File: /, '');
    const status = (/^([A-Z ]+? \d{4}-\d{2}-\d{2})/.exec(r.description || '') || [])[1] || '';
    return { id, title: id, status };
  });
}

// Notes live in knowledge_docs under the `Note: ` prefix (written by /note, see
// runSaveNoteTurn below). This returns just {id, title, description} so the
// Room's attach picker can draw a list without downloading each note's full
// text. `id` is the note's title with the prefix stripped. Capped so a long
// notebook doesn't flood the picker.
const NOTE_LIST_CAP = 200;

export function listNotes() {
  if (!db) return [];
  const rows = db.prepare(`SELECT title, description FROM knowledge_docs WHERE title LIKE ? ESCAPE '\\' ORDER BY title LIMIT ?`).all('Note: %', NOTE_LIST_CAP);
  return rows.map((r) => {
    const id = r.title.replace(/^Note: /, '');
    return { id, title: id, description: r.description || '' };
  });
}

// Attach a file to a conversation. The client has already extracted the file's
// text (never send raw bytes here — see plans/files-in-the-room.md's "a file
// never rides in the prompt" rule) and computed its own sha; this only persists
// it. Same-named upload gets a numbered suffix via uniqueTitle(), never an
// overwrite — a previous file's content must never be silently destroyed.
// outline (plan "deep-document-extraction"): the PDF outline/bookmarks the
// browser pulled via pdfjs getOutline() at upload time, as
// [{title, charStart}, ...]. Optional — non-PDF uploads and PDFs with no
// bookmarks send nothing, and docExtraction.js falls back to heuristic
// heading detection in that case.
export function attachFile(convoId, { filename, mimeType, text, bytes, sha, outline } = {}) {
  if (!db) return { error: 'no_db' };
  const convo = getConvo(convoId);
  if (!convo) return { error: 'not_found' };
  const body = String(text || '').trim();
  if (!body) return { error: 'text_required', message: 'A file needs extracted text.' };

  const rawName = String(filename || 'uploaded file').trim();
  const nameNoExt = rawName.replace(/\.[^/.]+$/, '') || 'uploaded file';
  const base = `File: ${nameNoExt}`.slice(0, 160);
  const finalTitle = uniqueTitle(db, base);
  const id = finalTitle.replace(/^File: /, '');
  const today = new Date().toISOString().slice(0, 10);
  const description = `UPLOADED ${today} — ${rawName}, ${Number(bytes) || body.length} bytes${sha ? `, sha ${String(sha).slice(0, 12)}` : ''}`;
  let outlineJson = null;
  if (Array.isArray(outline) && outline.length) {
    const clean = outline
      .filter((o) => o && Number.isFinite(o.charStart) && o.charStart >= 0 && o.charStart < body.length)
      .map((o) => ({ title: String(o.title || '').trim().slice(0, 200), charStart: Math.floor(o.charStart) }))
      .slice(0, 2000); // a bookmark list runs away only on a malformed PDF; this is a safety cap, not an expected ceiling
    if (clean.length) outlineJson = JSON.stringify(clean);
  }

  db.prepare(`
    INSERT INTO knowledge_docs (id, title, description, content, outline_json, updated_at)
    VALUES (?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  `).run(randomUUID(), finalTitle, description, body, outlineJson);

  db.prepare(
    `INSERT INTO convo_subjects (convo_id, subject_type, subject_id, is_primary, subject_hint) VALUES (?,?,?,0,?)`,
  ).run(convo.id, 'file', id, '');

  db.prepare(`UPDATE convos SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(convo.id);
  broadcastAll('convos:updated', { convoId: convo.id });

  return { id, title: id, status: 'UPLOADED' };
}

const CONVO_HISTORY_WINDOW = 16;
// The chat turn is the one you sit and wait for, so it runs on the fast tier by
// default; /plan and the rewrites keep the stronger model, because those produce
// something you keep. An explicit model is only a preference — ai/text.js drops it
// when the configured lane cannot honour it, so the AI Settings 'studio' row still
// has the final say.
const CONVO_CHAT_MODEL = process.env.CONVO_CHAT_MODEL || 'claude-haiku-4-5-20251001';
const CONVO_PLAN_MODEL = process.env.CONVO_PLAN_MODEL || 'claude-sonnet-4-5';

const DEFAULT_OPEN_TITLE = 'Open conversation';

// ─── Auto-title (roaming conversations only) ─────────────────────────────────
// A roaming thread starts as "Open conversation" — no subject to name it after,
// unlike every other convo type, which titles itself from the card it is about
// (see subjectContext.js). Deliberately NOT a model call: this is keyword
// extraction off the owner's own first message, in the spirit of the cost
// discipline elsewhere in this file (chat turns already run on the cheap tier;
// spending a second model call just to name the thread would double that for
// no real gain over reusing the words already typed).
const TITLE_STOPWORDS = new Set([
  'a', 'an', 'the', 'please', 'can', 'could', 'would', 'should', 'will',
  'i', 'you', 'we', 'me', 'my', 'your', 'our', 'it', 'this', 'that',
  'is', 'are', 'was', 'were', 'be', 'to', 'so', 'just', 'hey', 'hi', 'ok', 'okay',
  'want', 'wanna', 'need', 'like', 'think', 'lets', "let's", 'about',
]);
const TITLE_MAX_WORDS = 8;
const TITLE_MAX_CHARS = 80;

export function generateTitleFromText(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  // First line, first clause — the part of a ChatGPT-style opener that actually
  // names the topic, before it wanders into detail.
  const firstLine = trimmed.split('\n')[0];
  const clauseMatch = firstLine.match(/^.{0,160}?[.!?](?=\s|$)/);
  const clause = (clauseMatch ? clauseMatch[0] : firstLine).replace(/[.!?]+$/, '').trim();
  let words = clause.replace(/^[/#>*\-\s]+/, '').split(/\s+/).filter(Boolean);
  // Drop leading filler so the title opens on the substance, not "can you...".
  while (words.length > 3 && TITLE_STOPWORDS.has(words[0].toLowerCase().replace(/[^a-z']/g, ''))) {
    words.shift();
  }
  if (!words.length) return null;
  const truncated = words.length > TITLE_MAX_WORDS;
  let title = words.slice(0, TITLE_MAX_WORDS).join(' ');
  title = title.charAt(0).toUpperCase() + title.slice(1);
  if (truncated) title += '…';
  return title.slice(0, TITLE_MAX_CHARS) || null;
}

// Called right after the FIRST assistant reply in a roaming thread. `convo` is
// the pre-turn row (fetched before this exchange's saveAssistantTurn ran), so
// convo.turns === 0 here means "this was turn one" — the same moment ChatGPT
// names a new chat. Never overwrites a title the owner already set: a rename
// (manual or a prior auto-title) means this has already been decided.
function maybeAutoTitleConvo(convo) {
  if (!db || !convo || convo.subject_type !== 'open') return;
  if ((convo.turns || 0) !== 0) return;
  if (String(convo.title || '').trim() !== DEFAULT_OPEN_TITLE) return;
  const firstUser = db.prepare(
    `SELECT text FROM convo_messages WHERE convo_id=? AND role='user' ORDER BY created_at ASC, rowid ASC LIMIT 1`,
  ).get(convo.id);
  const title = generateTitleFromText(firstUser?.text);
  if (!title) return;
  db.prepare(`UPDATE convos SET title=? WHERE id=?`).run(title, convo.id);
  broadcastAll('convos:updated', { convoId: convo.id });
}

// ─── Read paths ──────────────────────────────────────────────────────────────

export function getConvo(id) {
  if (!db) return null;
  return db.prepare(`SELECT * FROM convos WHERE id=? AND deleted_at IS NULL`).get(id) || null;
}

// ─── Manual model picker (plan "chat-model-picker") ─────────────────────────
// A sticky per-conversation override of the automatic turn router: once set, every
// message in this conversation runs on that lane until it is cleared back to Auto.

const OVERRIDE_TAGS = {
  'claude-code': 'claude',
  'claude-side': 'claude (2nd)',
  opencode: 'opencode',
  'google-ai-studio': 'gemini',
};

export function getChatLane(convoId) {
  const row = db?.prepare(`SELECT chat_override FROM convos WHERE id=?`).get(convoId);
  if (!row?.chat_override) return null;
  try {
    const parsed = JSON.parse(row.chat_override);
    if (!parsed?.provider) return null;
    return { provider: parsed.provider, model: parsed.model || null, account: parsed.account || null, tag: OVERRIDE_TAGS[parsed.provider] || parsed.provider };
  } catch { return null; }
}

// override = { provider, model?, account? }, or null/falsy to clear (back to Auto).
export function setChatLane(convoId, override) {
  if (!db) return { error: 'no_db' };
  const convo = getConvo(convoId);
  if (!convo) return { error: 'not_found' };
  const json = override?.provider
    ? JSON.stringify({ provider: override.provider, model: override.model || null, account: override.account || null })
    : null;
  db.prepare(`UPDATE convos SET chat_override=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(json, convoId);
  broadcastAll('convos:updated', { convoId });
  return getChatLane(convoId);
}

export function findConvo(subjectType, subjectId) {
  if (!db) return null;
  return db.prepare(`SELECT * FROM convos WHERE subject_type=? AND subject_id=? AND deleted_at IS NULL`).get(subjectType, subjectId) || null;
}

export function listMessages(convoId) {
  if (!db) return [];
  return db.prepare(`SELECT * FROM convo_messages WHERE convo_id=? ORDER BY created_at ASC, rowid ASC`).all(convoId);
}

export function listConvosForSubjects(subjectType, ids) {
  if (!db || !ids.length) return {};
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM convos WHERE subject_type=? AND subject_id IN (${placeholders}) AND deleted_at IS NULL`).all(subjectType, ...ids);
  return Object.fromEntries(rows.map((r) => [r.subject_id, r]));
}

// ─── Many subjects per conversation ──────────────────────────────────────────
// (plan "roaming-conversations-backend" §1)
//
// The convos row still carries exactly one subject_type/subject_id — the PRIMARY
// — because those two columns are NOT NULL and uniquely indexed, and changing
// that would mean a destructive migration on live data. convo_subjects sits
// beside it and holds the rest.
//
// THE BACKFILL IS READ-TIME, ON PURPOSE. A conversation with no convo_subjects
// rows is read as having its own subject as its single primary, which is why
// every conversation that existed before this shipped keeps working with no
// migration script and no rows written on its behalf.
//
// COST: every attached card is re-sent on every turn, so the count is capped and
// each block is trimmed. Same instinct as promptQueue.js's "Credit control,
// threshold #1/#2" — an unbounded card count is an unbounded per-message bill.
export const MAX_ATTACHED_SUBJECTS = 6;
const SUBJECT_BLOCK_CAP = 5000;

export function convoSubjectRows(convo) {
  if (!db || !convo) return [];
  const rows = db.prepare(
    `SELECT * FROM convo_subjects WHERE convo_id=? ORDER BY is_primary DESC, added_at ASC, rowid ASC`,
  ).all(convo.id);
  if (rows.length) return rows.slice(0, MAX_ATTACHED_SUBJECTS);
  return [{
    convo_id: convo.id,
    subject_type: convo.subject_type,
    subject_id: convo.subject_id,
    is_primary: 1,
    subject_hint: convo.subject_hint || null,
    added_at: convo.created_at,
  }];
}

export function listConvoSubjects(convoId) {
  const convo = getConvo(convoId);
  if (!convo) return [];
  return convoSubjectRows(convo).map((r) => {
    const spec = subjectSpec(r.subject_type);
    let title = r.subject_id;
    try { title = spec?.title?.(db, r.subject_id, r.subject_hint) || r.subject_id; } catch { /* a deleted card keeps its id */ }
    return {
      subject_type: r.subject_type,
      subject_id: r.subject_id,
      is_primary: !!r.is_primary,
      label: spec?.label || r.subject_type,
      title,
    };
  });
}

// The primary only becomes a real row the first time a second card is attached —
// until then the read-time backfill above stands in for it.
function ensurePrimaryRow(convo) {
  const has = db.prepare(`SELECT 1 FROM convo_subjects WHERE convo_id=? AND is_primary=1`).get(convo.id);
  if (has) return;
  db.prepare(
    `INSERT OR IGNORE INTO convo_subjects (convo_id, subject_type, subject_id, is_primary, subject_hint) VALUES (?,?,?,1,?)`,
  ).run(convo.id, convo.subject_type, convo.subject_id, convo.subject_hint || null);
}

export function attachSubject(convoId, { subjectType, subjectId, subjectHint = null } = {}) {
  if (!db) return { error: 'no_db' };
  const convo = getConvo(convoId);
  if (!convo) return { error: 'not_found' };
  if (!subjectSpec(subjectType)) return { error: 'unknown_subject_type' };
  const id = String(subjectId || '').trim();
  if (!id) return { error: 'empty' };
  if (subjectType === 'open') return { error: 'cannot_attach_open', message: 'An open conversation is a room, not a card — it cannot be attached to another one.' };

  ensurePrimaryRow(convo);
  const already = db.prepare(`SELECT 1 FROM convo_subjects WHERE convo_id=? AND subject_type=? AND subject_id=?`).get(convo.id, subjectType, id);
  if (already) return { ok: true, already: true, subjects: listConvoSubjects(convo.id) };

  const count = db.prepare(`SELECT COUNT(*) AS n FROM convo_subjects WHERE convo_id=?`).get(convo.id).n;
  if (count >= MAX_ATTACHED_SUBJECTS) {
    return { error: 'too_many_subjects', message: `A conversation can hold ${MAX_ATTACHED_SUBJECTS} cards at once — take one off first.` };
  }

  const hint = subjectHint && typeof subjectHint !== 'string' ? JSON.stringify(subjectHint) : (subjectHint || null);
  db.prepare(
    `INSERT INTO convo_subjects (convo_id, subject_type, subject_id, is_primary, subject_hint) VALUES (?,?,?,0,?)`,
  ).run(convo.id, subjectType, id, hint);
  db.prepare(`UPDATE convos SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(convo.id);
  broadcastAll('convos:updated', { convoId: convo.id });
  return { ok: true, subjects: listConvoSubjects(convo.id) };
}

export function detachSubject(convoId, subjectType, subjectId) {
  if (!db) return { error: 'no_db' };
  const convo = getConvo(convoId);
  if (!convo) return { error: 'not_found' };
  // The primary IS the conversation's identity in convos — detaching it would
  // leave a row whose two NOT NULL columns point at nothing real.
  if (convo.subject_type === subjectType && convo.subject_id === subjectId) {
    return { error: 'cannot_detach_primary', message: 'That is the card this conversation started from — it stays.' };
  }
  const out = db.prepare(`DELETE FROM convo_subjects WHERE convo_id=? AND subject_type=? AND subject_id=? AND is_primary=0`)
    .run(convo.id, subjectType, subjectId);
  if (!out.changes) return { error: 'not_attached' };
  db.prepare(`UPDATE convos SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(convo.id);
  broadcastAll('convos:updated', { convoId: convo.id });
  return { ok: true, subjects: listConvoSubjects(convo.id) };
}

// Every attached subject's context, primary first, each labelled so the model can
// tell one card from another. Returns the same shape a single buildSubjectContext
// did — { title, contextText, compare } — plus `mode`, which the system prompt
// uses to decide how to describe what is being discussed.
//
// A single-subject conversation produces BYTE-IDENTICAL contextText to before:
// no labels, no headings, nothing added. Only a conversation that actually holds
// more than one card pays for the extra framing.
async function convoContext(convo) {
  const rows = convoSubjectRows(convo);
  const blocks = [];
  let primary = null;
  let primaryError = null;

  for (const r of rows) {
    const hint = r.is_primary ? (r.subject_hint ?? convo.subject_hint) : r.subject_hint;
    let ctx;
    try {
      ctx = await buildSubjectContext(db, r.subject_type, r.subject_id, hint);
    } catch (e) {
      ctx = { error: 'describe_failed', message: e.message };
    }
    if (ctx.error) {
      if (r.is_primary) primaryError = ctx.error;
      // A card that was deleted after being attached must not kill the whole
      // conversation — it just stops contributing.
      continue;
    }
    if (r.is_primary) primary = ctx;
    const spec = subjectSpec(r.subject_type);
    blocks.push({
      isPrimary: !!r.is_primary,
      label: spec?.label || r.subject_type,
      title: ctx.title || r.subject_id,
      text: String(ctx.contextText || '').slice(0, SUBJECT_BLOCK_CAP),
    });
  }

  if (!blocks.length) return { error: primaryError || 'not_found' };

  const mode = convo.subject_type === 'open'
    ? (blocks.length > 1 ? 'open_with_cards' : 'open')
    : (blocks.length > 1 ? 'multi' : 'single');

  let contextText;
  if (blocks.length === 1) {
    contextText = blocks[0].text;
  } else {
    const rest = blocks.slice(1).map((b, i) => `--- CARD ${i + 2} — ${b.label}: "${b.title}" ---\n${b.text}`);
    contextText = [
      blocks[0].text,
      '=== ALSO ATTACHED TO THIS CONVERSATION ===',
      'The owner attached these himself, so they belong in this conversation — not as background, as part of what is being discussed. Say when two of them are the same thing.',
      rest.join('\n\n'),
    ].join('\n\n');
  }

  return {
    title: primary?.title || blocks[0].title,
    contextText,
    compare: primary?.compare || null,
    mode,
    count: blocks.length,
  };
}

// ─── Write paths ─────────────────────────────────────────────────────────────

export function getOrCreateConvo({ subjectType, subjectId, subjectHint = null, createdBy = 'antoine' }) {
  const spec = subjectSpec(subjectType);
  if (!spec) return { error: 'unknown_subject_type' };

  const existing = findConvo(subjectType, subjectId);
  if (existing) return { convo: existing, created: false };

  const id = randomUUID();
  const title = spec.title?.(db, subjectId, subjectHint) || subjectId;
  db.prepare(`INSERT INTO convos (id, subject_type, subject_id, title, subject_hint, created_by) VALUES (?,?,?,?,?,?)`)
    .run(id, subjectType, subjectId, title, subjectHint || null, createdBy);
  broadcastAll('convos:updated', { convoId: id, subjectType, subjectId });
  return { convo: getConvo(id), created: true };
}

// A roaming conversation. Its subject is synthetic — type 'open', a fresh uuid —
// which is what keeps convos' two NOT NULL columns and their unique index valid
// without touching them. Cards get attached afterwards, or never.
export function createOpenConvo({ title = null, createdBy = 'antoine' } = {}) {
  if (!db) return { error: 'no_db' };
  const id = randomUUID();
  const subjectId = randomUUID();
  const name = String(title || '').trim().slice(0, 120) || DEFAULT_OPEN_TITLE;
  db.prepare(`INSERT INTO convos (id, subject_type, subject_id, title, created_by) VALUES (?,?,?,?,?)`)
    .run(id, 'open', subjectId, name, createdBy);
  broadcastAll('convos:updated', { convoId: id, subjectType: 'open', subjectId });
  return { convo: getConvo(id), created: true };
}

export function listOpenConvos(limit = 50) {
  if (!db) return [];
  const rows = db.prepare(
    `SELECT * FROM convos WHERE subject_type='open' AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?`,
  ).all(Math.min(Math.max(Number(limit) || 50, 1), 200));
  return rows.map((c) => ({ ...c, subjects: listConvoSubjects(c.id) }));
}

export function renameConvo(id, title) {
  if (!db) return { error: 'no_db' };
  const convo = getConvo(id);
  if (!convo) return { error: 'not_found' };
  const name = String(title || '').trim().slice(0, 120);
  if (!name) return { error: 'empty' };
  db.prepare(`UPDATE convos SET title=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(name, id);
  broadcastAll('convos:updated', { convoId: id });
  return { ok: true, convo: getConvo(id) };
}

export function resetConvoContext(id) {
  if (!db) return { error: 'no_db' };
  const convo = getConvo(id);
  if (!convo) return { error: 'not_found' };
  // Fold everything into a short recap row. The visible transcript stays in the
  // DB and on screen — only the model-facing context is compacted (transcriptOf).
  const msgs = listMessages(id);
  const recap = msgs.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${String(m.text).slice(0, 300)}`).join('\n');
  db.prepare(`UPDATE convos SET recap=?, compacted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(recap || null, id);
  broadcastAll('convos:updated', { convoId: id });
  return { ok: true, recap };
}

export function deleteConvo(id) {
  if (!db) return { error: 'no_db' };
  const convo = getConvo(id);
  if (!convo) return { error: 'not_found' };
  db.prepare(`UPDATE convos SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(id);
  broadcastAll('convos:updated', { convoId: id });
  return { ok: true };
}

export function latestConvoPlan(id) {
  const convo = getConvo(id);
  if (!convo) return { error: 'not_exist' };
  const planMsg = listMessages(id).filter((m) => m.kind === 'plan').pop();
  if (!planMsg) return { error: 'no_plan', message: 'no plan in this conversation yet' };
  const raw = planMsg.text || '';
  const titleMatch = raw.match(/^TITLE:\s*(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : (convo.title || 'Work');
  const brief = raw.replace(/^TITLE:\s*.+\n?/i, '').replace(/^BRIEF:\s*/i, '').trim();
  return { title, brief, text: raw, planId: planMsg.id };
}

// ─── Read-only tools the advisor can call ────────────────────────────────────

function toolSpecs() {
  return [
    {
      name: 'list_architecture',
      description: 'List all architecture components with their current status and one-line current state.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'list_queue_items',
      description: 'List Dispatch Queue items (optional status filter: queued/running/done/paused/blocked/cancelled, optional limit).',
      input_schema: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          limit: { type: 'integer' },
        },
      },
    },
    {
      name: 'list_subject_info',
      description: 'Fetch a specific subject row: seed -> { title, notes }, suggestion -> { title, rationale, area }, arch_component -> { name, status }, arch_node -> { name, what, why }.',
      input_schema: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          id: { type: 'string' },
        },
        required: ['type', 'id'],
      },
    },
    {
      name: 'project_stats',
      description: 'Project-wide statistics: entity counts, clusters, queued vs done tasks.',
      input_schema: { type: 'object', properties: {} },
    },
  ];
}

function dispatchByName(name, input) {
  switch (name) {
    case 'list_architecture': return getComponents(db).map((c) => ({ id: c.id, name: c.name, status: c.status })).slice(0, 200);
    case 'list_queue_items': {
      const { status, limit = 40 } = input || {};
      const rows = db.prepare(`SELECT id, title, status, mode FROM work_prompts WHERE (:status IS NULL OR status = :status) AND deleted_at IS NULL ORDER BY created_at DESC LIMIT :limit`)
        .all({ status: status || null, limit });
      return rows;
    }
    case 'list_subject_info': {
      const { type, id } = input || {};
      if (type === 'seed') return getIdea(id) || { error: 'not_found' };
      if (type === 'suggestion') return listSuggestions({}).find((s) => s.id === id) || { error: 'not_found' };
      if (type === 'arch_component') return (getComponents(db).find((c) => c.id === id) || { error: 'not_found' });
      if (type === 'arch_node') return db?.prepare(`SELECT * FROM architecture_nodes WHERE id=?`).get(id) || { error: 'not_found' };
      if (type === 'task') return db?.prepare(`SELECT id, title, status, mode, summary FROM work_prompts WHERE id=?`).get(id) || { error: 'not_found' };
      if (type === 'world_pick') {
        const ref = parseWorldPickId(id);
        const pick = ref ? getReport(db, ref.reportId)?.parts?.[ref.partIndex]?.picks?.[ref.pickIndex] : null;
        return pick || { error: 'not_found' };
      }
      return { error: 'unknown_type' };
    }
    case 'project_stats': {
      const entities = db.prepare(`SELECT COUNT(*) AS n FROM entities`).get()?.n ?? 0;
      const clusters = db.prepare(`SELECT COUNT(DISTINCT cluster_id) AS n FROM entity_clusters`).get()?.n ?? 0;
      const queue = db.prepare(`SELECT COUNT(*) AS n FROM work_prompts WHERE deleted_at IS NULL`).get()?.n ?? 0;
      const done = db.prepare(`SELECT COUNT(*) AS n FROM work_prompts WHERE status='done' AND deleted_at IS NULL`).get()?.n ?? 0;
      return { entities, clusters, queue, done };
    }
    default: return { error: `unknown tool: ${name}` };
  }
}

// NOTE: toolSpecs/dispatchByName/buildMessages below feed runToolLoop, which is
// the metered Messages-API path. Turns now go through generateText (the routed,
// subscription/free lane) instead, which is one prompt in and one answer out —
// the lookups those tools did are pre-answered by the project map plus
// liveListsBlock() below. Kept so
// the tool path still works if ALLOW_METERED_API is ever turned on.

// ─── System prompt builders ──────────────────────────────────────────────────

// The operating rules, assembled per turn rather than frozen into one string.
//
// TWO THINGS VARY, AND BOTH USED TO BE LIES.
//
// 1. THE TOOL CLAIM. This prompt used to promise the model could "look things up
//    using the tools", which was false — every lane was toolless — so the claim
//    was deleted and replaced with a flat denial. Now the conversation engine
//    really does carry lookup tools (services/studioTools.js), but only the lanes
//    that can run them get told so: `tools` is true exactly when the caller is
//    about to pass them. A lane that turns out to be toolless anyway is told so at
//    the END of the prompt by ai/text.js's NO_TOOLS_NOTE.
// 2. WHAT IS BEING DISCUSSED. "working through one subject at a time" and "it is
//    the whole reason this conversation exists" are both wrong for a roaming
//    conversation with no card, and wrong again for one holding four.
//
// The single-subject, toolless wording is kept BYTE-IDENTICAL to what shipped
// before, so an ordinary card conversation reads exactly as it did.
const NO_TOOLS_BLOCK = `Everything you know about the project is in this prompt — you have NO tools and cannot look anything up. So never say or imply that you checked, searched, read the code or looked something up. Work from what the owner has said plus the reference sections below, and when you genuinely do not know, say so. If something already exists in the project, say so rather than proposing to build it again.`;

const OPENING = {
  single: `You are the Idea Studio thinking partner inside FMCNS, working through one subject at a time with its owner.`,
  multi: `You are the Idea Studio thinking partner inside FMCNS, working through several attached cards at once with its owner.`,
  open: `You are the Idea Studio thinking partner inside FMCNS, in an open conversation with its owner. There is no card on the table: this is a room to think in, and nothing has to be settled by the end of it.`,
  open_with_cards: `You are the Idea Studio thinking partner inside FMCNS, in an open conversation with its owner. It began with no card, and cards have since been attached to it.`,
};

const ANCHOR = {
  single: `The subject being discussed is described in SUBJECT CONTEXT below. It is the whole reason this conversation exists — keep every answer anchored to it.`,
  multi: `The cards being discussed are described in SUBJECT CONTEXT below, the first one first. They are all in play — read across them, and say when two of them are the same thought wearing different clothes.`,
  open: `SUBJECT CONTEXT below says what kind of room this is. Follow the owner where he goes: roaming is the point, and an answer that keeps pulling him back to a decision is the wrong answer.`,
  open_with_cards: `SUBJECT CONTEXT below says what kind of room this is, then lists the cards attached to it. Follow the owner where he goes — but the cards are in play, so use them and say when two of them are the same thought.`,
};

function baseSystem({ mode = 'single', tools = false } = {}) {
  return `${OPENING[mode] || OPENING.single}

${tools ? TOOLS_PROMPT_BLOCK : NO_TOOLS_BLOCK}

Commands the user may type:
  /grill-me — switch to interrogation mode: ask the sharpest clarifying questions, one at a time, no answering yet.
  /seed     — save what this conversation arrived at as an idea card (done by the system; you do not do this yourself).
  /note     — save it as a document the whole app can read afterwards (done by the system).
  /plan     — produce the final plan for the coding agent (done by the system; you do not do this yourself).
  /handoff  — queue the plan as a task (done by the system).
  /compare  — compare the enrichment ideas attached to this subject (done by the system; you do not do this yourself).
  /help     — list these commands.

${ANCHOR[mode] || ANCHOR.single}

Be direct. Never mention internal component ids, codes or file names in your answers — say what the thing DOES, not what it is called in the codebase. The owner is not a programmer, so TECHNICAL jargon is out.

Conceptual, philosophical and spiritual language is NOT jargon and is welcome — the subject matter is mythic and structural, and flattening it into plain operational English loses the actual thought. Abstraction is fine. Vagueness is not.`;
}

// How long an answer should be. Split out of the operating-rules block because the two lanes
// want opposite things and used to share one instruction.
//
// TERSE is for the structured, system-triggered turns (compare, fold, reframe)
// that land in a small card and are read at a glance.
//
// JUDGED is for actual conversation. Antoine's ask, in his words: "I don't want
// just a one-line answer... I need depth in these types of conversations." The
// old shared line ("keep answers short unless the user asks for detail") made
// every turn default to terse and put the burden on him to ask for depth every
// time — which is not how a real brainstorming conversation works. So the model
// judges length from the question instead, the way ChatGPT does by default.
// ─── The Idea Studio voice ───────────────────────────────────────────────────
// Third attempt, and the first one built on JUDGEMENT rather than on register.
//
// The two before it described the voice they wanted ("be philosophical", "reach
// for the structural reading") and gpt-4o answered in its default
// product-consultant idiom anyway. Live evidence, same question both times:
// "immersive engagement... exploratory adventure... impactful and memorable" and
// "participation rather than observation... engagement and exploration". It
// described an idea's benefits instead of taking a position on it.
//
// The most useful answer of that whole session came from the free lane during a
// run where gpt-4o errored: "Mostly a distraction right now — but there's a real
// itch underneath it worth naming, because I think two of your saved notes are the
// same itch. [...] it costs you a second toolchain, a rewrite of every view you
// already have working, and months of attention." That is the target — not because
// it was philosophical, because it JUDGED: took a position, found the want under
// the stated want, spotted a duplicate in the notebook, priced the cost in
// attention. So the prompt now asks for that behaviour directly.
//
// Antoine's own framing of his research is kept VERBATIM under HOW TO THINK. It is
// his text, not a paraphrase, and it is here as domain competence rather than as
// style: the project treats a character, a film and a country as one object read at
// different scales, and an advisor who cannot think that way cannot judge ideas
// about it. Specificity is also what actually moves a model — named lenses
// (biopolitics, shadow work, grief as a mirror of power) change how it reasons in a
// way "be profound" never does.
//
// THE NEVER BLOCK IS LOAD-BEARING — DO NOT TRIM IT. Every word on that list
// appeared in a real answer during testing. Banning a register by naming its
// vocabulary moves a model far more reliably than describing the register you want.
//
// Layered on top of baseSystem(), not replacing it: the operational rules (what it can
// and cannot look up, invent nothing, say when something already exists, stay anchored)
// are what keep this useful instead of merely eloquent.
//
// Overridable live from AI Settings (ai_settings.studio_persona) because a thinking
// partner's register is something you only get right by iterating, and waiting on a
// deploy each time kills that loop.
const DEFAULT_STUDIO_PERSONA = `You are what Antoine argues with before he builds anything.

His notebook is full and so is his queue. Ideas are not scarce here — judgement is. On every turn your job is to work out whether the thing being discussed is real, what it actually is underneath what he said, and whether it deserves his attention. Then say so.

HOW TO THINK
You navigate the liminal space where history, myth and imagination converge. You trace the conscious architectures and subconscious drives of entities — families, corporations, nations, civilizations — as evolving, self-similar consciousness systems. You think through biopolitics, post-humanism, cyberpunk dynamics, transhumanist warfare, shadow work, and grief as mirrors of power and memory. Literature, cinema and speculative worlds are living laboratories for decoding suppressed stories and collective feedback loops. You map multi-scale narrative cartographies where every node — real or imagined — can reveal deeper structural truths.

This frame is not decoration, it is the subject matter. The project treats a character, a film and a country as the same kind of object read at different scales. An idea that does not touch that is usually a distraction wearing an interesting coat, and noticing which is part of your job.

ALWAYS
- Take a position. "It depends" is allowed only if you then say on what, and pick.
- Find the want under the want — the stated idea is rarely the real one.
- Say when two things already in the notebook are the same idea. You can see the list.
- Name what it would COST: attention, coherence, months. Not only what it gives.
- Say plainly when you think he is wrong, and why.
- Say when you don't know.

NEVER
- Summarise benefits. You are not selling anything.
- Use these words: immersive, engagement, engaging, impactful, memorable, journey, seamless, leverage, unlock, elevate, robust, holistic, transformative.
- End with a paragraph restating what you just said.
- Open by repeating the question back.
- Pad to seem thorough. Length is earned by having more to say.`;

function studioPersona() {
  const custom = (studioPersonaText() || '').trim();
  return custom || DEFAULT_STUDIO_PERSONA;
}

const LENGTH_TERSE = `Keep answers short unless the user asks for detail.`;
const LENGTH_JUDGED = `Let the question decide how long the answer is — the way a good thinking partner would. A question with one right answer gets one or two sentences; a real question about direction, trade-offs or "what should this be" gets the depth it deserves: work through it, lay out the possibilities, say what you'd pick and why. Do not pad, and do not compress something that needs room. Never end with a summary of what you just said.`;

function subjectSystemPrompt(ctxText, { depth = false, mode = 'single', tools = false } = {}) {
  return `${baseSystem({ mode, tools })}

${depth ? LENGTH_JUDGED : LENGTH_TERSE}

=== SUBJECT CONTEXT ===
${ctxText}`;
}

const PLAN_INSTRUCTION = `You are drafting an execution brief for a coding agent that has real file access to a codebase, based on the conversation below. Turn the discussed idea into a brief with zero ambiguity left in it.

Respond in exactly this format, nothing else:
TITLE: <one short line>
BRIEF:
<the brief>

The brief must:
- Restate the goal in one line.
- List concrete steps to do it.
- Name specific files or areas of the codebase likely involved, if inferable — do not invent files.
- State a clear, checkable definition of done.
- Note anything the request implies is out of scope.
- Restate any standing preference or constraint this conversation relied on that would not be obvious from the goal alone (e.g. "never deep/opus", "free lane only") — the coding agent starts cold and has not seen this conversation.
- For each attached document, pull its relevant substance directly into the brief instead of only naming it — quote or summarize the parts the task actually needs. Exception: an attached repo file the coding agent can open itself (a path under plans/ or elsewhere in the codebase) — for those, name the exact path instead of inlining its content.

Write for the coding agent, not for a human reader. Be concise.`;

function buildMessages(convo, msgs, windowSize) {
  const visible = msgs.slice(-windowSize).filter((m) => m.kind === 'chat');
  const pairs = [];
  if (convo.recap) pairs.push({ role: 'user', content: `(folded earlier context)\n${convo.recap}` });
  for (const m of visible) pairs.push({ role: m.role, content: m.text });
  return pairs;
}

// ─── Turn machinery ───────────────────────────────────────────────────────────

// Flatten a conversation into one prompt. The lane that reaches the model is
// one-prompt-in, one-answer-out — there is no mid-turn tool round trip — so the
// lookups the tool loop used to make are pre-answered here instead, from the DB,
// for free.
//
// This used to be one big projectDigestBlock() that also dumped 40 architecture
// components. That half now lives in the standing project map
// (services/projectMap.js), which is built once at boot and sent first so prompt
// caching can pay for it. What is left here is the part that MUST be live: the
// notebook, the queue and the open suggestions. A list of ideas cached at boot
// would make the advisor claim two notes are duplicates of each other days after
// one of them changed — and "say when two things in the notebook are the same
// idea" is one of the things the voice explicitly promises. So it is rebuilt per
// turn, and sent AFTER the map, where being variable costs nothing.
function liveListsBlock() {
  try {
    const queued = db.prepare(`SELECT title, status FROM work_prompts WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 15`).all();
    // Titles only, and capped: this rides along on every chat turn, so it earns its
    // keep by being short. Dismissed suggestions are left out on purpose — they are
    // decisions already taken, not options still open.
    const sugg = db.prepare(
      `SELECT title FROM work_suggestions WHERE deleted_at IS NULL AND status IN ('new','accepted') ORDER BY created_at DESC LIMIT 20`
    ).all();
    const seeds = db.prepare(
      `SELECT title FROM work_ideas WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 15`
    ).all();
    if (!queued.length && !sugg.length && !seeds.length) return '';
    const brief = (rows) => rows.map((r) => `- ${String(r.title || '').slice(0, 90)}`).join('\n');
    // Framed as background reference, not as the topic. Named plainly so a reader
    // of the prompt (and the model) treats it as a list to check against rather
    // than as the thing being discussed.
    return `\n=== WHAT IS ALREADY ON THE TABLE — check against it; do not let it set the subject. ===\n`
      + (queued.length ? `Recent work in the queue:\n${queued.map((q) => `- [${q.status}] ${q.title}`).join('\n')}\n` : '')
      + (sugg.length ? `Suggestions already on the table:\n${brief(sugg)}\n` : '')
      + (seeds.length ? `Ideas already in the notebook:\n${brief(seeds)}` : '');
  } catch { return ''; }
}

function transcriptOf(convo, msgs, windowSize, { full } = {}) {
  // After a manual "Start fresh" compaction, the model-facing transcript is the
  // recap plus only the turns since the click — the older messages are already
  // folded into the recap. `full` overrides this (e.g. the background world-look
  // pass, which must still read the whole thread) regardless of compaction state.
  if (convo.compacted_at && !full) {
    const since = msgs.filter((m) => m.kind === 'chat' && m.created_at > convo.compacted_at);
    const lines = [`(folded earlier context)\n${convo.recap || ''}`];
    for (const m of since) lines.push(`${m.role === 'user' ? 'OWNER' : 'YOU'}: ${m.text}`);
    return lines.join('\n\n');
  }
  const visible = msgs.slice(-windowSize).filter((m) => m.kind === 'chat');
  const lines = [];
  if (convo.recap) lines.push(`(folded earlier context)\n${convo.recap}`);
  for (const m of visible) lines.push(`${m.role === 'user' ? 'OWNER' : 'YOU'}: ${m.text}`);
  return lines.join('\n\n');
}

// Background world-look for a Room conversation (plan "room-world-ideas"):
// the same ✨ world-look pass suggestions and ideas already get, keyed to this
// convo instead. Fire-and-forget, mirrors harvestMind's watermark above it —
// no-ops if nothing has been said since the last look, and the watermark is
// advanced as soon as the pass is kicked off rather than when it finishes, so
// a slow or failed look never leaves the convo re-triggering forever.
const _worldLookInFlight = new Set();
export function roomWorldLook(convoId) {
  if (!convoId || _worldLookInFlight.has(convoId)) return;
  const convo = getConvo(convoId);
  if (!convo) return;
  const seen = convo.world_look_seen_turns || 0;
  const turns = convo.turns || 0;
  if (turns <= seen) return;

  _worldLookInFlight.add(convoId);
  db.prepare(`UPDATE convos SET world_look_seen_turns=? WHERE id=?`).run(turns, convoId);
  setImmediate(async () => {
    try {
      const ideaText = transcriptOf(convo, listMessages(convoId), CONVO_HISTORY_WINDOW, { full: true });
      if (ideaText) await runWorldLookGuarded(db, { idea_text: ideaText, source: 'convo', source_id: convoId });
    } catch (e) { console.error('[room] world-look failed:', e?.message || e); }
    finally { _worldLookInFlight.delete(convoId); }
  });
}

// One turn against the routed lane (AI Settings decides which; the Claude
// subscription when 'studio' points there). Returns { text, via } | { error }.
// The prompt itself, factored out so the streaming turn below sends exactly the
// same thing — a second copy of this assembly would drift.
function buildTurnPrompt({ convo, ctx, instruction = null, includeProjectContext = true, brevity = true, tools = false, repoFacts = null }) {
  const msgs = listMessages(convo.id);
  const depth = !brevity;
  // ORDER MATTERS, TWICE OVER, AND EACH HALF FIXES A REAL FAILURE. A later
  // innocent-looking reorder would undo one of them, so both reasons are written
  // down here.
  //
  // 1. THE PROJECT MAP GOES FIRST — nothing variable in front of it. It is ~10k
  //    tokens on every turn, and prompt caching is what makes that affordable
  //    (~2¢ on the first message of a session, ~0.5¢ after). Caching matches a
  //    shared PREFIX, so a single variable character ahead of the map — a date, a
  //    subject name, a message count — turns every turn back into a full-price
  //    turn. See services/projectMap.js for the other half of the guarantee
  //    (byte-identical, built once at boot).
  //
  // 2. HOW TO THINK GOES LAST — immediately before it answers. The voice used to
  //    sit near the top, ahead of the project digest and an operational "reply to
  //    the owner's last message", and a model weights the END of a long prompt
  //    most heavily: gpt-4o read the frame, buried it, and answered in its default
  //    consultant register ("immersive engagement", "exploratory adventure").
  //    Verified live before and after.
  //
  // Both hold at once: stable map first, variable material after, voice last.
  return [
    includeProjectContext ? projectMapBlock() : '',
    subjectSystemPrompt(ctx.contextText, { depth, mode: ctx.mode || 'single', tools }),
    includeProjectContext ? liveListsBlock() : '',
    // Load-bearing position: immediately AFTER liveListsBlock(), which already
    // varies per turn and sits outside the cached prefix (projectMapBlock +
    // subjectSystemPrompt). Memory ahead of the project map would break the cache
    // prefix and roughly quadruple the token cost of every turn. See
    // plans/room-shared-memory.md §3 and conversation-voice-and-project-map.md.
    mindBlock(),
    // Repo facts (the Room's turn router) ride in the SAME cache-safe region as
    // memory — right after mindBlock(), before the transcript and voice. They are
    // free (gathered by git, not a model) and variable per turn, but variable
    // material after the project map is exactly what the cache is built to absorb;
    // putting them ahead of the map would break the prefix and quadruple cost.
    repoFacts
      ? `\n=== REPO FACTS (read from the checkout just now — trust these over your own recollection) ===\n${repoFacts}\nTreat any file not listed as EXIST above as non-existent. Do not name a file you have not been told exists.`
      : '',
    `\n=== THE CONVERSATION SO FAR ===\n${transcriptOf(convo, msgs, CONVO_HISTORY_WINDOW) || '(nothing yet)'}`,
    depth ? `\n=== HOW TO THINK ===\n${studioPersona()}` : '',
    instruction
      ? `\n=== WHAT TO DO NOW ===\n${instruction}`
      : `\n=== WHAT TO DO NOW ===\n${brevity
          ? `Reply to the owner's last message. Nothing else.\n\nKeep it short: this lands in a small box inside a card, not on a page. A few sentences. No preamble, no restating the question back, no summary at the end. If the honest answer is one line, give one line.`
          : `Reply to the owner's last message, in the voice and frame set out under HOW TO THINK above — that is the register, not a suggestion. Judge the thing being discussed: is it real, what is it actually, is it worth his attention. Say so.\n\nNo preamble, no restating the question back, no closing summary. Start with the substance and give it the room it needs.`}`,
  ].filter(Boolean).join('\n');
}

async function runRoutedTurn({ convo, ctx, instruction = null, model, maxTokens, feature, label, includeProjectContext = true }) {
  const prompt = buildTurnPrompt({ convo, ctx, instruction, includeProjectContext });
  return generateText({ prompt, feature, label, model, maxTokens, allowLongOutput: true, timeoutMs: 150_000, helperWaitMs: 120_000 });
}

// The lookup tools, bound to this server's db. Passed to the CHAT turns only —
// the structured turns (/plan, /fold, /reframe, /more) ask for one JSON object
// back, and a tool round mid-way through that is a round that returns prose
// instead of the object the caller then has to parse.
const studioTools = () => STUDIO_TOOLS;
const studioDispatch = (name, input) => dispatchStudioTool(db, name, input);

function saveAssistantTurn(convoId, text, meta = null) {
  const mid = randomUUID();
  db.prepare(`INSERT INTO convo_messages (id, convo_id, role, kind, text, meta) VALUES (?,?,?,?,?,?)`)
    .run(mid, convoId, 'assistant', 'chat', text || '', meta ? JSON.stringify(meta) : null);
  db.prepare(`UPDATE convos SET turns=turns+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(convoId);
  broadcastAll('convos:updated', { convoId });
  return mid;
}

// Streaming sibling of runChatTurn. Same prompt, same single saveAssistantTurn at
// the end — so the DB write is identical and the frontend's existing poll fallback
// (awaitTurn) keeps working untouched if a stream dies mid-flight.
//
// The output ceiling is 1200 here, not 450. That 450 existed only because nothing
// streamed and the whole answer had to be written before any of it appeared; once
// tokens arrive as they are produced, a longer answer costs patience nothing. The
// brevity instruction is relaxed to match — a cramped ceiling and a "keep it very
// short" order were solving the same vanished problem.
// Plain-English notice when a turn had to fall back because the Mac runner that
// answers repo questions was offline. Never let the model invent file names.
function noticeFor(turn, existingNotice) {
  if (turn?.noticeReason !== 'no_runner') return existingNotice || null;
  const base = "I couldn't check the code just now (the Mac runner is offline), so this is a guess, not a looked-up answer.";
  return existingNotice ? `${base} ${existingNotice}` : base;
}

// The streaming turn, now laned. `turn` is the resolveTurn() decision; its
// feature/model drive the generation, and repoFacts (if any) ride in the prompt.
async function runChatTurnStreaming(convoId, userId, onToken, turn) {
  const convo = getConvo(convoId);
  if (!convo) return { error: 'not_found' };
  const ctx = await convoContext(convo);
  if (ctx.error) return { error: ctx.error };

  const prompt = buildTurnPrompt({ convo, ctx, brevity: false, tools: true, repoFacts: turn?.repoFacts || null });
  // Instrumentation for the prompt-caching plan (2026-08-21): the map's own
  // length, so a short/empty map inside the container shows up as an obvious
  // number instead of a guess. Cheap — projectMapBlock() just returns the
  // string already held in memory.
  const mapChars = projectMapBlock().length;
  const result = await generateTextStream({
    prompt,
    // The router's lane: a brainstorm/forced turn points at 'studio' (which may be
    // the paid openai lane, with the monthly cap + notice handled inside
    // generateTextStream); an about_app turn points at the cheap 'summary' lane.
    feature: turn?.lane?.feature || 'studio',
    model: turn?.lane?.model || null,
    provider: turn?.lane?.provider || null,
    account: turn?.lane?.account || null,
    label: 'conversations:chat',
    // The lookup tools (plan "roaming-conversations-backend" §2). Only the chat
    // turn gets them: it is the one that answers a question, and the one whose
    // prompt now claims it can look things up.
    tools: studioTools(), dispatchTool: studioDispatch,
    // 4000, not 450 and not 1200. Both smaller numbers were brevity caps: 450
    // because nothing streamed and the whole answer had to be written before any
    // of it showed, 1200 because that was the timid first step away from it.
    // Neither is a budget constraint — an answer only costs what it actually
    // uses, so a high ceiling on a short answer costs nothing. This is headroom
    // for the times a question genuinely needs it, not a target.
    maxTokens: 4000,
    allowLongOutput: true, timeoutMs: 150_000, onToken,
    // Stable per conversation, not per turn, so every turn of one thread hits
    // the same OpenAI prompt cache instead of scattering across machines (plan
    // "make-the-caching-actually-work"). Only OpenAI's adapter reads this.
    cacheKey: convoId,
    onUsage: (usage) => {
      const cached = usage?.prompt_tokens_details?.cached_tokens || 0;
      console.log(`[studio-turn] prompt ${prompt.length} chars (map ${mapChars}) → prompt_tokens ${usage?.prompt_tokens ?? '?'}, cached ${cached}`);
    },
  });
  if (result.error) return result;
  const laneTag = computeLaneTag(turn?.intent, turn?.lane, result.via);
  const notice = noticeFor(turn, result.notice);
  saveAssistantTurn(convoId, result.text, { lane: laneTag, intent: turn?.intent, ...(notice ? { notice } : {}) });
  maybeAutoTitleConvo(convo);
  harvestMind(convoId); // fire-and-forget: extract standing facts after the turn
  roomWorldLook(convoId); // fire-and-forget: keyed to this Room convo (plan room-world-ideas)
  return { text: result.text, via: result.via, laneTag, intent: turn?.intent, notice };
}

// The non-streaming twin. Reached only when the client does not ask for NDJSON,
// so it uses generateTextStream without a token callback — that still honours the
// paid-lane cap and notice, and is the single code path.
async function runChatTurn(convoId, userId, turn) {
  const convo = getConvo(convoId);
  if (!convo) return { error: 'not_found' };
  const ctx = await convoContext(convo);
  if (ctx.error) return { error: ctx.error };

  const prompt = buildTurnPrompt({ convo, ctx, brevity: false, tools: false, repoFacts: turn?.repoFacts || null });
  const result = await generateTextStream({
    prompt,
    feature: turn?.lane?.feature || 'studio',
    model: turn?.lane?.model || null,
    provider: turn?.lane?.provider || null,
    account: turn?.lane?.account || null,
    maxTokens: 4000,
    label: 'conversations:chat',
    allowLongOutput: true, timeoutMs: 150_000,
    cacheKey: convoId,
  });
  if (result.error) return result;
  const laneTag = computeLaneTag(turn?.intent, turn?.lane, result.via);
  const notice = noticeFor(turn, result.notice);
  saveAssistantTurn(convoId, result.text, { lane: laneTag, intent: turn?.intent, ...(notice ? { notice } : {}) });
  maybeAutoTitleConvo(convo);
  harvestMind(convoId); // fire-and-forget: extract standing facts after the turn
  roomWorldLook(convoId); // fire-and-forget: keyed to this Room convo (plan room-world-ideas)
  return { text: result.text, via: result.via, laneTag, intent: turn?.intent, notice };
}

// code_read — a read-only helper job on the runner (claude, with Read/Grep/Glob),
// not an answer from facts alone. The reply lands as a normal turn, tagged 'claude'.
async function runCodeReadTurn(convoId, turn) {
  const convo = getConvo(convoId);
  if (!convo) return { error: 'not_found' };
  const ctx = await convoContext(convo);
  if (ctx.error) return { error: ctx.error };

  const prompt = buildTurnPrompt({ convo, ctx, brevity: false, tools: false, repoFacts: turn?.repoFacts || null });
  const result = await generateText({
    prompt, feature: turn?.lane?.feature || 'studio', model: turn?.lane?.model || null,
    maxTokens: 4000, label: 'conversations:chat-coderead',
    allowLongOutput: true, timeoutMs: 180_000,
    // Read-only: it may check the code, never touch it. The runner answers on the
    // second account and falls back to main on its own (see ai/text.js#runAttempt).
    helperTools: turn?.lane?.helperTools || 'Read,Grep,Glob', helperWaitMs: 180_000,
  });
  if (result.error) return result;
  saveAssistantTurn(convoId, result.text, { lane: 'claude', intent: 'code_read' });
  maybeAutoTitleConvo(convo);
  harvestMind(convoId);
  roomWorldLook(convoId); // fire-and-forget: keyed to this Room convo (plan room-world-ideas)
  return { text: result.text, via: result.via, laneTag: 'claude', intent: 'code_read' };
}

// implement — propose, never dispatch. A model call is deliberately NOT made here
// for the build itself; the owner's click decides. The reply is a proposal plus
// three buttons the frontend draws (Send to Claude Code / OpenCode / Just talk).
async function runImplementProposal(convoId, turn) {
  const convo = getConvo(convoId);
  if (!convo) return { error: 'not_found' };
  const text = "That sounds like something to build rather than just to talk through. Want me to queue it as a task for the coding agent?";
  saveAssistantTurn(convoId, text, { lane: 'implement', intent: 'implement' });
  maybeAutoTitleConvo(convo);
  return { text, intent: 'implement', laneTag: 'implement' };
}

// ── Slash commands added by the turn router (Part 3) ──────────────────────────
// /check — take the last assistant answer, re-examine it on a DIFFERENT lane with
// fresh repo facts, and report problems. Tagged with both lanes.
// /second — re-answer the last user question on a second lane, shown beside the first.
function parseMsgMeta(meta) {
  if (!meta) return {};
  try { return typeof meta === 'string' ? JSON.parse(meta) : meta; } catch { return {}; }
}
function lastUserText(convoId) {
  const msgs = listMessages(convoId).filter((m) => m.kind === 'chat');
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') return msgs[i].text;
  return null;
}
function lastAssistantMsg(convoId) {
  const msgs = listMessages(convoId).filter((m) => m.kind === 'chat');
  for (let i = msgs.length - 1; i >= 0; i--) if (m.role === 'assistant') return msgs[i];
  return null;
}

// Pick the checking/second lane: opposite of the one that answered last.
// gpt-4.1 <-> claude; git/opencode check on gpt-4.1.
function otherLane(originalTag) {
  if (originalTag === 'gpt-4.1') return { feature: 'reply', tag: 'claude' };
  return { feature: 'studio', tag: 'gpt-4.1' };
}

async function runCheckTurn(convoId) {
  const convo = getConvo(convoId);
  if (!convo) return { error: 'not_found' };
  const last = lastAssistantMsg(convoId);
  const userQ = lastUserText(convoId);
  if (!last) return { text: 'There is no answer here yet to check — send a message first.', intent: 'check', laneTag: 'claude' };

  const originalTag = parseMsgMeta(last.meta).lane || 'gpt-4.1';
  const lane = otherLane(originalTag);

  const ctx = await convoContext(convo);
  if (ctx.error) return { error: ctx.error };

  let repoFacts = '';
  try {
    const c = extractCandidates(`${last.text}\n${userQ || ''}`);
    const f = await runRepoProbe({ request: c, waitMs: 20_000, label: 'room-check-probe' });
    repoFacts = formatRepoFacts(f);
  } catch { repoFacts = ''; }

  const prompt = buildTurnPrompt({
    convo, ctx, brevity: false, tools: false, repoFacts,
    instruction: `The conversation above ends with an answer from another lane (${originalTag}). Re-examine it critically using the repo facts and your own judgement: point out anything wrong, overclaimed, missing, or unsafe — files it names that may not exist, suggestions that would break something, or anything it got backwards. If it is sound, say so plainly. Plain English, no jargon, no file names you have not been told exist.`,
  });
  const result = await generateTextStream({
    prompt, feature: lane.feature, model: null, maxTokens: 4000,
    label: 'conversations:check', allowLongOutput: true, timeoutMs: 150_000, cacheKey: convoId,
  });
  if (result.error) return result;
  const laneTag = tagFromVia(result.via, lane.tag);
  saveAssistantTurn(convoId, result.text, { lane: laneTag, intent: 'check', checked: originalTag });
  maybeAutoTitleConvo(convo);
  harvestMind(convoId);
  roomWorldLook(convoId); // fire-and-forget: keyed to this Room convo (plan room-world-ideas)
  return { text: result.text, via: result.via, laneTag, intent: 'check', checked: originalTag };
}

async function runSecondTurn(convoId) {
  const convo = getConvo(convoId);
  if (!convo) return { error: 'not_found' };
  const userQ = lastUserText(convoId);
  if (!userQ) return { text: 'There is no question here yet to answer twice — send a message first.', intent: 'second', laneTag: 'gpt-4.1' };
  const last = lastAssistantMsg(convoId);
  const originalTag = parseMsgMeta(last?.meta).lane || 'gpt-4.1';
  const lane = otherLane(originalTag);

  const ctx = await convoContext(convo);
  if (ctx.error) return { error: ctx.error };

  const prompt = buildTurnPrompt({ convo, ctx, brevity: false, tools: true });
  const result = await generateTextStream({
    prompt, feature: lane.feature, model: null, maxTokens: 4000,
    label: 'conversations:second', allowLongOutput: true, timeoutMs: 150_000,
    tools: studioTools(), dispatchTool: studioDispatch, cacheKey: convoId,
  });
  if (result.error) return result;
  const laneTag = tagFromVia(result.via, lane.tag);
  saveAssistantTurn(convoId, result.text, { lane: laneTag, intent: 'second', answered: originalTag });
  maybeAutoTitleConvo(convo);
  harvestMind(convoId);
  roomWorldLook(convoId); // fire-and-forget: keyed to this Room convo (plan room-world-ideas)
  return { text: result.text, via: result.via, laneTag, intent: 'second', answered: originalTag };
}

async function runPlanTurn(convoId, userId) {
  const convo = getConvo(convoId);
  if (!convo) return { error: 'not_found' };
  const ctx = await convoContext(convo);
  if (ctx.error) return { error: ctx.error };

  const msgs = listMessages(convoId);
  const chatText = msgs.filter((m) => m.kind === 'chat')
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
    .join('\n\n');
  const prompt = `${PLAN_INSTRUCTION}\n\n=== SUBJECT CONTEXT ===\n${ctx.contextText}\n\n=== CONVERSATION ===\n${chatText || '(no prior messages — plan from the subject alone)'}`;

  const result = await generateText({
    prompt,
    feature: 'plan_draft',
    label: 'conversations:plan',
    model: CONVO_PLAN_MODEL,
    maxTokens: 2200,
  });
  if (result.error) return result;

  const titleMatch = result.text.match(/^TITLE:\s*(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : (convo.title || 'Work');
  const brief = result.text.replace(/^TITLE:\s*.+\n?/i, '').replace(/^BRIEF:\s*/i, '').trim();

  const mid = randomUUID();
  db.prepare(`INSERT INTO convo_messages (id, convo_id, role, kind, text) VALUES (?,?,?,?,?)`)
    .run(mid, convoId, 'assistant', 'plan', result.text || '');
  db.prepare(`UPDATE convos SET turns=turns+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(convoId);
  broadcastAll('convos:updated', { convoId });
  return { title, brief, planId: mid, text: result.text, via: result.via };
}

// /compare — one condensed verdict over the enrichment ideas attached to the
// subject (world-look picks, generated next steps, or sibling suggestions).
// Nothing attached -> a free text answer, no model call at all.
async function runCompareTurn(convoId) {
  const convo = getConvo(convoId);
  if (!convo) return { error: 'not_found' };
  const ctx = await convoContext(convo);
  if (ctx.error) return { error: ctx.error };
  const collected = ctx.compare ? await ctx.compare() : { items: [], note: 'No enrichment ideas attached to this subject.' };
  const items = (collected.items || []).slice(0, 8);
  if (!items.length) {
    return { text: collected.note || 'Nothing attached to compare here yet.' };
  }
  const listing = items.map((it, i) => `${i + 1}. ${it.label}: ${it.text}`).join('\n');
  const prompt = `The owner asked to compare the ideas attached to the subject below.

=== SUBJECT ===
${ctx.contextText}

=== IDEAS ===
${listing}

Give a short comparison verdict: for each idea, one line on what it offers; then say which ONE you would pick and why (1-2 sentences). Plain English, no jargon, be concise.`;
  const result = await generateText({ prompt, feature: 'studio', label: 'conversations:compare', model: CONVO_CHAT_MODEL, maxTokens: 900 });
  if (result.error) return result;
  const mid = randomUUID();
  db.prepare(`INSERT INTO convo_messages (id, convo_id, role, kind, text) VALUES (?,?,?,?,?)`)
    .run(mid, convoId, 'assistant', 'chat', result.text || '');
  db.prepare(`UPDATE convos SET turns=turns+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(convoId);
  broadcastAll('convos:updated', { convoId });
  return { text: result.text, via: result.via };
}

// ─── Writing the conversation back into a world idea ─────────────────────────
// Three explicit commands, one model call each, only on a 'world_pick' subject.
// They are what turns "the suggestions are conversation starters" into something
// the app actually remembers: the idea itself changes, or new ideas appear beside
// it, or the question above them is rewritten. Nothing here ever moves or deletes
// an idea — positions are load-bearing (see codeDiscovery's write-back notes).

const PICK_SHAPES = {
  open: '{"kind":"open","repo":"owner/name","why_fits":"...","use":"..."}',
  hidden: '{"kind":"hidden","name":"...","what":"...","lesson":"...","use":"..."}',
  bold: '{"kind":"bold","name":"...","vision":"...","why_possible":"...","how_fmcns":"..."}',
};

// Model replies arrive as JSON, sometimes fenced, sometimes with a sentence in
// front. Take the first balanced object and parse that.
function firstJson(text) {
  const t = String(text || '').replace(/```(?:json)?/gi, '');
  const start = t.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < t.length; i++) {
    if (t[i] === '{') depth++;
    else if (t[i] === '}') { depth--; if (!depth) { try { return JSON.parse(t.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

function worldPickRef(convo) {
  if (convo.subject_type !== 'world_pick') return null;
  const ref = parseWorldPickId(convo.subject_id);
  if (!ref) return null;
  const report = getReport(db, ref.reportId);
  const part = report?.parts?.[ref.partIndex];
  const pick = part?.picks?.[ref.pickIndex];
  if (!pick) return null;
  return { ...ref, report, part, pick };
}

// ── The same three gestures, for everything else the studio can talk to ──────
// On a world idea they act on the idea inside its report. On a seed, suggestion,
// task, component or tech-tree node they act on the thing's own row: fold
// rewrites what it IS, reframe rewrites why it exists, and more turns the
// conversation's leftovers into fresh seeds in the notebook. Which of these a
// subject offers comes from subjectWrite.js, so nothing has to be special-cased
// twice.

// One rewrite turn against a subject's own row.
async function runSubjectWriteTurn(convoId, act) {
  const convo = getConvo(convoId);
  if (!convo) return { error: 'not_found' };
  const target = writeTarget(convo.subject_type, act);
  if (!target) {
    return { text: act === 'reframe'
      ? 'There is no separate purpose to rewrite on this one — "fold it in" already rewrites what it is.'
      : 'There is nothing on this one I can rewrite from here.' };
  }
  const ctx = await convoContext(convo);
  if (ctx.error) return { error: ctx.error };

  const asks = Object.entries(target.fields)
    .filter(([, ask]) => ask)
    .map(([k, ask]) => `  "${k}": "${ask}"`)
    .join(',\n');
  const instruction = act === 'fold'
    ? `Rewrite ${target.label} so it carries everything this conversation arrived at — the sharper version of the thing itself, not a summary of the chat. Keep what still holds, fold in what we added, drop what we rejected. Write it for someone reading it cold, with no knowledge of this conversation.
Respond with ONLY this JSON object and nothing else:
{
${asks}
}`
    : `The conversation suggests ${target.label} is aimed at the wrong thing. Rewrite why it exists — not what it does. Plain English, no jargon.
Respond with ONLY this JSON object and nothing else:
{
${asks}
}`;

  const result = await runRoutedTurn({
    convo, ctx, model: CONVO_PLAN_MODEL, maxTokens: 1600,
    feature: 'studio', label: `conversations:${act}`, includeProjectContext: false,
    instruction,
  });
  if (result.error) return result;

  const fields = firstJson(result.text);
  if (!fields) return { text: 'I could not get a clean rewrite out of that — say in one line what it should say, then ask again.' };
  const out = applySubjectWrite(db, { subjectType: convo.subject_type, subjectId: convo.subject_id, act, fields, convoId });
  if (out.error) return { text: out.message || 'Could not write that back.' };

  const what = out.changed.map((c) => c.field).join(' and ');
  const text = act === 'fold'
    ? `Folded into ${target.label} — its ${what} now carries what we worked out here. What it said before is kept, so nothing is lost.`
    : `Rewrote why ${target.label} exists (${what}). What it said before is kept.`;
  saveAssistantTurn(convoId, text, { act, subject_type: convo.subject_type, subject_id: convo.subject_id, fields: out.changed.map((c) => c.field) });
  broadcastAll('queue:updated', {});
  broadcastAll('convos:updated', { convoId });
  return { text, via: result.via, act, wrote: out.changed.map((c) => c.field) };
}

// New ideas from a conversation that has no report to append to: they land as
// seeds in the notebook, which is where a loose idea belongs in this app.
async function runSeedIdeasTurn(convoId) {
  const convo = getConvo(convoId);
  if (!convo) return { error: 'not_found' };
  const ctx = await convoContext(convo);
  if (ctx.error) return { error: ctx.error };

  const result = await runRoutedTurn({
    convo, ctx, model: CONVO_PLAN_MODEL, maxTokens: 1600,
    feature: 'studio', label: 'conversations:more-seeds',
    instruction: `Propose between one and three NEW ideas that this conversation opened up — things worth building that are not what we are already discussing, and not a rehash of the chat. Each must stand on its own, readable by someone who was not here.
Respond with ONLY this JSON object and nothing else:
{"ideas":[{"title":"a short title","notes":"what it is and what it would do, in a few sentences"}]}`,
  });
  if (result.error) return result;

  const parsed = firstJson(result.text);
  const ideas = (Array.isArray(parsed?.ideas) ? parsed.ideas : []).filter((i) => String(i?.title || '').trim()).slice(0, 3);
  if (!ideas.length) return { text: 'Nothing usable came back that time — say which direction you want more of and ask again.' };

  const made = [];
  for (const idea of ideas) {
    try {
      const notes = String(idea.notes || '').trim().slice(0, 4000);
      createIdea({
        title: String(idea.title).trim().slice(0, 200),
        notes: notes + (notes ? '\n\n' : '') + `(Came out of a conversation about "${convo.title || 'something else'}".)`,
      });
      made.push(String(idea.title).trim());
    } catch { /* one bad idea must not lose the others */ }
  }
  if (!made.length) return { text: 'Could not save those ideas.' };

  const text = `Saved ${made.length} new idea${made.length === 1 ? '' : 's'} to your notebook: ${made.join(', ')}. Each one says where it came from. They are seeds — nothing runs until you queue one.`;
  saveAssistantTurn(convoId, text, { act: 'more', made });
  broadcastAll('ideas:updated', {});
  broadcastAll('convos:updated', { convoId });
  return { text, via: result.via, act: 'more', made };
}

// ─── Somewhere for a vision to land ──────────────────────────────────────────
// (plan "roaming-conversations-backend" §3)
//
// /plan and /handoff turn a conversation into WORK. These two turn one into
// UNDERSTANDING, which until now had nowhere to go and was simply lost when the
// thread scrolled away.
//
//   /seed → an idea card in the notebook. Openable in the Idea Studio to sharpen
//           later. The default landing place, and the cheap one.
//   /note → a document in the knowledge base — the same store the lookup tools
//           read. This is the one that compounds: a vision saved here becomes
//           context for every other AI feature in the app, not just for the
//           conversation that produced it.

async function runSaveSeedTurn(convoId) {
  const convo = getConvo(convoId);
  if (!convo) return { error: 'not_found' };
  const ctx = await convoContext(convo);
  if (ctx.error) return { error: ctx.error };

  const result = await runRoutedTurn({
    convo, ctx, model: CONVO_PLAN_MODEL, maxTokens: 1200,
    feature: 'studio', label: 'conversations:seed', includeProjectContext: false,
    instruction: `Save what this conversation arrived at as ONE idea card for the owner's notebook. Not a summary of the chat — the idea itself, in its sharpest form, written for someone reading it cold who was not here. If the conversation arrived at nothing yet, say so in the title.
Plain English, no jargon, no file names.
Respond with ONLY this JSON object and nothing else:
{"title":"a short title, a handful of words","notes":"what the idea is and what it would do, a few sentences"}`,
  });
  if (result.error) return result;

  const parsed = firstJson(result.text);
  const title = String(parsed?.title || '').trim();
  if (!title) return { text: 'I could not get a clean idea out of that — say in one line what you want saved, then ask again.' };

  const notes = String(parsed?.notes || '').trim().slice(0, 4000);
  let idea;
  try {
    idea = createIdea({
      title: title.slice(0, 200),
      notes: notes + (notes ? '\n\n' : '') + `(Came out of a conversation about "${convo.title || 'something else'}".)`,
      created_by: convo.created_by || 'antoine',
    });
  } catch (e) {
    return { text: 'Could not save that to the notebook.' };
  }

  const text = `Saved to your notebook as **${title}**. It is a seed — nothing runs until you queue it, and you can open it and keep working on it any time.`;
  saveAssistantTurn(convoId, text, { act: 'seed', idea_id: idea?.id || null, title });
  broadcastAll('ideas:updated', {});
  broadcastAll('convos:updated', { convoId });
  return { text, via: result.via, act: 'seed', ideaId: idea?.id || null };
}

async function runSaveNoteTurn(convoId) {
  const convo = getConvo(convoId);
  if (!convo) return { error: 'not_found' };
  const ctx = await convoContext(convo);
  if (ctx.error) return { error: ctx.error };

  const result = await runRoutedTurn({
    convo, ctx, model: CONVO_PLAN_MODEL, maxTokens: 2400,
    feature: 'studio', label: 'conversations:note', includeProjectContext: false,
    instruction: `Write down what this conversation UNDERSTOOD, as a standing document the app will keep and re-read later. Not a plan, not a to-do list, not a transcript — the thinking itself, in its finished form, readable years from now by someone who was not here.
Keep every distinction the conversation actually earned. Where it changed its mind, say what it moved from and to. Where it stayed unsure, say so.
Plain English, no jargon, no file names. Markdown headings are fine.
Respond with ONLY this JSON object and nothing else:
{"title":"a short title, a handful of words","description":"one sentence saying what is in it and when someone would want to read it","content":"the document itself"}`,
  });
  if (result.error) return result;

  const parsed = firstJson(result.text);

  // Capture the FULL conversation, not just the AI summary, so nothing is lost.
  const msgs = getConvoMessages(convoId);
  const transcript = msgs
    .map((m) => {
      const who = m.role === 'user' ? 'You' : 'Assistant';
      const kind = m.kind && m.kind !== 'chat' ? ` (${m.kind})` : '';
      return `**${who}${kind}:**\n${String(m.text || '').trim()}`;
    })
    .join('\n\n');

  const understanding = String(parsed?.content || '').trim();
  const content = [
    understanding ? `## What this conversation understood\n\n${understanding}` : '',
    `## Full conversation\n\n${transcript}`,
  ].filter(Boolean).join('\n\n');

  const out = createKnowledgeNote(db, {
    title: parsed?.title,
    description: parsed?.description,
    content,
  });
  if (out.error) {
    return { text: out.message || 'I could not get a clean document out of that — say in one line what should be written down, then ask again.' };
  }

  // Deliver the note to the coding helper's folder (best-effort; never breaks /note).
  deliverNoteToRepo({ title: out.title, content });

  const text = `Written down as **${out.title}**. The whole conversation is saved in it (not just a summary), and I dropped it into your project folder so the coding helper can pick it up.`;
  saveAssistantTurn(convoId, text, { act: 'note', doc_title: out.title, chars: out.chars });
  broadcastAll('convos:updated', { convoId });
  return { text, via: result.via, act: 'note', doc: out };
}

// Everything a conversation has already rewritten on its subject, so the studio
// can show what the thing said before. World ideas keep their own `original`
// inside the report and are not listed here.
export function convoSubjectEdits(convoId) {
  const convo = getConvo(convoId);
  if (!convo || convo.subject_type === 'world_pick') return [];
  return subjectEdits(db, convo.subject_type, convo.subject_id, 12);
}

// Which of the three buttons this subject can offer — read by the studio so it
// never shows one that would only apologise.
export function writeActsForConvo(convoId) {
  const convo = getConvo(convoId);
  if (!convo) return [];
  if (convo.subject_type === 'world_pick') return ['fold', 'more', 'reframe'];
  return [...writeActsFor(convo.subject_type), 'more'];
}

// /fold — rewrite THIS idea with what the conversation arrived at.
async function runFoldTurn(convoId) {
  const convo = getConvo(convoId);
  if (!convo) return { error: 'not_found' };
  const ref = worldPickRef(convo);
  if (!ref) return runSubjectWriteTurn(convoId, 'fold');
  const ctx = await convoContext(convo);
  if (ctx.error) return { error: ctx.error };

  const kind = ref.pick.kind || 'bold';
  const result = await runRoutedTurn({
    convo, ctx, model: CONVO_PLAN_MODEL, maxTokens: 1600,
    feature: 'studio', label: 'conversations:fold', includeProjectContext: false,
    instruction: `Rewrite THIS idea so it carries everything the conversation arrived at — the sharper version of it, not a summary of the chat. Keep what still holds, fold in what we added, drop what we rejected. Write it for someone reading the idea cold, with no knowledge of this conversation. Plain English, no jargon, no file names.
Respond with ONLY this JSON object and nothing else — same shape, same kind:
${PICK_SHAPES[kind]}`,
  });
  if (result.error) return result;

  const fields = firstJson(result.text);
  if (!fields) return { text: 'I could not turn that into a clean rewrite of the idea — try saying in one line what the developed version should say, then ask me to fold it in again.' };
  const out = updatePickInPlace(db, {
    reportId: ref.reportId, partIndex: ref.partIndex, pickIndex: ref.pickIndex,
    fields, convoId,
  });
  if (out?.error) return { text: out.message || 'Could not write that back into the idea.' };

  const title = fields.repo || fields.name || 'the idea';
  const text = `Folded into **${title}**. The idea now carries what we worked out here — the version before this conversation is kept underneath it, so you can compare.`;
  saveAssistantTurn(convoId, text, { act: 'fold', report_id: ref.reportId, part_index: ref.partIndex, pick_index: ref.pickIndex });
  broadcastAll('worldlook:updated', { reportId: ref.reportId });
  return { text, via: result.via, act: 'fold', report: out };
}

// /more — new ideas shaped by where the conversation went, appended beside this one.
async function runMoreIdeasTurn(convoId) {
  const convo = getConvo(convoId);
  if (!convo) return { error: 'not_found' };
  const ref = worldPickRef(convo);
  if (!ref) return runSeedIdeasTurn(convoId);
  const ctx = await convoContext(convo);
  if (ctx.error) return { error: ctx.error };

  const existing = (ref.part?.picks || [])
    .map((p) => p.repo || p.name).filter(Boolean).join(', ');
  const result = await runRoutedTurn({
    convo, ctx, model: CONVO_PLAN_MODEL, maxTokens: 1800,
    feature: 'studio', label: 'conversations:more-ideas',
    instruction: `Propose between one and three NEW ideas that this conversation opened up — not variations on what is already listed, and not a rehash of the chat. Each must be something that could actually be built, and each must be an answer to the same question these ideas answer.
Already on the table, do not repeat: ${existing || '(nothing)'}.
An idea can be any of the three kinds: a real open-source project we could use, an existing product worth learning from, or a bold idea nobody has built.
Respond with ONLY this JSON object and nothing else:
{"picks":[ ${PICK_SHAPES.bold} ]}
Each entry may instead use ${PICK_SHAPES.open} or ${PICK_SHAPES.hidden}. Only name a real repository or a real product if you are sure it exists — otherwise use the bold shape.`,
  });
  if (result.error) return result;

  const parsed = firstJson(result.text);
  const picks = Array.isArray(parsed?.picks) ? parsed.picks : (parsed?.kind ? [parsed] : []);
  if (!picks.length) return { text: 'Nothing usable came back that time — say which direction you want more of and ask again.' };

  const out = appendPicks(db, {
    reportId: ref.reportId, partIndex: ref.partIndex, picks: picks.slice(0, 3), from: convoId,
  });
  if (out?.error) return { text: out.message || 'Could not add those ideas.' };

  const added = picks.slice(0, 3).map((p) => p.repo || p.name).filter(Boolean);
  const text = `Added ${added.length} idea${added.length === 1 ? '' : 's'} beside this one: ${added.join(', ')}. They are in the list now, marked as coming from this conversation — tick the ones you want.`;
  saveAssistantTurn(convoId, text, { act: 'more', report_id: ref.reportId, part_index: ref.partIndex, added });
  broadcastAll('worldlook:updated', { reportId: ref.reportId });
  return { text, via: result.via, act: 'more', report: out };
}

// /reframe — rewrite the question above the ideas. No idea is touched.
async function runReframeTurn(convoId) {
  const convo = getConvo(convoId);
  if (!convo) return { error: 'not_found' };
  const ref = worldPickRef(convo);
  if (!ref) return runSubjectWriteTurn(convoId, 'reframe');
  const ctx = await convoContext(convo);
  if (ctx.error) return { error: ctx.error };

  const result = await runRoutedTurn({
    convo, ctx, model: CONVO_PLAN_MODEL, maxTokens: 900,
    feature: 'studio', label: 'conversations:reframe', includeProjectContext: false,
    instruction: `The conversation suggests we were answering the wrong question. Rewrite the QUESTION these ideas are answers to — the heading above them — so it states what we are actually trying to do now. Do not touch the ideas themselves. Plain English, no jargon.
Respond with ONLY this JSON object and nothing else:
{"name":"<a short heading, a few words>","description":"<one or two sentences saying what we are really solving>"}`,
  });
  if (result.error) return result;

  const parsed = firstJson(result.text);
  if (!parsed?.description && !parsed?.name) return { text: 'I could not get a clean new framing out of that — say in one line what you think we are really solving, and ask again.' };
  const out = updatePartFraming(db, {
    reportId: ref.reportId, partIndex: ref.partIndex,
    name: parsed.name || null, description: parsed.description || null, convoId,
  });
  if (out?.error) return { text: out.message || 'Could not change the question.' };

  const text = `Changed the question above these ideas to: **${parsed.name || ''}** — ${parsed.description || ''}\n\nNone of the ideas moved. The original wording is kept.`;
  saveAssistantTurn(convoId, text, { act: 'reframe', report_id: ref.reportId, part_index: ref.partIndex });
  broadcastAll('worldlook:updated', { reportId: ref.reportId });
  return { text, via: result.via, act: 'reframe', report: out };
}

// ─── Public API ──────────────────────────────────────────────────────────────

// onToken, when supplied by the route, turns the ordinary text turn into a
// streamed one. Slash commands stay non-streamed: they are structured actions
// (plan, handoff, fold) whose value is the finished artefact, not the typing.
export async function sendMessage(convoId, { text, userId = 'antoine', onToken = null, override = undefined } = {}) {
  if (!db) return { error: 'no_db' };
  const convo = getConvo(convoId);
  if (!convo) return { error: 'not_found' };
  const trimmed = String(text || '').trim();
  if (!trimmed) return { error: 'empty' };

  // Sticky lane (plan "chat-model-picker"): a caller with no opinion on the lane
  // (override left undefined) reads whatever this conversation is pinned to —
  // that's what makes a picked lane persist across sends without resending it
  // every time. A caller that explicitly passes override (even null, to mean
  // "just this once, Auto") is respected as-is.
  const effectiveOverride = override !== undefined ? override : getChatLane(convoId);

  // Commands — handled before any model cost.
  const cmd = trimmed.match(/^\/([a-z-]+)/i);
  if (cmd) {
    const slash = cmd[1].toLowerCase();
    if (slash === 'plan') return requestPlan(convoId);
    if (slash === 'handoff') {
      const hm = trimmed.match(/^\/handoff(?:\s+(claude|opencode))\b/i);
      const engine = hm ? (hm[1].toLowerCase() === 'claude' ? 'claude-code' : 'opencode') : null;
      return handoffToQueue(convoId, { engine });
    }
    if (slash === 'help') {
      return {
        text: 'Available commands:\n  /grill-me — I ask you sharp clarifying questions, one at a time.\n  /seed — save what we arrived at as an idea card in your notebook.\n  /note — write it down as a document the whole app can read afterwards.\n  /plan — turn this conversation into a coder brief (TITLE + BRIEF).\n  /handoff claude|opencode — queue the plan as a paused task in the Dispatch Queue (idempotent); name an engine to pick it, or leave it off for the default.\n  /compare — compare the ideas attached to this subject.\n  /fold — (world ideas) rewrite this idea with what we worked out here.\n  /more — (world ideas) propose new ideas from where this conversation went.\n  /reframe — (world ideas) rewrite the question these ideas answer.\n  /ask gpt|claude|second|opencode <question> — force this one turn onto that lane (gpt = Google Gemini, second = your second Claude account).\n  /check — re-examine the last answer on a different lane, with fresh code facts.\n  /second — answer your last question again on a second lane, side by side.\n  /help — this list.\n\nOtherwise just type — I\'ll pick the right lane myself: a free code lookup when you name a file or function, a brainstorm when you\'re thinking out loud, and a build proposal when you ask me to make something.',
      };
    }
    if (slash === 'seed') return runSaveSeedTurn(convoId);
    if (slash === 'note') return runSaveNoteTurn(convoId);
    if (slash === 'compare') return runCompareTurn(convoId);
    if (slash === 'fold') return runFoldTurn(convoId);
    if (slash === 'more') return runMoreIdeasTurn(convoId);
    if (slash === 'reframe') return runReframeTurn(convoId);
    if (slash === 'check') return runCheckTurn(convoId);
    if (slash === 'second') return runSecondTurn(convoId);
    if (slash === 'grill-me') {
      // interrogation mode: a single turn where the model asks questions only
      const ctx = await convoContext(convo);
      if (ctx.error) return { error: ctx.error };
      const result = await runRoutedTurn({
        convo, ctx, model: CONVO_CHAT_MODEL, maxTokens: 700,
        feature: 'studio', label: 'conversations:grill', includeProjectContext: false,
        instruction: 'GRILL MODE. Ask the owner the sharpest clarifying questions you can, ONE at a time, in order of importance. Do not propose solutions yet. End with a question mark. Keep it short.',
      });
      if (result.error) return result;
      saveAssistantTurn(convoId, result.text);
      return { text: result.text, via: result.via };
    }
    // /ask (and any other text) falls through to the ordinary path, where the
    // turn router recognises it as a forced lane and routes accordingly.
  }

  // Resolve the lane BEFORE any model cost. The router is free and deterministic
  // except for one tiny tie-break judge call; it never dispatches a coding task
  // (that is the owner's click, on an implement proposal).
  const turn = await resolveTurn({ convoId, text: trimmed, lastAssistantText: lastUserText(convoId), override: effectiveOverride });

  // implement: propose, do not dispatch. The frontend draws the three buttons.
  if (turn.intent === 'implement') return runImplementProposal(convoId, turn);
  // code_read: a read-only helper job on the runner, not a facts-only answer.
  if (turn.intent === 'code_read') return runCodeReadTurn(convoId, turn);

  // Persist the user turn for every non-command message. For a forced /ask, store
  // the cleaned question so the model context is not polluted by the "/ask gpt"
  // prefix — the lane is chosen by the router, not by the words in the prompt.
  const sendText = turn.intent === 'forced' ? (turn.lane.forcedQuestion || trimmed) : trimmed;
  const mid = randomUUID();
  db.prepare(`INSERT INTO convo_messages (id, convo_id, role, kind, text) VALUES (?,?,?,?,?)`)
    .run(mid, convoId, 'user', 'chat', sendText);
  const out = onToken
    ? await runChatTurnStreaming(convoId, userId, onToken, turn)
    : await runChatTurn(convoId, userId, turn);
  if (out.error) return out;
  out.laneTag = out.laneTag || turn.lane?.tag || null;
  out.intent = turn.intent;
  return out;
}

export async function requestPlan(convoId) {
  if (!db) return { error: 'no_db' };
  const convo = getConvo(convoId);
  if (!convo) return { error: 'not_found' };
  return runPlanTurn(convo.id, convo.created_by || 'antoine');
}

export async function handoffToQueue(convoId, { title = null, prompt = null, engine = null } = {}) {
  if (!db) return { error: 'no_db' };
  const convo = getConvo(convoId);
  if (!convo) return { error: 'not_found' };

  // idempotent: if this conversation already handed off, return the existing task
  if (convo.work_prompt_id) {
    const existing = db.prepare(`SELECT * FROM work_prompts WHERE id=?`).get(convo.work_prompt_id);
    if (existing) return { ok: true, already: true, prompt: existing };
  }

  // A plan is required — either the conversation produced one, or the caller supplied text.
  const plan = await latestConvoPlan(convoId);
  const brief = prompt || plan?.brief || plan?.title || '';
  if (!brief) return { error: 'no_plan', message: 'Run /plan first (or pass a prompt).' };

  const queue = await import('./promptQueue.js');
  const created = await queue.createPrompt({
    title: title || plan.title || convo.title || 'Work',
    prompt: brief,
    mode: 'implement',
    preset: 'standard',
    space: 'fmcns',
    status: 'paused', // set aside, not auto-dispatched — Antoine decides
    // 'own', not 'skip': the conversation already deliberated, so the plan is final and
    // is never auto-drafted over — but the world-look still runs, because "this part
    // already exists" is worth knowing about a plan nobody has checked against the
    // code yet. Picking an idea redrafts from raw_prompt, keeping the original.
    plan_source: 'own',
    created_by: convo.created_by || 'antoine',
    convo_id: convoId,
    provider: engine || null,
  });

  const promptId = created.id;
  db.prepare(`UPDATE convos SET work_prompt_id=?, handed_off_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(promptId, convoId);

  // owner-row back-reference via the subject registration
  const spec = subjectSpec(convo.subject_type);
  if (spec?.handoff) {
    try { spec.handoff(db, convoId, convo.subject_id, promptId); } catch (e) { console.warn('[convos] handoff backref failed:', e.message); }
  }

  broadcastAll('convos:updated', { convoId });
  broadcastAll('queue:updated', {});
  return { ok: true, prompt: created };
}
