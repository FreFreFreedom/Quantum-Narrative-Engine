// npm run splitscreen:selftest — the split screen's rules, proved.
// Throwaway in-memory database, no network, no model, no credits.
//
// Three things fail silently if they break:
//   1. a moment that does not resolve to a real, verified scene is refused before the row
//      is written — the whole point of building this on resolveMoment() rather than free text.
//   2. the same moment on both sides is refused — a split screen needs two different scenes.
//   3. the two moments are resolved FRESH on every read, never cached in the row, so a
//      change to the underlying interior file is reflected the next time the pair is read.

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createScenePair, getScenePair, listScenePairs, deleteScenePair, validateScenePair } from '../server/src/services/splitScreen.js';

// entityRelations.js#resolveMoment resolves against the fixed data-seed/interiors path, not
// an injectable one, so the selftest writes two throwaway interior files under that real
// path — same approach relations-selftest.js already uses for its own anatomy fixture —
// and removes them in the `finally` block below whatever happens in between.
import { writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const INTERIORS_DIR = resolve(__dirname, '../data-seed/interiors');
const FIXTURE_ID = '__splitscreen_selftest_fixture__';
writeFileSync(resolve(INTERIORS_DIR, FIXTURE_ID + '.graph.json'), JSON.stringify({
  entity: FIXTURE_ID, medium: FIXTURE_ID, source: 'test fixture', scope: 'test',
  turns: [{ block: 1, speaker: 'x', stance: null, quote: 'a line that exists' }],
}));
writeFileSync(resolve(INTERIORS_DIR, FIXTURE_ID + '.names.json'), JSON.stringify({ x: 'Test Speaker' }));

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE scene_pairs (
  id TEXT PRIMARY KEY, moment_a TEXT NOT NULL, moment_b TEXT NOT NULL, reading TEXT NOT NULL,
  source_kind TEXT DEFAULT 'witness', source_ref TEXT NOT NULL, falsifier TEXT NOT NULL,
  created_by TEXT, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), deleted_at TEXT)`);

let passed = 0;
const ok = (name) => { passed++; console.log(`  ✓ ${name}`); };
const REAL_MOMENT = `${FIXTURE_ID}#1-1`;

try {
  // ── validation ─────────────────────────────────────────────────────────────
  assert.match(
    validateScenePair(db, { moment_a: 'nonexistent_entity#1-2', moment_b: REAL_MOMENT, reading: 'x', source_ref: 'a', falsifier: 'b' }),
    /moment_a does not resolve/);
  ok('a moment that does not resolve to a real interior is refused');

  assert.match(
    validateScenePair(db, { moment_a: REAL_MOMENT, moment_b: REAL_MOMENT, reading: 'x', source_ref: 'a', falsifier: 'b' }),
    /same one twice/);
  ok('the same moment on both sides is refused');

  assert.match(
    validateScenePair(db, { moment_a: REAL_MOMENT, moment_b: `${FIXTURE_ID}#0-1`, reading: '', source_ref: 'a', falsifier: 'b' }),
    /reading is required/);
  ok('no reading, no row');

  // ── writing and reading back, with fresh resolution ─────────────────────────
  // a second fixture entity, so the two sides are genuinely different scenes
  const FIXTURE_B = '__splitscreen_selftest_fixture_b__';
  writeFileSync(resolve(INTERIORS_DIR, FIXTURE_B + '.graph.json'), JSON.stringify({
    entity: FIXTURE_B, medium: FIXTURE_B, source: 'test fixture b', scope: 'test',
    turns: [{ block: 1, speaker: 'y', stance: null, quote: 'a different line that also exists' }],
  }));
  writeFileSync(resolve(INTERIORS_DIR, FIXTURE_B + '.names.json'), JSON.stringify({ y: 'Other Speaker' }));

  const pair = createScenePair(db, {
    moment_a: REAL_MOMENT, moment_b: `${FIXTURE_B}#1-1`,
    reading: 'both scenes share the same shape', source_ref: 'the two fixtures', falsifier: 'a difference would break this',
  });
  assert.equal(pair.a.turns[0].quote, 'a line that exists');
  assert.equal(pair.b.turns[0].quote, 'a different line that also exists');
  ok('a valid pair is written and both sides resolve to their real, verified turns');

  const reread = getScenePair(db, pair.id);
  assert.equal(reread.a.turns[0].speaker, 'Test Speaker');
  ok('reading the pair back resolves the moments fresh, with names attached');

  assert.equal(listScenePairs(db).length, 1);
  assert.equal(deleteScenePair(db, pair.id), true);
  assert.equal(getScenePair(db, pair.id), null);
  assert.equal(deleteScenePair(db, pair.id), false);
  ok('deleting a pair removes it, and deleting it again reports nothing to delete');

  console.log(`\n${passed} checks passed — the split screen holds.`);
} finally {
  rmSync(resolve(INTERIORS_DIR, FIXTURE_ID + '.graph.json'), { force: true });
  rmSync(resolve(INTERIORS_DIR, FIXTURE_ID + '.names.json'), { force: true });
  rmSync(resolve(INTERIORS_DIR, '__splitscreen_selftest_fixture_b__.graph.json'), { force: true });
  rmSync(resolve(INTERIORS_DIR, '__splitscreen_selftest_fixture_b__.names.json'), { force: true });
}
