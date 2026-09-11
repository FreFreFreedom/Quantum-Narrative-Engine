// npm run bonesearch:selftest — search-by-bone's rules, proved.
// Throwaway in-memory database, no network, no model, no credits.
//
// Four things fail silently if they break:
//   1. THE ACCEPTANCE TEST ITSELF: two entities sharing no tag at all still match, on the
//      strength of a shared shape alone — this is the whole point of the mechanism, and a
//      regression that quietly started requiring tag overlap would be invisible without an
//      assertion that explicitly checks for zero shared tags on a real match.
//   2. an entity with no written relation returns a reason, not an empty list masquerading
//      as "nothing found" — the two are different facts.
//   3. ranking is by shared-shape count, and a bone-only match (no shared tags) outranks a
//      tied match that also happens to share a tag — the stronger evidence goes first.
//   4. the result is capped for display only; changing the cap changes how many are shown,
//      never which entities qualify.

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { boneSearch, BONE_CAP } from '../server/src/services/boneSearch.js';

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE entities (id TEXT PRIMARY KEY, name TEXT, type TEXT, scale TEXT)`);
db.exec(`CREATE TABLE entity_relations (
  id TEXT PRIMARY KEY, from_id TEXT, to_id TEXT, move TEXT, shape TEXT, direction TEXT,
  at TEXT, note TEXT, moment TEXT, source_kind TEXT DEFAULT 'witness', source_ref TEXT, falsifier TEXT,
  created_by TEXT, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), deleted_at TEXT)`);
db.exec(`CREATE TABLE entity_tags (entity_id TEXT, tag TEXT, PRIMARY KEY (entity_id, tag))`);

const add = (id, type, scale) => db.prepare(`INSERT INTO entities (id,name,type,scale) VALUES (?,?,?,?)`).run(id, id, type, scale);
const rel = (from_id, to_id, shape) => db.prepare(`
  INSERT INTO entity_relations (id, from_id, to_id, move, shape, source_ref, falsifier)
  VALUES (?,?,?,?,?,?,?)`).run(crypto.randomUUID(), from_id, to_id, 'jump', shape, 'test', 'test');
const tag = (id, t) => db.prepare(`INSERT INTO entity_tags VALUES (?,?)`).run(id, t);

// A household in one city, an institution in another — no domain in common, no rung in
// common (family vs institution), and crucially no tag in common either.
add('household', 'family', 'family');
add('police_dept', 'institution', 'institution');
add('untouched', 'family', 'family');       // has a relation but a different shape
add('lonely', 'institution', 'institution'); // has no relation at all
add('other_end_a', 'city', 'city');
add('other_end_b', 'city', 'city');
add('other_end_c', 'city', 'city');

rel('household', 'other_end_a', 'sh_boundary_miscut');
rel('police_dept', 'other_end_b', 'sh_boundary_miscut');
rel('untouched', 'other_end_c', 'sh_load_down');

tag('household', 'inherited-duty');
tag('household', 'father-hunger');
tag('police_dept', 'quota-as-truth');   // deliberately disjoint from household's tags

let passed = 0;
const ok = (name) => { passed++; console.log(`  ✓ ${name}`); };

// ── the acceptance test ──────────────────────────────────────────────────────
const found = boneSearch(db, 'household');
const match = found.matches.find((m) => m.id === 'police_dept');
assert.ok(match, 'police_dept must appear in household\'s bone search');
assert.deepEqual(match.sharedTags, []);
assert.equal(match.boneOnly, true);
assert.deepEqual(match.sharedShapes, ['sh_boundary_miscut']);
ok('two entities sharing no tag at all still match, on a shared shape alone');

// the entity with a DIFFERENT shape must not appear
assert.equal(found.matches.some((m) => m.id === 'untouched'), false);
ok('an entity whose only relation carries a different shape does not match');

// ── no relation, no shape to search on ────────────────────────────────────────
const nothing = boneSearch(db, 'lonely');
assert.equal(nothing.matches.length, 0);
assert.match(nothing.reason, /no written-down relation/);
ok('an entity with no written relation returns a reason, not a silent empty list');

// ── ranking: bone-only outranks a tied match that also shares a tag ───────────
add('wordy_match', 'institution', 'institution');
add('other_end_d', 'city', 'city');
rel('wordy_match', 'other_end_d', 'sh_boundary_miscut');
tag('wordy_match', 'inherited-duty');   // now shares a tag with household too
const ranked = boneSearch(db, 'household');
const order = ranked.matches.map((m) => m.id);
assert.ok(order.indexOf('police_dept') < order.indexOf('wordy_match'),
  'the bone-only match must rank above the tied match that also shares a tag');
ok('among equal shape counts, the bone-only match ranks first');

// ── the cap is a display limit, not a filter ──────────────────────────────────
for (let i = 0; i < BONE_CAP + 5; i++) {
  add('extra' + i, 'institution', 'institution');
  add('extra_end' + i, 'city', 'city');
  rel('extra' + i, 'extra_end' + i, 'sh_boundary_miscut');
}
const capped = boneSearch(db, 'household');
assert.ok(capped.matchCount > BONE_CAP, 'matchCount must report the true total, uncapped');
assert.equal(capped.matches.length, BONE_CAP, 'matches shown must respect the cap');
const wider = boneSearch(db, 'household', { limit: capped.matchCount });
assert.equal(wider.matches.length, capped.matchCount, 'raising limit shows more of the same set, not a different one');
ok('the limit changes how many matches are shown, never which entities qualify');

console.log(`\n${passed} checks passed — search by bone holds.`);
