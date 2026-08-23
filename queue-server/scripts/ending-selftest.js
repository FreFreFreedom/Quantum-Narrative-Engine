#!/usr/bin/env node
// ending-selftest.js — the "a task ended" announcement. No network, no model credits.
//
// WHY. The three faults on 2026-08-23 (see feedback_shipped_and_inert) were all invisible
// to a code review: two were arithmetic, one a missing keyword. This announcer has exactly
// that shape of risk — its worst bug is a REPLAY (every finished task announced again on
// page load), which you cannot see by reading and can only see by running it twice.
//
// The functions live inside fmcns_navigator.html, so there is nothing to import. This
// extracts them from the served mirror and runs them against a fake Notification. That
// also means a drift between the two files fails here rather than in production.
//
// Run: npm run ending:selftest
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVED = resolve(HERE, '../public/index.html');
const MASTER = resolve(HERE, '../../fmcns_navigator.html');

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed++; console.log(`✗ ${name}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`); }
  else console.log(`✓ ${name}`);
}

// ── The mirror is the file the server actually serves ────────────────────────────────
// A frontend-only change looks perfect locally and ships nothing if this drifts.
const served = readFileSync(SERVED, 'utf8');
const master = readFileSync(MASTER, 'utf8');
console.log('\n— the served file matches the master copy —');
check('public/index.html === fmcns_navigator.html', served === master, true);

// ── Extract the announcer and run it for real ───────────────────────────────────────
function extract(src, startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  const b = src.indexOf(endMarker, a);
  if (a < 0 || b < 0) throw new Error(`could not find ${startMarker.slice(0, 40)}…`);
  return src.slice(a, b);
}
const block = extract(served, 'const Q_ENDED_STATUSES', 'async function qLoad()');

// The fake browser. Only what the announcer touches.
let notified = [];
let askCount = 0;
let permission = 'granted';
const sandbox = {
  Notification: class {
    static get permission() { return permission; }
    static requestPermission() { askCount++; return Promise.resolve(permission); }
    constructor(title, opts) { notified.push({ title, body: opts && opts.body, tag: opts && opts.tag }); }
    close() {}
  },
  window: { focus() {} }, setMode() {}, switchCoreView() {}, renderFlow() {},
  apiWrite: () => Promise.resolve(), qPrompts: [], flowSideSel: null, qSelected: null,
};
// `let` declarations in the block are function-scoped here, so a fresh call to make()
// gives a genuinely fresh module state — which is what lets the seeding test be honest.
const make = new Function(...Object.keys(sandbox), block + '; return { qAnnounceEndings, qEndedBody };');
const fresh = () => make(...Object.values(sandbox));

const DONE = { id: 'a', title: 'A task', status: 'done', result_line: 'Built the thing' };
const BLOCKED = { id: 'b', title: 'B task', status: 'blocked', blocked_reason: 'quota',
  blocked_why: 'every model was out of quota — it will retry when limits reset' };
const RUNNING = { id: 'c', title: 'C task', status: 'running' };

console.log('\n— the first poll must be silent —');
// THE BUG THAT MATTERS. Opening the app must not announce every task that ever finished.
let api = fresh(); notified = [];
api.qAnnounceEndings([DONE, BLOCKED, RUNNING]);
check('nothing announced on the seeding poll', notified.length, 0);

console.log('\n— an ending after that is announced, exactly once —');
api.qAnnounceEndings([DONE, BLOCKED, RUNNING, { id: 'd', title: 'D task', status: 'done', result_line: 'ok' }]);
check('one notification', notified.length, 1);
check('it names the task', notified[0].title, 'Done — D task');
api.qAnnounceEndings([DONE, BLOCKED, RUNNING, { id: 'd', title: 'D task', status: 'done', result_line: 'ok' }]);
check('a repeat poll does not announce it again', notified.length, 1);

console.log('\n— a reload replays nothing —');
// Same data, fresh page. This is the replay case, and reading the code will not show it.
api = fresh(); notified = [];
api.qAnnounceEndings([DONE, BLOCKED, { id: 'd', title: 'D task', status: 'done' }]);
check('a reload with three finished tasks announces none', notified.length, 0);

console.log('\n— a stopped task reads as stopped —');
api = fresh(); notified = [];
api.qAnnounceEndings([RUNNING]);                              // seed
api.qAnnounceEndings([BLOCKED]);
check('titled Stopped, not Done', notified[0].title, 'Stopped — B task');
check('the body is the plain sentence the server wrote', notified[0].body, BLOCKED.blocked_why);
check('tagged per task so a repeat replaces rather than stacks', notified[0].tag, 'fmcns-task-b');

console.log('\n— permission is asked once, at the first ending, never on load —');
api = fresh(); notified = []; askCount = 0; permission = 'default';
api.qAnnounceEndings([RUNNING]);
check('seeding asks for nothing', askCount, 0);
api.qAnnounceEndings([DONE]);
check('the first real ending asks once', askCount, 1);
api.qAnnounceEndings([DONE, BLOCKED]);
check('it never asks a second time', askCount, 1);

console.log('\n— a refusal is an answer —');
api = fresh(); notified = []; askCount = 0; permission = 'denied';
api.qAnnounceEndings([RUNNING]);
api.qAnnounceEndings([DONE]);
check('nothing is shown', notified.length, 0);
check('and it does not ask', askCount, 0);
permission = 'granted';

console.log('\n— the words for each ending —');
api = fresh();
check('quota → the server sentence', api.qEndedBody(BLOCKED), BLOCKED.blocked_why);
check('cancelled with no reason', api.qEndedBody({ status: 'cancelled' }), 'Stopped before it finished.');
check('blocked with no reason', api.qEndedBody({ status: 'blocked' }), 'Stopped part-way.');
check('done but built nothing',
  api.qEndedBody({ status: 'done', ship: { state: 'nothing_changed' } }), 'Finished — but nothing was built.');
check('done, falls back to the result line',
  api.qEndedBody({ status: 'done', result_line: 'Built the thing' }), 'Built the thing');
// Never a status code, and never the empty string — a notification with no body is noise.
check('done with nothing at all still says something',
  api.qEndedBody({ status: 'done' }), 'Finished.');

console.log('\n— it never claims "nothing built" from an absence —');
// shipStateForBlocked returns null when nothing was measured. The badge and this body
// must both read the explicit state only; inferring it would accuse a task falsely.
check('no ship data → not the nothing-built sentence',
  api.qEndedBody({ status: 'done', result_line: 'x' }) === 'Finished — but nothing was built.', false);
check('the badge is gated on the explicit state',
  /p\.ship && p\.ship\.state === 'nothing_changed'/.test(served), true);

console.log('\n— an announcement can never break the poll —');
api = fresh(); notified = [];
api.qAnnounceEndings(null);
api.qAnnounceEndings(undefined);
check('a missing list is survivable', true, true);

console.log('\n— Purpose is only relabelled on a stopped card —');
check('the label is conditional', /\$\{stopped \? 'What it was meant to do' : 'Purpose'\}/.test(served), true);
check('stopped means blocked or cancelled only',
  /const stopped = p\.status === 'blocked' \|\| p\.status === 'cancelled';/.test(served), true);
check('an empty outcome draws no heading', /const outcomeHtml = outcomeBits \?/.test(served), true);

console.log(failed ? `\n${failed} check(s) failed\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
