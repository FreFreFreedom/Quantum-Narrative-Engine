// The analogy engine beside the Room (plan "the analogy engine in the Room").
//
// World Ideas asks what could be BUILT out of a conversation. This asks a
// different question: where is the relation being discussed already living, under
// other names, in another domain or at another scale. The value of an arrival is
// the new question it makes possible — not a match score, which is why none is
// ever computed or shown.
//
// Two deliberate decisions, both Antoine's (2026-09-13):
//
//   1. The search space is the MODEL'S WORLD, not our 492 entities. "We don't have
//      much entities compared to the gazillion that exist for real." So there is
//      no structural matcher over the corpus here and no dependency on the
//      computed anatomy handle that blocks plans/cross-domain-healing-search.md.
//   2. The side pane is its own small conversation. He can read what arrived
//      unasked, ask for another kind, and carry results into the Room himself.
//      Nothing is ever said in his name: "bring" loads the composer, and the
//      frontend never sends.
//
// Storage rides what already exists. The side thread is a convo with
// subject_type 'analogy' and subject_id = the Room convo's id (the existing
// unique index gives exactly one per thread, and listOpenConvos only ever selects
// subject_type='open', so it never shows up in the thread list). Each arrival is
// one assistant message whose `meta` column holds the card. No new table.

import { randomUUID } from 'node:crypto';
import { broadcastAll } from '../realtime.js';
import { generateText } from './ai/text.js';
import { getConvo, listMessages } from './conversations.js';

let db = null;
export function bindRoomAnalogiesDb(database) { db = database; }

// ─── Steering ────────────────────────────────────────────────────────────────
// The moves are the paradigm's own navigation moves plus two shapes an arrival
// can take that are not moves (an antidote from another domain, a counterpart
// holding the same tension differently). `reach` is whether the model may leave
// the corpus — "here" keeps it to things this app already knows about.

export const MOVES = ['vertical', 'horizontal', 'entanglement', 'antidote', 'counterpart'];
export const WHENS = ['pause', 'every', 'asked'];
export const STEER_DEFAULT = Object.freeze({
  moves: ['vertical', 'horizontal', 'entanglement'],
  reach: 'anywhere',      // 'anywhere' | 'here'
  domains: [],            // empty = the model chooses
  when: 'pause',          // 'pause' | 'every' | 'asked'
});

export function normalizeSteer(raw) {
  const s = (raw && typeof raw === 'object') ? raw : {};
  const moves = Array.isArray(s.moves) ? s.moves.filter((m) => MOVES.includes(m)) : null;
  const domains = Array.isArray(s.domains)
    ? [...new Set(s.domains.map((d) => String(d || '').trim().toLowerCase()).filter(Boolean))].slice(0, 12)
    : [];
  return {
    moves: moves && moves.length ? moves : [...STEER_DEFAULT.moves],
    reach: s.reach === 'here' ? 'here' : 'anywhere',
    domains,
    when: WHENS.includes(s.when) ? s.when : STEER_DEFAULT.when,
  };
}

export function getSteer(convoId) {
  const row = db?.prepare(`SELECT analogy_steer FROM convos WHERE id=?`).get(convoId);
  if (!row?.analogy_steer) return { ...STEER_DEFAULT };
  try { return normalizeSteer(JSON.parse(row.analogy_steer)); } catch { return { ...STEER_DEFAULT }; }
}

export function setSteer(convoId, patch) {
  if (!db) return { error: 'no_db' };
  if (!getConvo(convoId)) return { error: 'not_found' };
  const next = normalizeSteer({ ...getSteer(convoId), ...(patch || {}) });
  db.prepare(`UPDATE convos SET analogy_steer=? WHERE id=?`).run(JSON.stringify(next), convoId);
  return next;
}

// ─── The side thread ─────────────────────────────────────────────────────────

export function sideThread(convoId, { create = false } = {}) {
  if (!db) return null;
  const found = db.prepare(
    `SELECT * FROM convos WHERE subject_type='analogy' AND subject_id=? AND deleted_at IS NULL`,
  ).get(convoId);
  if (found || !create) return found || null;
  const id = randomUUID();
  db.prepare(`INSERT INTO convos (id, subject_type, subject_id, title, created_by) VALUES (?,?,?,?,?)`)
    .run(id, 'analogy', convoId, 'Analogies', 'antoine');
  return db.prepare(`SELECT * FROM convos WHERE id=?`).get(id);
}

function parseMeta(raw) { try { return raw ? JSON.parse(raw) : null; } catch { return null; } }

// Every message of the side thread, newest last, with its card parsed out. His
// own asks come back as {role:'user'} rows with no card.
export function isLooking(convoId) { return _inFlight.has(convoId); }

export function listAnalogies(convoId) {
  const side = sideThread(convoId);
  if (!side) return { steer: getSteer(convoId), items: [], running: isLooking(convoId) };
  const items = listMessages(side.id).map((m) => {
    const meta = parseMeta(m.meta);
    return {
      id: m.id, role: m.role, text: m.text, created_at: m.created_at,
      card: meta?.kind === 'arrival' ? meta : null,
    };
  });
  return { steer: getSteer(convoId), items, running: isLooking(convoId) };
}

function addSideMessage(sideId, role, text, meta = null) {
  const id = randomUUID();
  db.prepare(`INSERT INTO convo_messages (id, convo_id, role, kind, text, meta) VALUES (?,?,?,'chat',?,?)`)
    .run(id, sideId, role, String(text || ''), meta ? JSON.stringify(meta) : null);
  db.prepare(`UPDATE convos SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(sideId);
  return id;
}

// ─── Asking the model ────────────────────────────────────────────────────────

const CARD_CAP = 3;

// The rules here are the vision's, not style: an analogy that matches on NAMES is
// worthless (fractal_operational_core.md — naming must never feed the matcher), a
// comparison that cannot say where it breaks is a claim rather than a finding, and
// a pattern that recurs at several scales is NOT evidence of cause travelling
// between them. A similarity percentage would invent precision that does not exist.
function buildPrompt({ transcript, steer, question }) {
  const moves = steer.moves.join(', ');
  const where = steer.reach === 'here'
    ? 'Stay with things this project already works on: films, characters, countries, institutions, households.'
    : 'Reach anywhere in the world — biology, law, myth, engineering, ecology, markets, craft. The stranger the domain, the better, as long as the relation really holds.';
  const domains = steer.domains.length ? `\nPrefer these domains: ${steer.domains.join(', ')}.` : '';
  return `You are the analogical instrument beside a conversation. You are NOT summarising it and NOT proposing work to build.

Your one job: find where the RELATION being discussed is already living under other names.

The conversation so far:
---
${transcript}
---
${question ? `\nWhat is being asked of you right now: ${question}\n` : ''}
Kinds of arrival allowed this time: ${moves}.
${where}${domains}

Hard rules:
- Match on the relation, never on shared words or shared subject matter. If two things are analogous only because they use the same nouns, it is not an analogy.
- Every arrival must say where it BREAKS. A comparison that cannot fail is a claim, not a finding.
- Never give a similarity score, percentage or star rating.
- A pattern repeating at several scales is not evidence that anything travels between them. Never imply cause.
- What you offer is PROPOSED, never established.
- Plain, short words. No jargon.

Respond with ONLY this JSON and nothing else:
{"arrivals":[{"move":"one of ${moves}","left":"the first side, 1-3 words","right":"the other side, 1-3 words","title":"the relation itself, under 7 words","reading":"one or two short sentences saying what holds","breaks":"one short sentence saying where it stops holding","question":"the new question this makes possible, one sentence"}]}

Between one and ${CARD_CAP} arrivals. Fewer and better beats more.`;
}

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

const S = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

export function parseArrivals(text, { steer = STEER_DEFAULT, anchorMessageId = null, asked = false } = {}) {
  const parsed = firstJson(text);
  const list = Array.isArray(parsed?.arrivals) ? parsed.arrivals : [];
  return list
    .map((a) => ({
      kind: 'arrival',
      move: MOVES.includes(a?.move) ? a.move : (steer.moves[0] || 'horizontal'),
      left: S(a?.left, 60), right: S(a?.right, 60),
      title: S(a?.title, 120), reading: S(a?.reading, 600),
      breaks: S(a?.breaks, 400), question: S(a?.question, 400),
      anchor_message_id: anchorMessageId, asked,
    }))
    .filter((a) => a.title && a.left && a.right)
    .slice(0, CARD_CAP);
}

// The last thing HE said — the line an unasked arrival is pinned to in the
// transcript. Falls back to nothing rather than guessing at an assistant turn.
function lastUserMessageId(convoId) {
  const msgs = listMessages(convoId).filter((m) => m.kind === 'chat' && m.role === 'user');
  return msgs.length ? msgs[msgs.length - 1].id : null;
}

function transcriptFor(convoId, limit = 14) {
  const msgs = listMessages(convoId).filter((m) => m.kind === 'chat').slice(-limit);
  return msgs.map((m) => `${m.role === 'user' ? 'OWNER' : 'QNE'}: ${String(m.text || '').slice(0, 2000)}`).join('\n\n');
}

async function runLook(convoId, { question = null, asked = false } = {}) {
  const convo = getConvo(convoId);
  if (!convo) return { error: 'not_found' };
  const transcript = transcriptFor(convoId);
  if (!transcript) return { arrivals: [] };
  const steer = getSteer(convoId);

  const result = await generateText({
    prompt: buildPrompt({ transcript, steer, question }),
    feature: 'studio',            // his one Room lane knob — no new setting
    maxTokens: 1200,
    label: 'room:analogies',
  });
  if (result?.error) return { error: result.error };

  const arrivals = parseArrivals(result?.text, { steer, anchorMessageId: lastUserMessageId(convoId), asked });
  if (!arrivals.length) return { arrivals: [] };

  const side = sideThread(convoId, { create: true });
  for (const card of arrivals) addSideMessage(side.id, 'assistant', card.title, card);
  broadcastAll('analogies:updated', { convoId, count: arrivals.length });
  return { arrivals };
}

// ─── The unasked pass ────────────────────────────────────────────────────────
// Identical in shape to conversations.js#roomWorldLook, and for the same reasons:
// fire-and-forget, one look per new turn, and the watermark is advanced as the
// pass is KICKED OFF rather than when it finishes, so a slow or failed look never
// leaves the conversation re-triggering forever.

const _inFlight = new Set();
export function analogyLook(convoId) {
  if (!convoId || _inFlight.has(convoId)) return;
  const convo = getConvo(convoId);
  if (!convo) return;
  const steer = getSteer(convoId);
  if (steer.when === 'asked') return;          // he turned the unasked pass off
  const seen = convo.analogy_seen_turns || 0;
  const turns = convo.turns || 0;
  if (turns <= seen) return;

  _inFlight.add(convoId);
  db.prepare(`UPDATE convos SET analogy_seen_turns=? WHERE id=?`).run(turns, convoId);
  // Say it is looking before the call, not after: a pane that sits still for two
  // seconds and then jumps reads as broken, and the whole point of this one is
  // that it arrives on its own.
  broadcastAll('analogies:updated', { convoId, running: true });
  setImmediate(async () => {
    try { await runLook(convoId); }
    catch (e) { console.error('[room] analogy look failed:', e?.message || e); }
    finally { _inFlight.delete(convoId); broadcastAll('analogies:updated', { convoId }); }
  });
}

// His own question into the side pane. Saved first so it is visible even if the
// model call fails — the ask is his, not the engine's.
export async function askAnalogies(convoId, text) {
  if (!db) return { error: 'no_db' };
  if (!getConvo(convoId)) return { error: 'not_found' };
  const question = String(text || '').trim().slice(0, 1000);
  if (!question) return { error: 'empty' };
  const side = sideThread(convoId, { create: true });
  addSideMessage(side.id, 'user', question);
  broadcastAll('analogies:updated', { convoId });
  return runLook(convoId, { question, asked: true });
}

export function clearAnalogies(convoId) {
  const side = sideThread(convoId);
  if (!side) return { cleared: 0 };
  const n = db.prepare(`DELETE FROM convo_messages WHERE convo_id=?`).run(side.id)?.changes || 0;
  broadcastAll('analogies:updated', { convoId });
  return { cleared: n };
}
