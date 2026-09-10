// npm run tensions:selftest — tag tensions with no database file, no network, no
// model credit. The model is a stub that returns whatever the test hands it.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { setTension, generateTension, fillMissingTensions, listTensions } from '../server/src/services/tagTensions.js';

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

console.log(`\n${passed} checks passed — tag tensions hold.`);
