// Architecture intelligence — the platform watching itself.
// (plan self-aware-platform.md, Parts 3–6.)
//
// Three layers, cheapest first:
//   1. The PULSE (Part 3 + 6.1/6.2/6.5): deterministic signals + health scores
//      over live tables, zero model calls, always on, server-cached ~20 s.
//   2. The MIND (Part 4): budgeted deliberative passes — Deepen (per node),
//      Pulse-of-the-whole-graph, Growth proposals (6.4), task retrospectives
//      (6.3). Everything free-first via ai/text.js, capped per hour (explicit
//      user clicks are never capped).
//   3. The FEED: durable thoughts; Accept → paused Flow task (the human gate),
//      ranked drain for the overnight agent (6.6).
//
// Deliberate gotcha: this module never calls the queue directly on load or on
// page view — every model call is either an explicit click or a bounded,
// rate-limited background pass (see intelCap()).

import { randomUUID, createHash } from 'node:crypto';
import { generateText } from './ai/text.js';
import { USER_FACING_STYLE } from './ai/style.js';
import { APP_BLURB, onSubjectRule } from './ai/appModel.js';
import * as queue from './promptQueue.js';

const TERRITORIES = ['perception', 'knowledge', 'reasoning', 'experience', 'interface'];
const STATUS_LEVELS = ['Concept', 'Designed', 'Prototype', 'Working', 'Validated', 'Advanced'];

const AGING_DAYS = 30;          // untouched/never-verified this long + below Advanced
const STALE_SPEC_DAYS = 14;     // speculative node unaccepted this long
const UNTOUCHED_DAYS = 45;      // never had a queue task and status below Prototype
const RETRO_WINDOW_MS = 15 * 60 * 1000; // learn from tasks that finished recently
const CACHE_TTL_MS = 20_000;

const level = (s) => STATUS_LEVELS.indexOf(s);
const dayStr = () => new Date().toISOString().slice(0, 10);
const daysSince = (iso) => {
  if (!iso) return null;
  const d = (new Date(iso)).getTime();
  if (!Number.isFinite(d)) return null;
  return (Date.now() - d) / 86_400_000;
};
const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// ─── Signal catalogue ─────────────────────────────────────────────────────────
// One source of truth for labels, colors (hex, dark-mode safe), severity and the
// one-line explanation the frontend shows on each signal card.
export const SIGNAL_META = {
  bottleneck:        { label: 'Bottleneck',        color: '#d4573c', severity: 15, help: '≥2 components depend on it but it is not Working yet — a stalled trunk line.' },
  aging:             { label: 'Aging',             color: '#c98a2e', severity: 10, help: 'Untouched or never verified for over a month, and not past Prototype.' },
  unbuilt_dep:       { label: 'Depends on unbuilt', color: '#c98a2e', severity: 10, help: 'One of its prerequisites is still only a Concept or a Design.' },
  no_next_step:      { label: 'No next step',      color: '#7a5ea8', severity: 5,  help: 'Below Working, with no planned next step written down.' },
  orphan:            { label: 'Orphan',            color: '#8a8378', severity: 5,  help: 'Nothing depends on it — it may be drifting away from the tree.' },
  territory_isolated:{ label: 'Territory isolated', color: '#8a8378', severity: 10, help: 'Nothing in this territory connects to any other territory.' },
  stale_speculation: { label: 'Stale speculation', color: '#7a5ea8', severity: 5,  help: 'A speculative branch proposed over two weeks ago, still unaccepted.' },
  never_touched:     { label: 'Never worked on',   color: '#8a8378', severity: 5,  help: 'No queue task has ever targeted it and it is still below Prototype.' },
  // Content-navigator signals (Part 5) — scope 'content'.
  cluster_ungrounded:{ label: 'Cluster ungrounded', color: '#c98a2e', severity: 10, help: 'A thematic cluster has no archive-grounded material behind its tags.' },
  untagged_entities: { label: 'Untagged entities', color: '#8a8378', severity: 5,  help: 'Entities that carry no archetypal tags at all — invisible to the pattern engine.' },
  thin_entities:     { label: 'Thin entities',     color: '#8a8378', severity: 5,  help: 'Entities with no books and no tag lens written about them.' },
  continuum_band_gap:{ label: 'Continuum band gap', color: '#7a5ea8', severity: 10, help: 'An axis band with almost no scores — comparisons across that region are ungrounded.' },
  no_scale_echo:     { label: 'No scale echo',     color: '#3f6b85', severity: 5,  help: 'Scored entities with no cross-type partner within echo range — Scale Echo can never bridge them.' },
};

const DEFAULT_WEIGHTS = (() => {
  const w = {};
  for (const [k, v] of Object.entries(SIGNAL_META)) w[k] = v.severity;
  return w;
})();

export function loadIntelConfig(db) {
  let cfg = {};
  try {
    const row = db.prepare(`SELECT intel_json FROM ai_settings WHERE id='global'`).get();
    if (row) cfg = JSON.parse(row.intel_json || '{}');
  } catch {}
  return {
    thoughts_per_hour: Number(cfg.thoughts_per_hour) > 0 ? Number(cfg.thoughts_per_hour) : 2,
    health_weights: { ...DEFAULT_WEIGHTS, ...(cfg.health_weights || {}) },
    self_correct_after: Number(cfg.self_correct_after) > 0 ? Number(cfg.self_correct_after) : 5,
    retro_enabled: cfg.retro_enabled !== false,
  };
}

// ─── Unified node model ───────────────────────────────────────────────────────
// The trunk lives in the frontend HTML; stored nodes live in the DB. The signals
// are computed over the union the user is actually looking at: the frontend posts
// its catalog (id/name/territory/status/what/next/depends/provenance) and the
// DB enriches it with stored created/updated timestamps where they exist. DB-only
// rows (never sent by a frontend) are merged in too, so the API stays usable
// without a catalog at all.
export function unifiedNodes(db, catalog) {
  const stored = db.prepare(`SELECT * FROM architecture_nodes WHERE deleted_at IS NULL ORDER BY created_at`).all();
  const compRows = (() => { try { return db.prepare(`SELECT * FROM architecture_components`).all(); } catch { return []; } })();
  const comps = new Map(compRows.map((r) => [r.id, r]));
  const map = new Map();

  for (const s of stored) {
    map.set(s.id, {
      id: s.id, territory: s.territory, name: s.name, what: s.what || '', why: s.why || '',
      next: s.next || '', depends: JSON.parse(s.depends_json || '[]'), status: s.status,
      provenance: s.provenance, parent_node_id: s.parent_node_id,
      store_created_at: s.created_at, store_updated_at: s.updated_at,
      component_verified_at: (comps.get(s.id) || {}).last_verified_at || null,
    });
  }
  const catalogIds = new Set();
  for (const c of (Array.isArray(catalog) ? catalog : [])) {
    if (!c || !c.id) continue;
    catalogIds.add(c.id);
    const base = map.get(c.id) || {};
    map.set(c.id, {
      ...base,
      id: c.id, name: c.name || base.name || c.id, territory: base.territory || c.territory || 'reasoning',
      what: c.what !== undefined ? c.what : base.what, why: c.why !== undefined ? c.why : base.why,
      next: c.next !== undefined ? (c.next || '') : base.next,
      depends: Array.isArray(c.depends) ? c.depends : base.depends || [],
      status: c.status || base.status || 'Concept',
      provenance: c.provenance || base.provenance || 'canon',
      parent_node_id: c.parent_node_id || base.parent_node_id || null,
    });
  }
  // Components known to the backend but absent from a posted catalog still matter
  // (orphan/aging signals): fold in rows the catalog never mentioned, excluding
  // ones the frontend deliberately dropped.
  for (const r of stored) if (!catalogIds.has(r.id) && !map.has(r.id)) {
    map.set(r.id, {
      id: r.id, territory: r.territory, name: r.name, what: r.what || '', why: r.why || '',
      next: r.next || '', depends: JSON.parse(r.depends_json || '[]'), status: r.status,
      provenance: r.provenance, parent_node_id: r.parent_node_id,
      store_created_at: r.created_at, store_updated_at: r.updated_at,
      component_verified_at: (comps.get(r.id) || {}).last_verified_at || null,
    });
  }
  // Territory coverage is computed over whatever the user sees; a tiny catalog
  // (unit tests) must not fabricate isolated territories from missing data.
  return {
    byId: map,
    all: [...map.values()],
    firstCatalogCount: Array.isArray(catalog) ? catalog.length : 0,
  };
}

export function adjacency(nodes) {
  const dependents = new Map();
  for (const n of nodes) {
    for (const d of n.depends || []) {
      if (!dependents.has(d)) dependents.set(d, []);
      dependents.get(d).push(n.id);
    }
  }
  return dependents;
}

// ─── The pulse: deterministic signals ─────────────────────────────────────────
export function computeSignals(db, catalog) {
  const { byId, all } = unifiedNodes(db, catalog);
  const dependents = adjacency(all);
  const acked = loadAcked(db);
  const ack = (type, scope, target) => acked.has(`${type}|${scope}|${target}`);
  const signals = []; // flat list
  const byTarget = {}; // target-id -> [signal]

  const push = (sig) => {
    if (ack(sig.type, sig.scope, sig.target_id)) return;
    signals.push(sig);
    const key = sig.scope === 'node' ? sig.target_id : `graph:${sig.target_id}`;
    (byTarget[key] = byTarget[key] || []).push(sig);
  };

  const labelFor = (id) => byId.get(id)?.name || byId.get(id)?.id || id;

  for (const n of all) {
    const lvl = level(n.status || '');
    const deps = (n.depends || []).length ? (n.depends || []).map((d) => byId.get(d)).filter(Boolean) : [];
    const depCount = (dependents.get(n.id) || []).length;
    const created = n.store_created_at;
    const updated = n.store_updated_at || n.component_verified_at;

    if (depCount >= 2 && lvl < level('Working')) {
      push({ type: 'bottleneck', scope: 'node', target_id: n.id, title: `${labelFor(n.id)} is a bottleneck`, detail: `${depCount} components wait on it while it is still ${n.status}.` });
    }
    if (depCount === 0 && lvl < level('Advanced')) {
      push({ type: 'orphan', scope: 'node', target_id: n.id, title: `${labelFor(n.id)} has no dependents`, detail: 'Nothing is planned on top of it — it may be drifting away from the tree.' });
    }
    const unbuilt = deps.filter((d) => level(d.status || '') <= level('Designed'));
    if (unbuilt.length) {
      push({ type: 'unbuilt_dep', scope: 'node', target_id: n.id, title: `${labelFor(n.id)} waits on unbuilt prerequisites`, detail: `${unbuilt.map((d) => labelFor(d.id) + ' (' + d.status + ')').join(', ')}.` });
    }
    if (!n.next && lvl < level('Advanced')) {
      push({ type: 'no_next_step', scope: 'node', target_id: n.id, title: `${labelFor(n.id)} has no next step`, detail: 'Below Working with no planned next step written down.' });
    }
    const age = daysSince(updated);
    if (age !== null && age > AGING_DAYS && lvl < level('Advanced')) {
      push({ type: 'aging', scope: 'node', target_id: n.id, title: `${labelFor(n.id)} is aging`, detail: `Last touched ${Math.round(age)} days ago — stale while below Advanced.` });
    }
    if (n.provenance === 'speculative' && created) {
      const specAge = daysSince(created);
      if (specAge !== null && specAge > STALE_SPEC_DAYS && level(n.status || '') < level('Advanced')) {
        push({ type: 'stale_speculation', scope: 'node', target_id: n.id, title: `${labelFor(n.id)} is a stale speculation`, detail: `Proposed ${Math.round(specAge)} days ago, still unaccepted.` });
      }
    }
    // Growth Hormone (6.4): never worked on.
    const taskCount = (() => {
      try { return db.prepare(`SELECT COUNT(*) n FROM work_prompts WHERE component_id=? AND deleted_at IS NULL`).get(n.id)?.n || 0; } catch { return 0; }
    })();
    if (!taskCount && lvl < level('Prototype')) {
      const neverAge = daysSince(created);
      if (neverAge === null || neverAge > UNTOUCHED_DAYS) {
        push({ type: 'never_touched', scope: 'node', target_id: n.id, title: `${labelFor(n.id)} has never been worked on`, detail: 'No queue task has ever targeted it.' });
      }
    }
  }

  // Territory isolation: a whole territory with no cross-territory edges.
  const nodeCount = all.length;
  if (nodeCount >= 5) {
    for (const terr of TERRITORIES) {
      const members = all.filter((n) => n.territory === terr);
      if (members.length < 3) continue;
      let cross = 0;
      for (const n of members) {
        for (const d of n.depends || []) if (byId.get(d) && byId.get(d).territory !== terr) cross++;
        for (const dep of (dependents.get(n.id) || [])) if (byId.get(dep) && byId.get(dep).territory !== terr) cross++;
      }
      if (!cross) {
        push({ type: 'territory_isolated', scope: 'graph', target_id: terr, title: `${terr} territory is isolated`, detail: `${members.length} components, none of them connected to any other territory.` });
      }
    }
  }

  // Content-navigator signals (Part 5) — separate scope, same feed.
  computeContentSignals(db, push);

  return { signals, byTarget };
}

function computeContentSignals(db, push) {
  if (!db) return;
  try {
    const clusters = db.prepare(`SELECT code, name, grounding_status FROM clusters ORDER BY code`).all();
    const ungrounded = clusters.filter((c) => c.grounding_status !== 'grounded');
    for (const c of ungrounded) {
      push({ type: 'cluster_ungrounded', scope: 'content', target_id: c.code, title: `Cluster ${c.code} is ungrounded`, detail: `${c.name || 'This cluster'}: tags exist but nothing is anchored in archive material.` });
    }
  } catch {}
  try {
    const total = db.prepare(`SELECT COUNT(*) n FROM entities`).get()?.n || 0;
    const tagged = db.prepare(`SELECT COUNT(DISTINCT entity_id) n FROM entity_tags`).get()?.n || 0;
    const untagged = total - tagged;
    if (total >= 5 && untagged > Math.max(2, total * 0.2)) {
      push({ type: 'untagged_entities', scope: 'content', target_id: 'corpus', title: `${untagged} entities have no tags`, detail: `${untagged} of ${total} entities are invisible to the tag-overlap pattern engine.` });
    }
  } catch {}
  try {
    const bare = db.prepare(`
      SELECT COUNT(*) n FROM entities e
      WHERE NOT EXISTS (SELECT 1 FROM entity_tag_lenses l WHERE l.entity_id = e.id)
        AND NOT EXISTS (SELECT 1 FROM entity_book_suggestions b WHERE b.entity_id = e.id)
    `).get()?.n || 0;
    if (bare >= 5) {
      push({ type: 'thin_entities', scope: 'content', target_id: 'corpus', title: `${bare} entities have no books and no lens`, detail: 'Nothing has ever been written about them — they stay one-dimensional.' });
    }
  } catch {}
  // Continuum band gaps (Part 5): an axis whose middle/edge bands are empty while
  // another band is well-populated is lopsided — scores in the gap band can't be
  // meaningfully compared.
  try {
    const bands = db.prepare(`
      SELECT a.key, a.name, ec.band, COUNT(*) n FROM continuum_axes a
      LEFT JOIN (
        SELECT ec2.axis_key, ec2.entity_id,
               CASE WHEN ec2.value < 0.34 THEN 'low' WHEN ec2.value < 0.67 THEN 'mid' ELSE 'high' END AS band
        FROM entity_continuum ec2
      ) ec ON ec.axis_key = a.key
      GROUP BY a.key, a.name, ec.band
    `).all();
    const byAxis = {};
    for (const b of bands) (byAxis[b.key] = byAxis[b.key] || []).push(b);
    for (const [key, list] of Object.entries(byAxis)) {
      const counts = { low: 0, mid: 0, high: 0 };
      for (const b of list) counts[b.band || 'mid'] = b.n || 0;
      const populated = Object.values(counts).filter((n) => n >= 5);
      for (const [band, n] of Object.entries(counts)) {
        if (n <= 1 && populated.length) {
          const name = (list[0] || {}).name || key;
          push({ type: 'continuum_band_gap', scope: 'content', target_id: key, title: `The ${band} band of ${name} is empty`, detail: `${n} of ${Object.values(counts).reduce((a, b) => a + b, 0)} scores fall in it — comparisons across that region are ungrounded.` });
          break; // one signal per axis
        }
      }
    }
  } catch {}
  // No-scale-echo potential (Part 5): entities scored on an axis but with no
  // cross-type partner within the echo threshold — the Scale Echo bridge v0 can
  // never fire for them, so they are dead ends across scales.
  try {
    const rows = db.prepare(`
      SELECT e.id, e.type, e.name, ec.axis_key, ec.value
      FROM entity_continuum ec JOIN entities e ON e.id = ec.entity_id
      ORDER BY ec.axis_key, ec.value
    `).all();
    const perAxis = {};
    for (const r of rows) (perAxis[r.axis_key] = perAxis[r.axis_key] || []).push(r);
    const echoes = new Set();
    for (const list of Object.values(perAxis)) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length && list[j].value - list[i].value <= 0.07; j++) {
          if (list[i].type !== list[j].type) { echoes.add(list[i].id); echoes.add(list[j].id); }
        }
      }
    }
    const scoredIds = new Set(rows.map((r) => r.id));
    const deadEnds = [...scoredIds].filter((id) => !echoes.has(id));
    if (deadEnds.length >= 3) {
      push({ type: 'no_scale_echo', scope: 'content', target_id: 'corpus', title: `${deadEnds.length} scored entities have no echo partner`, detail: 'No cross-type pair sits within echo range on any axis — Scale Echo cannot bridge them to another scale.' });
    }
  } catch {}
}

// ─── Acknowledgements (6.2) ───────────────────────────────────────────────────
function loadAcked(db) {
  const set = new Set();
  try { db.prepare(`SELECT signal_type, scope, target_id FROM intel_signal_acknowledgements`).all()
    .forEach((r) => set.add(`${r.signal_type}|${r.scope}|${r.target_id}`)); } catch {}
  return set;
}

export function acknowledgeSignal(db, { signal_type, scope = 'node', target_id = '', reason = '' } = {}) {
  if (!signal_type) return { error: 'type_required' };
  try {
    db.prepare(`INSERT OR IGNORE INTO intel_signal_acknowledgements (id, signal_type, scope, target_id, reason)
      VALUES (?,?,?,?,?)`).run(randomUUID(), signal_type, scope, String(target_id || ''), String(reason || '') || null);
  } catch (e) { return { error: 'storage', message: e.message }; }
  return { ok: true };
}

// ─── Health (6.1) + snapshots ─────────────────────────────────────────────────
export function healthFor(signalsResult, cfg) {
  const weights = cfg.health_weights;
  const nodeScore = (id) => {
    const list = signalsResult.byTarget[id] || [];
    let pen = 0;
    for (const s of list) pen += weights[s.type] || 0;
    return Math.max(0, 100 - pen);
  };
  const nodeScores = {};
  const nodeIds = new Set();
  for (const s of signalsResult.signals) if (s.scope === 'node') nodeIds.add(s.target_id);
  for (const id of nodeIds) nodeScores[id] = nodeScore(id);
  const scored = Object.values(nodeScores);
  const graph = scored.length ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : 100;
  return { nodes: nodeScores, graph, scoredCount: scored.length };
}

function upsertSnapshot(db, scope, target_id, score, signalsJson) {
  const day = dayStr();
  try {
    db.prepare(`
      INSERT INTO intel_health_snapshots (id, scope, target_id, score, signals_json, day)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(scope, target_id, day) DO UPDATE SET score=excluded.score, signals_json=excluded.signals_json
    `).run(randomUUID(), scope, target_id, score, signalsJson, day);
  } catch (e) { /* the ON CONFLICT needs the unique index — created in schema.js */ }
}

export function recordSnapshots(db, signalsResult, health) {
  try {
    for (const [id, score] of Object.entries(health.nodes)) {
      upsertSnapshot(db, 'node', id, score, JSON.stringify((signalsResult.byTarget[id] || []).map((s) => s.type)));
    }
    upsertSnapshot(db, 'graph', 'all', health.graph, JSON.stringify(signalsResult.signals.filter((s) => s.scope === 'graph').map((s) => s.type)));
  } catch {}
  return healthHistory(db);
}

export function healthHistory(db, days = 14) {
  try {
    return db.prepare(`
      SELECT day, score FROM intel_health_snapshots
      WHERE scope='graph' AND target_id='all' ORDER BY day DESC LIMIT ?
    `).all(days).reverse();
  } catch { return []; }
}

// ─── The loop watching itself (6.5) ───────────────────────────────────────────
export function adoptionMeter(db) {
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN status='new' THEN 1 ELSE 0 END) AS fresh,
      SUM(CASE WHEN status='accepted' THEN 1 ELSE 0 END) AS accepted,
      SUM(CASE WHEN status='adopted' THEN 1 ELSE 0 END) AS adopted,
      SUM(CASE WHEN status='dismissed' THEN 1 ELSE 0 END) AS dismissed,
      COUNT(*) AS total
    FROM intel_thoughts WHERE deleted_at IS NULL
  `).get();
  const accepted = (row.accepted || 0) + (row.adopted || 0);
  const decided = accepted + (row.dismissed || 0) || 1;
  return {
    fresh: row.fresh || 0, accepted, adopted: row.adopted || 0, dismissed: row.dismissed || 0, total: row.total || 0,
    acceptanceRate: Math.round((accepted / decided) * 100),
    adoptionRate: row.adopted ? Math.round((row.adopted / accepted) * 100) : 0,
  };
}

// A thought whose target later progressed is auto-marked adopted — "I thought it,
// then it happened" (Part 4 state-memory). Also: an accepted thought whose Flow
// task was completed is adopted on the spot.
export function autoAdopt(db) {
  try {
    const done = db.prepare(`
      UPDATE intel_thoughts SET status='adopted', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE deleted_at IS NULL AND status='accepted' AND work_prompt_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM work_prompts w WHERE w.id = work_prompt_id AND w.status IN ('done','blocked'))
    `).run();
    const progressed = db.prepare(`
      UPDATE intel_thoughts SET status='adopted', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE deleted_at IS NULL AND status IN ('new','accepted') AND scope='node'
        AND EXISTS (
          SELECT 1 FROM architecture_nodes n
          WHERE n.id = target_id AND n.deleted_at IS NULL
            AND n.updated_at > created_at
            AND n.status NOT IN ('Concept','Designed')
        )
    `).run();
    return { adopted: (done.changes || 0) + (progressed.changes || 0) };
  } catch { return { adopted: 0 }; }
}

// ─── Thoughts (Part 4) ────────────────────────────────────────────────────────
export function thoughtRow(r) {
  if (!r) return r;
  return {
    id: r.id, kind: r.kind, scope: r.scope, target_id: r.target_id, title: r.title,
    body: r.body || '', prompt_draft: r.prompt_draft, priority: r.priority || 0,
    status: r.status, work_prompt_id: r.work_prompt_id, dismissed_reason: r.dismissed_reason,
    created_at: r.created_at,
  };
}

export function listThoughts(db, { status = null, scope = null } = {}) {
  let sql = `SELECT * FROM intel_thoughts WHERE deleted_at IS NULL`;
  const args = [];
  if (status) { sql += ` AND status=?`; args.push(status); }
  if (scope) { sql += ` AND scope=?`; args.push(scope); }
  sql += ` ORDER BY created_at DESC LIMIT 200`;
  return db.prepare(sql).all(...args).map(thoughtRow);
}

// Score a thought from what is already known about its target, rather than trusting
// the number the model sent.
//
// Every deliberation prompt hands the model the literal example `"priority":0` and
// never asks it to score anything, so in practice every thought was written with
// priority 0 — which made drainList()'s `ORDER BY priority DESC` silently degrade to
// oldest-first, and made the `p<n>` badge in the Mind feed meaningless. The signals
// already computed for the target say how urgent it is, for free, so use those and
// keep the model's number only as a tie-break within the band it earns.
function derivedPriority(db, scope, target_id, modelPriority) {
  const base = Math.max(0, Math.min(100, Number(modelPriority) || 0));
  if (scope !== 'node' || !target_id) return base;
  try {
    const { byTarget } = computeSignals(db, []);
    const weights = loadIntelConfig(db).health_weights;
    let severity = 0;
    for (const sig of (byTarget[target_id] || [])) severity += weights[sig.type] || 0;
    if (!severity) return base;
    // Severity is a penalty against 100; a component carrying a bottleneck (15)
    // therefore outranks one carrying only an orphan note (5). Capped so a very
    // sick component cannot crowd out everything else entirely.
    return Math.max(base, Math.min(90, severity * 3));
  } catch {
    return base;   // never let scoring break the write
  }
}

export function createThought(db, { kind = 'deliberative', scope = 'node', target_id = '', title, body = '', prompt_draft = null, priority = 0, state_hash = null } = {}) {
  const t = String(title || '').trim();
  if (!t) return { error: 'title_required' };
  try {
    const id = randomUUID();
    priority = derivedPriority(db, scope, target_id, priority);
    db.prepare(`
      INSERT INTO intel_thoughts (id, kind, scope, target_id, title, body, prompt_draft, state_hash, priority)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(id, kind, scope, String(target_id || ''), t, String(body || ''), prompt_draft, state_hash, Math.max(0, Math.min(100, Number(priority) || 0)));
    return { thought: thoughtRow(db.prepare(`SELECT * FROM intel_thoughts WHERE id=?`).get(id)) };
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) return { error: 'duplicate', message: 'That state was already thought about.' };
    throw e;
  }
}

export function getThought(db, id) {
  return thoughtRow(db.prepare(`SELECT * FROM intel_thoughts WHERE id=? AND deleted_at IS NULL`).get(id));
}

async function acceptThought(db, id, { editedTitle = null, editedPrompt = null } = {}) {
  const t = getThought(db, id);
  if (!t) return { error: 'not_found' };
  if (t.work_prompt_id) return { thought: t, prompt: queue.getPrompt(t.work_prompt_id), already: true };
  const draft = editedPrompt !== null ? editedPrompt : (t.prompt_draft || t.body);
  if (!draft || !draft.trim()) return { error: 'no_prompt', message: 'This thought has no actionable draft.' };
  const promptRow = await queue.createPrompt({
    title: editedTitle || t.title,
    prompt: draft.trim(),
    mode: 'implement',
    preset: 'deep',
    status: 'paused', // the human gate: nothing runs automatically
    created_by: 'antoine',
    thought_id: t.id,
    component_id: t.scope === 'node' ? t.target_id : null,
    plan_source: 'skip', // the thought's draft already IS the plan
  });
  db.prepare(`UPDATE intel_thoughts SET status='accepted', work_prompt_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
    .run(promptRow.id, id);
  return { thought: getThought(db, id), prompt: promptRow, already: false };
}

function dismissThought(db, id, { reason = null } = {}) {
  const t = getThought(db, id);
  if (!t) return { error: 'not_found' };
  db.prepare(`UPDATE intel_thoughts SET status='dismissed', dismissed_reason=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
    .run(String(reason || '') || null, id);
  return { thought: getThought(db, id) };
}

// ─── Budget (Part 4 caps) ─────────────────────────────────────────────────────
// Automatic passes share one per-hour budget; explicit clicks bypass it.
function intelCap(db, cfg) {
  const hour = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const used = db.prepare(`
    SELECT COUNT(*) n FROM intel_thoughts
    WHERE kind='deliberative' AND created_at > ? AND status IN ('new','accepted','adopted')
  `).get(hour).n || 0;
  return { used, limit: cfg.thoughts_per_hour, allowed: used < cfg.thoughts_per_hour };
}

function stateHashOf(node) {
  return createHash('sha1').update([
    String(node.status || ''), String(node.next || ''), String(node.what || ''),
    (node.depends || []).join(','), String(node.store_updated_at || node.component_verified_at || ''),
  ].join('|')).digest('hex');
}

// ─── The architecture side of the state digest, for free ──────────────────────
// Why this lives here. The suggestion engine's own digest (workSuggestions.js
// buildContextDigest) read entity counts, ungrounded clusters, recent queue titles
// and its own past proposals — five lines, four of them about the material. The
// model was handed a corpus status report and asked "what should I build next?", so
// it proposed corpus work. It was not choosing the material over the build system;
// it was never shown the build system at all.
//
// This function supplies the missing half from the same rows the ranking already
// reads. SQL and arithmetic only — no model call, safe to run on every generation.
// `territory` narrows the digest to one part of the app, for a focused suggestion run.
// Note what is and isn't filtered: `scope` is what gets *reported on*, while `byId`
// stays whole, because the ready-to-start test below resolves each piece's
// dependencies through it and pieces depend on things in other territories. Filtering
// the lookup map instead would silently mark blocked work as ready.
export function architectureDigest(db, catalog = [], { territory = null } = {}) {
  const lines = [];
  try {
    const { byId, all: everything } = unifiedNodes(db, catalog);
    const all = territory ? everything.filter((n) => n.territory === territory) : everything;
    if (!all.length) return '';
    const built = (n) => ['Working', 'Validated', 'Advanced'].includes(n?.status || '');

    const byTerr = new Map();
    for (const n of all) {
      if (!byTerr.has(n.territory)) byTerr.set(n.territory, { total: 0, built: 0 });
      const t = byTerr.get(n.territory);
      t.total++;
      if (built(n)) t.built++;
    }
    lines.push(`${territory ? 'This part of the app' : "The app's own map of itself"}: ${[...byTerr.entries()]
      .map(([t, v]) => `${t} ${v.built}/${v.total} finished`)
      .join(', ')}.`);

    // Ready-to-start is the single most actionable fact here: it is what the free
    // ranking sorts on first, so naming it keeps proposals and ranking in agreement.
    const ready = all.filter((n) => !built(n) && (n.depends || []).every((d) => built(byId.get(d))));
    if (ready.length) {
      lines.push(`Unfinished and nothing blocking them, ready to start now: ${ready
        .slice(0, 12).map((n) => `${n.name} (${n.territory})`).join(' · ')}.`);
    }
    const blocked = all.filter((n) => !built(n) && !ready.includes(n));
    if (blocked.length) lines.push(`${blocked.length} more unfinished pieces are waiting on something else first.`);

    const signalsResult = computeSignals(db, catalog);
    // Signals are computed across the whole app. When scoped, keep only the ones aimed
    // at a piece in this territory or at the territory itself (territory_isolated uses
    // the territory id as its target) — a weak spot somewhere else is not this part's
    // problem and would just pull the proposals off subject.
    const inScope = new Set(all.map((n) => n.id));
    const relevant = (signalsResult.signals || []).filter(
      (sg) => !territory || sg.target_id === territory || inScope.has(sg.target_id));
    const worst = [...relevant]
      .sort((a, b) => (b.severity || 0) - (a.severity || 0)).slice(0, 6);
    if (worst.length) {
      lines.push(`Weak spots counted right now: ${worst.map((sg) => `${sg.type}${sg.target_id ? ` on ${sg.target_id}` : ''}`).join(' · ')}.`);
    }
    // Health is a whole-app score. Reporting it under a territory heading would read as
    // that territory's score, which it isn't, so a focused digest goes without it.
    if (!territory) {
      const health = healthFor(signalsResult, loadIntelConfig(db));
      if (health && typeof health.graph === 'number') lines.push(`Overall health of the app's own build: ${health.graph}/100.`);
    }
  } catch { /* an older database, or no catalog posted — the digest degrades to fewer lines */ }
  // Also a whole-app count, so left out of a focused digest for the same reason.
  if (!territory) {
    try {
      const open = db.prepare(`SELECT COUNT(*) n FROM intel_thoughts WHERE deleted_at IS NULL AND status='new'`).get()?.n || 0;
      if (open) lines.push(`${open} thoughts the app has already had about itself are still unread.`);
    } catch { /* same */ }
  }
  return lines.join('\n');
}

// ─── Deliberation (Part 4 + 6.3/6.4) ──────────────────────────────────────────
// Node context builder shared by Deepen — mirrors speculate()'s philosophy: the
// trunk lives in the frontend, so the caller passes the node's own text.
// Was `all.slice(0, 40)`, and `all` comes out of unifiedNodes ordered by
// architecture_nodes.created_at — so the oldest rows survived the cut and anything
// added later fell off the end. Every piece of the app's own build system is newer
// than the material pieces, so the whole 'self' area could vanish from the digest
// while the prompt still asked "what should I build next?". Round-robin by area
// instead: the cap now costs each area a little breadth rather than costing the
// newest area everything.
function digestLines(byId, all, signalsResult, limit = 48) {
  const byTerritory = new Map();
  for (const n of all) {
    if (!byTerritory.has(n.territory)) byTerritory.set(n.territory, []);
    byTerritory.get(n.territory).push(n);
  }
  const queues = [...byTerritory.values()];
  const picked = [];
  let drained = false;
  while (picked.length < limit && !drained) {
    drained = true;
    for (const q of queues) {
      if (!q.length) continue;
      drained = false;
      picked.push(q.shift());
      if (picked.length >= limit) break;
    }
  }
  const lines = [];
  for (const n of picked) {
    const sigs = (signalsResult.byTarget[n.id] || []).map((s) => s.type).join(',');
    lines.push(`- ${n.id} — ${n.name} (${n.territory}, ${n.status})${n.depends.length ? `, depends: ${n.depends.join(',')}` : ''}${sigs ? ` — signals: ${sigs}` : ''}: ${String(n.what || '').slice(0, 120)}`);
  }
  return lines.join('\n') || '- (no components)';
}

function parseThoughtsArray(text) {
  if (!text) return [];
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const tryParse = (str) => { try { const v = JSON.parse(str); return Array.isArray(v) ? v : null; } catch { return null; } };
  const arr = tryParse(s);
  if (arr) return arr.filter((t) => t && t.title).slice(0, 3);
  const start = s.indexOf('['), end = s.lastIndexOf(']');
  if (start !== -1 && end > start) {
    const a = tryParse(s.slice(start, end + 1));
    if (a) return a.filter((t) => t && t.title).slice(0, 3);
  }
  return [];
}

// One-time vulgarization pass: rewrites already-stored user-facing texts (mind
// thought titles/bodies, work suggestion titles/rationales) into plain everyday
// language — the same rule new generations are born with. Idempotent. One model
// call per table with rows to rewrite.
export async function vulgarizeExistingTexts(db) {
  const thoughts = db.prepare(`SELECT id, title, body FROM intel_thoughts WHERE deleted_at IS NULL`).all();
  const suggestions = db.prepare(`SELECT id, title, rationale FROM work_suggestions WHERE deleted_at IS NULL`).all();
  let thoughtCount = 0, suggestionCount = 0;

  if (thoughts.length) {
    const out = await generateText({
      prompt: `Rewrite these titles and bodies so a non-programmer understands them instantly. Plain English, everyday words. Never use internal component ids or technical slugs (like "observation-layer") — say what the change would do for the person using the app. Keep each title under 8 words, each body 1-2 short sentences. Return ONLY a JSON array with every input id exactly once: [{"id":"...","title":"...","body":"..."}]\n${JSON.stringify(thoughts)}`,
      feature: 'studio', maxTokens: 1200, label: 'vulgarize-thoughts',
    });
    if (!out.error) {
      const m = (out.text || '').match(/\[[\s\S]*\]/);
      let parsed = null;
      if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
      if (Array.isArray(parsed)) {
        for (const it of parsed) {
          if (!it || !it.id || !it.title) continue;
          db.prepare(`UPDATE intel_thoughts SET title=?, body=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
            .run(String(it.title).slice(0, 200), String(it.body || '').slice(0, 800), it.id);
          thoughtCount++;
        }
      }
    }
  }

  if (suggestions.length) {
    const out = await generateText({
      prompt: `Rewrite these suggestion titles and rationales so a non-programmer understands them instantly. Plain English, everyday words, no technical jargon, no internal names or ids — say what it would change for the person using the app. Keep each title short (under 8 words) and each rationale one short sentence. Return ONLY a JSON array with every input id exactly once: [{"id":"...","title":"...","rationale":"..."}]\n${JSON.stringify(suggestions)}`,
      feature: 'studio', maxTokens: 1200, label: 'vulgarize-suggestions',
    });
    if (!out.error) {
      const m = (out.text || '').match(/\[[\s\S]*\]/);
      let parsed = null;
      if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
      if (Array.isArray(parsed)) {
        for (const it of parsed) {
          if (!it || !it.id || !it.title) continue;
          db.prepare(`UPDATE work_suggestions SET title=?, rationale=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND deleted_at IS NULL`)
            .run(String(it.title).slice(0, 200), String(it.rationale || '').slice(0, 400), it.id);
          suggestionCount++;
        }
      }
    }
  }

  return { thoughts: thoughtCount, suggestions: suggestionCount };
}

// Explicit click only. Extends speculate(): instead of proposing child NODES, it
// proposes THOUGHTS — blind spots, improvements, integrations, next features.
export async function deepenNode(db, { catalog, targetId } = {}) {
  const { byId, all } = unifiedNodes(db, catalog);
  const n = byId.get(targetId);
  if (!n) return { error: 'not_found' };
  const signalsResult = computeSignals(db, catalog);
  const mine = (signalsResult.byTarget[targetId] || []).map((s) => `${s.type}: ${s.detail}`).join('\n');
  const prompt = `You are the mind of ${APP_BLURB}
You are the platform thinking about its own development.

${onSubjectRule(`${n.name} (${n.territory})`)}

Think deeply about ONE component of the platform:

NODE: ${n.name} (territory: ${n.territory}, status: ${n.status})
What it is: ${n.what || '(not described)'}
Why it matters: ${n.why || '(not described)'}
Next step planned: ${n.next || '(none)'}
Depends on: ${(n.depends || []).map((d) => byId.get(d)?.name || d).join(', ') || '(nothing)'}

Its current health signals:
${mine || '- none'}

Produce up to 3 THOUGHTS about this component, not child nodes. Each thought is one of: a blind spot risk, how to make this component meaningfully better, an integration opportunity with the rest of the platform, or a next feature that makes logical sense. Each must be specific to FMCNS's real subject matter — not generic advice ("add tests", "improve caching").

${USER_FACING_STYLE} (applies to the "title" and "body" the owner reads; "prompt_draft" may stay technical for the coding agent)
The title and body must NEVER mention internal component ids or slugs (like "observation-layer") — say what the change would do for the person using the app, in everyday words.

Respond with ONLY a JSON array, no prose, no markdown fence:
[{"title":"short title under 8 words","body":"2-3 sentences: the thought itself and why it matters now","prompt_draft":"a ready-to-queue task prompt implementing the thought","priority":0}]`;
  const out = await generateText({ prompt, feature: 'quick', maxTokens: 1300, label: 'intel-deepen' });
  if (out.error) return { error: out.error, message: out.message };
  const items = parseThoughtsArray(out.text);
  if (!items.length) return { error: 'unparseable', message: 'The model did not return usable thoughts.' };
  const hash = stateHashOf(n);
  const created = [];
  for (const it of items) {
    const r = createThought(db, {
      kind: 'deliberative', scope: 'node', target_id: n.id, title: it.title,
      body: it.body || '', prompt_draft: it.prompt_draft || null, priority: Number(it.priority) || 0,
      state_hash: hash,
    });
    if (r.thought) created.push(r.thought);
  }
  if (!created.length) return { error: 'all_duplicates', message: 'That state was already thought about.' };
  return { thoughts: created };
}

// Whole-graph deliberation — the "Think about the whole graph" button, plus the
// Growth proposals (6.4) when focus='growth'.
export async function pulseGraph(db, { catalog, focus = 'pulse', force = false } = {}) {
  const cfg = loadIntelConfig(db);
  if (!force) {
    const cap = intelCap(db, cfg);
    if (!cap.allowed) return { error: 'cap', message: `Automatic thinking is limited to ${cfg.thoughts_per_hour} thoughts/hour — an explicit click is always allowed.` };
  }
  const { byId, all } = unifiedNodes(db, catalog);
  const signalsResult = computeSignals(db, catalog);
  const graphSignals = signalsResult.signals.filter((s) => s.scope === 'graph').map((s) => `- ${s.type}: ${s.detail}`).join('\n');
  const queueState = (() => {
    try {
      const r = db.prepare(`SELECT status, COUNT(*) n FROM work_prompts WHERE deleted_at IS NULL GROUP BY status`).all();
      return r.map((x) => `${x.status}:${x.n}`).join(', ');
    } catch { return ''; }
  })();
  const recent = (() => {
    try { return db.prepare(`SELECT title, status FROM work_prompts WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 6`).all().map((x) => `${x.title} [${x.status}]`).join(' · '); } catch { return ''; }
  })();
  const growthFocus = focus === 'growth';

  const prompt = `You are the mind of ${APP_BLURB}
You are the platform thinking about its own development.

Here is the whole platform right now:

Components:
${digestLines(byId, all, signalsResult)}

Whole-graph health signals:
${graphSignals || '- none'}

Task queue: ${queueState || 'quiet'}${recent ? `\nRecent tasks: ${recent}` : ''}

${growthFocus
  ? 'Focus: GROWTH. Examine usage patterns and quiet zones (never-worked components, isolated territories, accepted speculations that produced value). Propose up to 3 next-logical-features: new capabilities that tie the platform together or fill obvious blind spots. Each must be specific to FMCNS, not generic.'
  : 'Focus: the platform\'s own development health. Propose up to 3 thoughts about what to do next — blind spots, integration opportunities between components, features that make logical sense. Each must be specific to FMCNS, not generic.'}

BALANCE. The list above holds both halves of the app: the material it studies, and the app's own build system (the 'self' area — the queue, the worker, shipping, self-observation, ranking, suggestions, the idea studio, the look at the world). If you produce 3 thoughts, at least ONE must be about the build system and at least ONE about the material. Both halves are real development areas; a set of thoughts entirely about one of them is an incomplete answer, not a focused one.

${USER_FACING_STYLE} (applies to the "title" and "body" the owner reads; "prompt_draft" may stay technical for the coding agent)
The title and body must NEVER mention internal component ids or slugs (like "observation-layer") — say what the change would do for the person using the app, in everyday words.

Respond with ONLY a JSON array, no prose, no markdown fence:
[{"title":"short title under 8 words","body":"2-3 sentences: the thought and why it matters now","prompt_draft":"a ready-to-queue task prompt implementing it","priority":0,"target_id":"optional existing component id from the list above"}]`;

  const out = await generateText({ prompt, feature: 'quick', maxTokens: 1700, label: growthFocus ? 'intel-growth' : 'intel-pulse' });
  if (out.error) return { error: out.error, message: out.message };
  const items = parseThoughtsArray(out.text);
  if (!items.length) return { error: 'unparseable', message: 'The model did not return usable thoughts.' };
  const created = [];
  for (const it of items) {
    const target = byId.has(it.target_id) ? it.target_id : '';
    const hash = target
      ? stateHashOf(byId.get(target))
      : createHash('sha1').update(dayStr() + '::graph::' + norm(it.title)).digest('hex');
    const r = createThought(db, {
      kind: 'deliberative', scope: target ? 'node' : 'graph', target_id: target,
      title: it.title, body: it.body || '', prompt_draft: it.prompt_draft || null,
      priority: Number(it.priority) || 0, state_hash: hash,
    });
    if (r.thought) created.push(r.thought);
  }
  return { thoughts: created, skipped: items.length - created.length };
}

// Content-corpus deliberation (Part 5) — the "Think" buttons in the Content
// graph's Intelligence panel. Same caps and dedup rules as pulseGraph, but it
// thinks about the ontology itself, not the platform's code.
export async function contentPulse(db, { focus = 'themes', force = false } = {}) {
  const cfg = loadIntelConfig(db);
  if (!force) {
    const cap = intelCap(db, cfg);
    if (!cap.allowed) return { error: 'cap', message: `Automatic thinking is limited to ${cfg.thoughts_per_hour} thoughts/hour — an explicit click is always allowed.` };
  }
  const contentDigest = (() => {
    try {
      const lines = [];
      const clusters = db.prepare(`SELECT code, name, grounding_status FROM clusters ORDER BY code`).all();
      for (const c of clusters) {
        const n = db.prepare(`SELECT COUNT(*) n FROM entities WHERE clusters LIKE ?`).get(`%${c.code}%`)?.n || 0;
        lines.push(`- Cluster ${c.code} ${c.name} (${c.grounding_status || 'unknown status'}, ${n} entities)`);
      }
      const axes = db.prepare(`
        SELECT a.key, a.name, COUNT(ec.entity_id) scored, ROUND(MIN(ec.value), 2) min_v, ROUND(MAX(ec.value), 2) max_v
        FROM continuum_axes a LEFT JOIN entity_continuum ec ON ec.axis_key = a.key
        GROUP BY a.key, a.name
      `).all();
      for (const a of axes) lines.push(`- Axis ${a.name} (${a.scored} scores, range ${a.min_v}–${a.max_v})`);
      const tags = db.prepare(`SELECT tag, COUNT(*) n FROM entity_tags GROUP BY tag ORDER BY n DESC LIMIT 12`).all();
      lines.push(`- Top tags: ${tags.map((t) => `${t.tag} (${t.n})`).join(', ') || 'none yet'}`);
      const counts = db.prepare(`SELECT type, COUNT(*) n FROM entities GROUP BY type`).all();
      lines.push(`- Corpus: ${counts.map((t) => `${t.type}×${t.n}`).join(', ')}`);
      return lines.join('\n');
    } catch { return '(corpus data unavailable)'; }
  })();
  const focusLine = focus === 'bridges'
    ? 'Focus: BRIDGE PITCHES. Look at the axes and their scored entities. Propose up to 3 specific cross-scale bridges: name the concrete pair of entities (or two entity archetypes) across different scales — e.g. a character and a country, a film and a country — that share a telling archetypal position and are worth an explicit scale-echo link. Point to the axis and approximate scores.'
    : 'Focus: UNDER-EXPLORED THEMES. Look at the corpus: cluster grounding, axis coverage and band gaps, sparse or missing tags, thin entities (no books, no lens). Propose up to 3 thoughts about what the corpus is missing or what theme deserves exploration next. Each must be specific to this corpus, not generic advice.';

  const prompt = `You are the mind of ${APP_BLURB}
You are thinking about the MATERIAL itself — the corpus — not the software, and not the app's own build system.

Here is the corpus right now:
${contentDigest}

${focusLine}

${USER_FACING_STYLE} (applies to the "title" and "body" the owner reads; "prompt_draft" may stay technical for the coding agent)

Respond with ONLY a JSON array, no prose, no markdown fence:
[{"title":"short title under 8 words","body":"2-3 sentences: the insight and why it matters now","prompt_draft":"a ready-to-queue task prompt that would act on this","priority":0,"target_id":"optional cluster code or axis key from the list above"}]`;

  const out = await generateText({ prompt, feature: 'quick', maxTokens: 1700, label: 'intel-content' });
  if (out.error) return { error: out.error, message: out.message };
  const items = parseThoughtsArray(out.text);
  if (!items.length) return { error: 'unparseable', message: 'The model did not return usable thoughts.' };
  const validTargets = new Set([
    ...db.prepare(`SELECT code FROM clusters`).all().map((c) => c.code),
    ...db.prepare(`SELECT key FROM continuum_axes`).all().map((a) => a.key),
  ]);
  const created = [];
  for (const it of items) {
    const target = validTargets.has(it.target_id) ? it.target_id : '';
    const hash = createHash('sha1').update(dayStr() + '::content::' + focus + '::' + norm(it.title)).digest('hex');
    const r = createThought(db, {
      kind: 'deliberative', scope: 'content', target_id: target,
      title: it.title, body: it.body || '', prompt_draft: it.prompt_draft || null,
      priority: Number(it.priority) || 0, state_hash: hash,
    });
    if (r.thought) created.push(r.thought);
  }
  return { thoughts: created, skipped: items.length - created.length };
}
function lessonFingerprint(lesson) {
  return createHash('sha1').update(norm(lesson)).digest('hex');
}

export async function runRetrospectives(db, { force = false, max = 1 } = {}) {
  const cfg = loadIntelConfig(db);
  if (!cfg.retro_enabled && !force) return { error: 'disabled', learned: [] };
  if (!force) {
    const cap = intelCap(db, cfg);
    if (!cap.allowed) return { error: 'cap', message: 'Retrospective budget reached for this hour.' };
  }
  const candidates = db.prepare(`
    SELECT w.* FROM work_prompts w
    LEFT JOIN intel_task_lessons l ON l.work_prompt_id = w.id
    WHERE w.status IN ('done','blocked') AND w.mode='implement'
      AND w.completed_at IS NOT NULL AND w.deleted_at IS NULL AND l.id IS NULL
    ORDER BY w.completed_at DESC LIMIT ?
  `).all(max);
  const learned = [];
  for (const w of candidates) {
    const finishedMs = new Date(w.completed_at).getTime();
    if (!force && Date.now() - finishedMs > RETRO_WINDOW_MS) continue;
    const digest = [
      `Task: ${w.title}`,
      `Outcome: ${w.status}${w.cost_usd != null ? ` (cost $${Number(w.cost_usd).toFixed(4)}, model ${w.run_model || 'n/a'})` : ''}`,
      `Started: ${w.started_at || '?'} · Finished: ${w.completed_at}`,
      `Prompt: ${String(w.prompt || '').slice(0, 400)}`,
    ].join('\n');
    const prompt = `You are the memory of FMCNS, a self-aware platform. A development task just finished. Review it and extract ONE durable lesson worth remembering — what worked, what failed, what to do differently next time. Be concrete. If the outcome was success, still find one transferable lesson.

${digest}

${USER_FACING_STYLE} (applies to the "title" and "lesson" the owner reads)

Respond with ONLY JSON, no prose, no markdown fence:
{"title":"short title under 8 words","lesson":"2-3 sentences: the reusable lesson","outcome":"done|blocked"}`;
    const out = await generateText({ prompt, feature: 'quick', maxTokens: 500, label: 'intel-retro' });
    if (out.error) continue;
    const m = out.text.match(/\{[\s\S]*\}/);
    let parsed = null;
    if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
    if (!parsed || !parsed.lesson) continue;
    const fp = lessonFingerprint(parsed.lesson);
    try {
      db.prepare(`
        INSERT INTO intel_task_lessons (id, work_prompt_id, title, lesson, outcome, fingerprint)
        VALUES (?,?,?,?,?,?)
      `).run(randomUUID(), w.id, String(parsed.title || '').slice(0, 120), parsed.lesson, parsed.outcome === 'done' ? 'done' : 'blocked', fp);
      learned.push({ work_prompt_id: w.id, title: parsed.title, lesson: parsed.lesson, outcome: parsed.outcome });
    } catch { /* fingerprint dedup — already learned */ }
  }
  return { learned, candidates: candidates.length };
}

export function listLessons(db, limit = 8) {
  return db.prepare(`SELECT * FROM intel_task_lessons ORDER BY created_at DESC LIMIT ?`).all(limit);
}

// ─── Ranked drain (6.6) ───────────────────────────────────────────────────────
export function drainList(db, { limit = 10 } = {}) {
  const rows = db.prepare(`
    SELECT * FROM intel_thoughts
    WHERE deleted_at IS NULL AND status='new' AND work_prompt_id IS NULL
    ORDER BY priority DESC, created_at ASC LIMIT ?
  `).all(limit);
  return rows.map(thoughtRow);
}

// ─── The public surface ───────────────────────────────────────────────────────
let cached = { at: 0, key: '', out: null };

export function signalsFor(db, catalog = []) {
  autoAdopt(db);
  // The catalog (what the user sees) rarely changes; cache by a light hash of the
  // statuses + ids so the pulse is cheap on the frontend's poll cadence.
  const key = JSON.stringify((Array.isArray(catalog) ? catalog : []).map((c) => `${c.id}:${c.status || ''}`));
  const now = Date.now();
  if (cached.key === key && now - cached.at < CACHE_TTL_MS && cached.out) return cached.out;

  const cfg = loadIntelConfig(db);
  const signalsResult = computeSignals(db, catalog);
  const health = healthFor(signalsResult, cfg);
  const history = recordSnapshots(db, signalsResult, health);
  const meter = adoptionMeter(db);

  const out = {
    signals: signalsResult.signals,
    byTarget: signalsResult.byTarget,
    health: { nodes: health.nodes, graph: health.graph, history },
    meter,
    selfCorrect: (() => {
      // 6.5: if thoughts keep being ignored, the platform says so once.
      const selfN = cfg.self_correct_after;
      if (meter.total >= selfN && meter.accepted === 0) {
        return { title: `I have proposed ${meter.total} thoughts and none were accepted`, body: 'What should I look at differently? Accept one, or dismiss them — but silence is the one signal I cannot read.', exists: true };
      }
      return { exists: false };
    })(),
  };
  cached = { at: now, key, out };
  return out;
}

// Background pass — called from the signals endpoint, never awaited by it.
// Reconciles finished tasks into lessons, strictly within the per-hour budget.
export function scheduleBackgroundIntel(db) {
  setTimeout(() => {
    runRetrospectives(db).catch(() => {});
  }, 1500);
}

export const intelApi = {
  signalsFor, computeSignals, acknowledgeSignal, healthFor, recordSnapshots, healthHistory,
  adoptionMeter, listThoughts, createThought, getThought, acceptThought, dismissThought,
  deepenNode, pulseGraph, contentPulse, runRetrospectives, listLessons, drainList, scheduleBackgroundIntel,
  vulgarizeExistingTexts,
};