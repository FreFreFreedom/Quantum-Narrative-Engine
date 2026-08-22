#!/usr/bin/env node
// Proves the architecture tree's witness check, at zero cost — no model, no
// network, no runner, and a throwaway database.
//
//   node scripts/witness-selftest.js
//
// The four things the plan asks for, plus the one that matters most:
//
//   · a witness that passes flips the node to live and stamps its "built on" date;
//   · a witness pointing at nothing leaves the node where it was — NOT retired;
//   · a witness that once passed and now fails DOES retire the node;
//   · with the Mac unreachable, every file/symbol/route witness comes back
//     "not checked" and nothing is retired. This is the load-bearing one: a
//     witness system that wrongly retires work is worse than none.
//
// No test framework in this repo, by design — a plain script that exits non-zero
// on the first broken expectation.

import { DatabaseSync } from 'node:sqlite';
import {
  parseWitness, routeCandidates, answerRepoWitnesses, checkDbWitnesses,
  decideLifecycle, applyWitnessResults, witnessesFor, isRepoKind,
} from '../server/src/services/witnessCheck.js';

let failures = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

// ─── A throwaway database with the columns the checker writes ─────────────────
function scratchDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE architecture_nodes (
      id TEXT PRIMARY KEY, territory TEXT, name TEXT,
      witness_kind TEXT, witness_value TEXT, witness_ok INTEGER,
      witness_checked_at TEXT, witness_first_ok_at TEXT,
      lifecycle TEXT NOT NULL DEFAULT 'concept',
      updated_at TEXT, deleted_at TEXT
    )
  `);
  db.exec(`CREATE TABLE architecture_umbrellas (id TEXT PRIMARY KEY)`);
  return db;
}
const plant = (db, id, kind, value, extra = {}) => db.prepare(`
  INSERT INTO architecture_nodes (id, name, witness_kind, witness_value, lifecycle, witness_first_ok_at)
  VALUES (?,?,?,?,?,?)
`).run(id, extra.name || id, kind, value, extra.lifecycle || 'concept', extra.first_ok || null);
const row = (db, id) => db.prepare(`SELECT * FROM architecture_nodes WHERE id=?`).get(id);

// A stand-in for the Mac's checkout: `present.js` is there, nothing else is.
const fakeRepo = {
  pathFacts: (paths) => paths.map((p) => ({ path: p, exists: p === 'services/present.js' })),
  grepHits: (terms) => terms.map((t) => ({
    term: t,
    // 'runWitness' is really in the code; 'writtenAboutOnly' is only ever mentioned
    // in a plan, which must not count as proof of anything.
    hits: t === 'runWitness' ? [{ file: 'services/present.js', line: 3 }]
      : t === 'writtenAboutOnly' ? [{ file: 'plans/some-plan.md', line: 12 }]
      : [],
  })),
};

try {
  console.log('\n1. reading a witness off a node');
  {
    ok(parseWitness('file:services/witnessCheck.js')?.kind === 'file', 'the shorthand a person types parses');
    ok(parseWitness({ witness_kind: 'TABLE', witness_value: ' reviews ' })?.value === 'reviews', 'kind and value are normalised');
    ok(parseWitness({ witness_kind: 'vibes', witness_value: 'x' }) === null, 'an unknown kind is no witness at all');
    ok(parseWitness({ witness_kind: 'file', witness_value: '' }) === null, 'a blank value is no witness at all');
    ok(isRepoKind('route') && !isRepoKind('query'), 'the repo/database split is right');
  }

  console.log('\n2. a route is looked for the way Express actually writes it');
  {
    const c = routeCandidates('POST /api/architecture/witness/recheck');
    ok(c[0] === '/api/architecture/witness/recheck' && c.includes('/witness/recheck'),
      'both the whole address and the part a router file holds', c.join(' , '));
    ok(routeCandidates('') .length === 0, 'nothing to search for is not a search');
  }

  console.log('\n3. the checkout half');
  {
    const r = answerRepoWitnesses([
      { id: 'a', kind: 'file', value: 'services/present.js' },
      { id: 'b', kind: 'file', value: 'services/missing.js' },
      { id: 'c', kind: 'symbol', value: 'runWitness' },
      { id: 'd', kind: 'symbol', value: 'neverWritten' },
    ], fakeRepo);
    ok(r[0].ok === true, 'a file that is there passes');
    ok(r[1].ok === false, 'a file that is not there fails (not "unknown")');
    ok(r[2].ok === true && r[3].ok === false, 'symbols read the same way');

    const doc = answerRepoWitnesses([{ id: 'e', kind: 'symbol', value: 'writtenAboutOnly' }], fakeRepo);
    ok(doc[0].ok === false, 'being written about in a plan is not proof it was built', doc[0].detail);

    const blind = answerRepoWitnesses([{ id: 'a', kind: 'file', value: 'x' }], {});
    ok(blind[0].ok === null, 'with no checkout to read, the answer is "we could not tell"');

    const boom = answerRepoWitnesses([{ id: 'a', kind: 'file', value: 'x' }], {
      pathFacts: () => { throw new Error('git exploded'); }, grepHits: () => [],
    });
    ok(boom[0].ok === null, 'a checkout that throws is "we could not tell", never a failure');
  }

  console.log('\n4. the database half');
  {
    const db = scratchDb();
    const r = checkDbWitnesses(db, [
      { id: 'a', kind: 'table', value: 'architecture_umbrellas' },
      { id: 'b', kind: 'table', value: 'nothing_like_this' },
      { id: 'c', kind: 'query', value: 'SELECT COUNT(*) > 0 FROM architecture_nodes' },
      { id: 'd', kind: 'query', value: 'DELETE FROM architecture_nodes' },
      { id: 'e', kind: 'query', value: 'SELECT 1; DROP TABLE architecture_nodes' },
      { id: 'f', kind: 'query', value: 'SELECT 1 FROM no_such_table' },
    ]);
    ok(r[0].ok === true && r[1].ok === false, 'a table is there or it is not');
    ok(r[2].ok === false, 'an empty table means the query found nothing');
    ok(r[3].ok === null && r[4].ok === null, 'anything that could change the database is refused, not run');
    ok(r[5].ok === null, 'a broken query is "we could not tell", never proof the thing is gone');
    ok(db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name='architecture_nodes'`).get().n === 1,
      'and nothing it refused actually ran');

    plant(db, 'x', 'table', 'architecture_umbrellas');
    const r2 = checkDbWitnesses(db, [{ id: 'x', kind: 'query', value: 'SELECT COUNT(*) > 0 FROM architecture_nodes' }]);
    ok(r2[0].ok === true, 'a query that finds something passes');
  }

  console.log('\n5. the rule: never retire on uncertainty');
  {
    ok(decideLifecycle({ ever_ok: false }, { ok: true }) === 'live', 'passing means live');
    ok(decideLifecycle({ ever_ok: true }, { ok: false }) === 'retired', 'once proved, now gone, means retired');
    ok(decideLifecycle({ ever_ok: false }, { ok: false }) === null, 'never proved and failing is still just an idea');
    ok(decideLifecycle({ ever_ok: true }, { ok: null }) === null, 'not checked changes nothing');
    ok(decideLifecycle({ ever_ok: true }, null) === null, 'no answer at all changes nothing');
  }

  console.log('\n6. writing the results down');
  {
    const db = scratchDb();
    plant(db, 'good', 'file', 'services/present.js');
    plant(db, 'wrong', 'file', 'services/missing.js');
    const items = witnessesFor(db);
    ok(items.length === 2, 'only nodes that declare a witness are checked');

    const t1 = applyWitnessResults(db, items, answerRepoWitnesses(items, fakeRepo));
    ok(row(db, 'good').lifecycle === 'live', 'a passing witness flips the node to live');
    ok(!!row(db, 'good').witness_first_ok_at, 'and stamps when it was first proved');
    ok(row(db, 'wrong').lifecycle === 'concept', 'a wrong path leaves the node where it was');
    ok(row(db, 'wrong').lifecycle !== 'retired', 'a wrong path does NOT retire the node');
    ok(t1.live === 1 && t1.failed === 1 && t1.retired === 0 && t1.unchecked === 0, 'the tally reads right',
      JSON.stringify(t1));

    const stamped = row(db, 'good').witness_first_ok_at;
    applyWitnessResults(db, witnessesFor(db), answerRepoWitnesses(witnessesFor(db), fakeRepo));
    ok(row(db, 'good').witness_first_ok_at === stamped, 'the first-proved date is stamped once, not on every check');

    // Now the thing it proves is taken away.
    db.prepare(`UPDATE architecture_nodes SET witness_value='services/gone.js' WHERE id='good'`).run();
    const items2 = witnessesFor(db);
    const t2 = applyWitnessResults(db, items2, answerRepoWitnesses(items2, fakeRepo));
    ok(row(db, 'good').lifecycle === 'retired', 'something built that is no longer there is retired');
    ok(t2.retired === 1 && t2.changed.some((c) => c.id === 'good' && c.to === 'retired'),
      'and the change is reported, not silent', JSON.stringify(t2.changed));
  }

  console.log('\n7. THE IMPORTANT ONE — the Mac is off');
  {
    const db = scratchDb();
    plant(db, 'built', 'file', 'services/present.js', { lifecycle: 'live', first_ok: '2026-01-01T00:00:00.000Z' });
    plant(db, 'sym', 'symbol', 'runWitness', { lifecycle: 'live', first_ok: '2026-01-01T00:00:00.000Z' });
    plant(db, 'rt', 'route', 'POST /api/architecture/witness/recheck', { lifecycle: 'live', first_ok: '2026-01-01T00:00:00.000Z' });
    const items = witnessesFor(db);

    // No runner: recheckAllWitnesses' askTheMac() returns [] — no results at all
    // for those nodes, which is exactly what applyWitnessResults sees here.
    const t = applyWitnessResults(db, items, []);
    ok(t.checked === 0, 'nothing was checked');
    ok(t.unchecked === 3, 'and all three are counted as not checked, not quietly skipped', JSON.stringify(t));
    ok(t.retired === 0, 'NOTHING was retired');
    for (const id of ['built', 'sym', 'rt']) {
      ok(row(db, id).lifecycle === 'live', `${id} is left exactly as it was`);
      ok(row(db, id).witness_checked_at === null, `${id} is not stamped as checked`);
    }

    // The other shape of the same thing: the runner answered, but could not tell.
    const unknowns = items.map((it) => ({ id: it.id, ok: null, detail: 'could not check' }));
    const t2 = applyWitnessResults(db, items, unknowns);
    ok(t2.unchecked === 3 && t2.retired === 0 && t2.failed === 0,
      'an explicit "could not tell" retires nothing either', JSON.stringify(t2));
    ok(['built', 'sym', 'rt'].every((id) => row(db, id).lifecycle === 'live'), 'all three still live');

    // And a malformed reply from the far end.
    const t3 = applyWitnessResults(db, items, [{ id: 'built' }, null, { id: 'nope', ok: false }]);
    ok(t3.retired === 0 && row(db, 'built').lifecycle === 'live', 'a malformed reply retires nothing');
  }

  console.log('\n8. a node with no witness is never touched');
  {
    const db = scratchDb();
    plant(db, 'bare', null, null);
    const items = witnessesFor(db);
    ok(items.length === 0, 'it is not even in the list');
    applyWitnessResults(db, items, [{ id: 'bare', ok: false }]);
    ok(row(db, 'bare').lifecycle === 'concept', 'and a stray result for it is ignored');
  }
} catch (e) {
  console.error('\nself-test crashed:', e.stack || e.message);
  failures++;
}

console.log(failures ? `\nFAILED — ${failures} broken expectation(s)\n` : '\nAll good.\n');
process.exit(failures ? 1 : 0);
