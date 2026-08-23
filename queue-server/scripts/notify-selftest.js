#!/usr/bin/env node
// notify-selftest.js — proves the "a task cannot end silently" machinery, with zero
// model credits and no network.
//
// WHY THIS EXISTS. On 2026-08-23 a task blocked because every model was out of quota.
// Nothing told Antoine. Four separate faults had to line up for that: the ending was
// decided server-side (where the notice went to an unset webhook), `blocked` carried no
// cause so it read like a real failure, the runner never recorded that zero files had
// changed, and the card had no review to read so it showed nothing at all.
//
// The rule this file mostly exists to defend is the one borrowed from
// services/ideaLanded.js: a null is missing information, not a finding. A card must
// never say "nothing was built" because it has no data — only because it has data
// saying zero. That is the assertion at the bottom, and it is the one worth keeping.
//
// Run: npm run notify:selftest
import { shipStateForBlocked } from '../server/src/services/gitJobs.js';
import { blockedWords } from '../server/src/services/promptQueue.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed++; console.log(`✗ ${name}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`); }
  else console.log(`✓ ${name}`);
}
function checkTrue(name, got) { check(name, !!got, true); }

console.log('\n— the cause has words for every code the runner can send —');
// Every value stamped anywhere in queue-runner.js / promptQueue.js must have a phrase.
// A missing one would surface the raw code name to Antoine, which is the jargon the
// house style forbids.
for (const r of ['no_engine', 'quota', 'timeout', 'nothing_changed', 'crashed', 'lost']) {
  checkTrue(`"${r}" has plain words`, blockedWords(r));
}
check('an unknown cause says nothing rather than inventing', blockedWords('wat'), null);
check('no cause at all says nothing', blockedWords(null), null);

// The two that mean "it will sort itself out" must read that way, because that is the
// whole reason the cause is stored: these need no reaction, the others need a person.
checkTrue('"quota" says it will retry', /retry/i.test(blockedWords('quota')));
checkTrue('"no_engine" says it will retry', /retry/i.test(blockedWords('no_engine')));
checkTrue('"crashed" does NOT promise a retry', !/retry/i.test(blockedWords('crashed')));
checkTrue('"timeout" does NOT promise a retry', !/retry/i.test(blockedWords('timeout')));

console.log('\n— the card speaks only from a stored fact —');

// THE IMPORTANT ONE. Nothing measured: the task blocked before the runner ever got to
// look at git. Absence of data is not evidence that nothing was built.
check('no ship data at all → no claim',
  shipStateForBlocked({ ship_skip_reason: null, ship_files: null, ship_insertions: null, ship_deletions: null }),
  null);
check('a missing task → no claim', shipStateForBlocked(null), null);
check('undefined counts are not zeros', shipStateForBlocked({}), null);

// Measured, and the measurement says nothing happened.
const neverRan = shipStateForBlocked({
  ship_skip_reason: 'never_ran', ship_files: '[]', ship_insertions: 0, ship_deletions: 0,
});
check('never ran → nothing_changed', neverRan?.state, 'nothing_changed');
checkTrue('never ran says it never got as far as running', /never got as far/i.test(neverRan?.message || ''));

const ranEmpty = shipStateForBlocked({
  ship_skip_reason: 'nothing_changed', ship_files: '[]', ship_insertions: 0, ship_deletions: 0,
});
check('ran but changed nothing → nothing_changed', ranEmpty?.state, 'nothing_changed');
checkTrue('ran-but-empty says it finished without changing a file', /without changing/i.test(ranEmpty?.message || ''));

// Blocked, but work exists. This must NOT wear the "nothing was built" mark — the work
// is there and needs looking at, which is the opposite message.
check('blocked with real edits → no nothing-built claim',
  shipStateForBlocked({ ship_skip_reason: 'commit_failed', ship_files: '["a.js","b.js"]', ship_insertions: 12, ship_deletions: 3 }),
  null);
check('blocked with insertions but no file list → no claim',
  shipStateForBlocked({ ship_skip_reason: null, ship_files: null, ship_insertions: 40, ship_deletions: 0 }),
  null);

// Corrupt JSON in ship_files must not throw — a lost verdict is a line on a card, a
// thrown one would take out the whole /prompts response.
const bad = shipStateForBlocked({ ship_skip_reason: 'never_ran', ship_files: '{not json', ship_insertions: 0, ship_deletions: 0 });
check('unreadable ship_files degrades instead of throwing', bad?.state, 'nothing_changed');
check('unreadable ship_files counts as zero files', bad?.files, 0);

// ─────────────────────────────────────────────────────────────────────────────────
// "Has it built anything yet?" — the question none of the runner's three time limits
// asks. They all measure whether the model is TALKING; files are counted once, at
// commit time. So a model that emits something every couple of minutes looks healthy
// for the full attempt cap while writing nothing. On 2026-08-23 one did that for 47
// minutes and the only way to know was to open the worktree by hand.
//
// makeIdleWriteWatch lives in queue-runner.js, which starts a runner when imported —
// so it is extracted by text instead, the same way ending-selftest.js does it. That
// also means a drift between this test and the real source fails here.
const runnerSrc = readFileSync(resolve(HERE, 'queue-runner.js'), 'utf8');
const watchSrc = runnerSrc.slice(
  runnerSrc.indexOf('function makeIdleWriteWatch'),
  runnerSrc.indexOf('// The three time limits'));
// NOTHING_WRITTEN_MS is read from the module scope the function closes over, so the
// harness supplies it. 20 min, matching the default in the source.
const MS = 20 * 60_000;
const makeIdleWriteWatch = new Function('NOTHING_WRITTEN_MS', 'gitIn',
  watchSrc + '; return makeIdleWriteWatch;')(MS, () => { throw new Error('gitIn must not be called when a probe is given'); });

// A probe recording how often it was asked, so "stops asking" is a real assertion and
// not a guess about internal state.
function stubProbe(value) {
  const calls = { n: 0 };
  return [() => { calls.n++; return typeof value === 'function' ? value(calls.n) : value; }, calls];
}
const T0 = 1_000_000;   // any fixed clock; Date.now() is never used in here

console.log('\n— it says nothing before the limit —');
let [probe, calls] = stubProbe('');
let check1 = makeIdleWriteWatch({ branch: 'queue/x', cwd: '/tmp', startedAt: T0, probe });
check('silent at 1 min', check1(T0 + 60_000), null);
check('silent at 19 min', check1(T0 + 19 * 60_000), null);
check('and it has not even asked git yet', calls.n, 0);

console.log('\n— past the limit, with nothing written, it says so exactly once —');
[probe, calls] = stubProbe('');
const check2 = makeIdleWriteWatch({ branch: 'queue/x', cwd: '/tmp', startedAt: T0, probe });
const warned = check2(T0 + 21 * 60_000);
checkTrue('it warns', typeof warned === 'string' && warned.includes('no files'));
checkTrue('it names how long', /21 min/.test(String(warned)));
// The important half: a warning every 15s for 100 minutes would be noise, not news.
check('silent on the next tick', check2(T0 + 22 * 60_000), null);
check('silent an hour later', check2(T0 + 80 * 60_000), null);
check('and it stopped asking git', calls.n, 1);

console.log('\n— a task that IS writing is never warned about —');
[probe, calls] = stubProbe('M queue-server/server/src/index.js');
const check3 = makeIdleWriteWatch({ branch: 'queue/x', cwd: '/tmp', startedAt: T0, probe });
check('no warning', check3(T0 + 21 * 60_000), null);
check('no warning later either', check3(T0 + 60 * 60_000), null);
check('it asked once and then stopped', calls.n, 1);

console.log('\n— question mode is never measured —');
// THE ONE THAT WOULD BE ACTIVELY WRONG. With no branch, cwd is the MAIN checkout,
// which is nearly always dirty — measuring it would report the opposite of the truth.
[probe, calls] = stubProbe('M some-unrelated-file.md');
const check4 = makeIdleWriteWatch({ branch: null, cwd: '/repo', startedAt: T0, probe });
check('no warning with no branch', check4(T0 + 90 * 60_000), null);
check('and git is never run in the main checkout', calls.n, 0);

console.log('\n— once a minute, not once a second —');
[probe, calls] = stubProbe(null);   // null keeps it undecided, so it keeps being eligible
const check5 = makeIdleWriteWatch({ branch: 'queue/x', cwd: '/tmp', startedAt: T0, probe });
check5(T0 + 21 * 60_000);
check5(T0 + 21 * 60_000 + 1_000);
check5(T0 + 21 * 60_000 + 30_000);
check('three ticks in 30s ran git once', calls.n, 1);
check5(T0 + 23 * 60_000);
check('a tick two minutes later ran it again', calls.n, 2);

console.log('\n— a failed git command is not evidence —');
// Same rule as shipStateForBlocked above: a null is missing information, not a finding.
// gitIn returns null when git itself fails; reading that as "nothing written" would put
// a false accusation in a banner.
[probe, calls] = stubProbe(null);
const check6 = makeIdleWriteWatch({ branch: 'queue/x', cwd: '/tmp', startedAt: T0, probe });
check('a broken probe produces no warning', check6(T0 + 30 * 60_000), null);
// And it must not give up on the question either — the next probe may succeed.
[probe, calls] = stubProbe((n) => (n === 1 ? null : ''));
const check7 = makeIdleWriteWatch({ branch: 'queue/x', cwd: '/tmp', startedAt: T0, probe });
check('first probe fails, silent', check7(T0 + 21 * 60_000), null);
checkTrue('second probe succeeds and it warns', typeof check7(T0 + 23 * 60_000) === 'string');

console.log('\n— the real source still wires it into both lanes —');
// Two byte-identical watchdogs; a check pasted into only one silently covers half the
// work. And the warning must sit inside the heartbeat branch, after the newline dance,
// or it glues onto mid-stream model text.
check('both lanes build the watch',
  (runnerSrc.match(/makeIdleWriteWatch\(\{ branch, cwd, startedAt \}\)/g) || []).length, 2);
check('both lanes call it and warn',
  (runnerSrc.match(/const idle = idleWrite\(now\);/g) || []).length, 2);
check('both lanes raise a banner',
  (runnerSrc.match(/Still nothing built —/g) || []).length, 2);
check('branch reaches both runners',
  /cwd: wt\.path, branch: wt\.branch/.test(runnerSrc)
  && /runOnce\(\{ task, model, cwd: wt\.path, branch: wt\.branch \}\)/.test(runnerSrc), true);
check('the default probe uses the string form, where a git failure is null',
  /gitIn\(cwd, \['status', '--porcelain'\]\)\)/.test(runnerSrc), true);

console.log(failed ? `\n${failed} check(s) failed\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
