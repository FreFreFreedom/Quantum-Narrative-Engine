#!/usr/bin/env node
// Selftest for the task size judge (tierForTask).
//
//   npm run tier:selftest
//
// Why this file exists. 'mini' is what skips BOTH the plan draft and the world-look, so a
// wrong 'mini' is the one misjudgment here that can hurt: it sends an under-specified
// request straight to a coding agent with no brief written for it. Everything else about
// this judge is cheap to get wrong — a task wrongly called 'standard' loses about thirty
// seconds to a draft.
//
// So the assertions below are deliberately lopsided. They pin the SAFE direction hard
// (nothing that introduces new work may be 'mini', no matter how few words it takes to
// ask) and pin the fast lane only on the cases Antoine actually types.
//
// The old rule required one of eight literal words AND <=30 words, and across his first 31
// real tasks it fired zero times. The examples marked (real) are taken from those tasks.
//
// No DB, no network, no model calls.

import { tierForTask } from '../server/src/services/taskPlanner.js';

let pass = 0; let fail = 0;
function ok(label, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`); }
}
function section(t) { console.log(`\n${t}`); }
function is(text, want, note = '') {
  const got = tierForTask(text);
  ok(`${want.padEnd(8)} ${JSON.stringify(text.length > 46 ? text.slice(0, 46) + '…' : text)}${note ? `  (${note})` : ''}`,
    got === want, `got '${got}'`);
}

section('Small, concrete adjustments — these are the whole point of the fast lane');
is('the button is too small', 'mini');
is('make this button please at a better place', 'mini', 'real');
is('move the mic button to the left', 'mini');
is('the label is cut off on mobile', 'mini');
is('fix the spacing on the suggestion card, it is far too tight and looks cramped', 'mini', 'MINI_DOWNERS widens to 40 words');

section('New capability — never mini, however short the ask');
is('add GraphRAG', 'standard', 'the two-word trap');
is('add a Web Speech mic button to the task composer', 'standard', 'real');
is('implement Reddit API integration', 'standard', 'real');
is('integrate Google Books', 'standard', 'real');
is('create a settings page', 'standard');
is('set up a webhook', 'standard');
is('build the export view', 'standard');

section('Genuinely big — unchanged behaviour');
is('rewrite the auth system', 'deep');
is('refactor the queue', 'deep');
is('redesign the whole navigation', 'deep');
is(`please look at ${'word '.repeat(70)}`.trim(), 'deep', 'over 65 words');

section('Shape, not just length — a pasted plan is never one small ask');
is('Every card says what it is.\nAnd a second demand.\nAnd a third one.', 'standard', 'multi-line');
is('- do this\n- and that', 'standard', 'a list');
is('# Plan\n\nMake the thing better.', 'standard', 'a heading');
is('the graph is slow. it also flickers. and the labels overlap.', 'standard', 'three sentences');

section('The invariant that actually protects him');
const NEW_WORK_WORDS = ['add ', 'implement', 'build ', 'create', 'integrate', 'support for', 'new ', 'from scratch', 'set up', 'introduce'];
const probes = [
  'add a button', 'implement search', 'build a page', 'create an index',
  'integrate stripe', 'support for pdf', 'new tab please', 'set up logging',
  'introduce a cache', 'do it from scratch',
  'add', 'ADD A THING', 'Please add a small thing',
];
let leaked = null;
for (const t of probes) {
  const hay = t.toLowerCase();
  if (NEW_WORK_WORDS.some((k) => hay.includes(k)) && tierForTask(t) === 'mini') { leaked = t; break; }
}
ok('nothing that introduces new work is ever judged small', !leaked, leaked ? `"${leaked}" came back mini` : '');

// The empty/degenerate cases must not fall into the fast lane by accident either — an
// empty prompt cannot be verified as small, and createPrompt already rejects it, but the
// judge should not be the thing that says "tiny, run it raw".
ok("an empty request is not 'mini'", tierForTask('') !== 'mini', `got '${tierForTask('')}'`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
