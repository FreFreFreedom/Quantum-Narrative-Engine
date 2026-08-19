#!/usr/bin/env node
// Proves the ranked "what to do next" list, end to end, without spending a credit.
//
//   npm run next:selftest
//
// Three things get checked, because three different things could be wrong:
//
//  1. THE ORDER IS RIGHT. The "how much does this unlock" count is re-derived here
//     by a deliberately separate brute-force method (iterate reachability to a
//     fixed point) and compared against services/nextSteps.js. Two independent
//     implementations agreeing is the only reason to trust a number the whole
//     ranking hangs on.
//  2. IT NEVER PROPOSES WORK ALREADY UNDER WAY. Queue a task against the top pick
//     and it must leave the list; finish that task and it must come back.
//  3. THE PANEL RENDERS, AND ESCAPES. The render functions are lifted straight out
//     of fmcns_navigator.html and run against stubs, including hostile input — a
//     component name is user-authored text and must never become markup.
//
// There is no test framework in this repo by design, so this is a plain script
// that exits non-zero on the first broken expectation. It writes to a throwaway
// DB and touches nothing live.

import { readFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const QS = resolve(HERE, '..');
const REPO = resolve(QS, '..');
const APP = join(REPO, 'fmcns_navigator.html');

let failures = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

// The component trunk lives in the app file, not the DB, so read it from there —
// exactly as the browser posts it to the endpoint.
function readCatalog() {
  const html = readFileSync(APP, 'utf8');
  const start = html.indexOf('const ARCH_DATA = [');
  if (start === -1) throw new Error('ARCH_DATA not found in ' + APP);
  let i = html.indexOf('[', start), depth = 0, end = -1;
  for (let k = i; k < html.length; k++) {
    if (html[k] === '[') depth++;
    else if (html[k] === ']') { depth--; if (depth === 0) { end = k; break; } }
  }
  // eslint-disable-next-line no-eval
  return eval(html.slice(i, end + 1));
}

// Lift a top-level function's source out of the app file by brace matching.
function appFn(html, name) {
  const start = html.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`not found in app: ${name}`);
  let i = html.indexOf('{', start), depth = 0, end = -1;
  for (let k = i; k < html.length; k++) {
    if (html[k] === '{') depth++;
    else if (html[k] === '}') { depth--; if (depth === 0) { end = k; break; } }
  }
  return html.slice(start, end + 1);
}

const DB_FILE = join(tmpdir(), `fmcns-nextsteps-selftest-${process.pid}.db`);

async function main() {
  const catalog = readCatalog();
  console.log(`\nTrunk: ${catalog.length} components, ${catalog.filter(c => (c.depends || []).length).length} with prerequisites.`);

  process.env.DB_PATH = DB_FILE;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'selftest';
  process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'selftest';
  const { openDb } = await import(join(QS, 'server/src/db/schema.js'));
  const { nextSteps } = await import(join(QS, 'server/src/services/nextSteps.js'));
  const db = openDb();

  // ── 1. the order ───────────────────────────────────────────────────────────
  console.log('\n1. the ranking, checked against an independent count');
  const out = nextSteps(db, catalog, { limit: 3 });
  ok(out.free === true, 'it cost nothing to produce');
  ok(out.picks.length === 3, 'three picks', String(out.picks.length));
  ok(out.picks.every(p => p.reason && p.reason.length > 20), 'every pick explains itself');
  ok(out.picks[0].ready === true, 'the top pick is something you can actually start now');

  const BUILT = new Set(['Working', 'Validated', 'Advanced']);
  const byId = Object.fromEntries(catalog.map(c => [c.id, c]));
  const dependents = {};
  catalog.forEach(c => (c.depends || []).forEach(d => { (dependents[d] = dependents[d] || []).push(c.id); }));
  const bruteForce = (id) => {
    let set = new Set(dependents[id] || []), changed = true;
    while (changed) {
      changed = false;
      for (const m of [...set]) for (const c of (dependents[m] || [])) if (!set.has(c)) { set.add(c); changed = true; }
    }
    return [...set].filter(x => !BUILT.has(byId[x].status)).length;
  };
  const ranked = [...out.picks, ...out.rest];
  const mismatch = ranked.filter(p => p.unlocks !== bruteForce(p.id));
  ok(!mismatch.length, 'every "unlocks" count matches a separate brute-force count',
    mismatch.length ? mismatch.map(p => `${p.id}: said ${p.unlocks}, really ${bruteForce(p.id)}`).join('; ') : `${ranked.length} checked`);

  ok(ranked.every(p => !BUILT.has(byId[p.id] ? byId[p.id].status : p.status)),
    'finished components are not offered as next steps');
  const readyFlags = ranked.map(p => p.ready ? 1 : 0);
  ok(readyFlags.join('').indexOf('01') === -1, 'nothing blocked is ranked above something ready');
  const blocked = ranked.filter(p => !p.ready);
  ok(blocked.every(p => (p.blocked_by || []).length && p.blocked_by.every(b => !BUILT.has(byId[b.id] ? byId[b.id].status : b.status))),
    'every blocked item names a prerequisite that really is unfinished', `${blocked.length} blocked`);
  // Check against the real id list, not a hyphen pattern — ordinary English like
  // "Half-built already" is hyphenated too, and flagging that says nothing.
  const ids = catalog.map(c => c.id);
  const leaked = ranked.filter(p => ids.some(id => (p.reason || '').includes(id)));
  ok(!leaked.length, 'no internal ids leak into the reasons Antoine reads',
    leaked.length ? leaked.map(p => p.id).join(', ') : `${ranked.length} checked`);

  // ── 2. work already under way ──────────────────────────────────────────────
  console.log('\n2. it never tells you to start something twice');
  const top = out.picks[0].id, topName = out.picks[0].name;
  db.prepare(`INSERT INTO work_prompts (id,title,prompt,status,position,component_id) VALUES (?,?,?,?,?,?)`)
    .run('nextsteps-selftest-1', 'selftest', 'x', 'running', 1, top);
  const during = nextSteps(db, catalog, { limit: 3 });
  ok(![...during.picks, ...during.rest].some(p => p.id === top), `"${topName}" left the list while a task runs`);
  ok(during.in_flight.some(p => p.id === top), 'and shows as already under way instead');
  db.prepare(`UPDATE work_prompts SET status='done' WHERE id='nextsteps-selftest-1'`).run();
  ok(nextSteps(db, catalog, { limit: 3 }).picks.some(p => p.id === top), 'and returns once that task is finished');

  // ── 3. the panel ───────────────────────────────────────────────────────────
  console.log('\n3. the panel renders, and cannot be injected into');
  const html = readFileSync(APP, 'utf8');
  const src = ['nuTerrLabel', 'nuRowHtml', 'flowNextUpHtml'].map(n => appFn(html, n)).join('\n');
  const ctx = {
    qEsc: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    TERRITORIES: [{ id: 'knowledge', label: 'Knowledge' }, { id: 'interface', label: 'Interface' }],
    flowWorldPickSuffix: () => '',
    nextUp: null, nextUpOpen: false, nextUpBusy: false, nextUpErr: '',
  };
  // eslint-disable-next-line no-new-func
  const api = new Function('ctx', `with (ctx) { ${src} return { nuRowHtml, flowNextUpHtml }; }`)(ctx);

  ok(api.flowNextUpHtml() === '', 'nothing loaded yet renders nothing, not an empty box');
  ctx.nextUpBusy = true;
  ok(/Working out what to do next/.test(api.flowNextUpHtml()), 'a load in progress says so');
  ctx.nextUpBusy = false;
  ctx.nextUpErr = 'Could not work out the order just now.';
  ok(/Could not work out the order/.test(api.flowNextUpHtml()), 'a failure says so, rather than looking like "nothing to do"');
  ctx.nextUpErr = '';

  ctx.nextUp = {
    picks: out.picks.map(p => ({ ...p, territory: 'knowledge' })),
    rest: out.rest.slice(0, 1).map(p => ({ ...p, territory: 'knowledge' })),
    in_flight: [{ id: 'maps', name: 'Maps' }],
  };
  let rendered = api.flowNextUpHtml();
  ok(/What to do next/.test(rendered), 'the section has its heading');
  ok(rendered.indexOf(ctx.nextUp.picks[0].name) < rendered.indexOf(ctx.nextUp.picks[1].name), 'the server order is preserved');
  ok(/data-nubuild=/.test(rendered), 'rows can be started');
  ok(/Already under way: Maps/.test(rendered), 'it says what it deliberately left out');
  ok(/Show the other 1/.test(rendered), 'the rest is one click away');
  ctx.nextUpOpen = true;
  rendered = api.flowNextUpHtml();
  ok(/Hide the rest/.test(rendered), 'and folds back up');
  ctx.nextUpOpen = false;

  ctx.nextUp = { picks: [{ id: 'x', name: '<img src=x onerror=alert(1)>', territory: 'knowledge', ready: true, unlocks: 1, next: '"><script>bad()</script>', reason: '<b>hi</b>' }], rest: [], in_flight: [] };
  rendered = api.flowNextUpHtml();
  ok(!/<img src=x/.test(rendered), 'a component name cannot inject markup');
  ok(!/<script>bad/.test(rendered), 'a next-step string cannot inject a script');
  ok(!/<b>hi<\/b>/.test(rendered), 'a reason cannot inject markup');

  db.close();
}

try {
  await main();
} catch (e) {
  console.error('\nself-test crashed:', e.message);
  failures++;
} finally {
  for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
    try { if (existsSync(f)) rmSync(f); } catch {}
  }
}

console.log(failures ? `\nFAILED — ${failures} broken expectation(s)\n` : '\nAll good.\n');
process.exit(failures ? 1 : 0);
