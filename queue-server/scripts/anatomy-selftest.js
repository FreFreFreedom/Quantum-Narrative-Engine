// npm run anatomy:selftest — the rules in services/entityAnatomy.js, proved.
// Throwaway in-memory database, no network, no model, no credits.
//
// Two things are being defended:
//   1. same falsifiability discipline as entity_relations — no reading without a source
//      and a falsifier, whatever else it contains.
//   2. a missing reading is absent, not a placeholder — anatomyFor() must say which of
//      the four are there and which are not, so a blank stays a finding rather than a zero.

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  READINGS, validateAnatomy, setAnatomy, deleteAnatomy, anatomyFor, anatomyByRungAudit,
} from '../server/src/services/entityAnatomy.js';

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE entities (id TEXT PRIMARY KEY, name TEXT, type TEXT, scale TEXT)`);
db.exec(`CREATE TABLE entity_anatomy (
  entity_id TEXT NOT NULL, reading TEXT NOT NULL, answer TEXT NOT NULL, points_at TEXT,
  source_kind TEXT DEFAULT 'witness', source_ref TEXT NOT NULL, falsifier TEXT NOT NULL,
  created_by TEXT, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (entity_id, reading))`);

const add = (id, type, scale) => db.prepare(`INSERT INTO entities (id,name,type,scale) VALUES (?,?,?,?)`).run(id, id, type, scale);
add('fam', 'family', 'family');
add('crew', 'group', 'group');

let passed = 0;
const ok = (name) => { passed++; console.log(`  ✓ ${name}`); };

// ── validation, same order the message is checked in ────────────────────────
assert.match(validateAnatomy(db, { entity_id: 'nope', reading: 'locus_of_exile', answer: 'x', source_ref: 'a', falsifier: 'b' }), /No entity/);
ok('an unknown entity is refused');

assert.match(validateAnatomy(db, { entity_id: 'fam', reading: 'bogus', answer: 'x', source_ref: 'a', falsifier: 'b' }), /reading must be one of/);
ok('an unknown reading name is refused');

assert.match(validateAnatomy(db, { entity_id: 'fam', reading: 'locus_of_exile', answer: '  ', source_ref: 'a', falsifier: 'b' }), /answer is required/);
ok('a blank answer is refused rather than stored as an empty row');

assert.match(validateAnatomy(db, { entity_id: 'fam', reading: 'locus_of_exile', answer: 'x', falsifier: 'b' }), /source_ref is required/);
ok('a reading with no source is refused — the source check runs before the falsifier check');

assert.match(validateAnatomy(db, { entity_id: 'fam', reading: 'locus_of_exile', answer: 'x', source_ref: 'a' }), /falsifier is required/);
ok('a reading with no falsifier is refused');

assert.equal(validateAnatomy(db, { entity_id: 'fam', reading: 'locus_of_exile', answer: 'x', source_ref: 'a', falsifier: 'b' }), null);
ok('a properly sourced reading is allowed');

assert.match(
  validateAnatomy(db, { entity_id: 'fam', reading: 'locus_of_exile', answer: 'x', source_ref: 'a', falsifier: 'b',
    points_at: 'a person whose actual name leaked into this field by accident' }),
  /looks like a name/);
ok('a long points_at that is not a known entity id is refused as a leaked name');

assert.equal(
  validateAnatomy(db, { entity_id: 'fam', reading: 'locus_of_exile', answer: 'x', source_ref: 'a', falsifier: 'b', points_at: 'crew' }),
  null);
ok('a points_at that is a real entity id, or a short part code, is allowed');

// ── writing and reading back ─────────────────────────────────────────────────
setAnatomy(db, { entity_id: 'fam', reading: 'locus_of_exile', answer: 'the son sent away', points_at: 'crew',
  source_ref: 'the play', falsifier: 'a scene of unconditional welcome would break this' });
setAnatomy(db, { entity_id: 'fam', reading: 'load_shift', answer: 'lands on the household',
  source_ref: 'the recorded jump', falsifier: 'no trace at home would break this' });

let a = anatomyFor(db, 'fam');
assert.deepEqual(a.have.sort(), ['load_shift', 'locus_of_exile']);
assert.deepEqual(a.missing.sort(), ['loop_dynamics', 'sovereignty_reversal'].sort());
ok('two readings present, two absent — reported as absent, not as null-filled rows');

// a row for an entity with nothing recorded at all
assert.deepEqual(anatomyFor(db, 'crew').have, []);
assert.deepEqual(anatomyFor(db, 'crew').missing, READINGS);
ok('an entity with no anatomy at all reports all four as missing, not an error');

// re-writing the same reading updates it rather than duplicating the row
setAnatomy(db, { entity_id: 'fam', reading: 'locus_of_exile', answer: 'revised reading', points_at: 'crew',
  source_ref: 'the play, act two', falsifier: 'revised falsifier' });
a = anatomyFor(db, 'fam');
assert.equal(a.readings.locus_of_exile.answer, 'revised reading');
assert.equal(db.prepare(`SELECT count(*) n FROM entity_anatomy WHERE entity_id='fam' AND reading='locus_of_exile'`).get().n, 1);
ok('writing the same reading twice updates the one row rather than duplicating it');

// deleting one reading leaves the others untouched
assert.equal(deleteAnatomy(db, 'fam', 'load_shift'), true);
a = anatomyFor(db, 'fam');
assert.deepEqual(a.have, ['locus_of_exile']);
assert.equal(deleteAnatomy(db, 'fam', 'load_shift'), false);
ok('deleting a reading removes only that one, and deleting it again reports nothing to delete');

// ── the blind-spot audit ──────────────────────────────────────────────────────
const audit = anatomyByRungAudit(db);
const locus = audit.readings.find((r) => r.reading === 'locus_of_exile');
const famCell = locus.cells.find((c) => c.rung === 'family');
const groupCell = locus.cells.find((c) => c.rung === 'group');
assert.equal(famCell.n, 1);
assert.equal(groupCell.n, 0);
ok('the audit counts a filled rung and reports an untouched one as zero, not as absent');

console.log(`\n${passed} checks passed — entity anatomy holds.`);
