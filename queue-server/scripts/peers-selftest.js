// npm run peers:selftest — the horizontal move's rules, proved.
// Throwaway in-memory database, no network, no model, no credits.
//
// Five things here fail silently if they break, which is why each gets an assertion rather
// than a glance:
//   1. a film has no peers, and says why — comparing two mediums as though they were
//      entities is the error the scale ladder exists to prevent
//   2. peers are found by RUNG, not by type, so the legacy stored value `national` and a
//      `nation`-scaled row are peers of each other
//   3. an entity sharing no scored axis still comes back as a peer, with an empty `axes`,
//      instead of vanishing from a list that claims to show who else is on the rung
//   4. `difference` is a real set difference — things the peer has and this one does not —
//      never a re-listing of everything the peer has
//   5. the result is capped, because the individual rung holds 237 entities and this is
//      re-sent with every following round of a conversation

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { peersOf, PEER_CAP } from '../server/src/services/peers.js';

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE entities (id TEXT PRIMARY KEY, name TEXT, type TEXT, scale TEXT, meta TEXT)`);
db.exec(`CREATE TABLE entity_tags (entity_id TEXT, tag TEXT)`);
db.exec(`CREATE TABLE entity_continuum (entity_id TEXT, axis_key TEXT, value REAL)`);
db.exec(`CREATE TABLE continuum_axes (key TEXT PRIMARY KEY, name TEXT, low TEXT, high TEXT)`);
db.exec(`CREATE TABLE entity_relations (id TEXT PRIMARY KEY, from_id TEXT, to_id TEXT, move TEXT,
  shape TEXT, direction TEXT, at TEXT, note TEXT, moment TEXT, source_kind TEXT, source_ref TEXT,
  falsifier TEXT, created_by TEXT, created_at TEXT, deleted_at TEXT)`);
db.exec(`CREATE TABLE entity_mentions (id TEXT PRIMARY KEY, entity_id TEXT, source_type TEXT,
  source_id TEXT, matched TEXT, quote TEXT, tier TEXT, status TEXT, hits INTEGER, created_at TEXT)`);

db.prepare(`INSERT INTO continuum_axes VALUES ('guilt','Guilt-as-Engine','Self-Destruction','Integrated Accountability')`).run();
db.prepare(`INSERT INTO continuum_axes VALUES ('poss','Possession','Control','Sovereignty')`).run();

const ent = (id, type, scale, name, postures = []) =>
  db.prepare(`INSERT INTO entities VALUES (?,?,?,?,?)`).run(id, name || id, type, scale, JSON.stringify({ postures }));
const score = (id, k, v) => db.prepare(`INSERT INTO entity_continuum VALUES (?,?,?)`).run(id, k, v);
const tag = (id, t) => db.prepare(`INSERT INTO entity_tags VALUES (?,?)`).run(id, t);
const relate = (id, from, to, move, shape, dir) =>
  db.prepare(`INSERT INTO entity_relations (id,from_id,to_id,move,shape,direction,source_ref,falsifier) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, from, to, move, shape, dir, 's', 'f');

ent('cops', 'institution', 'institution', 'The department', [{ name: 'Sweep the corner', since: '1996' }]);
ent('school', 'institution', 'institution', 'The alternative school');
ent('office', 'institution', 'institution', 'The welfare office', [{ name: 'Means-test the household', since: '1987' }]);
ent('unscored', 'institution', 'institution', 'A department nobody has scored');
ent('usa', 'country', 'national', 'United States');     // LEGACY stored value
ent('france', 'country', 'nation', 'France');           // rung-naming value
ent('movie', 'film', 'film', 'A film');
ent('other_movie', 'film', 'film', 'Another film');
ent('kid', 'character', 'individual', 'A person');

score('cops', 'guilt', 0.18); score('school', 'guilt', 0.86); score('office', 'guilt', 0.34);
score('usa', 'guilt', 0.4); score('france', 'guilt', 0.6);
score('cops', 'poss', 0.2); score('school', 'poss', 0.5);
tag('cops', 'quota-as-truth'); tag('cops', 'institutional-rot');
tag('school', 'containment-over-extermination'); tag('school', 'institutional-rot');
tag('office', 'institutional-rot');
relate('r1', 'cops', 'kid', 'vertical', 'sh_prey', 'down');
relate('r2', 'office', 'kid', 'vertical', 'sh_prey', 'down');
relate('r3', 'school', 'kid', 'vertical', 'sh_buffer', 'down');

// ── 1. a medium has no peers, and says why ──────────────────────────────────
const film = peersOf(db, 'movie');
assert.equal(film.rung, null);
assert.deepEqual(film.alongside, []);
assert.deepEqual(film.furtherAlong, []);
assert.match(film.reason, /medium/, 'and it explains itself rather than returning a bare empty');
assert.match(film.reason, /scale ladder/, 'and it names why, not just that');
assert.ok(!JSON.stringify(film).includes('Another film'), 'two films are never compared to each other');

// ── 2. peers are found by rung, not by type ─────────────────────────────────
const us = peersOf(db, 'usa');
assert.equal(us.rung, 'Nation');
assert.equal(us.peerCount, 1, "the legacy 'national' value and a 'nation' row are on one rung");
assert.equal(us.furtherAlong[0].name, 'France');
assert.equal(us.furtherAlong[0].axes[0].delta, 0.2);

// ── 3. an unscored peer is still a peer ─────────────────────────────────────
const cops = peersOf(db, 'cops');
assert.equal(cops.peerCount, 3, 'every institution on the rung is counted, scored or not');
const unscored = cops.alongside.find((p) => p.id === 'unscored');
assert.ok(!unscored || unscored.axes.length === 0, 'an unscored peer carries an empty axes list, not a fabricated one');
assert.ok(!cops.furtherAlong.some((p) => p.id === 'unscored'), 'but it cannot be "further along" on nothing');

// ── the ordering the whole feature exists for ───────────────────────────────
assert.equal(cops.furtherAlong[0].id, 'school', 'the biggest gap comes first');
assert.equal(cops.furtherAlong[0].axes.find((a) => a.key === 'guilt').delta, 0.68);
assert.equal(cops.furtherAlong[0].axes.find((a) => a.key === 'guilt').direction, 'further');
assert.equal(cops.alongside[0].id, 'office', 'and "who else is here" is a different order: the shared shape wins');
assert.deepEqual(cops.alongside[0].sharedShapes, ['sh_prey']);

// every axis says a person assigned it
for (const p of cops.furtherAlong) for (const a of p.axes) assert.equal(a.source, 'assigned');

// ── 4. difference is a set difference, not a re-listing ─────────────────────
const d = cops.difference;
assert.equal(d.peer, 'The alternative school');
assert.deepEqual(d.taggedThingsYouAreNot, ['containment-over-extermination'],
  'institutional-rot is shared, so it must NOT appear — that is what makes this a difference');
assert.deepEqual(d.carriesShapesYouDoNot, ['sh_buffer']);
assert.ok(!d.carriesShapesYouDoNot.includes('sh_prey'), 'a shape both carry is not a difference');
assert.match(d.onAxis[0], /0\.18 → 0\.86/);
assert.match(d.onAxis[0], /Integrated Accountability/, 'the axis pole is named, so "better" means something specific');
assert.match(d.caveat, /not a measurement/, 'and the reading never travels without saying what it is');

// a peer holding a posture this one also holds is not a difference either
ent('twin', 'institution', 'institution', 'A twin department', [{ name: 'Sweep the corner', since: '1996' }]);
score('twin', 'guilt', 0.9);
assert.ok(!peersOf(db, 'cops').difference.holdsPosturesYouDoNot.includes('Sweep the corner'));

// ── 5. capped ───────────────────────────────────────────────────────────────
for (let i = 0; i < PEER_CAP + 10; i++) {
  ent('bulk' + i, 'institution', 'institution', 'Bulk ' + i);
  score('bulk' + i, 'guilt', 0.9);
  tag('bulk' + i, 'institutional-rot');
}
const big = peersOf(db, 'cops');
assert.ok(big.peerCount > PEER_CAP, 'more peers exist than the cap');
assert.equal(big.furtherAlong.length, PEER_CAP, 'and the list is cut to it');
assert.equal(big.alongside.length, PEER_CAP);
assert.equal(peersOf(db, 'cops', { limit: 3 }).furtherAlong.length, 3, 'the caller may ask for fewer');

// ── an entity that does not exist ───────────────────────────────────────────
assert.equal(peersOf(db, 'nope'), null);

console.log(`peers selftest: OK (mediums excluded with a reason, rung not type, unscored peers kept, difference is a real set difference, capped at ${PEER_CAP})`);
