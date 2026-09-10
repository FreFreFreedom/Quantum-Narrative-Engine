// Stored relations between entities — plans/civic-structures-and-loops.md, Stage 4.
//
// The app's echoes have always been recomputed and thrown away: shared tags, shared author,
// two entities near each other on an axis. Nothing was written down, so nothing could carry
// a direction, a date, a source, or a statement of what would prove it wrong. This module
// is where a relation someone actually asserts gets kept.
//
// Four rules live here rather than in the caller, because a rule enforced only by
// convention is a rule that will be broken by the second caller:
//
//   1. A VERTICAL RELATION MAY NOT SKIP A RUNG. The paradigm's whole distinction between
//      vertical navigation and an entanglement jump is that the vertical one visits every
//      intermediate node — "neither direction skips a rung" (fractal_operational_core.md
//      §9). A claim that a national law produced a broken family, with nothing in between,
//      is a jump wearing a vertical label. Rejected.
//   2. A HORIZONTAL RELATION IS SAME-RUNG, by definition. Rejected otherwise.
//   3. A MEDIUM HAS NO RUNG, so it cannot be either end of a vertical or horizontal
//      relation. A film testifies about entities; it does not sit above or beside them.
//      (It may still be one end of a jump — nothing about structural kinship needs a rung.)
//   4. EVERY RELATION CARRIES ITS PROVENANCE. A source reference and a falsifier are
//      required, because §11 says provenance costs almost nothing at birth and cannot be
//      reconstructed later — and the one time this project skipped it, a fabricated pattern
//      survived to be caught by hand.
//
// A LOOP IS NOT A ROW. There is no loop table and there must not be one: an event is an
// entity-state over time, not its own node type (§2). A loop is a query — vertical
// relations that return to the rung they started on with `at` increasing — and findLoops()
// below is that query, nothing more.

import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rungOf, rungDirection, SCALE_LADDER } from './scaleLadder.js';

export const MOVES = ['vertical', 'horizontal', 'jump'];
export const SOURCE_KINDS = ['self', 'witness'];

function scaleOf(db, id) {
  const row = db.prepare(`SELECT scale FROM entities WHERE id=?`).get(id);
  return row ? row.scale : undefined;
}

// Returns null when the relation is allowed, or a sentence saying why it is not. Exported
// so a caller can check before writing and get the same answer the writer would give.
export function validateRelation(db, { from_id, to_id, move, source_ref, falsifier, source_kind }) {
  if (!from_id || !to_id) return 'from_id and to_id are both required.';
  if (from_id === to_id) return 'A relation from an entity to itself says nothing.';
  const fromScale = scaleOf(db, from_id);
  const toScale = scaleOf(db, to_id);
  if (fromScale === undefined) return `No entity ${from_id}.`;
  if (toScale === undefined) return `No entity ${to_id}.`;
  if (!MOVES.includes(move)) return `move must be one of ${MOVES.join(', ')}.`;
  if (source_kind && !SOURCE_KINDS.includes(source_kind)) return `source_kind must be self or witness.`;
  // Rule 4 first: an unsourced relation is refused whatever its shape.
  if (!source_ref) return 'source_ref is required — which testimony produced this claim.';
  if (!falsifier) return 'falsifier is required — what observation would break this claim.';

  if (move === 'jump') return null; // a jump asserts no path, so no rung constraint applies

  const a = rungOf(fromScale);
  const b = rungOf(toScale);
  if (a === null || b === null) {
    // Rule 3. Naming the offending side makes this actionable instead of cryptic.
    const which = a === null ? `${from_id} (scale ${fromScale || 'none'})` : `${to_id} (scale ${toScale || 'none'})`;
    return `${which} sits on no rung, so it cannot be one end of a ${move} relation. A film is a medium, not an entity with a scale. Use move 'jump', or relate the entity the film testifies about.`;
  }
  if (move === 'horizontal' && a !== b) {
    return `A horizontal relation compares peers on one rung, but these are ${Math.abs(a - b)} rungs apart.`;
  }
  if (move === 'vertical' && Math.abs(a - b) !== 1) {
    // Rule 1, with the fix spelled out: name the rungs that were skipped.
    const skipped = SCALE_LADDER.slice(Math.min(a, b) + 1, Math.max(a, b)).map((r) => r.key);
    return Math.abs(a - b) === 0
      ? 'A vertical relation crosses a rung; these two sit on the same one. Use move \'horizontal\'.'
      : `A vertical relation may not skip a rung — these are ${Math.abs(a - b)} apart, skipping ${skipped.join(', ')}. Assert the intermediate steps as their own relations, or use move 'jump' if there is no path to trace.`;
  }
  return null;
}

export function createRelation(db, input) {
  const problem = validateRelation(db, input);
  if (problem) { const e = new Error(problem); e.status = 400; throw e; }

  const { from_id, to_id, move, shape = null, at = null, note = null, moment = null,
    source_kind = 'witness', source_ref, falsifier, created_by = 'antoine' } = input;

  // Direction is derived, never taken from the caller: it is a fact about the two rungs,
  // and letting it be passed in would allow a row that contradicts its own endpoints.
  const direction = move === 'vertical' ? rungDirection(scaleOf(db, from_id), scaleOf(db, to_id)) : null;

  const id = randomUUID();
  db.prepare(`
    INSERT INTO entity_relations (id, from_id, to_id, move, shape, direction, at, note, moment, source_kind, source_ref, falsifier, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(id, from_id, to_id, move, shape, direction, at, note, moment, source_kind, source_ref, falsifier, created_by);
  return getRelation(db, id);
}

export function getRelation(db, id) {
  return db.prepare(`SELECT * FROM entity_relations WHERE id=? AND deleted_at IS NULL`).get(id) || null;
}

export function deleteRelation(db, id) {
  const r = db.prepare(`UPDATE entity_relations SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND deleted_at IS NULL`).run(id);
  return r.changes > 0;
}

// Every relation touching this entity, in either direction, with the other end's name and
// rung attached so a caller does not have to fetch each one. `role` says which end this
// entity is, because a vertical relation is not symmetric.
export function relationsFor(db, entityId) {
  const rows = db.prepare(`
    SELECT r.*,
           fe.name AS from_name, fe.scale AS from_scale, fe.type AS from_type,
           te.name AS to_name,   te.scale AS to_scale,   te.type AS to_type
    FROM entity_relations r
    JOIN entities fe ON fe.id = r.from_id
    JOIN entities te ON te.id = r.to_id
    WHERE (r.from_id = ? OR r.to_id = ?) AND r.deleted_at IS NULL
    ORDER BY COALESCE(r.at, ''), r.created_at
  `).all(entityId, entityId);
  return rows.map((r) => ({ ...r, role: r.from_id === entityId ? 'from' : 'to' }));
}

export function listRelations(db, { move, shape } = {}) {
  let sql = `SELECT * FROM entity_relations WHERE deleted_at IS NULL`;
  const args = [];
  if (move) { sql += ` AND move = ?`; args.push(move); }
  if (shape) { sql += ` AND shape = ?`; args.push(shape); }
  return db.prepare(sql + ` ORDER BY COALESCE(at,''), created_at`).all(...args);
}

// A date in this data is written the way the source writes it — "1957", "c.1930", "1889".
// Comparing those as strings is wrong in a way that looks right: "c.1950" sorts AFTER
// "1965" because 'c' is above '1', so a circuit would be reported running backwards while
// every check passed. Compare on the leading four-digit year and keep the written form for
// display. A date with no year in it is uncomparable and returns null, which callers must
// treat as "unknown", never as year zero.
export function yearOf(at) {
  if (!at) return null;
  const m = String(at).match(/(\d{4})/);
  return m ? Number(m[1]) : null;
}

// ─── Loops ───────────────────────────────────────────────────────────────────
// A loop is a query, not a stored object. It is a chain of vertical relations that leaves
// a rung and comes back to it, with `at` never going backwards — the law descending to the
// family and the family's fracture returning as the next law.
//
// Undated relations are allowed into a chain but never make one: a loop needs at least two
// dated steps, or "the wound came back" is an assertion about time with no time in it.
// Depth is capped at the ladder's height, which is the longest a non-repeating rung walk
// can be, so a cycle in the data cannot run away.
//
// Two properties the selftest established, recorded here because both are easy to assume
// wrongly (the first draft of that test assumed both wrongly):
//
//   • The time rule PRUNES CHAINS; it cannot reject a cycle. Because a vertical relation
//     crosses exactly one rung, every cycle must return the way it went, so every cycle
//     contains a two-step sub-cycle — and a two-step cycle is always chronological from
//     its earlier end. What the rule actually stops is a longer walk being reported as one
//     circuit when its dates do not run round it.
//   • NESTED LOOPS ARE BOTH REPORTED. A four-step circuit and the two-step circuit inside
//     it are different claims — how far down the wound travelled before it came back — and
//     collapsing them would throw the difference away. Rotations of the SAME loop are
//     deduplicated; a shorter loop inside a longer one is not.
export function findLoops(db, { entityId, maxDepth = SCALE_LADDER.length } = {}) {
  const verticals = listRelations(db, { move: 'vertical' });
  const out = new Map();
  const byFrom = new Map();
  for (const r of verticals) {
    if (!byFrom.has(r.from_id)) byFrom.set(r.from_id, []);
    byFrom.get(r.from_id).push(r);
  }
  // Always walk from every possible start. `entityId` filters what comes back, and the
  // difference matters: a household caught in a circuit is IN that loop whether or not the
  // loop happens to be keyed at the household. Filtering the starts instead of the results
  // would hide an entity's own loop from it whenever the walk began somewhere else.
  const starts = [...new Set(verticals.map((r) => r.from_id))];

  const walk = (start, node, path, lastAt) => {
    if (path.length >= maxDepth) return;
    for (const r of byFrom.get(node) || []) {
      if (path.some((p) => p.id === r.id)) continue;           // never reuse a relation
      const rY = yearOf(r.at);
      if (rY !== null && lastAt !== null && rY < lastAt) continue;  // time may not run backwards
      const next = [...path, r];
      if (r.to_id === start) {
        // A loop has to have duration. Two dated steps is not enough on its own: a
        // descent and a return recorded at the same date are two claims about one moment,
        // not a circuit, and reporting them as a loop would put time in the output that
        // is not in the evidence.
        const dates = next.map((x) => x.at).filter(Boolean);
        const years = dates.map(yearOf).filter((y) => y !== null);
        if (years.length < 2) continue;
        if (years[0] === years[years.length - 1]) continue;
        const dated = dates.length;
        const key = next.map((x) => x.id).sort().join('|');    // one loop, not n rotations
        if (!out.has(key)) {
          out.set(key, {
            entity: start,
            steps: next.map((x) => ({ id: x.id, from: x.from_id, to: x.to_id, direction: x.direction, at: x.at, shape: x.shape })),
            // The span is the walk's own order — first dated step to last — which is
            // chronological because the walk enforced it. Not min/max: a loop is a path,
            // and its ends are where it started and finished, not its extremes.
            span: [dates[0], dates[dates.length - 1]],
            datedSteps: dated,
          });
        }
        continue;
      }
      walk(start, r.to_id, next, rY !== null ? rY : lastAt);
    }
  };
  for (const s of starts) walk(s, s, [], null);
  const all = [...out.values()];
  if (!entityId) return all;
  return all.filter((l) => l.steps.some((st) => st.from === entityId || st.to === entityId));
}

// ─── The gap audit ───────────────────────────────────────────────────────────
// Which anatomies have been asserted at which rungs, and which cells are empty. Deferred
// once as its own feature and correctly so: it needs nothing built, it is a GROUP BY over
// the relations that now exist. An empty cell is the useful output — the rung where a shape
// is certain to be operating and nobody has looked.
export function shapeByRungAudit(db) {
  const rows = db.prepare(`
    SELECT r.shape AS shape, e.scale AS scale, COUNT(*) AS n
    FROM entity_relations r
    JOIN entities e ON e.id = r.from_id
    WHERE r.deleted_at IS NULL AND r.shape IS NOT NULL
    GROUP BY r.shape, e.scale
  `).all();
  const shapes = [...new Set(rows.map((r) => r.shape))].sort();
  const counts = new Map(rows.map((r) => [`${r.shape}|${r.scale}`, r.n]));
  return {
    rungs: SCALE_LADDER.map((r) => r.key),
    shapes: shapes.map((shape) => ({
      shape,
      cells: SCALE_LADDER.map((rung) => {
        // A rung's count sums every stored scale value that maps onto it, so the legacy
        // 'national' rows land under 'nation' with no data migration.
        let n = 0;
        for (const [k, v] of counts) {
          const [s, scale] = k.split('|');
          if (s === shape && rungOf(scale) === rungOf(rung.key)) n += v;
        }
        return { rung: rung.key, n };
      }),
    })),
  };
}

// ─── Moments ─────────────────────────────────────────────────────────────────
// A relation's path back to the lines that produced it. The Narrative Mirror exists so
// that no structural claim closes without the scene it costs, and this is the only route
// from one to the other.
//
// It reads the verified turns the anatomy runs write to data-seed/interiors/. That matters
// more than it looks: every line returned here already passed a byte-for-byte check
// against the source file on disk, so the Mirror cannot be handed an invented quote even
// if everything upstream of it went wrong. Nothing in this project generates a moment.

const INTERIORS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../data-seed/interiors');

// "fam_maxson#355-479" → the turns in that block range, with speakers named.
export function resolveMoment(moment) {
  if (!moment) return null;
  const m = String(moment).match(/^([A-Za-z0-9_]+)#(\d+)-(\d+)$/);
  if (!m) return { error: 'unparseable_moment', moment };
  const [, entityId, fromS, toS] = m;
  const from = Number(fromS), to = Number(toS);
  const file = resolve(INTERIORS_DIR, entityId + '.graph.json');
  // The id is already constrained to word characters by the pattern above; this is the
  // second guard, because a path built from data should never rest on one check.
  if (!file.startsWith(INTERIORS_DIR) || !existsSync(file)) return { error: 'no_interior', entityId };
  let doc;
  try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch { return { error: 'unreadable_interior', entityId }; }
  if (!Array.isArray(doc.turns)) {
    return { error: 'interior_has_no_turns', entityId, hint: 'Re-run the anatomy script — it writes turns as of 2026-09-09.' };
  }
  let names = {};
  const nf = resolve(INTERIORS_DIR, entityId + '.names.json');
  if (nf.startsWith(INTERIORS_DIR) && existsSync(nf)) {
    try { names = JSON.parse(readFileSync(nf, 'utf8')); } catch { names = {}; }
  }
  const turns = doc.turns
    .filter((t) => t.block >= from && t.block <= to)
    .map((t) => ({ block: t.block, speaker: names[t.speaker] || t.speaker, stance: t.stance || null, quote: t.quote }));
  return { entityId, source: doc.source, scope: doc.scope, from, to, turns };
}

// One entity's mapped interior, or null. Most entities have none and that is the normal
// case — an anatomy costs a careful read of a real scene, and two exist.
export function anatomyFor(entityId) {
  if (!/^[A-Za-z0-9_]+$/.test(String(entityId || ''))) return null;
  const file = resolve(INTERIORS_DIR, entityId + '.graph.json');
  if (!file.startsWith(INTERIORS_DIR) || !existsSync(file)) return null;
  try {
    const d = JSON.parse(readFileSync(file, 'utf8'));
    const b = d.structuralBalance || {};
    // The graph names its parts by the code the attribution used — 't', 'r', 'l'. The
    // names file beside it says who those are, and until now only the scene reader
    // looked at it, so nothing could draw an interior with people in it.
    let names = {};
    const nf = resolve(INTERIORS_DIR, entityId + '.names.json');
    if (nf.startsWith(INTERIORS_DIR) && existsSync(nf)) {
      try { names = JSON.parse(readFileSync(nf, 'utf8')); } catch { names = {}; }
    }
    return {
      scope: d.scope,
      source: d.source,
      nodes: d.graph?.nodes || [],
      edges: d.graph?.edges || [],
      names,
      balanced: b.balanced,
      frustration: b.frustration,
      camps: b.bestSplit,
    };
  } catch { return null; }
}

// ─── Saved maps ──────────────────────────────────────────────────────────────
// A walk somebody kept, so a reading can be returned to instead of re-derived. The stored
// path is entity ids in visit order and nothing else — no names, no rendered text — so a
// map reopened next month shows what those entities say then, not what they said when it
// was saved. That is the difference between a map and a screenshot.

export function listSavedMaps(db) {
  return db.prepare(`
    SELECT id, title, root_id, path_json, created_at, updated_at
    FROM saved_maps WHERE deleted_at IS NULL ORDER BY updated_at DESC
  `).all().map((m) => ({ ...m, path: JSON.parse(m.path_json || '[]'), path_json: undefined }));
}

export function saveMap(db, { id, title, path }) {
  const steps = (path || []).filter(Boolean);
  if (!title || !title.trim()) { const e = new Error('A map needs a title to be found again.'); e.status = 400; throw e; }
  if (steps.length < 2) { const e = new Error('A map of one entity is not a walk.'); e.status = 400; throw e; }
  const payload = JSON.stringify(steps);
  if (id) {
    const r = db.prepare(`
      UPDATE saved_maps SET title=?, root_id=?, path_json=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=? AND deleted_at IS NULL
    `).run(title.trim(), steps[0], payload, id);
    if (!r.changes) { const e = new Error('No such map.'); e.status = 404; throw e; }
    return getSavedMap(db, id);
  }
  const newId = randomUUID();
  db.prepare(`INSERT INTO saved_maps (id, title, root_id, path_json) VALUES (?,?,?,?)`)
    .run(newId, title.trim(), steps[0], payload);
  return getSavedMap(db, newId);
}

export function getSavedMap(db, id) {
  const m = db.prepare(`SELECT * FROM saved_maps WHERE id=? AND deleted_at IS NULL`).get(id);
  return m ? { ...m, path: JSON.parse(m.path_json || '[]'), path_json: undefined } : null;
}

export function deleteSavedMap(db, id) {
  return db.prepare(`UPDATE saved_maps SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND deleted_at IS NULL`)
    .run(id).changes > 0;
}
