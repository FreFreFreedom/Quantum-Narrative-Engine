// npm run tensions:selftest — tag tensions with no database file, no network, no
// model credit. The model is a stub that returns whatever the test hands it.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { setTension, generateTension, fillMissingTensions, listTensions,
  recover, repairTensions, mirrorTensions } from '../server/src/services/tagTensions.js';

let passed = 0;
const ok = (name) => { passed++; console.log(`  ✓ ${name}`); };

const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE entities (id TEXT PRIMARY KEY, name TEXT, meta TEXT);
  CREATE TABLE entity_tags (entity_id TEXT, tag TEXT, PRIMARY KEY (entity_id, tag));
  CREATE TABLE tag_tensions (tag TEXT PRIMARY KEY, against TEXT NOT NULL, why TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'model', created_at TEXT NOT NULL DEFAULT (datetime('now')));
  INSERT INTO entities VALUES ('e1','Ahab','{"note":"chases the whale"}'), ('e2','Ishmael',NULL);
  INSERT INTO entity_tags VALUES ('e1','obsession'), ('e1','sea'), ('e2','sea'), ('e2','witness');
`);
const gen = (reply) => async ({ prompt }) => { gen.lastPrompt = prompt; return { text: reply }; };

// (a) a model reply parses and stores
let r = await generateTension(db, 'obsession', { gen: gen('Foo Bar|because') });
assert.equal(r.against, 'foo-bar'); assert.equal(r.why, 'because'); assert.equal(r.source, 'model');
assert.match(gen.lastPrompt, /Ahab: chases the whale/); assert.match(gen.lastPrompt, /obsession, sea, witness/);
ok('model reply foo-bar|because parses, slugs and stores');

// (b) a hand row survives a later model write
setTension(db, 'sea', { against: 'land', why: 'by hand' }, 'hand');
r = await generateTension(db, 'sea', { gen: gen('sky|model says') });
assert.equal(r.against, 'land'); assert.equal(r.source, 'hand');
ok('hand row is not overwritten by a model write');

// (c) an against not in the vocabulary is still accepted
r = await generateTension(db, 'witness', { gen: gen('brand-new-tag|coined') });
assert.equal(r.against, 'brand-new-tag');
ok('a coined tag outside the vocabulary is accepted');

// (d) fillMissingTensions fills only tags without rows
db.exec(`INSERT INTO entity_tags VALUES ('e2','exile'), ('e1','home')`);
let calls = 0;
await fillMissingTensions(db, { gen: async () => { calls++; return { text: 'x|y' }; } });
assert.equal(calls, 2);
assert.deepEqual(listTensions(db).map((t) => t.tag), ['exile', 'home', 'obsession', 'sea', 'witness']);
ok('fillMissingTensions only fills tags without a row');

// bad reply returns an error, stores nothing
r = await generateTension(db, 'nothing', { gen: gen('no pipe here') });
assert.ok(r.error); assert.equal(db.prepare(`SELECT count(*) n FROM tag_tensions WHERE tag='nothing'`).get().n, 0);
ok('an unparseable reply returns an error and stores nothing');

// ── the template word is not an answer, and the answer is recoverable ────────
// Production stored 211 rows this way: told to reply "against|why", the model wrote the
// literal word. These are the four real shapes, taken from the live data.
const known = (t) => ['episodic-accountability', 'addiction-as-slow-death', 'surrender-vs-control'].includes(t);

assert.deepEqual(
  recover({ against: 'against', why: 'episodic-accountability — because it emphasizes sustained practice over episodes.' }, known),
  { against: 'episodic-accountability', why: 'because it emphasizes sustained practice over episodes.' });
ok('a partner at the head of the sentence, split on the dash, is recovered');

assert.equal(
  recover({ against: 'against', why: 'surrender-vs-control|It represents the friction between instinct and restraint.' }, known).against,
  'surrender-vs-control');
ok('a whole reply that landed in the second field, pipe and all, is recovered');

// truncated data must NOT become a partner: "bodily-" is half a word, not a tag
assert.equal(recover({ against: 'against', why: 'bodily-' }, known).against, '');
ok('a truncated fragment is refused rather than stored as a partner');

// a sentence with the partner never written separately is left for a person
assert.equal(recover({ against: 'against', why: 'An affair erupts the buried self through transgression.' }, known).against, '');
ok('a row whose partner was never written down is left alone');

// a coined partner outside the vocabulary is kept if it looks like a tag
assert.equal(recover({ against: 'against', why: 'duty-over-desire — one is the price of the other.' }, known).against, 'duty-over-desire');
ok('a coined partner outside the vocabulary is kept when it is shaped like a tag');

// a good row passes through untouched
assert.deepEqual(recover({ against: 'land', why: 'by hand' }, known), { against: 'land', why: 'by hand' });
ok('a row that was never malformed is returned unchanged');

// ── the repair, on a database, is idempotent and never calls a model ─────────
const rdb = new DatabaseSync(':memory:');
rdb.exec(`
  CREATE TABLE entity_tags (entity_id TEXT, tag TEXT, PRIMARY KEY (entity_id, tag));
  CREATE TABLE tag_tensions (tag TEXT PRIMARY KEY, against TEXT NOT NULL, why TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'model', created_at TEXT NOT NULL DEFAULT (datetime('now')));
  INSERT INTO entity_tags VALUES ('x','episodic-accountability');
  INSERT INTO tag_tensions (tag, against, why) VALUES
    ('accountability-as-practice','against','episodic-accountability — because sustained beats episodic.'),
    ('agency-after-violation','against','bodily-'),
    ('good-row','land','already fine');
`);
let res = repairTensions(rdb);
assert.equal(res.seen, 2); assert.equal(res.fixed, 1); assert.equal(res.stuck, 1);
assert.equal(rdb.prepare(`SELECT against FROM tag_tensions WHERE tag='accountability-as-practice'`).get().against, 'episodic-accountability');
assert.equal(rdb.prepare(`SELECT why FROM tag_tensions WHERE tag='agency-after-violation'`).get().why, 'bodily-');
ok('the repair fixes what it can, leaves the rest, and touches no good row');

assert.deepEqual(repairTensions(rdb), { seen: 1, fixed: 0, stuck: 1 });
ok('running the repair twice changes nothing more');

// ── an opposition ought to run both ways ────────────────────────────────────
const m = mirrorTensions(rdb);
assert.equal(m.added, 2);   // episodic-accountability and land had no row of their own
assert.equal(rdb.prepare(`SELECT against FROM tag_tensions WHERE tag='land'`).get().against, 'good-row');
assert.equal(rdb.prepare(`SELECT source FROM tag_tensions WHERE tag='land'`).get().source, 'mirror');
ok('a one-way opposition gets its other half, marked as mirrored');

setTension(rdb, 'land', { against: 'sea', why: 'by hand' }, 'hand');
mirrorTensions(rdb);
assert.equal(rdb.prepare(`SELECT against FROM tag_tensions WHERE tag='land'`).get().against, 'sea');
ok('mirroring never overwrites a row that already exists');

console.log(`\n${passed} checks passed — tag tensions hold.`);
