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
// 2. It lands on the TRUNK and pushes exactly one ref. There used to be two:
//    `develop` for the work and `main` as a separate pointer for Railway to watch.
//    They never once diverged in the project's whole history, so the second push
//    bought nothing and was a step you could forget — and forgetting it looked
//    exactly like a broken pipeline. On 2026-08-19 Railway was pointed at `develop`
//    and `main` retired. Do NOT add a second ref back here: with `main` gone, an
//    atomic two-ref push either recreates the branch or is refused outright, and a
//    refused atomic push means `develop` never moves either, so every publish and
//    every "Put it back" silently stops working.
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
export function shipTree(repo, trunk) {
  const path = join(repo, '.claude', 'worktrees', 'ship');
  if (!existsSync(path)) {
    const base = git(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${trunk}`]) ? `origin/${trunk}` : 'HEAD';
    if (git(repo, ['worktree', 'add', '--detach', path, base]) === null) return null;
  }
  return path;
}

export function fetchTrunk(repo, wt, trunk) {
  // One ref. This used to fetch `main` alongside the trunk, which becomes a trap the
  // moment `main` stops existing: git fails the ENTIRE fetch on an unknown ref rather
  // than fetching what it can, git() swallows the error, and this function then
  // returns the stale local `origin/<trunk>` as though all were well — so every
  // publish would merge onto an out-of-date trunk and be rejected with a misleading
  // "push refused" instead of the real cause.
  git(wt, ['fetch', 'origin', trunk, '--quiet']);
  return git(wt, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${trunk}`]);
}

// Wipe the ship tree back to the current trunk. Safe because nothing but this
// module ever writes here.
function resetToTrunk(wt, trunk) {
  git(wt, ['reset', '--hard', `origin/${trunk}`]);
  git(wt, ['clean', '-fd', '-e', 'node_modules']);
}

// One branch, one push. Named `pushTrunk` rather than the old `pushBoth` because the
// name was the thing most likely to invite a second ref back.
function pushTrunk(wt, trunk, dryRun) {
  if (dryRun) return { ok: true, dry: true, would_push: [trunk] };
  const out = git(wt, ['push', 'origin', `HEAD:refs/heads/${trunk}`]);
  if (out === null) return { ok: false, error: 'push_rejected' };
  return { ok: true, pushed: [trunk] };
}

// ─── is it already live? ────────────────────────────────────────────────────
// The one genuinely dangerous case for a ship in flight: the runner pushed, then
// died before it could report. Without this check a retry would merge the same
// work twice. Also the whole of the stranded-review sweep (queue-runner.js) —
// same question, asked later and from outside an active ship job, for a review
// that was never mid-flight at all (published by hand, or a ship that failed
// after the push somehow still landed).
//
// Assumes the trunk was already fetched into the ship worktree (fetchTrunk) —
// callers checking many reviews at once (the sweep) fetch exactly once and call
// this per review, rather than paying for a fetch each time.
export function alreadyOnTrunk({ head_sha, review_id }, { repo, trunk = 'develop', log = () => {} } = {}) {
  const wt = shipTree(repo, trunk);
  if (!wt || !head_sha) return { live: false, merge_commit: null };
  if (git(wt, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${trunk}`]) === null) return { live: false, merge_commit: null };
  if (git(wt, ['merge-base', '--is-ancestor', head_sha, `origin/${trunk}`]) === null) {
    return { live: false, merge_commit: null };
  }
  const found = git(wt, ['log', `origin/${trunk}`, '--merges', `--grep=Ship-Review: ${review_id}`, '--format=%H', '-n', '1']);
  log('already published — recovering the record');
  return { live: true, merge_commit: found || null };
}

// ─── ship ─────────────────────────────────────────────────────────────────────

export function shipJob(job, { repo, trunk = 'develop', dryRun = false, log = () => {} } = {}) {
  const wt = shipTree(repo, trunk);
  if (!wt) return { ok: false, error: 'no_ship_worktree', detail: 'could not make a publishing folder' };

  if (!fetchTrunk(repo, wt, trunk)) return { ok: false, error: 'network', detail: `cannot see origin/${trunk}` };

  const already = alreadyOnTrunk(job, { repo, trunk, log });
  if (already.live) return { ok: true, already: true, merge_commit: already.merge_commit };

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
  const pushed = pushTrunk(wt, trunk, dryRun);
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

  const pushed = pushTrunk(wt, trunk, dryRun);
  if (!pushed.ok) { resetToTrunk(wt, trunk); return { ok: false, error: pushed.error }; }
  if (pushed.dry) {
    resetToTrunk(wt, trunk);
    log(`DRY RUN — would have put ${job.merge_commit.slice(0, 8)} back`);
    return { ok: false, error: 'dry_run', detail: 'would have put it back' };
  }

  log(`put ${job.merge_commit.slice(0, 8)} back`);
  return { ok: true, reverted: job.merge_commit, pushed: pushed.pushed };
}
