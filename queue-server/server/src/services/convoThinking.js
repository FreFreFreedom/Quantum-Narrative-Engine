// The thinking of each Room conversation, kept, and read again when its subject
// comes back (plan "conversation-thinking-recall", 2026-10-01).
//
// His words: "the model [should] read the full thinking when the subject comes back
// … minimal ingestion … giving context, no rules." Recording costs an answer nothing;
// what constricts it is what gets pushed into every turn. So three parts:
//
//   1. The record. Every Room conversation and side talk is written down by itself
//      once it has gone quiet: the thinking (the path it took, not a fact list) plus
//      the full transcript, in the same `Note: ` knowledge_docs row /note writes — so
//      the Mac runner's existing mirror carries it to the repo with no new lane.
//      The record is written by Gemini (geminiWrite), whatever lane the Room uses.
//   2. Recall. A full Room answer carries an earlier conversation's thinking only
//      when his message clearly shares its subject — a free word match, rarer words
//      weighing more. Plain context under a bare heading; nothing tells the model
//      what to do with it.
//   3. Bring. A side talk carried into the main thread carries this record.
//
// Append-only, like convoLog.js: each later part covers only the messages since and
// sees the record so far for continuity. A memory an LLM keeps rewriting drifts from
// what was said, and resending the whole thread every time is the cost pattern this
// repo forbids. A long thread is caught up one slice per tick.
//
// The writer's own prompt is the only instruction here, and it never reaches the
// Room: it leaves out anything about answer shape, so no rule rides back in through
// the record (AGENTS.md "Where the rules kept hiding").

import { generateText } from './ai/text.js';
import { KEPT_SIDE_ONLY_SQL } from './pairSql.js';
import { createKnowledgeNote, updateKnowledgeNote, NOTE_PREFIX } from './knowledgeDocs.js';

let db = null;
let sweepTimer = null;

export function bindConvoThinkingDb(database) {
  db = database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS convo_thinking (
      convo_id TEXT PRIMARY KEY,
      doc_title TEXT,
      thinking TEXT,
      through_created_at TEXT,
      note_through TEXT,
      written_by TEXT,
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
  // The earlier conversations a thread has recalled, as a JSON array of convo ids.
  // Kept for the thread, so "what do you mean?" after a recall does not lose it.
  try { db.exec(`ALTER TABLE convos ADD COLUMN recalled TEXT`); } catch {}
  if (!sweepTimer && !process.env.PREVIEW_TASK_ID) {
    sweepTimer = setInterval(() => { sweep().catch((e) => console.error('[thinking] sweep failed:', e?.message || e)); }, SWEEP_MS);
    sweepTimer.unref?.();
  }
}

const SWEEP_MS = 5 * 60_000;
const QUIET_MS = 15 * 60_000;
const RETRY_AFTER_FAIL_MS = 30 * 60_000;
// Small slices: given a whole long thread at once, Gemini wrote only its last
// stretch, and ran out of room mid-list (2026-10-01). A few exchanges per part.
const SLICE_CHARS = 18_000;
const MSG_CHARS = 12_000;
const CONTINUITY_CHARS = 8_000;
const RECALL_DOC_CHARS = 14_000;
const RECALL_MAX = 2;

const WRITER_PROMPT = `You keep the record of a conversation between Antoine and an AI, so that when its subject comes back months from now the thinking can be picked up where it was left instead of being started again.

Write the thinking itself, from the first message to the last, in the order it moved: what he opened and what he was reaching for, what each answer brought, where he pushed back, corrected or turned the line, the distinctions and names that were earned, the works and people that came in and what each was there for, and what was left open. Keep his own words and coined terms exact. Keep the answers' strongest images and formulations where the talk built on them. The path matters as much as where it arrived.

Leave out anything about how answers should be shaped — length, tone, format, style. That is not what the conversation was about.

Invent nothing. If something stayed vague, keep it vague. Plain words. Markdown headings are fine. No preamble, no closing line, and never write "the user" or "the assistant".`;

const CONTINUE_PROMPT = `The record so far is shown for continuity only. Write the next part of it, covering every one of the new messages in order — do not repeat, summarise or rewrite what the record already holds.`;

function parseMeta(meta) {
  if (!meta) return {};
  try { return typeof meta === 'string' ? JSON.parse(meta) : meta; } catch { return {}; }
}

// His own words, without the passage-selection preamble the composer wraps around
// a quoted message; the quoted passages come back as a short "on:" line.
export function spokenText(m) {
  const meta = parseMeta(m.meta);
  if (m.role !== 'user') return String(m.text || '').trim();
  const body = typeof meta.body === 'string' && meta.body.trim() ? meta.body.trim() : String(m.text || '').trim();
  const quotes = Array.isArray(meta.quotes) ? meta.quotes.map((q) => String(q?.text || '').trim()).filter(Boolean) : [];
  return quotes.length ? `(on: ${quotes.map((q) => `“${q.slice(0, 600)}”`).join(' · ')})\n${body}` : body;
}

function chatMessages(convoId) {
  return db.prepare(`SELECT id, role, kind, text, meta, created_at FROM convo_messages WHERE convo_id=? AND ${KEPT_SIDE_ONLY_SQL} ORDER BY created_at ASC, rowid ASC`).all(convoId)
    .filter((m) => m.kind === 'chat' && (m.role === 'user' || m.role === 'assistant') && m.text && !parseMeta(m.meta).failed);
}

function allMessages(convoId) {
  return db.prepare(`SELECT id, role, kind, text, meta, created_at FROM convo_messages WHERE convo_id=? AND ${KEPT_SIDE_ONLY_SQL} ORDER BY created_at ASC, rowid ASC`).all(convoId);
}

function convoRow(convoId) {
  return db.prepare(`SELECT id, title, subject_type, parent_convo_id, deleted_at, recalled FROM convos WHERE id=?`).get(convoId);
}

function thinkingRow(convoId) {
  return db.prepare(`SELECT * FROM convo_thinking WHERE convo_id=?`).get(convoId) || null;
}

function saveRow(convoId, fields) {
  const cur = thinkingRow(convoId);
  const next = { doc_title: null, thinking: null, through_created_at: null, note_through: null, written_by: null, ...(cur || {}), ...fields };
  db.prepare(`
    INSERT INTO convo_thinking (convo_id, doc_title, thinking, through_created_at, note_through, written_by, updated_at)
    VALUES (?,?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(convo_id) DO UPDATE SET doc_title=excluded.doc_title, thinking=excluded.thinking,
      through_created_at=excluded.through_created_at, note_through=excluded.note_through,
      written_by=excluded.written_by, updated_at=excluded.updated_at
  `).run(convoId, next.doc_title, next.thinking, next.through_created_at, next.note_through, next.written_by);
  recallIndex = null;
}

function displayTitle(convo) {
  const own = String(convo?.title || '').trim() || 'Conversation';
  if (convo?.subject_type !== 'side' || !convo.parent_convo_id) return own;
  const parent = convoRow(convo.parent_convo_id);
  return parent?.title ? `${own} — side talk of ${String(parent.title).trim()}` : own;
}

const day = (iso) => String(iso || '').slice(0, 10);

// ─── The note: thinking + the full conversation ─────────────────────────────

export function writeNote(convoId) {
  const convo = convoRow(convoId);
  if (!convo) return { error: 'not_found' };
  const msgs = allMessages(convoId);
  if (!msgs.length) return { error: 'empty' };
  const row = thinkingRow(convoId);
  const transcript = msgs.map((m) => {
    const who = m.role === 'user' ? 'You' : 'Assistant';
    const kind = m.kind && m.kind !== 'chat' ? ` (${m.kind})` : '';
    return `**${who}${kind}:**\n${spokenText(m)}`;
  }).join('\n\n');
  const thinking = String(row?.thinking || '').trim();
  const content = [
    thinking ? `## What this conversation understood\n\n${thinking}` : '',
    `## Full conversation\n\n${transcript}`,
  ].filter(Boolean).join('\n\n');
  const description = (thinking || transcript).replace(/[#*_>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 300);

  // A note /note made before this existed sits under the conversation's own title:
  // adopt it rather than write a second one beside it.
  let docTitle = row?.doc_title || null;
  if (!docTitle) {
    const plain = `${NOTE_PREFIX}${String(convo.title || '').trim()}`.slice(0, 160);
    if (convo.subject_type !== 'side' && db.prepare(`SELECT 1 FROM knowledge_docs WHERE title=?`).get(plain)) docTitle = plain;
  }
  let out;
  const existing = docTitle ? db.prepare(`SELECT content FROM knowledge_docs WHERE title=?`).get(docTitle) : null;
  if (existing) {
    if (existing.content === content) out = { title: docTitle, chars: content.length, unchanged: true };
    else out = updateKnowledgeNote(db, docTitle, { description, content });
  } else {
    out = createKnowledgeNote(db, { title: displayTitle(convo).replace(/\s+/g, ' ').slice(0, 150), description, content });
  }
  if (out.error) return out;
  saveRow(convoId, { doc_title: out.title, note_through: msgs.at(-1).created_at });
  return out;
}

// ─── The thinking: written by the Room's own lane, append-only ──────────────

const _inFlight = new Set();
const _failedAt = new Map();

// Written by Gemini, always — his pick (2026-10-01): the record is the system's
// own reading, not the reading of whichever model a session runs on. Flash first,
// Flash-Lite when Flash is out of its daily allowance; never another provider.
const GEMINI_WRITERS = ['gemini-flash-latest', 'gemini-flash-lite-latest'];
async function geminiWrite(prompt) {
  let last = null;
  for (const model of GEMINI_WRITERS) {
    last = await generateText({
      prompt, feature: 'studio', provider: 'google-ai-studio', model, strictModel: true,
      label: 'conversations:thinking', maxTokens: 16000, allowLongOutput: true, timeoutMs: 300_000,
    });
    if (String(last?.text || '').trim()) return last;
  }
  return last;
}

export async function writeThinking(convoId, { force = false, reset = false } = {}) {
  if (!db) return { error: 'no_db' };
  if (_inFlight.has(convoId)) return { error: 'busy' };
  const convo = convoRow(convoId);
  if (!convo) return { error: 'not_found' };
  _inFlight.add(convoId);
  try {
    if (reset) saveRow(convoId, { thinking: null, through_created_at: null, written_by: null });
    const row = thinkingRow(convoId);
    const since = row?.through_created_at || '';
    const fresh = chatMessages(convoId).filter((m) => m.created_at > since);
    if (!fresh.length) {
      const note = writeNote(convoId);
      return { ok: true, upToDate: true, note };
    }
    const slice = [];
    let used = 0;
    for (const m of fresh) {
      const line = `${m.role === 'user' ? 'Antoine' : 'The AI'}: ${spokenText(m).slice(0, MSG_CHARS)}`;
      if (slice.length && used + line.length > SLICE_CHARS) break;
      slice.push({ m, line });
      used += line.length;
    }
    const prior = String(row?.thinking || '').trim();
    const parent = convo.subject_type === 'side' && convo.parent_convo_id ? convoRow(convo.parent_convo_id) : null;
    const prompt = [
      WRITER_PROMPT,
      parent ? `\nThis is a side talk he stepped into from the conversation "${parent.title}".` : '',
      prior ? `\n${CONTINUE_PROMPT}\n\n=== THE RECORD SO FAR ===\n${prior.length > CONTINUITY_CHARS ? '…' + prior.slice(-CONTINUITY_CHARS) : prior}` : '',
      `\n=== ${prior ? 'THE NEW MESSAGES' : 'THE CONVERSATION'} — "${convo.title || 'Conversation'}" ===\n${slice.map((s) => s.line).join('\n\n')}`,
    ].filter(Boolean).join('\n');
    const out = await geminiWrite(prompt);
    const part = String(out?.text || '').trim();
    if (!part) {
      _failedAt.set(convoId, Date.now());
      const note = force ? writeNote(convoId) : null;
      return { error: 'no_thinking', message: out?.message || 'Nothing came back from the lane.', note };
    }
    _failedAt.delete(convoId);
    const through = slice.at(-1).m.created_at;
    const laterDay = prior && day(through) !== day(row?.through_created_at);
    const thinking = !prior ? part : laterDay ? `${prior}\n\n### Later — ${day(through)}\n\n${part}` : `${prior}\n\n${part}`;
    saveRow(convoId, { thinking, through_created_at: through, written_by: 'auto' });
    const note = writeNote(convoId);
    return { ok: true, thinking, more: fresh.length > slice.length, note, via: out?.via };
  } finally {
    _inFlight.delete(convoId);
  }
}

// A record written elsewhere (a terminal session reading the thread) becomes the
// conversation's thinking, through its newest message; the sweep appends after it.
export function setThinking(convoId, text) {
  if (!db) return { error: 'no_db' };
  if (!convoRow(convoId)) return { error: 'not_found' };
  const body = String(text || '').trim();
  if (!body) return { error: 'empty' };
  const last = chatMessages(convoId).at(-1);
  saveRow(convoId, { thinking: body, through_created_at: last?.created_at || null, written_by: 'hand' });
  return { ok: true, note: writeNote(convoId) };
}

export function readThinking(convoId) {
  const row = db ? thinkingRow(convoId) : null;
  return row ? { thinking: row.thinking || '', doc_title: row.doc_title, through_created_at: row.through_created_at, written_by: row.written_by, updated_at: row.updated_at } : null;
}

// For "bring": the side talk's thinking, caught up first if it is behind.
export async function thinkingForBring(convoId) {
  const behind = () => {
    const row = thinkingRow(convoId);
    const last = chatMessages(convoId).at(-1);
    return !row?.thinking || (last && last.created_at > (row.through_created_at || ''));
  };
  for (let pass = 0; pass < 8 && behind(); pass++) {
    const out = await writeThinking(convoId);
    if (out.error) break;
  }
  return String(thinkingRow(convoId)?.thinking || '').trim();
}

// ─── The sweep: write down what went quiet ──────────────────────────────────

let _sweeping = false;
export async function sweep() {
  if (!db || _sweeping) return;
  _sweeping = true;
  try {
    const quietBefore = new Date(Date.now() - QUIET_MS).toISOString();
    const rows = db.prepare(`
      SELECT c.id,
             MAX(CASE WHEN m.kind='chat' THEN m.created_at END) AS last_chat,
             MAX(m.created_at) AS last_any,
             SUM(CASE WHEN m.kind='chat' THEN 1 ELSE 0 END) AS chats,
             t.through_created_at, t.note_through
        FROM convos c
        JOIN convo_messages m ON m.convo_id=c.id
        LEFT JOIN convo_thinking t ON t.convo_id=c.id
       WHERE c.subject_type IN ('open','side') AND c.deleted_at IS NULL
       GROUP BY c.id
      HAVING last_any < ? AND chats >= 2
       ORDER BY last_any DESC
    `).all(quietBefore);
    let called = false;
    for (const r of rows) {
      const thinkingBehind = r.last_chat && r.last_chat > (r.through_created_at || '');
      if (thinkingBehind && !called) {
        const failed = _failedAt.get(r.id);
        if (!(failed && Date.now() - failed < RETRY_AFTER_FAIL_MS)) {
          called = true; // one model call per tick, newest conversation first
          const out = await writeThinking(r.id);
          if (out.error && out.error !== 'busy') console.warn(`[thinking] ${r.id}: ${out.message || out.error}`);
          continue;
        }
      }
      if (r.last_any > (r.note_through || '')) writeNote(r.id); // free: the transcript only
    }
  } finally {
    _sweeping = false;
  }
}

// ─── Recall: an earlier conversation's thinking, only when he is on its subject ─

const STOP = new Set(`about above after again against also although always among another answer anything around because been before being below between both cannot could does doing down during each either else enough even ever every first from further give have having here hers herself himself however into itself just keep know like little made make many maybe more most much must myself need never next none often only other others ought ours over please quite rather really right same seem seems shall should since some something still such than that their them themselves then there these they thing things think this those though through thus together under until upon very want were what whatever when where whether which while whom whose will with within without would yeah your yours yourself
answer answers words word thank thanks explore exploring tell help understand mean means meaning nature kind sort ways list best good great deep deeper also really maybe essentially actually something someone everything nothing
avec dans pour mais donc alors comme cette sont nous vous elle elles leur leurs aussi tout tous toute toutes plus moins tres bien faire fait etre avoir quoi quel quelle quels quelles parce`.split(/\s+/));

export function terms(text) {
  const out = new Map();
  const words = String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z][a-z0-9-]{3,}/g) || [];
  for (let w of words) {
    w = w.replace(/^-+|-+$/g, '');
    if (w.length < 4 || STOP.has(w)) continue;
    if (w.length > 5 && w.endsWith('ies')) w = w.slice(0, -3) + 'y';
    else if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    if (STOP.has(w)) continue;
    out.set(w, (out.get(w) || 0) + 1);
  }
  return out;
}

// docs: [{id, title, text}] → a scorer over a query's words. Pure, for the selftest.
export function buildIndex(docs) {
  const rows = docs.map((d) => ({ ...d, tf: terms(`${d.title}\n${d.title}\n${d.text}`), titleTerms: new Set(terms(d.title).keys()) }));
  const df = new Map();
  for (const r of rows) for (const t of r.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  return { rows, df, n: rows.length };
}

// A shared word counts for more the rarer it is across the records and the more
// central it is in this one. A record is recalled only when several such words
// meet, or one rare word that the record is plainly about.
const RECALL_SCORE = 9;
export function scoreQuery(index, queryText, { exclude = new Set() } = {}) {
  const q = terms(queryText);
  const out = [];
  for (const r of index.rows) {
    if (exclude.has(r.id)) continue;
    let score = 0;
    let shared = 0;
    let central = 0;
    for (const t of q.keys()) {
      const tf = r.tf.get(t);
      if (!tf) continue;
      const d = index.df.get(t) || 1;
      if (index.n >= 4 && d / index.n > 0.5) continue; // a word most records share says nothing
      const idf = Math.log(1 + index.n / d);
      const weight = idf * Math.min(3, 1 + Math.log(tf)) * (r.titleTerms.has(t) ? 1.5 : 1);
      score += weight;
      shared += 1;
      if (tf >= 4) central += 1;
    }
    if ((shared >= 3 && score >= RECALL_SCORE) || (central >= 1 && shared >= 2 && score >= RECALL_SCORE * 0.7)) {
      out.push({ id: r.id, score, shared });
    }
  }
  out.sort((a, b) => b.score - a.score);
  // A second record far weaker than the first is noise beside it, not a second subject.
  return out.filter((x) => x.score >= out[0].score * 0.5);
}

let recallIndex = null;
function index() {
  if (recallIndex) return recallIndex;
  const rows = db.prepare(`
    SELECT t.convo_id AS id, c.title, t.thinking AS text, t.updated_at
      FROM convo_thinking t JOIN convos c ON c.id=t.convo_id
     WHERE c.deleted_at IS NULL AND t.thinking IS NOT NULL AND t.thinking != ''
  `).all();
  recallIndex = buildIndex(rows);
  return recallIndex;
}

function family(convo) {
  const out = new Set([convo.id]);
  if (convo.subject_type === 'side' && convo.parent_convo_id) out.add(convo.parent_convo_id);
  return out;
}

// What a full Room answer carries: '' unless his message is on an earlier
// conversation's subject. The recalled ones stay with the thread.
export function recalledThinkingBlock(convoId) {
  if (!db) return '';
  try {
    const convo = convoRow(convoId);
    if (!convo) return '';
    let kept = [];
    try { kept = JSON.parse(convo.recalled || '[]'); } catch {}
    if (!Array.isArray(kept)) kept = [];
    const his = chatMessages(convoId).filter((m) => m.role === 'user').slice(-2).map((m) => spokenText(m).replace(/^\(on: [^\n]*\)\n/, ''));
    const said = his.join('\n');
    const exclude = family(convo);
    const found = said ? scoreQuery(index(), said, { exclude }).map((x) => x.id) : [];
    let next = [...kept.filter((id) => !exclude.has(id))];
    for (const id of found.slice(0, RECALL_MAX)) {
      if (next.includes(id)) continue;
      next.push(id);
      if (next.length > RECALL_MAX) next.shift();
    }
    if (JSON.stringify(next) !== JSON.stringify(kept)) {
      db.prepare(`UPDATE convos SET recalled=? WHERE id=?`).run(JSON.stringify(next), convoId);
    }
    const blocks = [];
    for (const id of next) {
      const row = db.prepare(`
        SELECT t.thinking, t.through_created_at, c.id, c.title, c.subject_type, c.parent_convo_id
          FROM convo_thinking t JOIN convos c ON c.id=t.convo_id
         WHERE t.convo_id=? AND c.deleted_at IS NULL
      `).get(id);
      const text = String(row?.thinking || '').trim();
      if (!text) continue;
      const cut = text.length > RECALL_DOC_CHARS
        ? `${text.slice(0, RECALL_DOC_CHARS * 0.4)}\n…\n${text.slice(-RECALL_DOC_CHARS * 0.6)}`
        : text;
      blocks.push(`\n=== AN EARLIER CONVERSATION OF HIS: "${displayTitle(row)}" (${day(row.through_created_at)}) ===\n${cut}`);
    }
    return blocks.join('\n');
  } catch (e) {
    console.error('[thinking] recall failed:', e?.message || e);
    return '';
  }
}
