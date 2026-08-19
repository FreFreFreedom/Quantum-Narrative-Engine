// The publish step. Runs on Antoine's Mac, driven by the runner.
//
// This is the half the server cannot do: it has no git repository (Railway builds
// from a tarball), so every merge it ever tried returned `no_git` and nothing this
// app produced was ever published. The server now records the intention as a
// `git_jobs` row and the runner brings it here.
//
// Two decisions worth knowing before reading the code:
//
// 1. It works in its own DISPOSABLE DETACHED worktree, never the checkout Antoine
//    works in. The old server-side merge refused to run whenever the repo had
//    uncommitted edits — which is nearly always, since that checkout is where the
//    work happens. Detached because the trunk is already checked out in the main
//    repo, and a branch cannot be checked out twice. Reset hard before every job,
//    so a previous failure can never poison the next one.
//
// 2. It lands on the TRUNK and pushes both refs in one go. `develop` is where this
//    project's work lives; `main` is only the pointer Railway deploys from (local
//    main sits ~80 commits behind). Merging into `main` alone — what the old code
//    did — would put the deploy pointer ahead of the trunk and break every
//    subsequent ordinary deploy, including by hand.
//
// GIT_SHIP_DRY_RUN=1 does everything except the push, and reports what it would
// have pushed. That is how this gets proven before it is trusted.

import { execFileSync } from 'node:child_process';
import { existsSync, copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runShipChecks } from '../server/src/services/shipChecks.js';

const APP_FILE = 'fmcns_navigator.html';
const SERVED_FILE = 'queue-server/public/index.html';

function git(cwd, args, { lines = false } = {}) {
  try {
    const out = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const t = out.trim();
    return lines ? (t ? t.split('\n').map((l) => l.trim()).filter(Boolean) : []) : t;
  } catch (e) {
    return lines ? null : null;
  }
}

// A worktree kept for this purpose alone, reused between jobs. `.claude/worktrees`
// is already git-excluded, so it never shows up as a stray file.
function shipTree(repo, trunk) {
  const path = join(repo, '.claude', 'worktrees', 'ship');
  if (!existsSync(path)) {
    const base = git(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${trunk}`]) ? `origin/${trunk}` : 'HEAD';
    if (git(repo, ['worktree', 'add', '--detach', path, base]) === null) return null;
  }
  return path;
}

function fetchTrunk(repo, wt, trunk) {
  // Both refs: the trunk to merge onto, and the deploy pointer we also move.
  git(wt, ['fetch', 'origin', trunk, 'main', '--quiet']);
  return git(wt, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${trunk}`]);
}

// Wipe the ship tree back to the current trunk. Safe because nothing but this
// module ever writes here.
function resetToTrunk(wt, trunk) {
  git(wt, ['reset', '--hard', `origin/${trunk}`]);
  git(wt, ['clean', '-fd', '-e', 'node_modules']);
}

function pushBoth(wt, trunk, dryRun) {
  if (dryRun) return { ok: true, dry: true, would_push: [trunk, 'main'] };
  // One command for both refs so the trunk and the deploy pointer can never end up
  // pointing at different commits — which is what breaks ordinary deploys.
  const out = git(wt, ['push', '--atomic', 'origin', `HEAD:refs/heads/${trunk}`, 'HEAD:refs/heads/main']);
  if (out === null) return { ok: false, error: 'push_rejected' };
  return { ok: true, pushed: [trunk, 'main'] };
}

// ─── ship ─────────────────────────────────────────────────────────────────────

export function shipJob(job, { repo, trunk = 'develop', dryRun = false, log = () => {} } = {}) {
  const wt = shipTree(repo, trunk);
  if (!wt) return { ok: false, error: 'no_ship_worktree', detail: 'could not make a publishing folder' };

  if (!fetchTrunk(repo, wt, trunk)) return { ok: false, error: 'network', detail: `cannot see origin/${trunk}` };

  // Already published? This is the one genuinely dangerous case: the runner pushed,
  // then died before it could report. Without this check a retry would merge the
  // same work twice.
  if (job.head_sha && git(wt, ['merge-base', '--is-ancestor', job.head_sha, `origin/${trunk}`]) !== null) {
    const found = git(wt, ['log', `origin/${trunk}`, '--merges', `--grep=Ship-Review: ${job.review_id}`, '--format=%H', '-n', '1']);
    log('already published — recovering the record');
    return { ok: true, already: true, merge_commit: found || null };
  }

  resetToTrunk(wt, trunk);

  // --no-ff always, so every publish is exactly one merge commit. That is what
  // makes "put it back" a single, reliable reverse-commit later.
  if (git(wt, ['merge', '--no-ff', '--no-commit', job.branch]) === null) {
    const conflicts = git(wt, ['diff', '--name-only', '--diff-filter=U'], { lines: true }) || [];
    git(wt, ['merge', '--abort']);
    resetToTrunk(wt, trunk);
    return { ok: false, error: 'conflict', conflicts, detail: conflicts.join(', ') };
  }

  // The app exists twice and AGENTS.md requires them identical. The runner already
  // syncs them in the task's own commit; this is the net for anything that reached
  // the trunk another way.
  try {
    if (existsSync(join(wt, APP_FILE)) && existsSync(join(wt, SERVED_FILE))
      && readFileSync(join(wt, APP_FILE), 'utf8') !== readFileSync(join(wt, SERVED_FILE), 'utf8')) {
      copyFileSync(join(wt, APP_FILE), join(wt, SERVED_FILE));
      git(wt, ['add', '--', SERVED_FILE]);
      log('re-synced the served copy of the app page');
    }
  } catch { /* not worth failing a publish over */ }

  const subject = String(job.commit_subject || `ship: ${job.branch}`).slice(0, 72);
  if (git(wt, ['commit', '-m', subject, '-m', `Ship-Review: ${job.review_id}`]) === null) {
    resetToTrunk(wt, trunk);
    return { ok: false, error: 'commit_failed', detail: 'the merge could not be recorded' };
  }

  // Re-check the MERGED result, not just the branch. Two changes that are each fine
  // on their own can combine into broken syntax, and this is the last moment before
  // it becomes the live app.
  const merged = git(wt, ['diff', '--name-only', 'HEAD~1...HEAD'], { lines: true }) || [];
  const checks = runShipChecks(wt, merged);
  if (!checks.ok) {
    const detail = checks.checks.syntax.ok ? checks.checks.html.detail : checks.checks.syntax.detail;
    resetToTrunk(wt, trunk);
    return { ok: false, error: 'post_merge_failed', detail };
  }

  const mergeCommit = git(wt, ['rev-parse', 'HEAD']);
  const pushed = pushBoth(wt, trunk, dryRun);
  if (!pushed.ok) {
    resetToTrunk(wt, trunk);   // nothing half-done is left behind
    return { ok: false, error: pushed.error, detail: 'publishing was refused — nothing changed online' };
  }
  if (pushed.dry) {
    resetToTrunk(wt, trunk);
    log(`DRY RUN — would have published ${mergeCommit.slice(0, 8)} to ${pushed.would_push.join(' + ')}`);
    return { ok: false, error: 'dry_run', detail: `would have published to ${pushed.would_push.join(' + ')}`, merge_commit: mergeCommit, would_push: pushed.would_push };
  }

  // Tidy up the task's folder now its work is safely on the trunk. The branch is
  // deliberately kept — it is the thing that makes the work recoverable.
  try {
    const tw = join(repo, '.claude', 'worktrees', '');
    for (const line of git(repo, ['worktree', 'list', '--porcelain'], { lines: true }) || []) {
      if (!line.startsWith('worktree ')) continue;
      const path = line.slice('worktree '.length);
      if (!path.startsWith(tw)) continue;
      if (git(repo, ['-C', path, 'rev-parse', '--abbrev-ref', 'HEAD']) === job.branch) {
        git(repo, ['worktree', 'remove', '--force', path]);
        log('cleared the task folder');
      }
    }
  } catch { /* housekeeping only */ }

  log(`published ${mergeCommit.slice(0, 8)} to ${pushed.pushed.join(' + ')}`);
  return { ok: true, merge_commit: mergeCommit, pushed: pushed.pushed };
}

// ─── undo ─────────────────────────────────────────────────────────────────────

export function undoJob(job, { repo, trunk = 'develop', dryRun = false, log = () => {} } = {}) {
  const wt = shipTree(repo, trunk);
  if (!wt) return { ok: false, error: 'no_ship_worktree' };
  if (!job.merge_commit) return { ok: false, error: 'nothing_to_undo' };
  if (!fetchTrunk(repo, wt, trunk)) return { ok: false, error: 'network' };
  resetToTrunk(wt, trunk);

  // A reversing commit, NOT a rewind. Anything published after this one stays
  // published, which a reset could not promise — and a reset could not be pushed
  // without force anyway.
  if (git(wt, ['revert', '-m', '1', job.merge_commit, '--no-edit']) === null) {
    git(wt, ['revert', '--abort']);
    resetToTrunk(wt, trunk);
    return { ok: false, error: 'revert_conflict' };
  }

  const pushed = pushBoth(wt, trunk, dryRun);
  if (!pushed.ok) { resetToTrunk(wt, trunk); return { ok: false, error: pushed.error }; }
  if (pushed.dry) {
    resetToTrunk(wt, trunk);
    log(`DRY RUN — would have put ${job.merge_commit.slice(0, 8)} back`);
    return { ok: false, error: 'dry_run', detail: 'would have put it back' };
  }

  log(`put ${job.merge_commit.slice(0, 8)} back`);
  return { ok: true, reverted: job.merge_commit, pushed: pushed.pushed };
}
