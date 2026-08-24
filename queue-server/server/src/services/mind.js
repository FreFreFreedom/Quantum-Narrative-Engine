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
// (after the 8-turn watermark) using the existing `summary` feature lane, which
// is free in practice (second Claude account first, then free models).

import { randomUUID } from 'node:crypto';
import { generateText } from './ai/text.js';
import { broadcastAll } from '../realtime.js';

let db = null;
export function bindMindDb(database) { db = database; }

const KINDS = ['about', 'taste', 'decision', 'project', 'person', 'style'];
const MAX_FACTS = 300;
const BLOCK_CAP = 4000;
// Stopwords dropped before normalising a fact for the deterministic dedup check.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'i', 'my', 'me', 'we', 'our', 'you', 'it', 'its',
  'is', 'are', 'was', 'were', 'am', 'do', 'does', 'did', 'have', 'has', 'had',
  'to', 'of', 'in', 'on', 'for', 'and', 'or', 'but', 'this', 'that', 'these',
  'those', 'with', 'as', 'at', 'be', 'been', 'being', 'will', 'would', 'should',
  'can', 'could', 'about', 'he', 'she', 'they', 'them', 'his', 'her', 'their',
]);

// Lowercase, strip punctuation, drop stopwords — two facts that normalise to the
// same string are the same fact. Deterministic, no model call.
function normalize(s) {
  return String(s || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter((w) => w && !STOPWORDS.has(w))
    .join(' ').trim();
}

export function listFacts({ kind = null, activeOnly = true } = {}) {
  try {
    let sql = `SELECT id, kind, text, detail, weight, source_convo_id, source_note, hits, last_used_at, created_at, updated_at, superseded_by, active FROM mind_facts WHERE 1=1`;
    const params = [];
    if (activeOnly) sql += ` AND active=1`;
    if (kind) { sql += ` AND kind=?`; params.push(kind); }
    sql += ` ORDER BY weight DESC, updated_at DESC`;
    return db.prepare(sql).all(...params);
  } catch { return []; }
}

export function getFact(id) {
  try {
    return db.prepare(`SELECT id, kind, text, detail, weight, source_convo_id, source_note, hits, last_used_at, created_at, updated_at, superseded_by, active FROM mind_facts WHERE id=?`).get(id) || null;
  } catch { return null; }
}

// Deterministic dedup first — reject if an existing active fact normalises to the
// same string. No model call for this check.
export function saveFact({ kind, text, detail = null, sourceConvoId = null, sourceNote = null }) {
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
    db.prepare(`INSERT INTO mind_facts (id, kind, text, detail, weight, source_convo_id, source_note, hits, created_at, updated_at, active) VALUES (?,?,?,?,1,?,?,0,?,?,1)`)
      .run(id, k, String(text).slice(0, 240), detail ? String(detail).slice(0, 4000) : null, sourceConvoId, sourceNote, now, now);
    return getFact(id);
  } catch (e) {
    return { error: e.message || 'save_failed' };
  }
}

export function forgetFact(id) {
  try {
    const r = db.prepare(`UPDATE mind_facts SET active=0, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND active=1`).run(id);
    if (r.changes === 0) return { error: 'not_found' };
    return { ok: true };
  } catch (e) { return { error: e.message || 'forget_failed' }; }
}

export function reviseFact(id, { text, detail } = {}) {
  try {
    const cur = getFact(id);
    if (!cur) return { error: 'not_found' };
    const newText = text != null ? String(text).slice(0, 240) : cur.text;
    const newDetail = detail != null ? String(detail).slice(0, 4000) : cur.detail;
    db.prepare(`UPDATE mind_facts SET text=?, detail=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
      .run(newText, newDetail, id);
    return getFact(id);
  } catch (e) { return { error: e.message || 'revise_failed' }; }
}

// The block injected into every conversation turn. Empty string when there are no
// facts, so an empty memory costs nothing. Selected by weight * recency *
// (1 + log(hits+1)), hard-capped at BLOCK_CAP chars.
export function mindBlock() {
  try {
    const facts = db.prepare(`SELECT id, kind, text, weight, hits, last_used_at, updated_at, created_at FROM mind_facts WHERE active=1`).all();
    if (!facts.length) return '';
    const now = Date.now();
    const scored = facts.map((f) => {
      const t = f.last_used_at || f.updated_at || f.created_at;
      let days = 30;
      if (t) { const dt = new Date(t).getTime(); if (!Number.isNaN(dt)) days = Math.max(0, (now - dt) / 86400000); }
      const recency = 1 / (1 + days);
      const score = (f.weight || 1) * recency * (1 + Math.log((f.hits || 0) + 1));
      return { f, score };
    }).sort((a, b) => b.score - a.score);
    let out = '\n=== WHAT YOU KNOW ABOUT THE OWNER ===\n';
    for (const { f } of scored) {
      const line = `- ${String(f.text).slice(0, 240)}`;
      if (out.length + line.length + 1 > BLOCK_CAP) break;
      out += line + '\n';
    }
    return out;
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

function buildHarvestPrompt(newTurns, factList) {
  const facts = factList.length
    ? factList.map((f) => `- [${f.id}] ${f.text}`).join('\n')
    : '(none yet)';
  const turns = newTurns.length ? newTurns.map((t, i) => `${i + 1}. ${t}`).join('\n') : '(none)';
  return `You maintain a long-term memory of standing facts about the owner of this personal app. He is one person; the app is built for him alone.

Return ONLY a JSON array (no prose, no markdown fence) of objects:
  {"kind": "about"|"taste"|"decision"|"project"|"person"|"style", "text": "<one fact, plain English, <= 240 chars>", "detail"?": "<longer body if needed>", "replaces"?": "<an existing fact id from the list below, if this corrects it>"}

Save ONLY facts that would still be true next month: standing preferences, decisions AND the reason behind them, people, constraints, how he likes things. Do NOT save conversation content, do NOT save what was merely discussed, and do NOT save anything already present in the existing facts list below — if a new message repeats a known fact, omit it.

EXISTING FACTS YOU ALREADY KNOW:
${facts}

NEW MESSAGES FROM THE OWNER (most recent last):
${turns}`;
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

// The extraction job. Never called on the request path — fire-and-forget after an
// assistant turn. Reads only the turns since the watermark, never the whole thread.
async function runHarvest(convoId, force) {
  const convo = db.prepare(`SELECT id, turns, mind_seen_turns FROM convos WHERE id=? AND deleted_at IS NULL`).get(convoId);
  if (!convo) return;
  const msgs = db.prepare(`SELECT text FROM convo_messages WHERE convo_id=? AND kind='chat' AND role='user' ORDER BY created_at`).all(convoId);
  const seen = convo.mind_seen_turns || 0;
  const newMsgs = msgs.slice(Math.min(seen, msgs.length));
  if (!force && newMsgs.length < 8) return;

  const factList = listFacts({ activeOnly: true }).map((f) => ({ id: f.id, text: f.text }));
  const result = await generateText({
    feature: 'summary', maxTokens: 500, label: 'mind:harvest',
    prompt: buildHarvestPrompt(newMsgs.map((m) => m.text), factList),
  });
  if (result.error) { console.error('[mind] harvest model error:', result.error); return; }
  const items = parseHarvest(result.text);
  // Failed to parse as the expected shape: do NOT advance the watermark, so the
  // next harvest pass retries these same turns rather than silently losing them.
  if (!items) { console.error('[mind] harvest: unparseable model reply, watermark not advanced'); return; }

  let wrote = 0;
  for (const it of items) {
    if (!it || !it.kind || !it.text || !KINDS.includes(it.kind)) continue;
    if (it.replaces) {
      const existing = getFact(it.replaces);
      if (existing) { reviseFact(it.replaces, { text: it.text, detail: it.detail || null }); wrote++; continue; }
    }
    const saved = saveFact({ kind: it.kind, text: it.text, detail: it.detail || null, sourceConvoId: convoId });
    if (saved && !saved.error) wrote++;
  }
  enforceCap();
  // Advance the watermark to the full count of chat turns seen.
  db.prepare(`UPDATE convos SET mind_seen_turns=? WHERE id=?`).run(msgs.length, convoId);
  if (wrote > 0) broadcastAll('mind:updated', {});
}

const _harvestInFlight = new Set();
export function harvest(convoId, { force = false } = {}) {
  if (!convoId || _harvestInFlight.has(convoId)) return;
  _harvestInFlight.add(convoId);
  setImmediate(async () => {
    try { await runHarvest(convoId, force); }
    catch (e) { console.error('[mind] harvest failed:', e?.message || e); }
    finally { _harvestInFlight.delete(convoId); }
  });
}
