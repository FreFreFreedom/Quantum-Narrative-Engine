#!/usr/bin/env node
// Proves the runner's "save the work" step without touching the live queue, the
// live app, or a single model credit.
//
//   node scripts/ship-selftest.js
//
// It makes a throwaway worktree, edits a file in it, runs the real commitWork(),
// and asserts the outcome — including the case that matters most: a syntax error
// must be reported as a failed check while the work is still committed, because
// losing the work is worse than not publishing it.
//
// There is no test framework in this repo (by design), so this is a plain script
// that exits non-zero on the first broken expectation.

import { execFileSync } from 'node:child_process';
import { writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { commitWork, TRUNK } from './queue-runner.js';

const REPO = resolve(process.cwd(), '..');
let failures = 0;
let made = [];

const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};
const git = (args, cwd = REPO) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function scratch(name) {
  const branch = `selftest/${name}-${process.pid}`;
  const path = join(REPO, '.claude', 'worktrees', `selftest-${name}-${process.pid}`);
  let base = 'HEAD';
  try { git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${TRUNK}`]); base = `origin/${TRUNK}`; } catch {}
  git(['worktree', 'add', '-b', branch, path, base]);
  made.push({ path, branch });
  return { path, branch, base };
}

function cleanup() {
  for (const { path, branch } of made) {
    try { git(['worktree', 'remove', '--force', path]); } catch {}
    try { git(['branch', '-D', branch]); } catch {}
  }
}

const task = (over = {}) => ({ id: 'selftest-0000-0000', title: 'Self-test: a harmless change', mode: 'implement', work_prompt_id: null, ...over });

try {
  const trunkSha = (() => { try { return git(['rev-parse', `origin/${TRUNK}`]); } catch { return null; } })();

  console.log('\n1. a clean change is committed, with passing checks');
  {
    const wt = scratch('clean');
    appendFileSync(join(wt.path, 'RUN_LOG.md'), '\n<!-- ship self-test, safe to delete -->\n');
    const ship = commitWork({ wt, task: task(), status: 'done', summary: 'Appended one comment line.', model: 'selftest' });
    ok(ship.committed === true, 'committed', ship.reason || '');
    ok(ship.checks_ok === true, 'checks passed');
    ok(ship.files_changed?.includes('RUN_LOG.md'), 'the changed file is reported');
    ok(/^[0-9a-f]{40}$/.test(ship.head_sha || ''), 'a real commit sha came back', ship.head_sha?.slice(0, 8));
    ok(ship.insertions > 0, 'insertions counted', String(ship.insertions));
    ok(git(['status', '--porcelain'], wt.path) === '', 'the worktree is clean afterwards');
  }

  console.log('\n2. a syntax error still commits, but fails the check');
  {
    const wt = scratch('broken');
    writeFileSync(join(wt.path, 'queue-server/scripts/selftest-broken.js'), 'const x = ;\n');
    const ship = commitWork({ wt, task: task(), status: 'done', summary: '', model: 'selftest' });
    ok(ship.committed === true, 'the work is preserved anyway');
    ok(ship.checks_ok === false, 'the check refuses it');
    ok(/selftest-broken\.js/.test(ship.checks?.syntax?.detail || ''), 'it names the broken file', ship.checks?.syntax?.detail?.slice(0, 60));
  }

  console.log('\n3. the frontend copy is kept in step, in the same commit');
  {
    const wt = scratch('sync');
    // Inserted BEFORE </html>, not appended after it — appending would trip the
    // truncation guard, which is correct behaviour and not what this case is about.
    const appPath = join(wt.path, 'fmcns_navigator.html');
    const app = readFileSync(appPath, 'utf8');
    writeFileSync(appPath, app.replace(/<\/html>(\s*)$/, '<!-- ship self-test -->\n</html>$1'));
    const ship = commitWork({ wt, task: task(), status: 'done', summary: '', model: 'selftest' });
    ok(ship.committed === true, 'committed');
    ok(ship.files_changed?.includes('queue-server/public/index.html'), 'the served copy went in too');
    const a = git(['show', `${ship.head_sha}:fmcns_navigator.html`], wt.path);
    const b = git(['show', `${ship.head_sha}:queue-server/public/index.html`], wt.path);
    ok(a === b, 'both copies are identical in the commit');
    ok(ship.checks?.html?.ok === true, 'the inline scripts still parse');
  }

  console.log('\n4. nothing is committed when there is nothing to commit');
  {
    const wt = scratch('empty');
    const ship = commitWork({ wt, task: task(), status: 'done', summary: '', model: 'selftest' });
    ok(ship.committed === false && ship.reason === 'nothing_changed', 'reported as "nothing changed"', ship.reason);
  }

  console.log('\n5. a blocked task is left alone, so its retry can resume');
  {
    const wt = scratch('blocked');
    appendFileSync(join(wt.path, 'RUN_LOG.md'), '\nhalf-done\n');
    const ship = commitWork({ wt, task: task(), status: 'blocked', summary: '', model: 'selftest' });
    ok(ship.committed === false && ship.reason === 'blocked', 'no commit', ship.reason);
    ok(git(['status', '--porcelain'], wt.path) !== '', 'the half-done work is still sitting in the folder');
  }

  console.log('\n6. a question task is left alone');
  {
    const wt = scratch('question');
    const ship = commitWork({ wt, task: task({ mode: 'question' }), status: 'done', summary: '', model: 'selftest' });
    ok(ship.committed === false && ship.reason === 'question_mode', 'no commit', ship.reason);
  }

  console.log('\n7. nothing was published to the trunk');
  {
    const now = (() => { try { return git(['rev-parse', `origin/${TRUNK}`]); } catch { return null; } })();
    ok(now === trunkSha, `origin/${TRUNK} is untouched`, (now || 'n/a').slice(0, 8));
  }
} catch (e) {
  console.error('\nself-test crashed:', e.message);
  failures++;
} finally {
  cleanup();
}

console.log(failures ? `\nFAILED — ${failures} broken expectation(s)\n` : '\nAll good.\n');
process.exit(failures ? 1 : 0);
