// npm run scale:selftest — proves the ladder's two load-bearing rules hold.
// No DB, no network, no model calls, no credits.
//
// The rules (services/scaleLadder.js, plans/civic-structures-and-loops.md Stage 1):
//   1. A medium has no rung. A film is a record, not a self-maintaining entity.
//   2. No rung is NOT rung zero. An unplaced entity must be incomparable, never nearest.
// Rule 2 is the one that would fail silently and expensively: if `film` resolved to 0,
// every film in the corpus would look one rung from a cell and adjacent to every
// character, and the graph would fill with bridges that mean nothing.

import assert from 'node:assert/strict';
import { SCALE_LADDER, rungOf, rungKeyOf, rungName, rungDistance, isAdjacentRung, rungDirection } from '../server/src/services/scaleLadder.js';

// --- the ladder itself ---
assert.equal(SCALE_LADDER[0].key, 'cell', 'the ladder starts at the smallest rung');
assert.equal(SCALE_LADDER[SCALE_LADDER.length - 1].key, 'cosmos', 'and ends at the largest');
assert.equal(new Set(SCALE_LADDER.map(r => r.key)).size, SCALE_LADDER.length, 'no duplicate rungs');
for (const r of SCALE_LADDER) assert.ok(r.name && r.vocab, `${r.key} has a name and a vocabulary`);

// --- legacy stored values, mapped without migrating data ---
assert.equal(rungKeyOf('individual'), 'individual', 'characters keep their rung');
assert.equal(rungKeyOf('national'), 'nation', 'countries: the legacy value maps to the nation rung');
assert.equal(rungKeyOf('film'), null, 'rule 1 — a film is a medium and sits on no rung');
assert.equal(rungKeyOf('institution'), 'institution', 'a new rung-naming value maps to itself');
assert.equal(rungKeyOf('family'), 'family');
assert.equal(rungKeyOf('city'), 'city');

// --- rule 2, the expensive one ---
assert.equal(rungOf('film'), null, 'a film resolves to null, not to index 0');
assert.notEqual(rungOf('film'), 0, 'and null must not be 0 — the whole point');
assert.equal(rungOf('cell'), 0, 'while the real bottom rung IS 0');
assert.equal(rungDistance('film', 'individual'), null, 'a medium cannot be one end of a distance');
assert.equal(rungDistance('nonsense-value', 'nation'), null, 'nor can an unknown value');
assert.equal(rungDistance(null, 'nation'), null);
assert.equal(rungDistance(undefined, undefined), null);

// --- real distances ---
assert.equal(rungDistance('individual', 'individual'), 0, 'same rung is 0, and 0 is not null');
assert.equal(rungDistance('individual', 'family'), 1);
assert.equal(rungDistance('family', 'individual'), 1, 'distance is symmetric');
assert.equal(rungDistance('individual', 'national'), 5, 'individual → family → group → institution → city → nation');
assert.equal(rungDistance('cell', 'cosmos'), SCALE_LADDER.length - 1, 'the full span');

// --- adjacency: what vertical navigation may cross in one step ---
assert.equal(isAdjacentRung('family', 'group'), true);
assert.equal(isAdjacentRung('family', 'institution'), false, 'skipping a rung is not adjacency');
assert.equal(isAdjacentRung('individual', 'individual'), false, 'nor is standing still');
assert.equal(isAdjacentRung('film', 'individual'), false, 'nor is comparing against a medium');

// --- direction ---
assert.equal(rungDirection('institution', 'family'), 'down', 'a law reaching a family goes down');
assert.equal(rungDirection('family', 'institution'), 'up', 'and the wound coming back goes up');
assert.equal(rungDirection('nation', 'nation'), null, 'same rung has no direction');
assert.equal(rungDirection('film', 'nation'), null, 'a medium has no direction either');

// --- display ---
assert.equal(rungName('national'), 'Nation');
assert.equal(rungName('film'), null);

console.log(`scale ladder selftest: OK (${SCALE_LADDER.length} rungs, all rules hold)`);
