#!/usr/bin/env node
// Proves the second-opinion review without spending a single model credit.
//
//   node scripts/review-selftest.js
//
// Everything in codeReviewPass.js that decides anything is a pure function, and
// the one part that isn't (the model call) is injected — so this runs the whole
// pass against a real throwaway commit with a fake reviewer, and asserts the two
// things that actually matter:
//
//   · a normal finding does NOT stop the change going live;
//   · a secret or a removed login check DOES.
//
// Plus the failure paths, which matter just as much: a reviewer that times out,
// declines, or replies with prose must leave the task shipping exactly as it did
// before this feature existed. A review that can strand work is worse than none.
//
// No test framework in this repo, by design — a plain script that exits non-zero
// on the first broken expectation.

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  needsSecurityPass, parseFindings, runReviewPass, summariseForAntoine, concernLines, buildDiff,
} from '../server/src/services/codeReviewPass.js';

let failures = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

// ─── A throwaway repo with one commit, so buildDiff has something real to read ──
function scratchRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'review-selftest-'));
  const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-q']);
  git(['config', 'user.email', 'selftest@fmcns.local']);
  git(['config', 'user.name', 'selftest']);
  writeFileSync(join(dir, 'thing.js'), 'export const a = 1;\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);
  const base = git(['rev-parse', 'HEAD']);
  writeFileSync(join(dir, 'thing.js'), 'export const a = 1;\nexport const b = a + 1;\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'change']);
  const head = git(['rev-parse', 'HEAD']);
  return { dir, base, head };
}

const reply = (findings) => async () => JSON.stringify({ findings });
const FINDING = { severity: 'high', blocking: false, file: 'thing.js', line: 2, what: 'b is never used', why: 'nothing reads it' };
const SECRET = { severity: 'high', blocking: true, file: 'thing.js', line: 2, what: 'A password was left in the code', why: 'anyone reading the project can see it' };

const repo = scratchRepo();
const pass = (callModel, files = ['thing.js']) => runReviewPass({
  root: repo.dir, baseSha: repo.base, headSha: repo.head, files, task: { title: 'selftest' }, callModel,
});

try {
  console.log('\n1. the diff is real and is the task\'s own change');
  {
    const d = buildDiff(repo.dir, repo.base, repo.head);
    ok(!d.error && /export const b/.test(d.text), 'read the change', d.error || `${d.text.length} chars`);
    ok(buildDiff(repo.dir, repo.base, null).error !== null, 'no commit is reported, not thrown');
  }

  console.log('\n2. when the security pass runs (free, no model call)');
  {
    ok(needsSecurityPass(['queue-server/server/src/auth.js'], '').yes, 'the login code triggers it');
    ok(needsSecurityPass(['queue-server/server/src/routes/chat.js'], '').yes, 'an endpoint triggers it');
    ok(needsSecurityPass(['README.md'], '').yes === false, 'a doc change does not');
    ok(needsSecurityPass(['thing.js'], '+const password = "hunter2hunter2"').yes, 'a key in the new lines triggers it');
    ok(needsSecurityPass(['thing.js'], '-const password = "hunter2hunter2"').yes === false,
      'a key on a REMOVED line does not — it was already there');
  }

  console.log('\n3. reading the reply');
  {
    ok(parseFindings('```json\n{"findings":[]}\n```').findings.length === 0, 'a fenced empty list is fine');
    ok(parseFindings('Here you go: {"findings":[' + JSON.stringify(FINDING) + ']}').findings.length === 1,
      'JSON with a preamble still reads');
    ok(parseFindings('I could not review this.').findings.length === 0, 'prose is zero findings, not a crash');
    ok(parseFindings('').findings.length === 0, 'an empty reply is zero findings');
    ok(parseFindings('{"findings":[{"what":"x","blocking":"yes"}]}').findings[0].blocking === false,
      'a non-boolean blocking is forced false — a hallucinated one would park a task');
    ok(parseFindings(JSON.stringify({ findings: Array(40).fill(FINDING) })).findings.length === 12,
      'a runaway list is capped');
  }

  console.log('\n4. an ordinary finding does NOT stop the change');
  {
    const out = await pass(reply([FINDING]));
    ok(out.ran === true, 'the review ran');
    ok(out.findings.length === 1, 'the finding is kept');
    ok(out.blocking === false, 'nothing is held back');
    ok(concernLines(out.findings)[0].startsWith('b is never used'), 'it becomes a note', concernLines(out.findings)[0]);
  }

  console.log('\n5. a secret DOES stop the change');
  {
    const out = await pass(reply([FINDING, SECRET]));
    ok(out.blocking === true, 'held back');
    ok(concernLines(out.findings)[0].startsWith('Held back:'), 'the blocking one is listed first');
    ok(/^Held back/.test(summariseForAntoine(out.findings)), 'the one-line summary says so',
      summariseForAntoine(out.findings));
  }

  console.log('\n6. the security pass only runs when it is needed');
  {
    let calls = 0;
    const counting = async () => { calls++; return '{"findings":[]}'; };
    await pass(counting, ['README.md']);
    ok(calls === 1, 'an ordinary change is one call', `${calls}`);
    calls = 0;
    const out = await pass(counting, ['queue-server/server/src/auth.js']);
    ok(calls === 2, 'a change to the login code is two', `${calls}`);
    ok(out.security_ran === true, 'and it says so');
  }

  console.log('\n7. a broken reviewer never strands the work');
  {
    const timedOut = await pass(async () => { throw new Error('no response after 180s'); });
    ok(timedOut.ran === false && timedOut.blocking === false, 'a timeout blocks nothing', timedOut.error);

    const prose = await pass(async () => 'I am unable to review this change.');
    ok(prose.ran === true && prose.blocking === false && prose.findings.length === 0,
      'an unreadable reply blocks nothing', prose.error || '');

    const none = await runReviewPass({ root: repo.dir, baseSha: repo.base, headSha: repo.head, files: [] });
    ok(none.ran === false && none.blocking === false, 'no reviewer at all blocks nothing', none.error);

    // The security pass failing on its own must not lose the code review either.
    let n = 0;
    const secondFails = async () => { n++; if (n === 2) throw new Error('boom'); return JSON.stringify({ findings: [FINDING] }); };
    const partial = await pass(secondFails, ['queue-server/server/src/auth.js']);
    ok(partial.ran === true && partial.findings.length === 1 && partial.blocking === false,
      'the code review survives a failed security pass', partial.error || '');
  }

  console.log('\n8. the summary is plain English for someone who is not a programmer');
  {
    const clean = summariseForAntoine([]);
    ok(!/\b(diff|commit|SHA|repo|null|undefined)\b/i.test(clean), 'no jargon in the clean case', clean);
    ok(summariseForAntoine([FINDING]).includes('worth a look'), 'notes are described as notes',
      summariseForAntoine([FINDING]));
  }
} catch (e) {
  console.error('\nself-test crashed:', e.stack || e.message);
  failures++;
}

console.log(failures ? `\nFAILED — ${failures} broken expectation(s)\n` : '\nAll good.\n');
process.exit(failures ? 1 : 0);
