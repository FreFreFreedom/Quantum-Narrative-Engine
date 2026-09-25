// The Room's shared memory (plan "room-shared-memory").
//
// One small, cheap, plain-text memory table (`mind_facts`) that any feature can
// read from and write to, so a fact stated once is known forever — without
// embeddings, a vector DB, or any external memory service.
//
// Two reads feed the model:
//   - mindBlock(): the always-on slice injected into every conversation turn
//     (deduplicated, ranked, hard-capped at ~1000 tokens). Keeps the per-turn
//     prompt small.
//   - recallFacts(): an on-demand tool the model calls when a question needs a
//     specific older/lower-ranked fact the block didn't surface.
//
// A fire-and-forget `harvest()` extracts standing facts from conversation turns
// (after the HARVEST_AFTER_TURNS watermark) using the existing `summary` feature
// lane, which is free in practice (second Claude account first, then free models).

import { randomUUID } from 'node:crypto';
import { generateText } from './ai/text.js';
import { broadcastAll } from '../realtime.js';
import { triggerMindMirror } from './mindMirror.js';
import { triggerMentionScan } from './entityMentions.js';
import { STOPWORDS } from '../lib/stopwords.js';
import { saveFoundAnalogy } from './referenceLibrary.js';
import { recordReach } from './connections.js';

let db = null;
export function bindMindDb(database) {
  db = database;
  // Watermarks for the passes that read something other than a conversation. A
  // conversation carries its own (convos.mind_seen_turns); the library has nowhere
  // to put one, and a whole table per pass would be four columns of ceremony.
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS mind_marks (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')`);
  } catch (e) { console.error('[mind] marks table:', e?.message || e); }
}

function markGet(key) {
  try { return db.prepare(`SELECT value FROM mind_marks WHERE key=?`).get(key)?.value || ''; } catch { return ''; }
}
function markSet(key, value) {
  try {
    db.prepare(`INSERT INTO mind_marks (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
      .run(key, String(value || ''));
  } catch (e) { console.error('[mind] mark write:', e?.message || e); }
}

// Write this memory back out to the repo files every engine can read
// (mindMirror.js). Fire-and-forget and debounced there — a failed write must
// never turn into a failed save, so this is called AFTER the row landed and its
// result is deliberately ignored. Getting those files onto the trunk is the Mac
// runner's job (scripts/queue-runner.js#mirrorToRepo); production has no git.
function mirrorOut() {
  try { triggerMindMirror(db); } catch (e) { console.error('[mind] mirror trigger failed:', e?.message || e); }
}

// Point this fact at the entities it names (entityMentions.js). Same discipline as
// mirrorOut above: called after the row landed, result ignored, failures logged — a fact
// that saved and did not scan is fine, a scan that lost a fact is not. The facts side
// yields almost nothing on its own and is scanned only because it is two lines.
function scanMentions(id) {
  try {
    const f = getFact(id);
    if (f) triggerMentionScan(db, 'fact', id, [f.text, f.detail].filter(Boolean).join('\n'));
  } catch (e) { console.error('[mind] mention scan failed:', e?.message || e); }
}

// 'vision' is the paradigm itself — what the platform IS and why — as opposed to
// 'project', which is what is being built. Kept as its own kind because the repo
// mirror files them separately: the paradigm belongs beside the vision docs, not
// in a list of the owner's preferences.
export const KINDS = ['about', 'taste', 'decision', 'project', 'person', 'style', 'vision'];
const MAX_FACTS = 300;
// A fact he explicitly marked Central outranks an equal ordinary fact everywhere
// weight is used: mindBlock() selection, sorting, recall. One named constant so the
// number means the same thing in every place that reads it, instead of a "5" that
// could silently drift out of sync between them.
export const CENTRAL_WEIGHT = 5;
// How many of his own messages must pile up before a harvest runs. Was 8, which
// never fired for the way he actually talks: his threads are a handful of long
// questions answered at length, so a whole conversation ends below the
// watermark and its facts are never extracted at all — "Cross-Domain Analogical
// Reasoning" sat at 4 turns with nothing harvested. 3 costs no more per fact
// (the pass only ever reads the messages since the watermark, on the free
// `summary` lane) — it just runs more often on smaller batches.
const HARVEST_AFTER_TURNS = 3;
// Was 4000, raised when the block started carrying the reasoning behind its top
// facts and not only their headlines. The extra characters buy the argument under a
// claim, which is the part that was being stored and thrown away.
const BLOCK_CAP = 6000;
// Stopwords dropped before normalising a fact for the deterministic dedup check.
// The list itself lives in lib/stopwords.js — entityMentions.js needs the same one.

// Lowercase, strip punctuation, drop stopwords — two facts that normalise to the
// same string are the same fact. Deterministic, no model call.
function normalize(s) {
  return String(s || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter((w) => w && !STOPWORDS.has(w))
    .join(' ').trim();
}

const FACT_COLUMNS = 'id, kind, text, detail, weight, source_convo_id, source_note, owner_note, is_central, hits, last_used_at, created_at, updated_at, superseded_by, active';

export function listFacts({ kind = null, activeOnly = true } = {}) {
  try {
    let sql = `SELECT ${FACT_COLUMNS} FROM mind_facts WHERE 1=1`;
    const params = [];
    if (activeOnly) sql += ` AND active=1`;
    if (kind) { sql += ` AND kind=?`; params.push(kind); }
    sql += ` ORDER BY weight DESC, updated_at DESC`;
    return db.prepare(sql).all(...params);
  } catch { return []; }
}

export function getFact(id) {
  try {
    return db.prepare(`SELECT ${FACT_COLUMNS} FROM mind_facts WHERE id=?`).get(id) || null;
  } catch { return null; }
}

// Deterministic dedup first — reject if an existing active fact normalises to the
// same string. No model call for this check.
export function saveFact({ kind, text, detail = null, sourceConvoId = null, sourceNote = null, ownerNote = null, central = false }) {
  if (!text || !text.trim()) return { error: 'text_required' };
  const k = KINDS.includes(kind) ? kind : 'about';
  const norm = normalize(text);
  if (!norm) return { error: 'text_required' };
  try {
    const existing = db.prepare(`SELECT id, text FROM mind_facts WHERE active=1`).all();
    for (const e of existing) {
      if (normalize(e.text) === norm) return { error: 'duplicate', id: e.id };
    }
    const id = `mf_${randomUUID().slice(0, 8)}_${Date.now().toString(36)}`;
    const now = new Date().toISOString();
    const weight = central ? CENTRAL_WEIGHT : 1;
    db.prepare(`INSERT INTO mind_facts (id, kind, text, detail, weight, source_convo_id, source_note, owner_note, is_central, hits, created_at, updated_at, active) VALUES (?,?,?,?,?,?,?,?,?,0,?,?,1)`)
      .run(id, k, String(text).slice(0, 240), detail ? String(detail).slice(0, 4000) : null, weight, sourceConvoId, sourceNote, ownerNote ? String(ownerNote).slice(0, 2000) : null, central ? 1 : 0, now, now);
    mirrorOut();
    scanMentions(id);
    return getFact(id);
  } catch (e) {
    return { error: e.message || 'save_failed' };
  }
}

// A direct instruction to remember something must not wait for the background
// harvest. That pass deliberately waits for several turns and can fail with the
// model lane, which made "remember this" sound like a promise while leaving no
// durable fact behind. Keep recognition narrow and deterministic: questions
// about memory do not match, while a direct command or stated wish does.
const EXPLICIT_MEMORY_PATTERNS = [
  /^\s*(?:please\s+)?remember(?:\s+this)?(?:\s*[:,.-]|\s+that)?\s+(.+)$/i,
  /^\s*(?:please\s+)?(?:do not|don't)\s+forget(?:\s+that)?\s+(.+)$/i,
  /\bI\s+(?:really\s+)?want\s+(?:you|the\s+model|it)\s+to\s+remember(?:\s+this)?(?:\s*[:,.-]|\s+that)?\s+(.+)$/i,
  /\bmake\s+sure\s+(?:you|the\s+model|it)\s+remember(?:s)?(?:\s+this)?(?:\s*[:,.-]|\s+that)?\s+(.+)$/i,
];

export function explicitMemoryText(input) {
  const source = String(input || '').trim();
  if (!source || source.endsWith('?')) return null;
  for (const pattern of EXPLICIT_MEMORY_PATTERNS) {
    const match = pattern.exec(source);
    const remembered = String(match?.[1] || '').trim().replace(/[.!]+$/, '').trim();
    if (remembered) return remembered;
  }
  return null;
}

function explicitMemoryKind(text) {
  const value = String(text || '').toLowerCase();
  if (/\b(?:answer|reply|respond|write|say|speak|call|refer|metaphor|analogy|model|assistant|tone|style|word|phrase|stop|never|always)\b/.test(value)) return 'style';
  if (/\b(?:like|love|dislike|hate|prefer|favourite|favorite)\b/.test(value)) return 'taste';
  if (/\b(?:decided|decision|choose|chosen|will use|will not use)\b/.test(value)) return 'decision';
  return 'about';
}

// Save the owner's exact meaning, not a model's paraphrase. Explicit memories
// are central so they remain in the always-on memory slice instead of decaying
// behind facts gathered automatically. A duplicate still counts as remembered:
// return the existing row so the caller can report success honestly.
export function saveExplicitChatMemory(input, { convoId = null } = {}) {
  const remembered = explicitMemoryText(input);
  if (!remembered) return null;
  const text = remembered.length <= 240
    ? remembered
    : `${remembered.slice(0, 237).trimEnd()}...`;
  const saved = saveFact({
    kind: explicitMemoryKind(remembered),
    text,
    detail: remembered.length > 240 ? remembered : null,
    sourceConvoId: convoId,
    sourceNote: 'chat_explicit',
    ownerNote: 'Explicitly asked the Room to remember this.',
    central: true,
  });
  if (saved?.error === 'duplicate') return getFact(saved.id);
  if (saved?.error) return saved;
  broadcastAll('mind:updated', {});
  return saved;
}

export function forgetFact(id) {
  try {
    const r = db.prepare(`UPDATE mind_facts SET active=0, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND active=1`).run(id);
    if (r.changes === 0) return { error: 'not_found' };
    mirrorOut();
    return { ok: true };
  } catch (e) { return { error: e.message || 'forget_failed' }; }
}

// `kind` is revisable, not just the words. Without it a fact could never be
// re-filed, and the facts harvested before `vision` existed would sit under
// 'project' forever — the paradigm stuck in the list of preferences, invisible to
// the vision mirror. The harvest re-files them itself now, through `replaces`.
export function reviseFact(id, { text, detail, kind } = {}) {
  try {
    const cur = getFact(id);
    if (!cur) return { error: 'not_found' };
    const newText = text != null ? String(text).slice(0, 240) : cur.text;
    const newDetail = detail != null ? String(detail).slice(0, 4000) : cur.detail;
    const newKind = kind && KINDS.includes(kind) ? kind : cur.kind;
    db.prepare(`UPDATE mind_facts SET text=?, detail=?, kind=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
      .run(newText, newDetail, newKind, id);
    mirrorOut();
    scanMentions(id);
    return getFact(id);
  } catch (e) { return { error: e.message || 'revise_failed' }; }
}

// One fact replaces another. The old row stops being active but keeps a pointer to
// what replaced it, so the memory has a history instead of a hole — and so a wrong
// merge can be read back rather than guessed at.
//
// Two callers, both from the harvest: a CONTRADICTION (this conversation reversed an
// older claim, and the old one is now simply wrong) and a MERGE (several facts turn
// out to be one idea seen from several angles, and they fold into the strongest
// statement of it). Until this existed the table could only ever grow: a fact that
// reversed another just sat next to it, both true forever.
export function supersedeFact(oldId, newId) {
  if (!oldId || oldId === newId) return { ok: false };
  try {
    const r = db.prepare(`UPDATE mind_facts SET active=0, superseded_by=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND active=1`)
      .run(newId, oldId);
    return { ok: r.changes > 0 };
  } catch (e) { return { error: e.message || 'supersede_failed' }; }
}

// Topic words only — short and common words carry no subject. Used by the
// relevance score below, which is deliberately plain word overlap: no embeddings,
// no extra table, no model call on the request path.
function topicWords(s) {
  return new Set(String(s || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter((w) => w.length > 3 && !STOPWORDS.has(w)));
}

// How close a fact sits to what he is asking RIGHT NOW. Returns a multiplier rather
// than a score of its own, so a fact he marked Central never drops out of the block
// just because this turn happens to be about something else.
function relevanceTo(fact, contextWords) {
  if (!contextWords.size) return 0;
  const own = topicWords(`${fact.text} ${fact.detail || ''}`);
  if (!own.size) return 0;
  let hit = 0;
  for (const w of own) if (contextWords.has(w)) hit += 1;
  return hit / Math.sqrt(own.size);
}

const DETAIL_FACTS = 3;     // how many facts arrive with their reasoning attached
const DETAIL_CHARS = 900;   // per fact
const RELEVANCE_PULL = 6;   // how hard the current subject outranks plain recency

// The block injected into every conversation turn. Empty string when there are no
// facts, so an empty memory costs nothing.
//
// `context` is what he just said. Two things changed here, and they were the same
// weakness seen from two sides. The order used to be weight * recency * hits and
// nothing else, so fifty facts arrived in the same order whatever the subject was.
// And only `text` was ever sent — the 240-character headline — while `detail`, the
// mechanism and the example that made the fact land, sat in the table unread. A
// headline without its argument is close to useless a month later. So the block is
// now ranked against the subject, and the few facts closest to it bring their
// reasoning with them.
export function mindBlock(context = '') {
  try {
    const facts = db.prepare(`SELECT id, kind, text, detail, weight, hits, last_used_at, updated_at, created_at FROM mind_facts WHERE active=1`).all();
    return renderMindBlockFrom(facts, context);
  } catch { return ''; }
}

// The block itself, from a list of facts — no database, so the self-test can prove
// the ranking and the detail selection without one. mindBlock() above is this plus
// one query. Same split as mindMirror.js's renderMindFrom().
export function renderMindBlockFrom(facts = [], context = '', now = Date.now()) {
  if (!facts.length) return '';
  const contextWords = topicWords(String(context || '').slice(0, 4000));
  const scored = facts.map((f) => {
    const t = f.last_used_at || f.updated_at || f.created_at;
    let days = 30;
    if (t) { const dt = new Date(t).getTime(); if (!Number.isNaN(dt)) days = Math.max(0, (now - dt) / 86400000); }
    const recency = 1 / (1 + days);
    const rel = relevanceTo(f, contextWords);
    const score = (f.weight || 1) * recency * (1 + Math.log((f.hits || 0) + 1)) * (1 + RELEVANCE_PULL * rel);
    return { f, score, rel };
  }).sort((a, b) => b.score - a.score);

  // Only a fact that genuinely touches the subject earns its reasoning. Without
  // this guard the deep section is three arbitrary facts dressed up as the ones
  // that matter, which is worse than sending headlines alone.
  const deep = scored.filter((x) => x.rel > 0 && x.f.detail).slice(0, DETAIL_FACTS);
  const deepIds = new Set(deep.map((x) => x.f.id));

  let out = '\n=== WHAT YOU KNOW ABOUT THE OWNER ===\nFollow explicit instructions and preferences here. When an older theme conflicts with a newer direct instruction, the direct instruction wins.\n';
  if (deep.length) {
    out += '\nCLOSEST TO WHAT HE IS ASKING NOW — the claim, and the thinking under it:\n';
    for (const { f } of deep) {
      out += `- ${String(f.text).slice(0, 240)}\n  ${String(f.detail).slice(0, DETAIL_CHARS).replace(/\s+/g, ' ')}\n`;
    }
    out += '\nEVERYTHING ELSE YOU KNOW:\n';
  }
  for (const { f } of scored) {
    if (deepIds.has(f.id)) continue;
    const line = `- ${String(f.text).slice(0, 240)}`;
    if (out.length + line.length + 1 > BLOCK_CAP) break;
    out += line + '\n';
  }
  return out;
}

// Direct "remember this" instructions and Central style/taste memories get a
// second, focused placement near the end of every conversation prompt. The broad
// memory block above carries facts and vision too, but it appears before the
// Room's voice; a later voice line such as "metaphor is welcome" could therefore
// weaken a remembered "use fewer immune-system metaphors" preference. This block
// is deliberately provider-free: the same text reaches Gemini, Claude, ChatGPT
// and every other Room lane.
export function renderDirectInstructions(rows = []) {
  if (!rows.length) return '';
  return `
=== OWNER INSTRUCTIONS REMEMBERED ACROSS EVERY MODEL ===
These are direct standing instructions from Antoine. Follow them regardless of which engine is answering. They outrank the general voice above. If his current message explicitly changes one, the current message wins.
${rows.map((row) => `- ${String(row.text || '').slice(0, 240)}`).join('\n')}`;
}

export function directInstructionsBlock() {
  try {
    const rows = db.prepare(`
      SELECT text FROM mind_facts
      WHERE active=1
        AND (source_note='chat_explicit' OR (is_central=1 AND kind IN ('style','taste')))
      ORDER BY is_central DESC, updated_at DESC
      LIMIT 20
    `).all();
    return renderDirectInstructions(rows);
  } catch { return ''; }
}

// On-demand recall (the model's `recall_memory` tool). Plain LIKE search over
// text/detail — no embeddings. Bumps hits + last_used_at so useful facts climb
// into mindBlock()'s top slice over time.
export function recallFacts(query, limit = 5) {
  try {
    const q = `%${String(query || '').toLowerCase()}%`;
    const rows = db.prepare(
      `SELECT id, kind, text, detail FROM mind_facts WHERE active=1 AND (lower(text) LIKE ? OR lower(COALESCE(detail,'')) LIKE ?) ORDER BY weight DESC, hits DESC LIMIT ?`,
    ).all(q, q, limit);
    if (rows.length) {
      const ids = rows.map((r) => r.id);
      db.prepare(`UPDATE mind_facts SET hits=hits+1, last_used_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    }
    return rows.map((r) => ({ id: r.id, kind: r.kind, text: r.text, detail: r.detail }));
  } catch { return []; }
}

// Keep the table bounded: if active facts exceed MAX_FACTS, demote the
// lowest-ranked ones rather than refusing to learn something new.
function enforceCap() {
  const count = db.prepare(`SELECT COUNT(*) c FROM mind_facts WHERE active=1`).get().c;
  if (count <= MAX_FACTS) return;
  const toDrop = count - MAX_FACTS;
  const victims = db.prepare(
    `SELECT id FROM mind_facts WHERE active=1 ORDER BY weight ASC, updated_at ASC LIMIT ?`,
  ).all(toDrop);
  for (const v of victims) {
    db.prepare(`UPDATE mind_facts SET active=0, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(v.id);
  }
}

// The transcript given to the harvest. His own messages AND the answers, because
// the answers are where the thinking lands: his threads are a few long questions
// worked out at length, so reading only his side threw away most of what the
// conversation arrived at. Answers are cut to ANSWER_CHARS — enough to carry the
// idea, short enough that the pass stays cheap on the free lane.
const ANSWER_CHARS = 2000;
function transcriptFor(turns) {
  if (!turns.length) return '(none)';
  return turns.map((t, i) => (t.role === 'user'
    ? `[T${i + 1}] HE ASKED: ${t.text}`
    : `[T${i + 1}] THE ANSWER: ${String(t.text).slice(0, ANSWER_CHARS)}`)).join('\n\n');
}

// The slice of a thread the harvest has not read yet. `seen` counts HIS messages
// only — that is what mind_seen_turns has always meant — but the slice returned
// runs from his first unseen message to the end of the thread, answers included.
// Exported for the self-test: the off-by-one here decides whether a conversation's
// ideas are read twice or missed entirely.
export function unseenTurns(all = [], seen = 0) {
  let cut = all.length;
  for (let i = 0, u = 0; i < all.length; i++) {
    if (all[i].role !== 'user') continue;
    if (u === seen) { cut = i; break; }
    u++;
  }
  return all.slice(cut);
}

function buildHarvestPrompt(newTurns, factList) {
  const facts = factList.length
    ? factList.map((f) => `- [${f.id}] (${f.kind}) ${f.text}`).join('\n')
    : '(none yet)';
  return `You maintain the long-term memory of a personal app built for one man. He is its only user. Two things go in that memory: standing facts about HIM, and the PARADIGM the platform is built on — the ideas he and this app are working out together.

Return ONLY a JSON array (no prose, no markdown fence) of objects:
  {"kind": "about"|"taste"|"decision"|"project"|"person"|"style"|"vision", "text": "<the claim itself, plain English, <= 240 chars>", "detail": "<the reasoning, the mechanism, the example that made it land — as long as it needs to be>", "replaces"?: "<an existing fact id, if this corrects or sharpens it>", "contradicts"?: "<an existing fact id this REVERSES>", "merges"?: ["<existing fact ids that are all one idea>"]}

USE "vision" for the paradigm: what the platform IS, the mechanisms it runs on, what counts as an entity or a scale or a pattern, how analogy is supposed to work, what a part of the system is FOR. This is the material the whole project is built to accumulate — err toward keeping it.

Use the other kinds for him: "taste" and "style" for how he likes things and wants to be worked with, "decision" for a choice he has made, "project" for what is being built, "person" for people, "about" for who he is.

ALWAYS fill "detail" when there is reasoning behind a fact. "text" alone is a headline, and a headline without its argument is close to useless a month later — the mechanism, the why, and the example that convinced him all belong in "detail".

Keep only what would still be worth knowing next month. Do NOT save the shape of the conversation itself ("he asked about X", "the answer explored Y"), pleasantries, or anything already in the list below — if a turn merely repeats a known fact, omit it. But an idea that DEVELOPS a fact already in the list is not a repeat: return it with "replaces" set to that fact's id.

Use "replaces" to REPAIR the list too, when this conversation gives you what it takes: a fact filed under the wrong kind (the paradigm sitting under "project", say), or one whose "detail" is empty although the reasoning is right here in front of you. Return it with its id in "replaces", the kind it should have had, and the detail filled in. Repairing a fact is as valuable as finding a new one.

USE "contradicts" WHEN HE CHANGED HIS MIND. If this conversation REVERSES something in the list — he dropped an approach he had decided on, rejected a preference he used to hold, or corrected a claim about the paradigm — return the new, true claim with the old fact's id in "contradicts". The old one is then retired. This is different from "replaces", which sharpens a fact that is still true. A memory that can only ever add will end up holding both halves of every reversal and believing both.

USE "merges" WHEN SEVERAL FACTS ARE ONE IDEA. Look at the list as a whole, not only at this conversation. When three or four entries are the same idea seen from different angles, return ONE strong statement of it — the claim in "text", the combined reasoning in "detail" — with every id it absorbs in "merges". Memory should get denser as it grows, not longer. Folding four weak facts into one that carries all four is worth more than a new one.

ALSO RETURN, IN THE SAME ARRAY, EVERY REAL ANALOGY IN THE CONVERSATION — whether he said it or the answer did:
  {"kind": "analogy", "left": "<one side, a few words>", "right": "<the other side, a few words>", "pattern": "<the shape both share, one plain sentence>", "turn": "T<n>", "said_by": "he"|"answer"}
Only a real one: two things from DIFFERENT worlds or scales (a prison and an immune system, a cell and a city, a film character and a nation) sharing ONE pattern you can name. A passing comparison ("it's like a list"), a metaphor for style, or two examples of the same kind of thing are NOT analogies — leave them out. Most conversations hold none or one; never pad.

ALSO RETURN EVERY MOMENT THE CONVERSATION REACHES FOR SOMETHING KEPT OUTSIDE THIS TOOL:
  {"kind": "reach", "source": "kindle"|"readwise"|"youtube"|"zotero"|"notion"|"drive"|"gmail"|"calendar"|"other", "name": "<for other: the app or place named>", "what": "<the thing reached for, a few words>", "turn": "T<n>", "said_by": "he"|"answer"}
A reach is real when he or the answer names a thing kept somewhere else — a passage he underlined in a book, a lecture or a video, a paper in his reference manager, a document, an email, a date to hold, notes in another app — and this tool could not open it. A book or film title alone is NOT a reach (the library already takes those). Most conversations hold none.

WHAT YOU ALREADY KNOW:
${facts}

THE CONVERSATION SINCE YOU LAST LOOKED (most recent last):
${transcriptFor(newTurns)}`;
}

// Pull the JSON array out of a model reply that may be fenced or have a sentence
// in front. Returns null if it doesn't parse as an array.
function parseHarvest(text) {
  if (!text) return null;
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const open = s.indexOf('[');
  const close = s.lastIndexOf(']');
  if (open === -1 || close === -1 || close < open) return null;
  try {
    const arr = JSON.parse(s.slice(open, close + 1));
    return Array.isArray(arr) ? arr : null;
  } catch { return null; }
}

// A merge rearranges the list the other moves point into, so merges are applied
// first. Its own function so the self-test can prove the order without a database.
export function orderHarvestItems(items = []) {
  const isMerge = (it) => Array.isArray(it?.merges) && it.merges.length > 0;
  return [...items.filter(isMerge), ...items.filter((it) => !isMerge(it))];
}

// What the harvest returns, written into the table. Shared by the conversation pass
// and the library pass so both get the same four moves — add, sharpen, retire a
// reversed claim, fold several into one — and neither can quietly grow its own.
//
// Order matters: a merge rearranges the list the other two are pointing into, so it
// goes first, and an id already absorbed by a merge is not touched again.
function applyHarvestItems(items, { sourceConvoId = null, sourceNote = null } = {}) {
  let wrote = 0;
  const gone = new Set();
  const ordered = orderHarvestItems(items);
  for (const it of ordered) {
    if (!it || !it.kind || !it.text || !KINDS.includes(it.kind)) continue;
    const payload = { kind: it.kind, text: it.text, detail: it.detail || null, sourceConvoId, sourceNote };

    if (Array.isArray(it.merges) && it.merges.length) {
      const absorb = it.merges.filter((id) => id && !gone.has(id) && getFact(id));
      if (absorb.length < 2) {
        // One id is not a merge — treat it as the sharpening it actually is.
        if (absorb.length === 1) { reviseFact(absorb[0], { text: it.text, detail: it.detail || null, kind: it.kind }); wrote += 1; continue; }
      } else {
        // The survivor is the first absorbed row, rewritten — rather than a new row
        // the others point at. It keeps the oldest id, so anything already linked to
        // this idea (a core publication, an entity mention) still resolves.
        const survivor = absorb[0];
        reviseFact(survivor, { text: it.text, detail: it.detail || null, kind: it.kind });
        for (const id of absorb.slice(1)) { supersedeFact(id, survivor); gone.add(id); }
        wrote += 1;
        continue;
      }
    }

    if (it.contradicts && !gone.has(it.contradicts) && getFact(it.contradicts)) {
      const saved = saveFact(payload);
      const survivor = saved?.error === 'duplicate' ? saved.id : (saved?.id || null);
      if (survivor) { supersedeFact(it.contradicts, survivor); gone.add(it.contradicts); wrote += 1; }
      continue;
    }

    if (it.replaces && !gone.has(it.replaces) && getFact(it.replaces)) {
      reviseFact(it.replaces, { text: it.text, detail: it.detail || null, kind: it.kind });
      wrote += 1;
      continue;
    }

    const saved = saveFact(payload);
    if (saved && !saved.error) wrote += 1;
  }
  enforceCap();
  return wrote;
}

// The extraction job. Never called on the request path — fire-and-forget after an
// assistant turn. Reads only the turns since the watermark, never the whole thread.
async function runHarvest(convoId, force) {
  const convo = db.prepare(`SELECT id, subject_type, title, turns, mind_seen_turns FROM convos WHERE id=? AND deleted_at IS NULL`).get(convoId);
  // A side talk is a tangent, not standing memory to harvest — same reasoning
  // as roomWorldLook and analogyLook skipping it in conversations.js/roomAnalogies.js.
  if (!convo || convo.subject_type === 'side') return;
  // Both roles now. mind_seen_turns still counts HIS messages only — that is what
  // the watermark has always meant and what the trigger counts — but the slice
  // handed to the model runs from his first unseen message to the end, answers
  // included, so the pass sees what the conversation actually worked out.
  const all = db.prepare(`SELECT id, role, text FROM convo_messages WHERE convo_id=? AND kind='chat' AND role IN ('user','assistant') ORDER BY created_at`).all(convoId);
  const userCount = all.filter((m) => m.role === 'user').length;
  const newTurns = unseenTurns(all, convo.mind_seen_turns || 0);
  if (!force && newTurns.filter((m) => m.role === 'user').length < HARVEST_AFTER_TURNS) return;

  const factList = listFacts({ activeOnly: true }).map((f) => ({ id: f.id, text: f.text, kind: f.kind }));
  const result = await generateText({
    feature: 'summary', maxTokens: 2200, label: 'mind:harvest',
    prompt: buildHarvestPrompt(newTurns, factList),
  });
  if (result.error) { console.error('[mind] harvest model error:', result.error); return; }
  const items = parseHarvest(result.text);
  // Failed to parse as the expected shape: do NOT advance the watermark, so the
  // next harvest pass retries these same turns rather than silently losing them.
  if (!items) { console.error('[mind] harvest: unparseable model reply, watermark not advanced'); return; }

  const wrote = applyHarvestItems(items.filter((it) => it?.kind !== 'analogy' && it?.kind !== 'reach'), { sourceConvoId: convoId });
  // Reaches go to the connections ledger (plans/room-connections.md), never into memory.
  let reached = 0;
  for (const it of items.filter((x) => x?.kind === 'reach')) {
    const turn = newTurns[Number(String(it.turn || '').replace(/\D/g, '')) - 1];
    try {
      if (recordReach('antoine', { source: it.source, name: it.name, what: it.what, saidBy: it.said_by,
        convoId, messageId: turn?.id || null, convoTitle: convo.title || '' })) reached += 1;
    } catch (e) { console.error('[mind] reach save failed:', e.message); }
  }
  if (reached) broadcastAll('connections:updated', { reaches: reached });
  // Analogies go to the library, marked found, not into memory.
  let found = 0;
  for (const it of items.filter((x) => x?.kind === 'analogy')) {
    const turn = newTurns[Number(String(it.turn || '').replace(/\D/g, '')) - 1];
    try {
      if (saveFoundAnalogy('antoine', { left: it.left, right: it.right, pattern: it.pattern, saidBy: it.said_by,
        convoId, messageId: turn?.id || null, convoTitle: convo.title || '' })) found += 1;
    } catch (e) { console.error('[mind] analogy save failed:', e.message); }
  }
  if (found) broadcastAll('library:updated', { analogies: found });
  // Advance the watermark to the full count of chat turns seen.
  db.prepare(`UPDATE convos SET mind_seen_turns=? WHERE id=?`).run(userCount, convoId);
  if (wrote > 0) broadcastAll('mind:updated', {});
  mirrorOut();
}

// ---------------------------------------------------------------------------
// The library pass — what he keeps, not only what he says.
//
// Until this existed the memory only ever listened to the Room. But keeping a line
// is the loudest signal he gives: out of a long answer he chose that sentence, and
// out of every book he put THAT one on the shelf. None of it reached memory.
//
// Two watermarks, not one, and the reason is dull but load-bearing: saved_passages
// stamps its rows in ISO ('2026-09-22T14:03:11.000Z') while shelf_books uses
// SQLite's CURRENT_TIMESTAMP ('2026-09-22 14:03:11'). A space sorts before a 'T',
// so one shared watermark compared as text would make every book look older than
// every passage and the shelf would never be read at all. Each mark is only ever
// compared against stamps from its own table, and is set from the rows actually
// read rather than from the clock.
const MARK_PASSAGES = 'passages_seen_at';
const MARK_BOOKS = 'books_seen_at';
// Enough kept things to be worth a model call. One kept line on its own is usually
// a quote he liked; three or four start to describe what he is circling.
const LIBRARY_MIN_ITEMS = 3;
const LIBRARY_PASSAGES = 30;
const LIBRARY_BOOKS = 15;

function buildLibraryPrompt(passages, books, factList) {
  const facts = factList.length
    ? factList.map((f) => `- [${f.id}] (${f.kind}) ${f.text}`).join('\n')
    : '(none yet)';
  const kept = passages.map((row) => {
    const from = row.source_title ? ` (out of: ${row.source_title})` : '';
    const read = row.reading ? `\n  it was read here as: ${String(row.reading).slice(0, 500)}` : '';
    return `KEPT LINE${from}:\n  "${String(row.text).slice(0, 900)}"${read}`;
  });
  const shelf = books.map((row) => {
    const who = row.author ? ` — ${row.author}` : '';
    const why = row.relevance
      ? `\n  why it is here: ${String(row.relevance).slice(0, 600)}`
      : (row.blurb ? `\n  ${String(row.blurb).slice(0, 400)}` : '');
    return `PUT ON THE SHELF: ${row.title}${who}${why}`;
  });

  return `You maintain the long-term memory of a personal app built for one man. He is its only user. This time you are not reading a conversation — you are reading what he chose to KEEP.

That choice is the signal. Out of a long answer he lifted one sentence and saved it. Out of everything he could read he put this book on his shelf. Nobody asked him to; there is no reward for it. So treat every item below as him pointing at something and saying "this".

Do NOT save the line itself. A quote is not a memory. Name what it is an instance OF — the standing fact about him, or the paradigm concept it is pointing at — and save THAT. If several kept things point at the same thing, that is one strong memory, not four weak ones.

Two things go in this memory: standing facts about HIM (what he is drawn to, how he wants to be worked with, what he has decided) and the PARADIGM the platform is built on — what it IS, its mechanisms, what counts as an entity or a scale, how analogy is supposed to work.

Return ONLY a JSON array (no prose, no markdown fence) of objects:
  {"kind": "about"|"taste"|"decision"|"project"|"person"|"style"|"vision", "text": "<the claim itself, plain English, <= 240 chars>", "detail": "<the reasoning, the mechanism, the kept line that made it land — as long as it needs to be>", "replaces"?: "<an existing fact id, if this sharpens it>", "contradicts"?: "<an existing fact id this REVERSES>", "merges"?: ["<existing fact ids that are all one idea>"]}

ALWAYS fill "detail", and quote the kept line inside it when the line is what makes the fact real.

Return an empty array rather than padding. Most batches of kept lines yield one or two real memories, and several yield none at all — they were simply good sentences. Nothing here is worth saving twice: if the list below already holds it, leave it out, unless this deepens it (then use "replaces") or reverses it (then use "contradicts").

WHAT YOU ALREADY KNOW:
${facts}

WHAT HE HAS KEPT SINCE YOU LAST LOOKED:
${[...kept, ...shelf].join('\n\n')}`;
}

async function runLibraryHarvest(force) {
  const sincePassages = markGet(MARK_PASSAGES);
  const sinceBooks = markGet(MARK_BOOKS);
  let passages = [];
  let books = [];
  try {
    passages = db.prepare(
      `SELECT text, source_title, reading, created_at FROM saved_passages
       WHERE deleted_at IS NULL AND created_at > ? ORDER BY created_at LIMIT ?`,
    ).all(sincePassages || '', LIBRARY_PASSAGES);
  } catch (e) { console.error('[mind] library: passages read failed:', e?.message || e); }
  try {
    books = db.prepare(
      `SELECT title, author, blurb, relevance, created_at FROM shelf_books
       WHERE created_at > ? ORDER BY created_at LIMIT ?`,
    ).all(sinceBooks || '', LIBRARY_BOOKS);
  } catch (e) { /* the shelf may not exist yet on a fresh database */ }

  const count = passages.length + books.length;
  if (!count) return;
  if (!force && count < LIBRARY_MIN_ITEMS) return;

  const factList = listFacts({ activeOnly: true }).map((f) => ({ id: f.id, text: f.text, kind: f.kind }));
  const result = await generateText({
    feature: 'summary', maxTokens: 1500, label: 'mind:library',
    prompt: buildLibraryPrompt(passages, books, factList),
  });
  if (result.error) { console.error('[mind] library model error:', result.error); return; }
  const items = parseHarvest(result.text);
  // Same rule as the conversation pass: an unreadable reply must not advance the
  // watermark, or the kept lines it was about are lost for good.
  if (!items) { console.error('[mind] library: unparseable model reply, watermarks not advanced'); return; }

  const wrote = applyHarvestItems(items, { sourceNote: 'library' });
  // Set from the rows actually read, never from the clock — anything saved while
  // this pass was running is then still unseen and gets read next time.
  if (passages.length) markSet(MARK_PASSAGES, passages[passages.length - 1].created_at);
  if (books.length) markSet(MARK_BOOKS, books[books.length - 1].created_at);
  if (wrote > 0) { broadcastAll('mind:updated', {}); mirrorOut(); }
}

// ---------------------------------------------------------------------------
// How he likes an answer — learned from the passages he marks in Room answers
// (his ask, 2026-09-25: "when a little passage is answered the way i like, i select
// it, so the system gets over time more feedback of what i like"). Two marks feed
// it: Like (answer_likes), made only for this, and Keep (saved_passages), made for
// a personal reason but still him pointing at what he loves — he wants both to
// count. Like is the stronger signal, and the prompt says so.
//
// Moon, not finger: the kept lines never reach an answering model. A model shown
// them copies their images and words (the-lens.md, top comment). One pass reads
// them together and writes down only what they share underneath — the move, the
// stance, the rhythm, the reach — and a code check refuses any reading that lifts
// a phrase or a striking word from them. The result is ONE fact in the Mind,
// refined each time rather than added to, so he can read and correct it there.
const TASTE_NOTE = 'answer_taste';
const MARK_TASTE = 'answer_taste_ids';
const TASTE_MIN = 3;        // kept lines before a reading is worth making
const TASTE_NEW = 3;        // new keeps before it is worth making again
const TASTE_LINES = 40;

const wordsOf = (t) => String(t || '').toLowerCase().match(/[a-zÀ-ɏ']+/g) || [];
// Words a reading of style may share with the lines without having copied them.
const TASTE_COMMON = new Set(('abstract concrete metaphor metaphors image images sentence sentences paragraph rhythm ' +
  'answer answers thinking thought thoughts through between something structure pattern patterns feeling feelings ' +
  'meaning ordinary everyday familiar strange distance different another because without instead itself himself ' +
  'understanding understand question questions comparison comparisons physical personal emotional ' +
  'history present nothing everything someone somewhere recognises recognizes surprising unexpected ' +
  'language describe describes explain explains quietly directly simple plainly').split(' '));

// Any three-word run from a kept line, or any long word the lines use that is not
// the ordinary vocabulary of talking about style. Pure, for the self-test.
export function tasteLeaks(reading, lines = []) {
  const r = wordsOf(reading);
  const rs = r.join(' ');
  const out = new Set();
  const lineWords = new Set();
  for (const line of lines) {
    const w = wordsOf(line);
    w.forEach((x) => lineWords.add(x));
    for (let i = 0; i + 2 < w.length; i++) {
      const run = `${w[i]} ${w[i + 1]} ${w[i + 2]}`;
      if (w.slice(i, i + 3).some((x) => x.length > 3 && !STOPWORDS.has(x)) && (` ${rs} `).includes(` ${run} `)) out.add(`"${run}"`);
    }
  }
  // Single words only when they are names — capitalised inside a sentence in the
  // lines. A single ordinary word ("structural", "systems") is how anyone talks
  // about style; refusing those left the reading impossible to write (2026-09-25).
  const names = new Set();
  for (const line of lines) {
    for (const m of String(line || '').matchAll(/(?<=[a-z,;]\s)([A-Z][a-z\u00c0-\u024f']{2,})/g)) names.add(m[1].toLowerCase());
  }
  for (const x of new Set(r)) if (names.has(x) && lineWords.has(x)) out.add(x);
  return [...out];
}

function tastePrompt(liked, kept, current, avoid = []) {
  return `One man marks passages in the answers an AI writes for him. LIKED passages he marked precisely because they are answered the way he loves — the strongest signal. Some carry his own note on what he liked: those notes are the clearest words you have, follow them. KEPT passages he saved for a personal reason; they still show what he loves, but weigh them less.

Your job: understand what these lines share UNDERNEATH their subjects — the kind of move they make, how far they reach and to where, the stance they take toward the thing, how they are built and paced, what they dare, what they refuse to do — and write that down so an AI can answer in that way about ANY subject.

This is the most important rule: point at the moon, not at the finger. An AI that reads your description will copy any concrete thing in it. So:
- Never quote or paraphrase a line.
- Never name an image, object, place, person, field or subject that appears in them.
- Never reuse their distinctive words.
Describe the understanding, never the examples.${avoid.length ? `\n- Your last attempt lifted these from the lines; find other words: ${avoid.join(', ')}.` : ''}

${current ? `What was understood before (refine it with these lines — keep what still holds, correct what they contradict, do not start over):\n${current}\n\n` : ''}Return ONLY a JSON object, no fence: {"text": "<the heart of it, plain English, at most 240 characters>", "detail": "<the fuller understanding, at most 900 characters>"}

${liked.length ? `LIKED:\n${liked.map((l) => `- ${String(l).slice(0, 700)}`).join('\n')}\n\n` : ''}${kept.length ? `KEPT:\n${kept.map((l) => `- ${String(l).slice(0, 700)}`).join('\n')}` : ''}`;
}

function parseTaste(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    const t = String(o.text || '').trim();
    return t ? { text: t.slice(0, 240), detail: String(o.detail || '').trim().slice(0, 900) || null } : null;
  } catch { return null; }
}

function tasteFact() {
  try { return db.prepare(`SELECT * FROM mind_facts WHERE source_note=? AND active=1 ORDER BY updated_at DESC LIMIT 1`).get(TASTE_NOTE) || null; }
  catch { return null; }
}

async function runAnswerTaste(force = false) {
  let liked = [];
  let kept = [];
  try { liked = db.prepare(`SELECT id, text, note FROM answer_likes WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ?`).all(TASTE_LINES); } catch {}
  try { kept = db.prepare(`SELECT id, text FROM saved_passages WHERE deleted_at IS NULL AND message_id IS NOT NULL ORDER BY created_at DESC LIMIT ?`).all(TASTE_LINES); } catch {}
  const rows = [...liked, ...kept];
  // A note changes the reading too, so it is part of what counts as "seen".
  const ids = rows.map((r) => (r.note ? `${r.id}~${String(r.note).length}` : r.id));
  const seen = new Set(String(markGet(MARK_TASTE) || '').split(',').filter(Boolean));
  const added = ids.filter((id) => !seen.has(id)).length;
  const removed = [...seen].some((id) => !ids.includes(id));
  if (rows.length < TASTE_MIN) return;
  if (!force && added < TASTE_NEW && !removed) return;

  const lines = rows.map((r) => r.text);
  const likedLines = liked.map((r) => r.note ? `${r.text}\n  HIS NOTE ON WHAT HE LIKED: ${String(r.note).slice(0, 400)}` : r.text);
  const keptLines = kept.map((r) => r.text);
  const fact = tasteFact();
  const current = fact ? `${fact.text}${fact.detail ? `\n${fact.detail}` : ''}` : '';
  let got = null;
  let avoid = [];
  for (let attempt = 0; attempt < 3 && !got; attempt++) {
    const res = await generateText({ feature: 'summary', maxTokens: 700, label: 'mind:answer-taste', prompt: tastePrompt(likedLines, keptLines, current, avoid) });
    if (res.error) { console.error('[mind] answer taste model error:', res.error); return; }
    const t = parseTaste(res.text);
    if (!t) continue;
    const leaks = tasteLeaks(`${t.text} ${t.detail || ''}`, lines);
    if (leaks.length) { avoid = leaks.slice(0, 12); console.log('[mind] answer taste lifted words, retrying:', avoid.join(', ')); continue; }
    got = t;
  }
  // Nothing clean: leave the old reading and the watermark alone, try next time.
  if (!got) return;
  if (fact) reviseFact(fact.id, { text: got.text, detail: got.detail, kind: 'style' });
  else saveFact({ kind: 'style', text: got.text, detail: got.detail, sourceNote: TASTE_NOTE, central: true });
  markSet(MARK_TASTE, ids.join(','));
  broadcastAll('mind:updated', {});
  mirrorOut();
}

// The fuller reading, for the Room's full answers only (conversations.js puts it
// beside the lens). The short line already rides every turn as a Central style fact.
export function answerTasteBlock() {
  const f = tasteFact();
  if (!f) return '';
  return `\n=== HOW HE LIKES AN ANSWER — learned from the lines he kept ===\n${f.text}${f.detail ? `\n${f.detail}` : ''}\nThis is a way of answering, not a subject: bring it to whatever he asks.`;
}

// The Like mark itself.
export function listLikes() {
  try { return db.prepare(`SELECT id, text, note, convo_id, message_id, created_at FROM answer_likes WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 500`).all(); }
  catch { return []; }
}
export function likeLine({ text, convoId = null, messageId = null, note = null } = {}) {
  const body = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 20000);
  if (!body) return { error: 'empty' };
  const existing = db.prepare(`SELECT id FROM answer_likes WHERE text=? AND deleted_at IS NULL`).get(body);
  if (existing) return { ok: true, id: existing.id, already: true };
  const id = randomUUID();
  db.prepare(`INSERT INTO answer_likes (id, text, convo_id, message_id, note) VALUES (?,?,?,?,?)`).run(id, body, convoId || null, messageId || null, String(note || '').trim().slice(0, 1000) || null);
  refreshAnswerTasteSoon();
  broadcastAll('likes:updated', {});
  return { ok: true, id };
}
export function noteLike(id, note) {
  const r = db.prepare(`UPDATE answer_likes SET note=? WHERE id=? AND deleted_at IS NULL`).run(String(note || '').trim().slice(0, 1000) || null, id);
  if (!r.changes) return { error: 'not_found' };
  refreshAnswerTasteSoon();
  broadcastAll('likes:updated', {});
  return { ok: true };
}
export function unlikeLine(id) {
  const r = db.prepare(`UPDATE answer_likes SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND deleted_at IS NULL`).run(id);
  if (!r.changes) return { error: 'not_found' };
  refreshAnswerTasteSoon();
  broadcastAll('likes:updated', {});
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Subjects he is drawn to (his ask, 2026-09-25: "a library of entities and subjects
// and institutions I'm interested in, so the analogy engines run across those a bit
// more, without being confined to those"). Only the NAME is kept, never the passage
// it was marked in. A few are handed to each answer and to the analogy generator,
// picked at random every time: a fixed list would pull every answer to the same
// place, the very fault the lens had to be rewritten for ("everything becomes an
// office"). They are an invitation to reach there, never a destination.
export const SUBJECT_KINDS = ['person', 'institution', 'idea', 'place', 'work', 'field', 'thing', 'other'];

export function listSubjects() {
  try { return db.prepare(`SELECT id, name, kind, created_at FROM interest_subjects WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 1000`).all(); }
  catch { return []; }
}

function saveSubject({ name, kind = 'other', convoId = null, messageId = null }) {
  const n = String(name || '').replace(/\s+/g, ' ').trim().replace(/^["'“”]+|["'“”.]+$/g, '').slice(0, 80);
  if (!n) return { error: 'empty' };
  const k = SUBJECT_KINDS.includes(kind) ? kind : 'other';
  const same = db.prepare(`SELECT id, name, kind FROM interest_subjects WHERE lower(name)=lower(?) AND deleted_at IS NULL`).get(n);
  if (same) return { ok: true, subject: same, already: true };
  const id = randomUUID();
  db.prepare(`INSERT INTO interest_subjects (id, name, kind, convo_id, message_id) VALUES (?,?,?,?,?)`).run(id, n, k, convoId || null, messageId || null);
  broadcastAll('subjects:updated', {});
  return { ok: true, subject: { id, name: n, kind: k } };
}

// From a marked passage, the one subject it points at. A model names it; if the
// model is down, a short selection stands as its own name and a long one fails
// honestly rather than saving a sentence as a "subject".
export async function markSubject({ text, convoId = null, messageId = null } = {}) {
  const passage = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
  if (!passage) return { error: 'empty' };
  const res = await generateText({
    feature: 'summary', maxTokens: 120, label: 'mind:subject',
    prompt: `He selected this in an answer and marked it: "this subject interests me". Name the ONE subject he is pointing at — a person, an institution, an idea, a place, a work, a field or a thing. Use its usual short name, the way it would appear as a library entry (for example a named institution, a concept, a person's full name). Return ONLY JSON: {"name": "<at most 60 characters>", "kind": "${SUBJECT_KINDS.join('|')}"}

WHAT HE SELECTED:
${passage}`,
  });
  let got = null;
  if (!res.error) {
    const m = String(res.text || '').match(/\{[\s\S]*\}/);
    try { got = m ? JSON.parse(m[0]) : null; } catch { got = null; }
  }
  if (!got?.name) {
    if (passage.split(' ').length > 6) return { error: 'unreadable' };
    got = { name: passage, kind: 'other' };
  }
  return saveSubject({ name: got.name, kind: got.kind, convoId, messageId });
}

export function addSubject({ name, kind } = {}) { return saveSubject({ name, kind }); }

export function dropSubject(id) {
  const r = db.prepare(`UPDATE interest_subjects SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND deleted_at IS NULL`).run(id);
  if (!r.changes) return { error: 'not_found' };
  broadcastAll('subjects:updated', {});
  return { ok: true };
}

// A few, at random, every call. Pure over its input for the self-test.
export function pickSubjects(all = [], n = 3, rand = Math.random) {
  const pool = all.slice();
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  return pool.slice(0, n);
}

export function subjectsLine(n = 3) {
  const picked = pickSubjects(listSubjects(), n);
  if (!picked.length) return '';
  return `Subjects he is drawn to, a few picked at random this time: ${picked.map((s) => s.name).join('; ')}. When you look for the far parallel, you may reach toward one of these — but only if the same structure truly repeats there. Most answers will use none of them, and that is right. Never force one in, never mention this list.`;
}

export function subjectsBlock(n = 3) {
  const line = subjectsLine(n);
  return line ? `\n=== WHERE HE LIKES TO LOOK ===\n${line}` : '';
}

// After a mark is taken back, the reading must forget it too.
export function refreshAnswerTasteSoon() {
  setImmediate(() => { runAnswerTaste(false).catch((e) => console.error('[mind] answer taste failed:', e?.message || e)); });
}

// ---------------------------------------------------------------------------
// The thickening pass — memory that gets denser instead of longer.
//
// The harvest can fold facts together as it goes, but it only ever looks at the
// conversation in front of it. Nothing ever stood back and read the whole list, so
// eight entries could be one idea seen from eight angles and stay eight rows.
//
// Runs on the most crowded kind only, at most once a day, and only once the table
// is big enough for crowding to be real. It is the one pass that reads `detail` for
// every fact it considers — merging on headlines alone would fuse two ideas that
// happen to share their vocabulary.
const MARK_THICKENED = 'thickened_at';
const THICKEN_AT = 45;             // active facts before it is worth looking
const THICKEN_EVERY_MS = 86_400_000;
const THICKEN_DETAIL = 400;

function buildThickenPrompt(kind, rows) {
  const list = rows.map((f) => `- [${f.id}] ${f.text}${f.detail ? `\n    ${String(f.detail).slice(0, THICKEN_DETAIL).replace(/\s+/g, ' ')}` : ''}`).join('\n');
  return `You maintain the long-term memory of a personal app built for one man. Below is everything it currently believes under one heading: "${kind}".

A memory that only ever adds gets longer. A good one gets DENSER. Your job here is only that: find where several entries are one idea seen from different angles, and fold each such group into a single statement that carries all of them.

Return ONLY a JSON array (no prose, no markdown fence) of objects, one per group you are folding:
  {"kind": "${kind}", "text": "<the single strongest statement of the idea, plain English, <= 240 chars>", "detail": "<the combined reasoning: every mechanism, example and distinction worth keeping from the entries you are folding>", "merges": ["<every id in the group>"]}

Rules, and they matter more than finding something:
- A group is TWO OR MORE ids. Never return a group of one.
- Merge only what is genuinely ONE idea. Two ideas that share vocabulary, or that are about the same subject from different angles, are NOT one idea — a fact about how policy travels downward and a fact about how it loops back are two facts, and fusing them destroys both.
- Lose nothing. Every specific mechanism, named work, or distinction in the entries you fold must survive in "detail". If you cannot carry it all, do not merge.
- An empty array is the correct answer most of the time. Return [] rather than forcing a merge.

THE ENTRIES:
${list}`;
}

async function runThicken(force) {
  const last = Number(markGet(MARK_THICKENED) || 0);
  if (!force && last && Date.now() - last < THICKEN_EVERY_MS) return;
  const all = listFacts({ activeOnly: true });
  if (!force && all.length < THICKEN_AT) return;

  const byKind = new Map();
  for (const f of all) byKind.set(f.kind, [...(byKind.get(f.kind) || []), f]);
  let kind = null;
  let rows = [];
  for (const [k, list] of byKind) if (list.length > rows.length) { kind = k; rows = list; }
  if (!kind || rows.length < 4) return;

  // Written before the call, not after: a pass that dies mid-way must not retry on
  // every harvest for the rest of the day.
  markSet(MARK_THICKENED, String(Date.now()));

  const result = await generateText({
    feature: 'summary', maxTokens: 2000, label: 'mind:thicken',
    prompt: buildThickenPrompt(kind, rows),
  });
  if (result.error) { console.error('[mind] thicken model error:', result.error); return; }
  const items = parseHarvest(result.text);
  if (!items || !items.length) return;

  // Only merges are honoured here. This pass reads no conversation, so it has no
  // standing to add a new claim or retire one — the temptation for a model handed a
  // list of ideas is to write a better one, and that would be invention, not memory.
  const merges = items.filter((it) => Array.isArray(it?.merges) && it.merges.length >= 2)
    .map((it) => ({ ...it, kind, contradicts: null, replaces: null }));
  if (!merges.length) return;
  const wrote = applyHarvestItems(merges, { sourceNote: 'thicken' });
  if (wrote > 0) {
    console.log(`[mind] thickened ${kind}: ${wrote} group(s) folded`);
    broadcastAll('mind:updated', {});
    mirrorOut();
  }
}

// Rewind the watermark so the next harvest reads a thread from the beginning.
// Its own function rather than a flag on harvest() because it is a write that must
// land before the fire-and-forget pass starts reading.
export function rewindHarvest(convoId) {
  try {
    db.prepare(`UPDATE convos SET mind_seen_turns=0 WHERE id=?`).run(convoId);
    return { ok: true };
  } catch (e) { return { error: e.message || 'rewind_failed' }; }
}

// "Remember this" (plan "side talks in the Room, and remember this"): a selected
// passage, understood rather than copied — his own words: "it understands what
// we talked about and that this is a particular concept", not just the literal
// quote. The passage is a pointer; the turns around it (same shape as the
// harvest transcript) are what actually let the model name the concept.
const REMEMBER_RADIUS = 6;
function transcriptAround(convoId, messageId) {
  const all = db.prepare(`SELECT id, role, text FROM convo_messages WHERE convo_id=? AND kind='chat' AND role IN ('user','assistant') ORDER BY created_at`).all(convoId);
  const idx = messageId ? all.findIndex((m) => m.id === messageId) : -1;
  const slice = idx >= 0
    ? all.slice(Math.max(0, idx - REMEMBER_RADIUS), idx + REMEMBER_RADIUS + 1)
    : all.slice(-REMEMBER_RADIUS * 2);
  return transcriptFor(slice);
}

// Shared prompt for both remember entrances (plan "owner emphasis when the Room
// remembers or changes the core"): a selected passage AND a directly typed
// thought go through the same proposal path now, so a typed source gets the same
// care a passage always did. His own note is an INSTRUCTION, not an attachment —
// it must be honoured unless it contradicts the source, never invented past it.
// Exported (not called from outside this module otherwise) so mind-selftest.js
// can assert the prompt assembly directly — a wrong word here (his note read as
// optional, Central left unstated) is a silent behavior change no model call
// would surface in a quick manual check.
export function buildProposePrompt({ sourceType, text, transcript, factList, ownerNote, central, destination }) {
  const facts = factList.length ? factList.map((f) => `- [${f.id}] (${f.kind}) ${f.text}`).join('\n') : '(none yet)';
  const sourceLabel = sourceType === 'direct' ? 'He typed this thought directly, to remember it' : 'He selected this passage from a conversation, to remember it';
  return `You maintain the long-term memory of a personal app built for one man. ${sourceLabel}.

Do not just repeat the source back. Understand what it is an instance OF — the standing fact or the paradigm concept it is pointing at — and name THAT.

THE SOURCE:
"""
${text}
"""
${transcript ? `\nTHE CONVERSATION AROUND IT (for context only — the source above is what matters):\n${transcript}\n` : ''}
${ownerNote ? `HIS OWN NOTE ON WHY THIS MATTERS — this states what HE thinks is important. Honour it and build the memory from it unless it plainly contradicts the source; it may clarify the source, it must not invent a claim absent from both:\n"""\n${ownerNote}\n"""\n` : ''}
${central ? 'He marked this CENTRAL — it should carry real weight, not be filed as a passing note.\n' : ''}
${destination === 'core' ? 'He is saving this straight to the CORE PARADIGM document — write the memory as a settled, coherent addition to that paradigm, not a tentative note.\n' : ''}
WHAT YOU ALREADY KNOW:
${facts}

Return ONLY this JSON object (no prose, no markdown fence):
{"kind": "about"|"taste"|"decision"|"project"|"person"|"style"|"vision", "text": "<the concept itself, plain English, <= 240 chars>", "detail": "<the reasoning, the mechanism, the example that made it land>"}

Use "vision" only for the paradigm itself — what the platform is, a mechanism, what counts as an entity or a scale. Everything else about him or his work uses the other kinds.`;
}

function parseRememberReply(text) {
  if (!text) return null;
  let s = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const open = s.indexOf('{');
  const close = s.lastIndexOf('}');
  if (open === -1 || close === -1 || close < open) return null;
  try {
    const obj = JSON.parse(s.slice(open, close + 1));
    return (obj && typeof obj === 'object') ? obj : null;
  } catch { return null; }
}

// Returns a PROPOSAL only — saving is a separate, explicit step (saveRemembered
// below), because where it lands is his choice, never decided for him.
// `sourceType`: 'passage' (has convoId/messageId, transcript pulled around it) or
// 'direct' (typed straight into the Mind pane, no conversation to read around it).
export async function proposeRemember({ sourceType = 'passage', text, convoId = null, messageId = null, ownerNote = null, central = false, destination = 'memory' } = {}) {
  const source = String(text || '').trim();
  if (!source) return { error: 'empty' };
  const transcript = sourceType === 'direct' || !convoId ? null : transcriptAround(convoId, messageId);
  const factList = listFacts({ activeOnly: true }).map((f) => ({ id: f.id, text: f.text, kind: f.kind }));
  const result = await generateText({
    feature: 'summary', maxTokens: 700, label: 'mind:remember',
    prompt: buildProposePrompt({ sourceType, text: source, transcript, factList, ownerNote, central, destination }),
  });
  if (result.error) return { error: result.error };
  const obj = parseRememberReply(result.text);
  if (!obj || !obj.text) return { error: 'unparseable' };
  return {
    kind: KINDS.includes(obj.kind) ? obj.kind : 'about',
    text: String(obj.text).slice(0, 240),
    detail: obj.detail ? String(obj.detail).slice(0, 4000) : null,
  };
}

// Today's date, in the plain form the core document's own dated entries use
// elsewhere in the repo (data-seed docs are read by humans and agents, not
// machine-parsed) — kept local to avoid a dependency for one line.
function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

export function buildCoreAddition({ text, detail, ownerNote }) {
  const lines = [`### ${todayStamp()} — ${text}`];
  if (detail) lines.push('', detail);
  if (ownerNote) lines.push('', `_Owner's note: ${ownerNote}_`);
  return lines.join('\n');
}

// The one save path both remember entrances use once he presses Save. A plain
// Memory save is saveFact(); a Core save additionally writes the same
// understanding as a 'vision' fact (so the Room knows it immediately) and queues
// a pending core_publications row for the Mac runner to append and push — see
// scripts/queue-runner.js#publishCoreAdditions. Both writes happen together so a
// retry can never produce the vision fact without the matching pending row, or a
// pending row with no fact backing it in the Room in the meantime.
export function saveRemembered({ sourceType = 'passage', sourceText, convoId = null, ownerNote = null, central = false, destination = 'memory', kind, text, detail } = {}) {
  if (!text || !String(text).trim()) return { error: 'text_required' };
  if (destination !== 'core') {
    const fact = saveFact({ kind, text, detail, sourceConvoId: convoId, sourceNote: sourceType === 'direct' ? 'direct' : 'remember', ownerNote, central });
    if (fact.error) return fact;
    return { fact, destination: 'memory' };
  }
  const fact = saveFact({ kind: 'vision', text, detail, sourceConvoId: convoId, sourceNote: sourceType === 'direct' ? 'direct' : 'remember', ownerNote, central });
  if (fact.error) return fact;
  try {
    const id = `cpub_${randomUUID()}`;
    const now = new Date().toISOString();
    const addition = buildCoreAddition({ text, detail, ownerNote });
    db.prepare(`INSERT INTO core_publications (id, convo_id, source_type, source_text, owner_note, is_central, addition, fact_id, state, created_at) VALUES (?,?,?,?,?,?,?,?,'pending',?)`)
      .run(id, convoId, sourceType, sourceText ? String(sourceText).slice(0, 4000) : null, ownerNote, central ? 1 : 0, addition, fact.id, now);
    return { fact, destination: 'core', publication: { id, state: 'pending' } };
  } catch (e) {
    return { error: e.message || 'publication_failed' };
  }
}

// Runner-only surface: what still needs appending to the core document, and how
// the runner reports back once pushed. Automatic harvest() never touches this
// table — it only ever calls saveFact(), so there is no path from a background
// extraction to a core-document write.
export function listPendingCorePublications() {
  try {
    return db.prepare(`SELECT id, convo_id, source_type, source_text, owner_note, is_central, addition, fact_id, created_at FROM core_publications WHERE state='pending' ORDER BY created_at ASC`).all();
  } catch { return []; }
}

export function acknowledgeCorePublication(id, commitSha) {
  try {
    const r = db.prepare(`UPDATE core_publications SET state='published', commit_sha=?, published_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND state='pending'`).run(commitSha || null, id);
    return { ok: r.changes > 0 };
  } catch (e) { return { error: e.message || 'ack_failed' }; }
}

export function corePublicationStatus(id) {
  try {
    return db.prepare(`SELECT id, state, commit_sha, published_at FROM core_publications WHERE id=?`).get(id) || null;
  } catch { return null; }
}

const _harvestInFlight = new Set();
let _libraryInFlight = false;
let _thickenInFlight = false;

// The two passes that read something other than the conversation ride the same
// trigger as the conversation harvest — an assistant turn just finished, nothing is
// waiting on us, and the process is awake. Each decides for itself whether there is
// anything to do: the library needs a few newly kept things, the thickening needs a
// crowded table and a day since the last one. Both are fire-and-forget and both
// swallow their own failures, because neither may ever turn into a failed turn.
async function runSidePasses(force) {
  if (!_libraryInFlight) {
    _libraryInFlight = true;
    try { await runLibraryHarvest(force); }
    catch (e) { console.error('[mind] library harvest failed:', e?.message || e); }
    try { await runAnswerTaste(false); }
    catch (e) { console.error('[mind] answer taste failed:', e?.message || e); }
    finally { _libraryInFlight = false; }
  }
  if (!_thickenInFlight) {
    _thickenInFlight = true;
    try { await runThicken(false); }
    catch (e) { console.error('[mind] thicken failed:', e?.message || e); }
    finally { _thickenInFlight = false; }
  }
}

export function harvest(convoId, { force = false } = {}) {
  if (!convoId || _harvestInFlight.has(convoId)) return;
  _harvestInFlight.add(convoId);
  setImmediate(async () => {
    try { await runHarvest(convoId, force); }
    catch (e) { console.error('[mind] harvest failed:', e?.message || e); }
    finally { _harvestInFlight.delete(convoId); }
    await runSidePasses(false);
  });
}

// Manual entrances, for the Mind pane. Same passes, told to run even when their own
// thresholds say there is not enough yet.
export function harvestLibrary({ force = true } = {}) {
  if (_libraryInFlight) return { ok: false, busy: true };
  _libraryInFlight = true;
  setImmediate(async () => {
    try { await runLibraryHarvest(force); }
    catch (e) { console.error('[mind] library harvest failed:', e?.message || e); }
    try { await runAnswerTaste(force); }
    catch (e) { console.error('[mind] answer taste failed:', e?.message || e); }
    finally { _libraryInFlight = false; }
  });
  return { ok: true };
}

export function thickenMemory({ force = true } = {}) {
  if (_thickenInFlight) return { ok: false, busy: true };
  _thickenInFlight = true;
  setImmediate(async () => {
    try { await runThicken(force); }
    catch (e) { console.error('[mind] thicken failed:', e?.message || e); }
    finally { _thickenInFlight = false; }
  });
  return { ok: true };
}
