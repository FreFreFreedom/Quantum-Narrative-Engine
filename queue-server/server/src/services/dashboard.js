// services/dashboard.js — the Command Center's one read (plan
// "command-center-dashboard").
//
// Antoine learned the state of his own system by reading the runner's log file or
// asking a terminal session to go and look. Every number he wanted already existed;
// it was spread across five views and one log, and no screen answered "what is
// happening, what is stuck, what is waiting on me".
//
// WHAT THIS DELIBERATELY DOES NOT RETURN. The plan listed a queue tile and a quota
// tile. Both were dropped when the implementation started, because the rail's foot
// already draws them on EVERY view: #archQueueBanner carries paused/running/queued,
// auto-ship, today's spend, the helper budget and the storage warning
// (renderArchQueueBanner), and #usageStripHost carries the 5-hour and weekly windows.
// Rebuilding either here would be the exact thing AGENTS.md forbids — nothing drawn
// twice — and this file's own plan cites that rule. What is left is the material
// that is genuinely nowhere: what is waiting on him, what the Room has learned, the
// threads whose thinking has not been absorbed, and the walks he kept.
//
// The ranked "what to build next" is also absent, and cannot be here:
// nextSteps() needs the component catalogue, which lives in the frontend file rather
// than the database (see routes/architecture.js's own comment on POST /next). The
// browser fetches that one itself, the way Flow already does.
//
// Everything below is SQL and arithmetic. No model call, no cache — nextSteps.js's
// header explains why that is the right default, and a cache here would be the first
// thing to go stale and lie.

import { listIdeas } from './workIdeas.js';
import { listSuggestions } from './workSuggestions.js';
import { listFacts } from './mind.js';
import { listOpenConvos } from './conversations.js';
import { listSavedMaps } from './entityRelations.js';
import { listProposed, countProposed } from './entityMentions.js';

let db = null;
export function bindDashboardDb(database) { db = database; }

// One tile failing must never empty the screen. Each section is wrapped so a broken
// query returns null for that tile alone and every other tile still renders — the
// same discipline getQueueStatus's caller uses when it composes several sources.
function tile(name, fn) {
  try { return fn(); } catch (e) {
    console.error(`[dashboard] ${name} failed:`, e?.message || e);
    return null;
  }
}

// Tasks that stopped and are waiting on a decision. Counted here rather than read
// from getQueueStatus, which reports done/running/queued and has never carried
// `blocked` — the one queue number that actually means "you".
function blockedTasks() {
  return db.prepare(`
    SELECT id, title, updated_at
    FROM work_prompts
    WHERE status='blocked' AND deleted_at IS NULL
    ORDER BY updated_at DESC LIMIT 5
  `).all();
}

// What is waiting on him, in one place for the first time: stopped tasks, seeds
// never planted into a prompt (work_prompt_id IS NULL), and suggestions still 'new'.
function needsYou() {
  const blocked = blockedTasks();
  const seeds = listIdeas().filter((i) => !i.work_prompt_id);
  // flagShipped:false on purpose. The default runs shipFacts.js's "this may already
  // be done" comparison against the last month of shipped work — a useful guess on
  // the Flow card that owns a suggestion, and pure cost on a screen that only wants
  // to count them.
  const suggestions = listSuggestions({ status: 'new', flagShipped: false });
  // Single-token name matches in his own notes, waiting for one confirming click
  // (plans/testimony-in-the-ontology.md). Folded into this card rather than given one of
  // its own: it is the same question the card already asks — what is waiting on you — and
  // a new card for five rows, once, is a horizontal band spent on nothing.
  const mentionCount = countProposed(db);
  const mentions = listProposed(db, 5);
  return {
    total: blocked.length + seeds.length + suggestions.length + mentionCount,
    blocked,
    seeds: seeds.slice(0, 5).map((i) => ({ id: i.id, title: i.title })),
    seedCount: seeds.length,
    suggestions: suggestions.slice(0, 5).map((s) => ({ id: s.id, title: s.title })),
    suggestionCount: suggestions.length,
    mentions: mentions.map((m) => ({ id: m.id, entity_id: m.entity_id, title: m.entity_name, quote: m.quote })),
    mentionCount,
  };
}

// What the Room has learned. The split matters more than the total: `vision` is the
// paradigm, and until 2026-09-09 it had nowhere to go and nothing said it was
// accumulating.
function learned() {
  const facts = listFacts({ activeOnly: true });
  const vision = facts.filter((f) => f.kind === 'vision');
  const recent = [...facts]
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
    .slice(0, 3)
    .map((f) => ({ id: f.id, kind: f.kind, text: f.text }));
  return { total: facts.length, vision: vision.length, recent };
}

// Conversations whose turns the harvest has not read yet. `mind_seen_turns` counts
// his messages; `turns` is the same count kept on the row, so a gap is thinking the
// memory does not have. listOpenConvos SELECTs *, so both are already present — the
// plan expected to have to add a column and did not.
function unharvested() {
  const rows = listOpenConvos(50)
    .map((c) => ({
      id: c.id,
      title: c.title,
      turns: Number(c.turns) || 0,
      seen: Number(c.mind_seen_turns) || 0,
    }))
    .filter((c) => c.turns > c.seen)
    .map((c) => ({ ...c, behind: c.turns - c.seen }))
    .sort((a, b) => b.behind - a.behind);
  return { count: rows.length, threads: rows.slice(0, 5) };
}

// Walks kept through the ontology. Already ordered updated_at DESC by the service;
// a walk set down is invisible everywhere else in the app.
function walks() {
  return listSavedMaps(db).slice(0, 5).map((m) => ({
    id: m.id,
    title: m.title,
    steps: Array.isArray(m.path) ? m.path.length : 0,
    updated_at: m.updated_at,
  }));
}

export function dashboard() {
  if (!db) return { error: 'no_db' };
  return {
    needsYou: tile('needsYou', needsYou),
    learned: tile('learned', learned),
    unharvested: tile('unharvested', unharvested),
    walks: tile('walks', walks),
    checkedAt: new Date().toISOString(),
  };
}
