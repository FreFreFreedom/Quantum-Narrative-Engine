// The split screen — plans/anatomy-replaces-tags.md, Part 4; fractal_operational_core.md §21.
//
// Two scenes from two different works, side by side, with a written reading of what they
// share underneath. The conversation's own example: Bobby McCray's "Just sign what they want,
// son" against Troy Maxson's "Who the hell says I got to like you?" — two fathers, two
// interrogations of a kind, no vocabulary in common. That exact pair is not buildable yet:
// there is no verified scene source for "When They See Us" on disk, only Dogville and Fences.
// What is built here is the identical mechanism, on the two scenes the corpus can actually
// prove — a hallucinated split screen is worse than no split screen, for the same reason a
// hallucinated interior is (§14c): everything downstream inherits the fiction.
//
// Each side of a pair is a MOMENT, in the exact format entityRelations.js#resolveMoment
// already parses. Resolving it is how the byte-for-byte verified turns behind the reading
// are checked, on every read — not just once at creation.
//
// Same discipline as entity_relations and entity_signature: no source, no falsifier, no row.

import { randomUUID } from 'node:crypto';
import { resolveMoment } from './entityRelations.js';

export const SOURCE_KINDS = ['self', 'witness'];

// Returns null when the pair may be written, or a sentence saying why not.
export function validateScenePair(db, { moment_a, moment_b, reading, source_ref, falsifier, source_kind }) {
  if (!moment_a || !moment_b) return 'moment_a and moment_b are both required.';
  if (moment_a === moment_b) return 'A split screen needs two different scenes; this names the same one twice.';
  const a = resolveMoment(moment_a);
  if (!a || a.error) return `moment_a does not resolve to a verified scene: ${a?.error || 'unparseable'}.`;
  const b = resolveMoment(moment_b);
  if (!b || b.error) return `moment_b does not resolve to a verified scene: ${b?.error || 'unparseable'}.`;
  if (!reading || !reading.trim()) return 'reading is required — what the two scenes share.';
  if (source_kind && !SOURCE_KINDS.includes(source_kind)) return `source_kind must be self or witness.`;
  if (!source_ref) return 'source_ref is required.';
  if (!falsifier) return 'falsifier is required — what would show these two scenes do not share this.';
  return null;
}

export function createScenePair(db, input) {
  const problem = validateScenePair(db, input);
  if (problem) { const e = new Error(problem); e.status = 400; throw e; }
  const { moment_a, moment_b, reading, source_kind = 'witness', source_ref, falsifier, created_by = 'antoine' } = input;
  const id = randomUUID();
  db.prepare(`
    INSERT INTO scene_pairs (id, moment_a, moment_b, reading, source_kind, source_ref, falsifier, created_by)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(id, moment_a, moment_b, reading, source_kind, source_ref, falsifier, created_by);
  return getScenePair(db, id);
}

// The moments are resolved fresh on every read, never cached in the row — the verified
// quotes live in data-seed/interiors/, and this table only ever points at them.
export function getScenePair(db, id) {
  const row = db.prepare(`SELECT * FROM scene_pairs WHERE id=? AND deleted_at IS NULL`).get(id);
  if (!row) return null;
  return { ...row, a: resolveMoment(row.moment_a), b: resolveMoment(row.moment_b) };
}

export function listScenePairs(db) {
  return db.prepare(`SELECT * FROM scene_pairs WHERE deleted_at IS NULL ORDER BY created_at`).all();
}

export function deleteScenePair(db, id) {
  const r = db.prepare(`UPDATE scene_pairs SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND deleted_at IS NULL`).run(id);
  return r.changes > 0;
}
