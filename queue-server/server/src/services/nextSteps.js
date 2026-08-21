// services/nextSteps.js — the project's ranked next steps, computed for free.
//
// Why this exists. Before this file the app answered "what should I build next?"
// about fifteen different ways and none of them was in charge: seven orderings
// computed in the browser, seven that cost a model call, and no single endpoint
// that returned an ordered list for the project as a whole. So the one question
// that actually matters — in what order do I do these things — had no answer,
// while ~15 model calls a day went on refreshing suggestions for individual
// components (preGen.js).
//
// The fix needed no new intelligence, because the two signals that matter were
// already being computed and thrown away:
//
//   · `bottleneck` (architectureIntelligence.js) is the highest-severity signal
//     there is (15) and it means exactly "N things are waiting on this and it is
//     not finished". That is "how much does this unlock" — the number the paid
//     ranker (architectureNodes.js#rankUnbuilt) asks a model to *guess*.
//   · `healthFor` already scores every component 100 − Σ severity and stores it
//     daily in intel_health_snapshots. It was only ever drawn as a trend line.
//
// So this module ranks, it does not analyse. Everything here is SQL and
// arithmetic: no model call, nothing cached, safe to call on every render.
//
// The reasons are ASSEMBLED FROM THE FACT THAT CAUSED THE RANK, never generated.
// That is the point: a composed sentence about a counted number is true, and a
// model's sentence about the same number is only probably true. It also means the
// list still works when every model is down.

import { unifiedNodes, computeSignals, healthFor, adjacency, loadIntelConfig } from './architectureIntelligence.js';

const STATUS_LEVELS = ['Concept', 'Designed', 'Prototype', 'Working', 'Validated', 'Advanced'];
const level = (s) => {
  const i = STATUS_LEVELS.indexOf(s);
  return i === -1 ? 0 : i;
};
// Matches the frontend's BUILT_STATUSES / isBuilt (fmcns_navigator.html) on
// purpose: the list must agree with the built/buildable/locked colours already on
// the map, or the two disagree in front of the user.
const BUILT = level('Working');
const isBuilt = (n) => level(n?.status) >= BUILT;

// A task that is queued, running or waiting on an answer means the work is
// already moving; proposing it again is the fastest way to make the list feel
// wrong. Mirrors Q_ACTIVE_STATUSES in the frontend.
const ACTIVE = ['queued', 'running', 'paused'];

function inFlightComponents(db) {
  const out = new Map();
  try {
    const rows = db.prepare(`
      SELECT component_id, COUNT(*) AS n FROM work_prompts
      WHERE component_id IS NOT NULL AND deleted_at IS NULL
        AND status IN (${ACTIVE.map(() => '?').join(',')})
      GROUP BY component_id
    `).all(...ACTIVE);
    for (const r of rows) out.set(r.component_id, r.n);
  } catch { /* an older DB without the column just yields an empty map */ }
  return out;
}

// How much finishing this would unlock: every not-yet-built component that sits
// downstream of it, directly or through a chain. Transitive on purpose — a
// prerequisite two steps below the thing you actually want still unblocks it, and
// direct-dependents-only under-counts exactly the trunk lines worth doing first.
// Memoised, with the same cycle guard style as the frontend's archDepth.
function leverageMap(all, dependents) {
  const cache = new Map();
  const walk = (id, seen) => {
    if (cache.has(id)) return cache.get(id);
    if (seen.has(id)) return new Set();          // dependency cycle — contribute nothing
    seen.add(id);
    const reached = new Set();
    for (const child of dependents.get(id) || []) {
      reached.add(child);
      for (const deeper of walk(child, seen)) reached.add(deeper);
    }
    seen.delete(id);
    cache.set(id, reached);
    return reached;
  };
  const byId = new Map(all.map((n) => [n.id, n]));
  const out = new Map();
  for (const n of all) {
    // Only unbuilt descendants count — unlocking something already finished
    // unlocks nothing.
    let unlocked = 0;
    for (const id of walk(n.id, new Set())) if (!isBuilt(byId.get(id))) unlocked++;
    out.set(n.id, unlocked);
  }
  return out;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Plain names for the five territories. The frontend's TERRITORIES array carries
// these labels but the server only ever sees the ids, and a reason sentence must
// never show Antoine a slug (AGENTS.md).
const TERRITORY_NAME = {
  perception: 'getting material in',
  knowledge: 'the knowledge layers',
  reasoning: 'the reasoning engines',
  experience: 'how it feels to use',
  interface: 'the look and feel',
  // The sixth area. Without a plain name here, every reason sentence about a piece
  // of the app's own build system silently drops its territory clause — the rows
  // would rank correctly and then read as if they belonged nowhere.
  self: "the app's own build system",
};

// One plain-English sentence per row, built from the numbers above. AGENTS.md:
// everything the app writes for Antoine is plain English — no jargon, no ids, no
// "bottleneck", no status vocabulary he did not choose.
function reasonFor(n, { ready, blockers, leverage, topLeverage, signals, starvedTerritory }) {
  const has = (t) => signals.some((s) => s.type === t);
  const parts = [];

  if (!ready) {
    const names = blockers.map((b) => b.name).join(' and ');
    return `Not yet — it needs ${names} finished first.`;
  }

  const halfBuilt = level(n.status) >= level('Prototype');
  if (leverage > 0) {
    const lead = halfBuilt ? 'Half-built already, and nothing is blocking it.' : 'Ready now.';
    const best = leverage === topLeverage && topLeverage > 1 ? ' — more than anything else you could start' : '';
    parts.push(`${lead} ${plural(leverage, 'other piece is', 'other pieces are')} waiting on it${best}.`);
  } else if (halfBuilt) {
    parts.push('Half-built already, and nothing is blocking it — finishing it costs less than starting something new.');
  } else {
    parts.push('Ready now — nothing is blocking it.');
  }

  // Without this, every piece that unlocks nothing gets an identical sentence, so
  // five rows in a row read the same and tell you nothing about choosing between
  // them. The territory it belongs to is the honest differentiator.
  if (leverage === 0 && starvedTerritory && TERRITORY_NAME[n.territory]) {
    parts.push(`It sits in ${TERRITORY_NAME[n.territory]}, the least finished part of the app.`);
  }

  if (has('never_touched')) parts.push('Nothing has ever been done on it.');
  else if (has('aging')) parts.push('It has sat untouched for over a month.');

  return parts.join(' ');
}

/**
 * Rank the whole project's unbuilt work. Free: SQL and arithmetic only.
 *
 * `catalog` is the browser's own component list — the 16-component trunk lives in
 * fmcns_navigator.html, not the DB, so it travels with the request exactly as it
 * already does for POST /intel/signals.
 */
export function nextSteps(db, catalog = [], { limit = 3 } = {}) {
  const { byId, all } = unifiedNodes(db, catalog);
  const dependents = adjacency(all);
  const signalsResult = computeSignals(db, catalog);
  const health = healthFor(signalsResult, loadIntelConfig(db));
  const leverage = leverageMap(all, dependents);
  const moving = inFlightComponents(db);

  // Territory starvation: the share of a territory that is still unbuilt. Used
  // only to break ties, so one area cannot quietly stall while another races.
  const terrTotal = new Map(), terrUnbuilt = new Map();
  for (const n of all) {
    terrTotal.set(n.territory, (terrTotal.get(n.territory) || 0) + 1);
    if (!isBuilt(n)) terrUnbuilt.set(n.territory, (terrUnbuilt.get(n.territory) || 0) + 1);
  }
  const starvation = (t) => (terrUnbuilt.get(t) || 0) / Math.max(1, terrTotal.get(t) || 1);
  // The single least-finished territory, named in the reason for pieces that
  // unlock nothing so those rows still say something useful.
  //
  // Guarded on size: a territory holding one unbuilt component scores a perfect
  // 100% unbuilt and would win the title on ratio alone, which is not what "the
  // least finished part of the app" means to a reader. Ratio decides among
  // territories with real breadth; the count breaks ties.
  const worstTerritory = [...terrTotal.keys()]
    .filter((t) => (terrUnbuilt.get(t) || 0) >= 2)
    .sort((a, b) => (starvation(b) - starvation(a)) || ((terrUnbuilt.get(b) || 0) - (terrUnbuilt.get(a) || 0)))[0] || null;

  const candidates = [], inFlight = [];
  for (const n of all) {
    if (isBuilt(n)) continue;
    const blockers = (n.depends || []).map((d) => byId.get(d)).filter(Boolean).filter((d) => !isBuilt(d));
    const row = {
      id: n.id,
      name: n.name || n.id,
      territory: n.territory,
      status: n.status,
      next: n.next || '',
      summary: n.summary || '',   // the one line the card shows (services/cardLines.js)
      ready: blockers.length === 0,
      blocked_by: blockers.map((b) => ({ id: b.id, name: b.name || b.id, status: b.status })),
      unlocks: leverage.get(n.id) || 0,
      health: health.nodes[n.id] !== undefined ? health.nodes[n.id] : 100,
      signals: (signalsResult.byTarget[n.id] || []).map((s) => s.type),
    };
    if (moving.has(n.id)) { inFlight.push({ ...row, tasks: moving.get(n.id) }); continue; }
    candidates.push(row);
  }

  const topLeverage = candidates.reduce((m, c) => Math.max(m, c.unlocks), 0);

  candidates.sort((a, b) =>
    // 1. ready beats blocked, always
    (b.ready - a.ready)
    // 2. unlocks the most — the signal the paid ranker used to guess at
    || (b.unlocks - a.unlocks)
    // 3. momentum: finishing beats starting. Note nbSmartOrder in the frontend
    //    sorted this the other way round (Concept first), which is a large part
    //    of why the old order felt arbitrary.
    || (level(b.status) - level(a.status))
    // 4. the least healthy of equals goes first
    || (a.health - b.health)
    // 5. keep every territory moving
    || (starvation(b.territory) - starvation(a.territory))
    || String(a.name).localeCompare(String(b.name)));

  const decorate = (c) => ({
    ...c,
    reason: reasonFor(c, {
      ready: c.ready,
      blockers: c.blocked_by,
      leverage: c.unlocks,
      topLeverage,
      signals: (signalsResult.byTarget[c.id] || []),
      starvedTerritory: c.territory === worstTerritory,
    }),
  });

  const ranked = candidates.map(decorate);
  return {
    // `picks` is exactly the shape the (previously never-fed) "Your next 3" panel
    // in fmcns_navigator.html already reads: [{ id, reason }].
    picks: ranked.slice(0, limit),
    rest: ranked.slice(limit),
    in_flight: inFlight.map(decorate),
    computed_at: new Date().toISOString(),
    free: true,
  };
}
