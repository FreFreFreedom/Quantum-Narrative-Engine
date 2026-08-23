#!/usr/bin/env node
// group-selftest.js — the umbrella flag, and nothing else. No network, no model credits.
//
// WHY A WHOLE TEST FOR ONE BOOLEAN. The umbrella feature shipped on 2026-08-23, reported
// itself live, and did nothing at all: createGroup() passes `is_group: true`, createPrompt
// compared `is_group === 1`, and `true === 1` is false. Every umbrella was therefore stored
// as an ordinary task — no collapsing in the Flow, and none of the guards that stop a group
// row being handed to an agent. Six files, +437 lines, inert on one character.
//
// Nothing in the app noticed, because the failure was silent in both directions: the
// frontend filtered on `is_group === 1` over a set that was always empty, so no task went
// missing and no error appeared. A test is the only thing that would have caught it, so
// here is that test.
//
// Run: npm run group:selftest
import { createRequire } from 'node:module';

// The normalisation under test, kept byte-identical to promptQueue.js#createPrompt. If the
// two ever drift this test is worthless, so the assertion below reads the real source and
// fails if the line is gone — a copy that silently stops matching is worse than no copy.
const normalise = (v) => v === true || v === 1 || v === '1';

let failed = 0;
function check(name, got, want) {
  const ok = got === want;
  if (!ok) { failed++; console.log(`✗ ${name}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`); }
  else console.log(`✓ ${name}`);
}

console.log('\n— what makes a group —');
// The one that shipped broken: createGroup() passes a boolean.
check('true → group (the case that shipped broken)', normalise(true), true);
check('1 → group', normalise(1), true);
check('"1" → group (JSON from the composer)', normalise('1'), true);

console.log('\n— what must NOT make a group —');
// A false positive is the dangerous direction: an ordinary task flagged as an umbrella
// would be hidden from the Flow behind a group that owns nothing.
check('false → not a group', normalise(false), false);
check('0 → not a group', normalise(0), false);
check('"0" → not a group', normalise('0'), false);
check('undefined → not a group (the default)', normalise(undefined), false);
check('null → not a group', normalise(null), false);
check('"" → not a group', normalise(''), false);
check('"true" → not a group (a string is not a flag)', normalise('true'), false);
check('2 → not a group', normalise(2), false);

console.log('\n— the real source still normalises the same way —');
// Guards against the fix being reverted, and against this file drifting into fiction.
const require = createRequire(import.meta.url);
const { readFileSync } = require('node:fs');
const { resolve, dirname } = require('node:path');
const { fileURLToPath } = require('node:url');
const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, '../server/src/services/promptQueue.js'), 'utf8');

check('createPrompt normalises true/1/"1"',
  /const isGroup = is_group === true \|\| is_group === 1 \|\| is_group === '1';/.test(src), true);
check('the INSERT writes from isGroup, not a raw comparison',
  /preSkipNote, isGroup \? 1 : 0\)/.test(src), true);
check('no strict `is_group === 1` left on the WRITE side',
  /is_group === 1 \? 1 : 0/.test(src), false);
// The read-side guards are the point of the flag existing — an umbrella that can be
// dispatched is the hazard the whole design exists to prevent.
check('the status-patch guard is still there', /patch\.status !== undefined && row\.is_group === 1/.test(src), true);
check('moveToFront still refuses a group', /if \(target\.is_group === 1\)/.test(src), true);

console.log(failed ? `\n${failed} check(s) failed\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
