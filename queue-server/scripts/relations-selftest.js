// npm run relations:selftest — the rules in services/entityRelations.js, proved.
// Throwaway in-memory database, no network, no model, no credits.
//
// Four rules are being defended here, and each one fails silently if it breaks:
//   1. a vertical relation may not skip a rung (else it is a jump with a false label)
//   2. a horizontal relation is same-rung
//   3. a medium (a film) sits on no rung and cannot be either end of vertical/horizontal
//   4. every relation carries a source and a falsifier
// Plus: a loop is a query and not a row, and time may not run backwards inside one.

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  validateRelation, createRelation, relationsFor, deleteRelation, findLoops, shapeByRungAudit, yearOf,
} from '../server/src/services/entityRelations.js';

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE entities (id TEXT PRIMARY KEY, name TEXT, type TEXT, scale TEXT)`);
db.exec(`CREATE TABLE entity_relations (
  id TEXT PRIMARY KEY, from_id TEXT, to_id TEXT, move TEXT, shape TEXT, direction TEXT,
  at TEXT, note TEXT, source_kind TEXT DEFAULT 'witness', source_ref TEXT, falsifier TEXT,
  created_by TEXT, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), deleted_at TEXT)`);

const add = (id, type, scale) => db.prepare(`INSERT INTO entities (id,name,type,scale) VALUES (?,?,?,?)`).run(id, id, type, scale);
add('person', 'character', 'individual');
add('fam', 'family', 'family');
add('crew', 'group', 'group');
add('dept', 'institution', 'institution');
add('town', 'city', 'city');
add('usa', 'country', 'national');   // the LEGACY stored value, on purpose
add('movie', 'film', 'film');        // a medium — no rung

const P = { source_ref: 'a test', falsifier: 'a counter-observation' };
const ok = (o) => validateRelation(db, o);

// ── rule 4: provenance is required, and required first ──────────────────────
assert.match(ok({ from_id: 'fam', to_id: 'crew', move: 'vertical' }), /source_ref is required/);
assert.match(ok({ from_id: 'fam', to_id: 'crew', move: 'vertical', source_ref: 'x' }), /falsifier is required/);
// and it is checked even for a relation that would also fail on rungs, so the author is
// never told about a rung problem while a missing falsifier is still waiting behind it
assert.match(ok({ from_id: 'person', to_id: 'usa', move: 'vertical' }), /source_ref is required/);

// ── rule 1: vertical crosses exactly one rung ───────────────────────────────
assert.equal(ok({ from_id: 'fam', to_id: 'crew', move: 'vertical', ...P }), null, 'family → group is one rung');
assert.equal(ok({ from_id: 'dept', to_id: 'crew', move: 'vertical', ...P }), null, 'and it works downward too');
const skip = ok({ from_id: 'usa', to_id: 'fam', move: 'vertical', ...P });
assert.match(skip, /may not skip a rung/);
assert.match(skip, /4 apart/);
assert.match(skip, /group, institution, city/, 'the message names the rungs that were skipped');
assert.match(ok({ from_id: 'fam', to_id: 'fam', move: 'vertical', ...P }), /says nothing/, 'self-relation refused before anything else');
const sameRung = ok({ from_id: 'town', to_id: 'town', move: 'vertical', ...P });
assert.match(sameRung, /says nothing/);

// two distinct entities on the same rung, asked to be vertical
add('town2', 'city', 'city');
assert.match(ok({ from_id: 'town', to_id: 'town2', move: 'vertical', ...P }), /same one.*horizontal/s);

// The rule caught a wrong assumption the first time this test ran: institution → family
// is TWO rungs, because `group` sits between them. Keeping that as an assertion so the
// ladder's actual order stays load-bearing rather than remembered.
assert.match(ok({ from_id: 'dept', to_id: 'fam', move: 'vertical', ...P }), /2 apart, skipping group/);

// ── rule 2: horizontal is same-rung ─────────────────────────────────────────
assert.equal(ok({ from_id: 'town', to_id: 'town2', move: 'horizontal', ...P }), null);
assert.match(ok({ from_id: 'town', to_id: 'usa', move: 'horizontal', ...P }), /1 rungs apart/);

// ── rule 3: a medium has no rung ────────────────────────────────────────────
const medium = ok({ from_id: 'movie', to_id: 'person', move: 'vertical', ...P });
assert.match(medium, /sits on no rung/);
assert.match(medium, /movie/, 'and it names WHICH end is the problem');
assert.match(ok({ from_id: 'person', to_id: 'movie', move: 'horizontal', ...P }), /movie/);
assert.equal(ok({ from_id: 'movie', to_id: 'person', move: 'jump', ...P }), null,
  'but a jump asserts no path, so a medium may be one end of one');

// ── legacy scale values resolve without migration ───────────────────────────
assert.equal(ok({ from_id: 'usa', to_id: 'town', move: 'vertical', ...P }), null,
  "the stored value 'national' maps onto the nation rung");

// ── direction is derived, never accepted from the caller ────────────────────
const down = createRelation(db, { from_id: 'dept', to_id: 'crew', move: 'vertical', shape: 's1', at: '1957', direction: 'up', ...P });
assert.equal(down.direction, 'down', 'institution → group descends, whatever the caller passed');
const up = createRelation(db, { from_id: 'crew', to_id: 'dept', move: 'vertical', shape: 's1', at: '1965', ...P });
assert.equal(up.direction, 'up');
assert.equal(createRelation(db, { from_id: 'town', to_id: 'town2', move: 'horizontal', ...P }).direction, null,
  'only a vertical relation has a direction');

// ── reading them back ───────────────────────────────────────────────────────
const forCrew = relationsFor(db, 'crew');
assert.equal(forCrew.length, 2);
assert.deepEqual(forCrew.map((r) => r.role).sort(), ['from', 'to'], 'both ends are found, and each says which end it is');
assert.ok(forCrew.every((r) => r.from_name && r.to_name), 'the other end arrives named');

// ── a loop is a query ───────────────────────────────────────────────────────
// dept →(1957) crew →(1965) dept: leaves the institution rung and returns, time forward.
const loops = findLoops(db);
// Reported ONCE, not once per rotation: the same two relations traversed from `crew`
// instead of `dept` are the same loop, and a reader should not be shown it twice.
assert.equal(loops.length, 1, 'one loop is one loop, whichever end you start from');
const l = loops[0];
assert.equal(l.entity, 'dept');
assert.equal(l.steps.length, 2);
assert.equal(l.datedSteps, 2);
assert.deepEqual(l.span, ['1957', '1965']);

// Time may not run backwards INSIDE a chain. Worth being precise about what that does and
// does not rule out, because the first version of this test got it wrong: a two-step cycle
// is always reportable, since one of its two entry points is the earlier date. The loop is
// real; it is just described starting from 1957.
db.exec(`DELETE FROM entity_relations`);
createRelation(db, { from_id: 'dept', to_id: 'crew', move: 'vertical', at: '1990', ...P });
createRelation(db, { from_id: 'crew', to_id: 'dept', move: 'vertical', at: '1957', ...P });
const twoStep = findLoops(db);
assert.equal(twoStep.length, 1, 'a two-step cycle is entered at its earlier date, not rejected');
assert.equal(twoStep[0].entity, 'crew');
assert.deepEqual(twoStep[0].span, ['1957', '1990'], 'and it is reported in the order it happened');

// What the rule actually does is PRUNE LONGER CHAINS, and it is worth being exact rather
// than claiming more. Because a vertical relation may only cross one rung, every cycle
// must come back the way it went, so every cycle contains a two-step sub-cycle — and a
// two-step cycle is always reportable from its earlier end. The monotonicity rule can
// therefore never reject a cycle outright; what it stops is a longer walk being reported
// as one causal circuit when its dates do not run round it.
//
// Below: the 4-step walk town→dept→crew→dept→town has dates 1970, 1990, 1980, 1975 and is
// not chronological, while the 2-step town→dept→town (1970, 1975) is. Only the second is
// reported, and the difference is the rule doing its job.
db.exec(`DELETE FROM entity_relations`);
createRelation(db, { from_id: 'town', to_id: 'dept', move: 'vertical', at: '1970', ...P });
createRelation(db, { from_id: 'dept', to_id: 'crew', move: 'vertical', at: '1990', ...P });
createRelation(db, { from_id: 'crew', to_id: 'dept', move: 'vertical', at: '1980', ...P });
createRelation(db, { from_id: 'dept', to_id: 'town', move: 'vertical', at: '1975', ...P });
const pruned = findLoops(db, { entityId: 'town' });
assert.equal(pruned.length, 1, 'the out-of-order 4-step walk is not reported');
assert.equal(pruned[0].steps.length, 2, 'only the chronological 2-step circuit survives');
assert.deepEqual(pruned[0].span, ['1970', '1975']);

// an undated chain is not a loop either
db.exec(`DELETE FROM entity_relations`);
createRelation(db, { from_id: 'dept', to_id: 'crew', move: 'vertical', ...P });
createRelation(db, { from_id: 'crew', to_id: 'dept', move: 'vertical', ...P });
assert.equal(findLoops(db).length, 0, '"the wound came back" needs at least two dates in it');

// a three-rung loop, the shape the civic reading is actually about
db.exec(`DELETE FROM entity_relations`);
createRelation(db, { from_id: 'town', to_id: 'dept', move: 'vertical', at: '1954', ...P });
createRelation(db, { from_id: 'dept', to_id: 'crew', move: 'vertical', at: '1957', ...P });
createRelation(db, { from_id: 'crew', to_id: 'dept', move: 'vertical', at: '1962', ...P });
createRelation(db, { from_id: 'dept', to_id: 'town', move: 'vertical', at: '1965', ...P });
// Both circuits through this data are real and both are reported: the long one
// city→institution→group→institution→city, and the short one city→institution→city
// nested inside it. They are different claims — how far down the wound travelled before
// it came back — and collapsing them to one would throw away the difference.
const big = findLoops(db, { entityId: 'town' });
assert.equal(big.length, 2);
assert.deepEqual(big.map((x) => x.steps.length).sort(), [2, 4]);
const four = big.find((x) => x.steps.length === 4);
assert.deepEqual(four.steps.map((x) => x.to), ['dept', 'crew', 'dept', 'town']);
assert.deepEqual(four.span, ['1954', '1965']);

// `entityId` means PARTICIPATES IN, not STARTS AT. An entity caught in a circuit is in it
// whether or not the walk happened to be keyed at that entity — filtering the starts
// instead of the results would hide an entity's own loop from it.
db.exec(`DELETE FROM entity_relations`);
createRelation(db, { from_id: 'crew', to_id: 'fam', move: 'vertical', at: '1950', ...P });
createRelation(db, { from_id: 'fam', to_id: 'crew', move: 'vertical', at: '1965', ...P });
assert.equal(findLoops(db).length, 1, 'one loop exists');
assert.equal(findLoops(db)[0].entity, 'crew', 'and it happens to be keyed at the crew');
assert.equal(findLoops(db, { entityId: 'fam' }).length, 1, 'the family is in it too, and must be told so');
assert.equal(findLoops(db, { entityId: 'dept' }).length, 0, 'an entity outside the circuit is not');

// ── the gap audit: the empty cells are the point ────────────────────────────
db.exec(`DELETE FROM entity_relations`);
createRelation(db, { from_id: 'dept', to_id: 'crew', move: 'vertical', shape: 'exile', at: '1957', ...P });
createRelation(db, { from_id: 'usa', to_id: 'town', move: 'vertical', shape: 'exile', at: '1934', ...P });
const audit = shapeByRungAudit(db);
assert.equal(audit.shapes.length, 1);
const cells = Object.fromEntries(audit.shapes[0].cells.map((c) => [c.rung, c.n]));
assert.equal(cells.institution, 1);
assert.equal(cells.nation, 1, "the legacy 'national' row lands under the nation rung");
assert.equal(cells.family, 0, 'and the rungs nobody has looked at report zero rather than vanishing');
assert.equal(audit.shapes[0].cells.length, audit.rungs.length, 'every rung gets a cell, empty or not');

// ── delete is soft ──────────────────────────────────────────────────────────
const doomed = createRelation(db, { from_id: 'town', to_id: 'town2', move: 'horizontal', ...P });
assert.equal(deleteRelation(db, doomed.id), true);
assert.equal(deleteRelation(db, doomed.id), false, 'deleting twice is not an error, it is a no-op');
assert.ok(!relationsFor(db, 'town').some((r) => r.id === doomed.id));

// ── dates are compared by year, not as strings ──────────────────────────────
// This caught a live bug: sources write dates the way the source writes them, and
// "c.1950" sorts AFTER "1965" as a string because 'c' is above '1'. A real loop was
// reported running backwards while every other check passed.
assert.equal(yearOf('c.1950'), 1950);
assert.equal(yearOf('1965'), 1965);
assert.ok(yearOf('c.1950') < yearOf('1965'), 'the whole point');
assert.ok('c.1950' > '1965', 'and as strings it is the other way round, which is the trap');
assert.equal(yearOf(null), null);
assert.equal(yearOf('sometime'), null, 'a date with no year is unknown, not year zero');

db.exec(`DELETE FROM entity_relations`);
createRelation(db, { from_id: 'crew', to_id: 'fam', move: 'vertical', at: 'c.1950', ...P });
createRelation(db, { from_id: 'fam', to_id: 'crew', move: 'vertical', at: '1965', ...P });
const circa = findLoops(db);
assert.equal(circa.length, 1);
assert.deepEqual(circa[0].span, ['c.1950', '1965'], 'reported in the order it happened, in the words the source used');

console.log('entity relations selftest: OK (rung rules, provenance, derived direction, loops-as-query, gap audit, soft delete, date normalisation)');
