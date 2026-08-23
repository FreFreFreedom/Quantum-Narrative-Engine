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

console.log(failed ? `\n${failed} check(s) failed\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
