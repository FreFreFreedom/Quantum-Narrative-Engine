#!/usr/bin/env node
// Proves that suggestions now refresh on CHANGE rather than on a clock — without
// spending a credit.
//
//   npm run ship:facts
//
// The whole economic argument of the "suggestions that keep up with the code" plan
// is one claim: the daily architecture refresh should select only the components
// actually shipped against, instead of every component every day. That claim is
// worth testing rather than asserting, because if it is wrong the change costs MORE
// than the clock it replaced (it would refresh everything AND read the DB first).
//
// Four things get checked, because four different things could be wrong:
//
//  1. A component nobody shipped against is SKIPPED. This is the saving.
//  2. A component shipped against IS selected — and only after the ship, not before.
//  3. The file list a finished task reported is readable back (ship_files), since
//     Part 3 feeds it into the prompt.
//  4. The fuzzy overlap flag fires on real wording and stays quiet otherwise. It is
//     a guess, so what matters is that it is not a wild one.
//
// There is no test framework in this repo by design: this is a plain script that
// exits non-zero on the first broken expectation, against a throwaway DB.

import { rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const QS = resolve(HERE, '..');
const DB_FILE = join(tmpdir(), `fmcns-shipfacts-selftest-${process.pid}.db`);

let failures = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();

async function main() {
  process.env.DB_PATH = DB_FILE;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'selftest';
  process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'selftest';

  const { openDb } = await import(join(QS, 'server/src/db/schema.js'));
  const facts = await import(join(QS, 'server/src/services/shipFacts.js'));
  const db = openDb();

  // Two components, both refreshed an hour ago. Only one will be shipped against.
  const anHourAgo = iso(-3600_000);
  for (const id of ['comp-touched', 'comp-quiet']) {
    db.prepare(`INSERT OR REPLACE INTO architecture_components (id, now_text, status, suggestions_json, suggestions_generated_at)
                VALUES (?, ?, 'Working', '[]', ?)`).run(id, id, anHourAgo);
  }

  console.log('\n1. nothing shipped yet — nothing should be selected');
  ok(facts.lastShipByComponent(db).size === 0, 'no component reports a shipped task');
  ok(facts.touchedComponentsSince(db, anHourAgo).size === 0, 'nothing touched since the last refresh');

  console.log('\n2. one finished task, against one component');
  const shippedAt = iso(-60_000); // after the refresh, before now
  db.prepare(`INSERT INTO work_prompts (id, title, prompt, status, position, component_id, completed_at)
              VALUES ('p-1', 'Stop the queue freezing on a stuck stage', 'x', 'done', 1, 'comp-touched', ?)`).run(shippedAt);
  db.prepare(`INSERT INTO agent_tasks (id, work_prompt_id, title, status, ship_files)
              VALUES ('t-1', 'p-1', 'Stop the queue freezing', 'done', ?)`)
    .run(JSON.stringify(['queue-server/server/src/services/promptQueue.js', 'queue-server/scripts/queue-runner.js']));

  const last = facts.lastShipByComponent(db);
  ok(last.get('comp-touched') === shippedAt, 'the shipped component reports its ship time');
  ok(!last.has('comp-quiet'), 'the quiet component reports nothing');

  const touched = facts.touchedComponentsSince(db, anHourAgo);
  ok(touched.has('comp-touched'), 'the shipped component counts as touched since the refresh');
  ok(!touched.has('comp-quiet'), 'the quiet component does not');
  ok(facts.touchedComponentsSince(db, iso(-1_000)).size === 0, 'and nothing counts as touched since one second ago');

  console.log('\n3. the file list survives the round trip');
  const shipped = facts.shippedSince(db, anHourAgo, { componentId: 'comp-touched' });
  ok(shipped.length === 1, 'one shipped task found', String(shipped.length));
  ok(shipped[0]?.files.length === 2, 'both changed files read back', String(shipped[0]?.files.length));
  ok(facts.shippedSince(db, anHourAgo, { componentId: 'comp-quiet' }).length === 0, 'and none for the quiet component');

  console.log('\n4. the fuzzy flag, on suggestions with no component');
  const hit = facts.overlapsShipped('Fix the queue that freezes on a stuck stage', shipped);
  ok(hit.hit === true, 'fires on wording that matches what shipped', hit.why);
  const miss = facts.overlapsShipped('Add a dark theme to the country map', shipped);
  ok(miss.hit === false, 'stays quiet on unrelated wording');

  console.log('\n5. the selection itself — the saving, end to end');
  // preGen's archJobs is module-private; re-derive the same decision here from the
  // public readers, which is what it is built on. Checking the readers AND the
  // ratio separately is the point: a passing reader with a broken selection would
  // still refresh everything.
  const rows = db.prepare(`SELECT id, suggestions_json, suggestions_generated_at FROM architecture_components`).all();
  const selected = rows.filter((r) => {
    if (!r.suggestions_json || !r.suggestions_generated_at) return true;
    const s = last.get(r.id);
    return !!(s && s > r.suggestions_generated_at);
  }).map((r) => r.id);
  ok(selected.length === 1 && selected[0] === 'comp-touched',
    'exactly one of two components selected', selected.join(', ') || 'none');
  console.log(`  → the old 24h clock would have selected ${rows.length} of ${rows.length}; change-driven selects ${selected.length}.`);

  console.log('\n6. the repo probe — real git, against this checkout, no model');
  // The transport (helper_jobs kind='repo_probe') needs a live runner and is checked
  // by hand; what is testable here is the substance: does the probe tell the truth
  // about which files exist? That is the whole reason the drafting brief stops
  // guessing, so it is worth a real check against the real repo.
  const { extractCandidates, formatRepoFacts } = await import(join(QS, 'server/src/services/repoProbe.js'));
  const { gitPathFacts, gitGrepHits } = await import(join(QS, 'server/src/services/gitOps.js'));
  const REPO = resolve(QS, '..');

  const req = extractCandidates(
    'Make archJobs in queue-server/server/src/services/preGen.js skip untouched components, not queue-server/nope/missing.js');
  ok(req.paths.includes('queue-server/server/src/services/preGen.js'), 'a real path is picked out of the request');
  ok(req.identifiers.includes('archJobs'), 'a function name is picked out too');
  ok(extractCandidates('Make the app nicer').paths.length === 0,
    'a vague request yields nothing — which degrades to the old behaviour, not a wrong answer');

  const files = gitPathFacts(REPO, req.paths);
  const realOne = files.find((f) => f.path.endsWith('preGen.js'));
  const fakeOne = files.find((f) => f.path.endsWith('missing.js'));
  ok(realOne?.exists === true, 'the real file is reported as existing', `${realOne?.lines} lines`);
  ok(fakeOne?.exists === false, 'the invented file is reported as NOT existing');

  const grep = gitGrepHits(REPO, ['archJobs']);
  ok((grep[0]?.hits || []).length > 0, 'the function is located by file:line',
    (grep[0]?.hits || []).map((h) => `${h.file}:${h.line}`).slice(0, 2).join(', '));

  const block = formatRepoFacts({ head: 'abc1234', files, grep, recent: [] });
  ok(block.includes('EXIST'), 'the facts block names what exists');
  ok(block.includes('do NOT exist'), 'and what does not');
  ok(block.includes('Treat any file not listed'), 'and tells the model to trust it over its recollection');

  db.close();
  console.log(`\n${failures === 0 ? 'All good.' : `${failures} check(s) failed.`}\n`);
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => { if (existsSync(DB_FILE)) rmSync(DB_FILE, { force: true }); process.exit(code); })
  .catch((e) => { console.error(e); if (existsSync(DB_FILE)) rmSync(DB_FILE, { force: true }); process.exit(1); });
