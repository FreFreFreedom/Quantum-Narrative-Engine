// npm run prompt:selftest — the composer's two helpers, proven without a model,
// a network call or a credit. An in-memory database and pure functions only.
//
// What can quietly break here:
//   1. an edit filed under a name nobody foresaw being thrown away instead of
//      kept — the list used to punish the model for having an idea outside it,
//   2. muting leaking across situations, so a kind he refused on a one-line
//      question stops being offered on a long draft,
//   3. the carry-over of his old counts running twice and doubling them,
//   4. the grey tail's cleaning, which is the difference between his sentence and
//      the app talking to itself behind his caret.

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  bindPromptHelperDb, mutedKinds, recordTaste, recordTail, helperStats, situation, _internals,
} from '../server/src/services/promptHelper.js';

const { cleanTail, usableEdits, parseEdits, KINDS, OTHER } = _internals;

let passed = 0;
function ok(name) { passed++; console.log(`  ✓ ${name}`); }

// ─── 1. an edit is kept for what it does, not for its label ──────────────────
const draft = 'what is the shape of a city that heals itself, at street level';

let edits = usableEdits([
  { find: 'the shape of', replace: 'the mechanism of', kind: 'exact_word', why: 'name it' },
  { find: 'heals itself', replace: 'repairs its own fabric', kind: 'something_invented', why: 'sharper' },
], draft);
assert.equal(edits.length, 2);
assert.equal(edits[1].kind, OTHER);
ok('an unforeseen kind is filed under other, not thrown away');

assert.equal(usableEdits([{ find: 'not in the draft', replace: 'x', kind: 'scale' }], draft).length, 0);
ok('a find that is not in his draft is dropped');

const twice = 'a city, and then another city';
assert.equal(usableEdits([{ find: 'city', replace: 'street', kind: 'scale' }], twice).length, 0);
ok('a find that appears twice is dropped');

edits = usableEdits([
  { find: 'shape of a city', replace: 'mechanism of a city', kind: 'exact_word' },
  { find: 'a city that heals', replace: 'a city that repairs', kind: 'exact_word' },
], draft);
assert.equal(edits.length, 1);
ok('two overlapping edits keep only the first');

edits = usableEdits([
  { find: 'what', replace: 'which', kind: 'exact_word' },
  { find: 'shape', replace: 'mechanism', kind: 'exact_word' },
  { find: 'city', replace: 'street', kind: 'scale' },
  { find: 'heals', replace: 'repairs', kind: 'exact_word' },
  { find: 'street level', replace: 'doorstep level', kind: 'scale' },
], draft);
assert.equal(edits.length, _internals.MAX_EDITS ?? 4);
assert.deepEqual(edits.map((x) => x.at), [...edits.map((x) => x.at)].sort((a, b) => a - b));
ok('the set is capped and reads left to right');

edits = usableEdits([{ find: '', replace: ' — at what scale?', kind: 'scale' }], draft);
assert.equal(edits.length, 1);
assert.equal(edits[0].at, draft.length);
ok('an empty find appends to the end');

assert.deepEqual(usableEdits([{ find: 'city', replace: 'city', kind: 'scale' }], draft), []);
ok('an edit that changes nothing is dropped');

assert.deepEqual(parseEdits('```json\n[{"find":"a","replace":"b"}]\n```'), [{ find: 'a', replace: 'b' }]);
assert.equal(parseEdits('no json here'), null);
ok('a fenced array is read, and prose is not');

// ─── 2. the grey tail ────────────────────────────────────────────────────────
assert.equal(cleanTail('His current input:** and then', 'the city'), '');
assert.equal(cleanTail('**something**', 'the city'), '');
ok('anything wearing a label is thrown away rather than cleaned up');

assert.equal(cleanTail('the city that heals itself', 'the city'), ' that heals itself');
ok('the echoed draft is not repeated back to him');

assert.equal(cleanTail('heals itself', 'the city '), 'heals itself');
assert.equal(cleanTail(', at street level', 'the city'), ', at street level');
ok('the space between his word and ours is added only when it belongs');

// ─── 3. situations ───────────────────────────────────────────────────────────
assert.equal(situation('short one'), 'short');
assert.equal(situation('x'.repeat(179)), 'short');
assert.equal(situation('x'.repeat(180)), 'long');
ok('the two buckets split where they should');

// ─── 4. muting, counted per situation ────────────────────────────────────────
const db = new DatabaseSync(':memory:');
// His history, written the old way, before situations existed.
db.exec(`CREATE TABLE prompt_helper_taste (
  kind TEXT PRIMARY KEY, taken INTEGER NOT NULL DEFAULT 0, refused INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT)`);
db.exec(`INSERT INTO prompt_helper_taste (kind, taken, refused) VALUES ('far_jump', 0, 2)`);
bindPromptHelperDb(db);

assert.deepEqual(mutedKinds('short'), ['far_jump']);
assert.deepEqual(mutedKinds('long'), ['far_jump']);
ok('old counts carry into both buckets, since they were gathered across both');

bindPromptHelperDb(db);
const carried = db.prepare('SELECT refused FROM prompt_helper_taste_v2 WHERE kind=? AND situation=?').get('far_jump', 'long');
assert.equal(carried.refused, 2);
ok('a second boot does not carry them in again');

recordTaste([{ kind: 'scale', taken: false }], 'short');
assert.deepEqual(mutedKinds('short'), ['far_jump']);
recordTaste([{ kind: 'scale', taken: false }], 'short');
assert.deepEqual(mutedKinds('short').sort(), ['far_jump', 'scale']);
assert.deepEqual(mutedKinds('long'), ['far_jump']);
ok('two refusals retire a kind in that situation only');

recordTaste([{ kind: 'scale', taken: true }], 'short');
assert.deepEqual(mutedKinds('short'), ['far_jump']);
ok('one yes anywhere in a bucket brings the kind back');

recordTaste([{ kind: OTHER, taken: false }], 'short');
recordTaste([{ kind: OTHER, taken: false }], 'short');
recordTaste([{ kind: OTHER, taken: false }], 'short');
assert.ok(!mutedKinds('short').includes(OTHER));
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM prompt_helper_taste_v2 WHERE kind=?').get(OTHER).n, 0);
ok('other is never counted and never muted');

recordTaste([{ kind: 'far_jump', taken: false }], 'nonsense');
assert.equal(db.prepare('SELECT refused FROM prompt_helper_taste_v2 WHERE kind=? AND situation=?').get('far_jump', 'long').refused, 3);
ok('an unknown situation falls back to long rather than inventing a bucket');

assert.deepEqual(usableEdits([{ find: 'city', replace: 'street', kind: 'far_jump' }], draft, mutedKinds('long')), []);
ok('a muted kind is refused by the code, not only by the prompt');

// ─── 5. the tail, counted ────────────────────────────────────────────────────
recordTail(true); recordTail(false); recordTail(false);
const stats = helperStats();
assert.equal(stats.tail.taken, 1);
assert.equal(stats.tail.dropped, 2);
assert.equal(stats.tail.shown, 0);
assert.ok(stats.taste.length > 0);
ok('what happened to the tail is counted, and gates nothing');

assert.ok(Object.keys(KINDS).includes(OTHER));
console.log(`\n${passed} checks passed.`);
