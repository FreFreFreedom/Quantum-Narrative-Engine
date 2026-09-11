// The four readings that replace a tag — fractal_operational_core.md §21,
// plans/anatomy-replaces-tags.md.
//
// A tag is a membership claim, and the only question askable of it is present or absent.
// Each of these four readings is a question whose answer POINTS AT A PART of the entity —
// which entity, which interior part, which moment — and that is what lets them compose
// where a tag cannot: "share a locus of exile with" is a real relation between two
// pointers; "share a tag with" is a coincidence of spelling.
//
//   locus_of_exile        — which part is pushed outside the perimeter so the rest looks orderly
//   load_shift             — when this entity decides, where the real work of enduring it lands
//   sovereignty_reversal   — the point where the thing built to protect becomes the threat
//   loop_dynamics          — how the output of the lowest scale re-enters as the input of the highest
//
// SAME PROVENANCE RULE AS entity_relations, on purpose, and enforced the same way: a
// reading without a source and a falsifier is an assertion wearing a finding's clothes.
// §11 already paid for this lesson once (a fabricated pattern survived until it was caught
// by hand); this module does not reopen that door.
//
// points_at is an entity id or an interior part CODE — the opaque letter a signed-graph run
// gives a speaker (data-seed/interiors/*.graph.json) — and never a name. That is §18's rule
// (naming must never feed the matcher) enforced the same structural way the two-file
// interior format enforces it: nothing here can read a .names.json file, so a name cannot
// leak in even by accident.
//
// The four readings are not required together. Most entities will answer two of the four
// and leave two blank, and a blank reading is a true fact about the corpus, not a defect —
// the caller renders it as a finding ("nobody has looked") rather than an apology.

import { randomUUID } from 'node:crypto';
import { SCALE_LADDER } from './scaleLadder.js';

export const READINGS = ['locus_of_exile', 'load_shift', 'sovereignty_reversal', 'loop_dynamics'];
export const SOURCE_KINDS = ['self', 'witness'];

function entityExists(db, id) {
  return !!db.prepare(`SELECT 1 FROM entities WHERE id=?`).get(id);
}

// Returns null when the reading is allowed to be written, or a sentence saying why not.
// Exported so a caller (a route, a script, a selftest) gets the same answer the writer would.
export function validateAnatomy(db, { entity_id, reading, answer, points_at, source_ref, falsifier, source_kind }) {
  if (!entity_id) return 'entity_id is required.';
  if (!entityExists(db, entity_id)) return `No entity ${entity_id}.`;
  if (!READINGS.includes(reading)) return `reading must be one of ${READINGS.join(', ')}.`;
  if (!answer || !answer.trim()) return 'answer is required — a blank reading is recorded by leaving the row absent, not by writing an empty one.';
  if (source_kind && !SOURCE_KINDS.includes(source_kind)) return `source_kind must be self or witness.`;
  // Provenance first, same order entityRelations.js uses: an unsourced claim is refused
  // before its content is even worth reading.
  if (!source_ref) return 'source_ref is required — which testimony this reading was read from.';
  if (!falsifier) return 'falsifier is required — what observation would break this reading.';
  // An entity id or an interior part code is always short and has no spaces. Anything
  // longer than that, that is not itself a known entity, is almost certainly a name that
  // should have gone through .names.json instead — refuse it rather than silently store it.
  if (points_at && points_at.length > 40 && !entityExists(db, points_at)) {
    return `points_at looks like a name, not an entity id or a part code: "${points_at}".`;
  }
  return null;
}

export function setAnatomy(db, input) {
  const problem = validateAnatomy(db, input);
  if (problem) { const e = new Error(problem); e.status = 400; throw e; }
  const { entity_id, reading, answer, points_at = null, source_kind = 'witness', source_ref, falsifier, created_by = 'antoine' } = input;
  db.prepare(`
    INSERT INTO entity_anatomy (entity_id, reading, answer, points_at, source_kind, source_ref, falsifier, created_by)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(entity_id, reading) DO UPDATE SET
      answer=excluded.answer, points_at=excluded.points_at, source_kind=excluded.source_kind,
      source_ref=excluded.source_ref, falsifier=excluded.falsifier, created_by=excluded.created_by,
      created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).run(entity_id, reading, answer, points_at, source_kind, source_ref, falsifier, created_by);
  return anatomyFor(db, entity_id);
}

export function deleteAnatomy(db, entity_id, reading) {
  const r = db.prepare(`DELETE FROM entity_anatomy WHERE entity_id=? AND reading=?`).run(entity_id, reading);
  return r.changes > 0;
}

// All readings for one entity, keyed by reading name, with the two blanks left absent
// rather than filled with a placeholder — the caller decides how a blank should read.
export function anatomyFor(db, entity_id) {
  const rows = db.prepare(`SELECT reading, answer, points_at, source_kind, source_ref, falsifier, created_at
    FROM entity_anatomy WHERE entity_id=?`).all(entity_id);
  const byReading = {};
  for (const r of rows) byReading[r.reading] = r;
  return {
    entity_id,
    readings: byReading,
    have: rows.map((r) => r.reading),
    missing: READINGS.filter((r) => !byReading[r]),
  };
}

// The blind-spot report — fractal_operational_core.md §21, "you have mapped this loop 140
// times in urban justice and zero times in university faculties." A count over
// (reading × rung), so an empty cell reads as a place nobody has looked rather than a zero.
// Mirrors shapeByRungAudit() in entityRelations.js, same shape, different table.
export function anatomyByRungAudit(db) {
  const rungs = SCALE_LADDER.map((r) => r.key);
  const rows = db.prepare(`
    SELECT a.reading, e.scale, COUNT(*) n
    FROM entity_anatomy a JOIN entities e ON e.id = a.entity_id
    GROUP BY a.reading, e.scale
  `).all();
  const cells = {};
  for (const r of rows) cells[r.reading + '|' + r.scale] = r.n;
  return {
    rungs,
    readings: READINGS.map((reading) => ({
      reading,
      cells: rungs.map((rung) => ({ rung, n: cells[reading + '|' + rung] || 0 })),
    })),
  };
}
