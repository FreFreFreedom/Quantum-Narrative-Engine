// npm run mentions:selftest — the matcher that points Antoine's own writing at the
// entities it names, proven without a database, a network call or a model credit.
//
// Four things can quietly break and cost either precision or a decision he already made:
//   1. the sentence-initial rule — the whole defence against a character named "She"
//      turning the matcher into a pronoun detector,
//   2. case sensitivity and word boundaries — "he will fence it" must not be Fences,
//   3. one row per (entity, testimony) with a hit count, not one row per occurrence,
//   4. idempotency — a rescan must insert nothing new, and must never resurrect a
//      rejected match.
//
// (1)-(3) run against the pure function. (4) needs rows, so it runs against a throwaway
// in-memory SQLite with just the one table — no server, no seed data.

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { scanText, scanSource, mentionsFor, decideMention, listProposed } from '../server/src/services/entityMentions.js';

let passed = 0;
function ok(name) { passed++; console.log(`  ✓ ${name}`); }

const NAMES = [
  { id: 'e_fences', name: 'Fences' },
  { id: 'e_she', name: 'She' },
  { id: 'e_rocket', name: 'Rocket' },
  { id: 'e_troy', name: 'Troy Maxson' },
  { id: 'e_master', name: 'The Master' },
  { id: 'e_baltimore', name: 'Baltimore' },
];
const one = (text) => scanText(NAMES, text);
const forEntity = (text, id) => one(text).find((r) => r.entity_id === id) || null;

// ─── 1. tiers and the sentence-initial rule ───────────────────────────────────

const fences = forEntity('I keep coming back to the movie Fences, written by August Wilson.', 'e_fences');
assert.ok(fences, 'Fences mid-sentence must be found');
assert.equal(fences.tier, 'single');
assert.equal(fences.status, 'proposed');
assert.equal(fences.hits, 1);
ok('a single-token name mid-sentence is found, and lands as a proposal');

assert.equal(forEntity('Fences is the one that keeps coming back.', 'e_fences'), null);
ok('a single-token match opening a sentence is rejected');

assert.equal(forEntity('He was right. Fences says it plainly.', 'e_fences'), null);
ok('sentence-initial after a full stop is rejected too');

assert.deepEqual(one('She projects the living map onto the wall.'), []);
ok('"She" as an ordinary pronoun finds nothing — the character is unmatchable, by design');

const rocket = forEntity('What happens when a boy like Rocket discovers a camera?', 'e_rocket');
assert.ok(rocket && rocket.hits === 1);
ok('a single-token name inside the sentence survives');

const troy = forEntity('Troy Maxson', 'e_troy');
assert.ok(troy, 'a bare multi-word name must be found');
assert.equal(troy.tier, 'multiword');
assert.equal(troy.status, 'linked');
ok('a multi-word name is linked outright — the sentence-initial rule does not touch it');

assert.equal(forEntity('he will fence it off before spring', 'e_fences'), null);
ok('case sensitivity and word boundaries: "fence" is not Fences');

assert.ok(forEntity("Baltimore's decline is the argument.", 'e_baltimore') === null);
ok('...but that is because it opens the sentence — checked next');

const balt = forEntity("The book is about Baltimore's decline.", 'e_baltimore');
assert.ok(balt, "a trailing apostrophe must still match");
assert.equal(balt.matched, 'Baltimore');
ok("a possessive still matches (Baltimore's)");

// The one multi-word false positive measured in the real corpus. A heading NAMES a
// section; it asserts nothing about the entity, so it goes to review rather than straight
// into the ontology.
const master = forEntity('## 7. The Master PDF: Genome and Proof\n\nSome body text.', 'e_master');
assert.ok(master, 'The Master in a heading must still be seen');
assert.equal(master.status, 'proposed');
ok('a multi-word match seen only in a heading is proposed, not linked');

const masterReal = forEntity('## 7. The Master PDF\n\nWatching The Master again changed it.', 'e_master');
assert.equal(masterReal.status, 'linked');
assert.equal(masterReal.hits, 2);
ok('...and one occurrence in real prose is enough to link it');

// ─── 2. one row per entity, with a count ──────────────────────────────────────

const twice = forEntity('A note about Troy Maxson. Everything here is Troy Maxson.', 'e_troy');
assert.equal(twice.hits, 2);
assert.equal(one('A note about Troy Maxson. Everything here is Troy Maxson.').length, 1);
ok('a name appearing twice is one row with hits = 2');

// Fences twelve times, minus two sentence-initial ones — the measured shape of the real
// corpus, and the proof the rule costs occurrences and not the entity.
const mixed = 'Fences opens it. I read Fences again, and Fences again after that.';
const f2 = forEntity(mixed, 'e_fences');
assert.equal(f2.hits, 2);
ok('a name that opens one sentence and sits inside two others keeps the two');

// ─── 3. what gets stripped before matching ────────────────────────────────────

assert.deepEqual(one('```\nthe movie Fences here\n```'), []);
ok('a fenced code block is stripped before matching');
assert.deepEqual(one('see https://example.com/Troy%20Maxson/Fences for it'), []);
ok('a URL is stripped before matching');

// ─── 4. the quote ─────────────────────────────────────────────────────────────

const q = forEntity('First sentence. The second is about Troy Maxson and his fence. A third.', 'e_troy');
assert.equal(q.quote, 'The second is about Troy Maxson and his fence.');
ok('the quote is the sentence the match sat in, and nothing either side of it');

const long = forEntity('x '.repeat(400) + 'Troy Maxson' + ' y'.repeat(400) + '.', 'e_troy');
assert.ok(long.quote.length <= 302, `quote capped, got ${long.quote.length}`);
assert.ok(long.quote.includes('Troy Maxson'), 'a capped quote must still contain the name');
ok('a long sentence is windowed around the match, not truncated away from it');

// ─── 5. idempotency and decisions, against a real table ───────────────────────

const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE entities (id TEXT PRIMARY KEY, name TEXT);
  CREATE TABLE entity_mentions (
    id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, source_type TEXT NOT NULL,
    source_id TEXT NOT NULL, matched TEXT NOT NULL, quote TEXT NOT NULL,
    tier TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'linked', hits INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), decided_at TEXT
  );
  CREATE UNIQUE INDEX idx_entity_mentions_uniq ON entity_mentions(entity_id, source_type, source_id);
`);
for (const n of NAMES) db.prepare(`INSERT INTO entities (id, name) VALUES (?,?)`).run(n.id, n.name);

const NOTE = 'Note: a thread';
const TEXT = 'The second is about Troy Maxson and his fence. I read Fences again after that.';
const first = scanSource(db, 'note', NOTE, TEXT);
assert.equal(first.inserted, 2);
assert.deepEqual(mentionsFor(db, 'e_troy').map((m) => m.status), ['linked']);
assert.deepEqual(mentionsFor(db, 'e_fences').map((m) => m.status), ['proposed']);
ok('a scan writes one linked row and one proposal');

const again = scanSource(db, 'note', NOTE, TEXT);
assert.equal(again.inserted, 1); // the proposal is dropped and rewritten; the linked row is untouched
assert.equal(db.prepare(`SELECT COUNT(*) n FROM entity_mentions`).get().n, 2);
ok('re-scanning unchanged text leaves the table the same size');

// Confirm one, reject the other, then rescan: both decisions must survive.
decideMention(db, mentionsFor(db, 'e_fences')[0].id, 'linked');
const troyRow = mentionsFor(db, 'e_troy')[0];
decideMention(db, troyRow.id, 'rejected');
scanSource(db, 'note', NOTE, TEXT);
assert.equal(db.prepare(`SELECT status FROM entity_mentions WHERE entity_id='e_fences'`).get().status, 'linked');
assert.equal(db.prepare(`SELECT status FROM entity_mentions WHERE entity_id='e_troy'`).get().status, 'rejected');
assert.deepEqual(mentionsFor(db, 'e_troy'), []);
ok('a confirmed match stays confirmed and a rejected one never comes back');

assert.deepEqual(listProposed(db, 10), []);
ok('nothing is left waiting once both have been decided');

// An edited note must drop proposals for text that no longer exists.
scanSource(db, 'note', NOTE, 'Nothing in here names anybody at all.');
assert.equal(db.prepare(`SELECT COUNT(*) n FROM entity_mentions`).get().n, 2);
ok('an edited note keeps its decided rows (the rejected one is what stops it coming back)');

const OTHER = 'Note: another';
scanSource(db, 'note', OTHER, 'A boy like Rocket discovers a camera.');
assert.equal(mentionsFor(db, 'e_rocket').length, 1);
scanSource(db, 'note', OTHER, 'Nothing here.');
assert.deepEqual(mentionsFor(db, 'e_rocket'), []);
ok('an undecided proposal disappears when the text it came from does');

console.log(`\n${passed} checks passed.`);
