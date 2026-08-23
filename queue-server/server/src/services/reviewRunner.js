// services/reviewRunner.js — the gate that decides whether a finished task goes
// live, and the record of what did.
//
// It used to do the inspecting AND the git. Both were in the wrong place: it runs
// inside the Railway container, which has no git repository and cannot see the
// worktree the work lives in, so every check failed identically for every task ever
// finished, and every merge returned `no_git`. Nothing this module attempted had
// ever once succeeded in production.
//
// The work is now split by what each machine can actually see:
//   · the Mac's runner    — runs the cheap checks where the files are, and commits
//                           (services/shipChecks.js, scripts/queue-runner.js)
//   · this module         — judges the facts it is told, and keeps the record
//   · services/gitJobs.js — carries the merge/undo over to the Mac to execute
//
// So there is no git in this file at all any more. That is the whole point of it.

import { randomUUID } from 'node:crypto';
import { getAgent } from './agents.js';
import { getPrompt } from './promptQueue.js';
import { autoShipEnabled } from './ai/text.js';
import { shipCheckMessage } from './shipChecks.js';
import { concernLines, summariseForAntoine } from './codeReviewPass.js';
import { enqueueShipJob, enqueueUndoJob, setGitJobHandler } from './gitJobs.js';
import { kickWitnessRecheck } from './witnessCheck.js';
import { broadcastAll } from '../realtime.js';

let db = null;
export function bindReviewsDb(database) { db = database; }

// ─── Row access ───────────────────────────────────────────────────────────────

function parseJsonOr(v, fallback) {
  if (v == null) return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}

function reviewFromRow(row) {
  if (!row) return null;
  return {
    ...row,
    checks: parseJsonOr(row.checks, null),
    concerns: parseJsonOr(row.concerns, []),
    conflicts_with: parseJsonOr(row.conflicts_with, []),
    // files_changed was left as its raw JSON string here, so anything counting it
    // measured the STRING — a one-file change reported as "14 files changed",
    // because that is how long `["RUN_LOG.md"]` is.
    files_changed: parseJsonOr(row.files_changed, []),
  };
}

export function listReviews({ status = null } = {}) {
  if (!db) return [];
  const rows = status
    ? db.prepare(`SELECT * FROM reviews WHERE status=? ORDER BY created_at DESC`).all(status)
    : db.prepare(`SELECT * FROM reviews ORDER BY created_at DESC`).all();
  return rows.map(reviewFromRow).map((r) => {
    const prompt = getPrompt(r.prompt_id);
    return { ...r, prompt_title: prompt?.title || null };
  });
}

// The newest review for a prompt, whatever state it is in — what the Flow list
// reads to show whether a finished task actually went live.
export function latestReviewForPrompt(promptId) {
  if (!db || !promptId) return null;
  return reviewFromRow(db.prepare(
    `SELECT * FROM reviews WHERE prompt_id=? ORDER BY created_at DESC LIMIT 1`
  ).get(promptId));
}

export function getReview(id) {
  if (!db) return null;
  return reviewFromRow(db.prepare(`SELECT * FROM reviews WHERE id=?`).get(id));
}

function updateReview(id, patch) {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === 'id' || k === 'created_at') continue;
    let value = v;
    if ((k === 'checks' || k === 'concerns' || k === 'conflicts_with') && v && typeof v === 'object') value = JSON.stringify(v);
    sets.push(`${k}=?`);
    vals.push(value);
  }
  if (!sets.length) return getReview(id);
  db.prepare(`UPDATE reviews SET ${sets.join(', ')} WHERE id=?`).run(...vals, id);
  const review = getReview(id);
  if (review) broadcastAll('agent:review:updated', { review });
  return review;
}

function broadcastReview(id) {
  const review = getReview(id);
  if (review) broadcastAll('agent:review:updated', { review });
}


// ─── Review creation ──────────────────────────────────────────────────────────

// Called from promptQueue's onAgentTaskFinalized when an implement task finishes
// `done`. Question tasks and branchless runs get no review — there is nothing to
// publish.
//
// This used to run six checks itself, here, inside the Railway container — against
// a worktree path that only ever existed on Antoine's Mac. It therefore failed
// instantly and identically for every task ever finished ("The agent working
// folder no longer exists", six ✗, zero files), so no task in the history of this
// app was ever eligible to ship. The checks now run on the Mac, at commit time,
// where the files actually are (services/shipChecks.js, called by the runner), and
// arrive here as plain facts on the task row. This function's job is to judge, not
// to inspect.
export function createReviewForTask(task) {
  if (!db) return null;
  if (!task || task.status !== 'done' || task.mode === 'question' || !task.branch) return null;

  // Continuations of the same prompt finish too — reuse the open review for that
  // prompt instead of stacking duplicates (the branch is the same one).
  const existing = db.prepare(`
    SELECT * FROM reviews WHERE prompt_id=? AND status IN ('pending','approved','changes_requested') ORDER BY created_at DESC LIMIT 1
  `).get(task.work_prompt_id);

  const verdict = judgeTask(task);

  let id = existing?.id;
  if (!id) {
    id = randomUUID();
    db.prepare(`
      INSERT INTO reviews (id, prompt_id, task_id, agent_key, branch, base_sha, head_sha, status)
      VALUES (?,?,?,?,?,?,?, 'pending')
    `).run(id, task.work_prompt_id, task.id, task.agent_key || 'dev1', task.branch, task.base_sha || null, task.head_sha || null);
  }

  updateReview(id, {
    task_id: task.id,
    branch: task.branch,
    head_sha: task.head_sha || null,
    checks: verdict.checks,
    concerns: verdict.concerns.length ? JSON.stringify(verdict.concerns) : null,
    files_changed: JSON.stringify(verdict.filesChanged),
    insertions: verdict.insertions,
    deletions: verdict.deletions,
    status: verdict.ok ? 'approved' : 'changes_requested',
    verdict: verdict.ok ? 'safe' : (verdict.severity || 'risky'),
    plain_summary: verdict.plainSummary,
  });
  broadcastReview(id);

  if (verdict.ok) scheduleAutoShip(id);
  return getReview(id);
}

// Turn what the runner reported into a verdict. Pure: no git, no filesystem, no
// child processes — so it behaves identically in the Railway container and on the
// Mac, which is exactly what the old version did not.
//
// The runner supplies: head_sha (the commit to publish, or null), ship_checks (the
// two cheap checks it already ran on the files), ship_files, ship_insertions,
// ship_deletions, ship_skip_reason. Scope is judged here because it needs the
// agent's allow/deny rules out of the database, and needs nothing else.
// Exported for scripts/idealanded-selftest.js, which asserts the one property that
// must never quietly change: the ideas check may not alter whether a change is
// allowed to go live. A rule nothing can test is a rule that will be broken.
export function judgeTask(task) {
  const files = parseJsonOr(task.ship_files, []);
  const runnerChecks = parseJsonOr(task.ship_checks, null);
  const insertions = Number(task.ship_insertions) || 0;
  const deletions = Number(task.ship_deletions) || 0;
  const concerns = [];

  // No commit means there is nothing to publish. Say which of the reasons it was,
  // in words Antoine can act on.
  if (!task.head_sha) {
    const why = {
      nothing_changed: 'Nothing changed — the task finished without editing any files.',
      commit_failed: 'The work could not be saved to the project history, so it cannot go live. Run the task again.',
      no_branch: 'This task ran outside a working folder, so there is nothing to publish.',
      blocked: 'The task did not finish, so there is nothing to publish yet.',
      question_mode: 'This was a question, not a change.',
    }[task.ship_skip_reason] || 'There is no saved change to publish.';
    return {
      ok: false, checks: { saved: { ok: false, detail: task.ship_skip_reason || 'no commit' } },
      concerns: [why], filesChanged: files, insertions, deletions, plainSummary: why,
    };
  }

  // The reviewer's read of the code, done on the Mac right after the commit
  // (services/codeReviewPass.js, run by the runner). Absent is the normal state
  // for anything that finished before this existed, and for the in-container path
  // that reports no ship facts at all — so it must change nothing.
  const review = parseJsonOr(task.ship_review, null);
  // What became of the picked world ideas (services/ideaLanded.js, run by the runner
  // beside the review). Absent is the normal state for every task that finished before
  // this existed, and it must read exactly as it did then: nothing.
  const ideasPass = parseJsonOr(task.ship_ideas, null);
  const ideaItems = Array.isArray(ideasPass?.items) ? ideasPass.items : [];
  // 'not_checked' is not a finding. It is the absence of an answer, and showing it as
  // a problem is how a list stops being worth reading.
  const ideaGaps = ideaItems.filter((i) => i && (i.verdict === 'server_only' || i.verdict === 'not_landed'));
  const ideasCheck = ideasPass?.ran
    ? { ok: ideaGaps.length === 0, detail: ideaGaps.length ? `${ideaGaps.length} of ${ideaItems.length} not usable yet` : 'all of them landed', items: ideaItems }
    : { ok: true, detail: 'not checked' };
  const findings = Array.isArray(review?.findings) ? review.findings : [];
  // Only the two named cases can block (a secret committed, a login check
  // removed). Everything else the reviewer says is a note that travels with the
  // change and does not stop it — Antoine's rule, 2026-08-21: he ships directly
  // and Put it back is the net.
  const blocking = findings.filter((f) => f && f.blocking === true);

  const checks = {
    saved: { ok: true, detail: task.head_sha.slice(0, 8) },
    syntax: runnerChecks?.syntax || { ok: true, detail: 'not reported' },
    html: runnerChecks?.html || { ok: true, detail: 'not reported' },
    scope: checkScope(files, task.agent_key || 'dev1'),
    review: review?.ran
      ? {
          ok: blocking.length === 0,
          detail: summariseForAntoine(findings, { securityRan: Boolean(review.security_ran) }),
          findings,
          security_ran: Boolean(review.security_ran),
        }
      : { ok: true, detail: review?.error || 'not reviewed' },
    // Sixth check, and DELIBERATELY not part of the `ok` conjunction below: did the
    // world ideas he ticked onto this task actually get built, and can he reach them?
    // It reaches him through `concerns`, the same path the reviewer's non-blocking
    // findings take — which ships the change and shows the note. Only two findings
    // may ever stop a publish and neither of them is this one.
    ideas: ideasCheck,
  };

  const failed = shipCheckMessage({ syntax: checks.syntax, html: checks.html });
  if (failed) concerns.push(failed);
  if (!checks.scope.ok) {
    concerns.push(`Not live — this changed files it is not allowed to touch: ${checks.scope.detail}.`);
  }
  // Findings go into the same `concerns` array the app already shows, blocking
  // ones first. Non-blocking ones appear there too and the change still ships:
  // seeing them is the point, waiting on them is not.
  concerns.push(...concernLines(findings));
  // The half-built idea, said the way he would say it. Never prefixed "Held back" —
  // it is not held back, it went live, and there is a button to finish it.
  for (const gap of ideaGaps) {
    const name = gap.pick_name || 'an idea you picked';
    concerns.push(gap.verdict === 'server_only'
      ? `The idea "${name}" is on the server, but there is no way to use it in the app yet.`
      : `The idea "${name}" does not appear in what was built.`);
  }

  const ok = checks.syntax.ok && checks.html.ok && checks.scope.ok && blocking.length === 0;
  return {
    ok, checks, concerns, filesChanged: files, insertions, deletions,
    // 'unsafe' rather than 'risky' when the reviewer was the one that stopped it,
    // so the card can say it was a security finding and not a failed parse.
    severity: blocking.length ? 'unsafe' : null,
    plainSummary: blocking.length
      ? `${blocking[0].what} — held back until you look at it.`
      : buildPlainSummary({ ok, files, insertions, deletions, concerns, findings }),
  };
}

function runChecksAndFinalize() {
  // Kept as a no-op stub only so an older caller cannot crash the queue; the work
  // it used to do now happens in createReviewForTask/judgeTask above.
}

// ─── Auto-ship ────────────────────────────────────────────────────────────────
// When a review is approved and auto-ship is on (the Queue panel switch, default
// on), publishing runs itself. The git work does NOT happen here — it happens on
// the Mac, because that is the only machine with a checkout. See gitJobs.js.
function scheduleAutoShip(reviewId) {
  if (!autoShipEnabled()) return;              // switched off — it waits for a click
  const review = getReview(reviewId);
  if (!review) return;
  const out = enqueueShipJob(review);
  if (out?.error) {
    console.log(`[reviews] auto-ship ${reviewId} not queued: ${out.error}`);
    return;
  }
  updateReview(reviewId, { status: 'shipping' });
  broadcastReview(reviewId);
}


// ─── The one check that stays on the server ───────────────────────────────────
// Scope: the changed files must stay inside this agent's allowed paths and out of
// its denied ones, and must never include the live database, a secrets file, or CI
// config. It lives here rather than on the Mac because it needs the agent's rules
// out of the database and nothing else — no worktree, no git, no filesystem.
//
// Deleted with the move (recorded so nobody restores them by accident):
//   · boot / endpoints — booted the whole server and called four routes. Needed
//     node_modules inside the worktree (the runner's worktrees have none), took
//     30+ seconds, and were the single biggest source of false failures. They also
//     contradict AGENTS.md's ship-directly rule.
//   · syntax / html — moved to services/shipChecks.js so the runner can run them
//     where the files actually are, and so the ship step can re-run them on the
//     merged result before pushing.
//   · conflict — scanned `refs/heads/agent/*` only, so the runner's `queue/*`
//     branches were invisible to it, and it needed the repo anyway. The dry-run
//     merge on the Mac answers the same question for free, and accurately.
function checkScope(diffFiles, agentKey) {
  const agent = getAgent(agentKey) || {};
  const allow = parseJsonOr(agent.path_allow, ['**']);
  const deny = parseJsonOr(agent.path_deny, []);
  const bad = (diffFiles || []).filter((f) => {
    if (!matchesAny(f, allow)) return true;
    if (matchesAny(f, deny)) return true;
    if (/^queue-server\/data\//.test(f)) return true;
    if (/\.env$/.test(f)) return true;
    if (/^\.github\//.test(f)) return true;
    return false;
  });
  if (bad.length) return { ok: false, detail: bad.join(', ') };
  return { ok: true, detail: 'scope OK' };
}
function matchesAny(path, patterns) {
  return (patterns || []).some((p) => {
    // '**' is parked on a NUL placeholder while '*' expands, then restored — NUL
    // cannot occur in a real path, unlike any printable stand-in would.
    const re = String(p)
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\u0000')
      .replace(/\*/g, '[^/]*')
      .replace(/\u0000/g, '.*');
    return new RegExp(`^${re}$`).test(path);
  });
}

// One line, plain English, no jargon — shown to Antoine verbatim.
function buildPlainSummary({ ok, files, insertions, deletions, concerns, findings = [] }) {
  const n = (files || []).length;
  const scale = `${n} file${n === 1 ? '' : 's'} changed, +${insertions} / −${deletions}`;
  if (!ok) return `${concerns[0] || 'Not live.'} (${scale})`;
  // It passed, but the reviewer still left notes. Say so on the same line rather
  // than a flat "ready to go live" that hides them one panel deeper.
  const k = (findings || []).length;
  if (k) return `Ready to go live, with ${k} note${k === 1 ? '' : 's'} to read. ${scale}.`;
  return `Ready to go live. ${scale}.`;
}


// ─── What Antoine can ask for ─────────────────────────────────────────────────
// These used to be ~200 lines of git run on this server. They are now three-line
// decisions that hand the git to the Mac. Same endpoints, same buttons, same
// meaning — the work simply happens where a checkout exists.

// "Send it live." Also the path auto-ship takes.
export function mergeReview(id) {
  const review = getReview(id);
  if (!review) return { error: 'not_found' };
  if (review.status === 'merged') return { error: 'already_merged' };
  if (!review.head_sha) {
    return { error: 'nothing_to_publish', detail: 'There is no saved change on this task to publish.' };
  }

  const prompt = getPrompt(review.prompt_id);
  const subject = String(prompt?.title || review.branch).replace(/\s+/g, ' ').trim().slice(0, 72);

  const out = enqueueShipJob(review, { subject });
  if (out.error === 'already_queued') return { ok: true, queued: true, id: out.id };
  if (out.error) return { error: out.error };

  updateReview(id, { status: 'shipping' });
  broadcastReview(id);
  return { ok: true, queued: true, id: out.id };
}

// The stranded-review sweep (queue-runner.js, via /worker/git/reconcile): a
// review that said "not live yet" but git shows its commit already on the
// trunk — published by hand, or a ship whose push landed but whose result never
// made it back. This never merges or pushes anything; it only catches the record
// up to what git already shows. `merge_commit` can legitimately be null (work
// landed outside the ship-job lane leaves no `Ship-Review:` trailer to find) —
// that is honest and "Put it back" correctly can't undo it (git-ship.js).
export function markReviewLive(id, { merge_commit = null } = {}) {
  const review = getReview(id);
  if (!review) return { error: 'not_found' };
  if (review.status === 'merged') return { error: 'already_merged' };
  if (review.status === 'reverted') return { error: 'locked' };

  updateReview(id, {
    status: 'merged',
    merge_commit: merge_commit || null,
    merged_at: new Date().toISOString(),
    concerns: null,
  });
  broadcastReview(id);
  console.log(`[reviews] ${id} was already live — record caught up (${merge_commit ? merge_commit.slice(0, 8) : 'no sha'})`);
  return { ok: true, review: getReview(id) };
}

// "Put it back." Reverses the published change and republishes, so the app returns
// to how it was. Uses a reverse-commit rather than rewinding history, so anything
// published after this stays published — see git-ship.js.
export function revertReview(id) {
  const review = getReview(id);
  if (!review) return { error: 'not_found' };

  const out = enqueueUndoJob(review);
  if (out.error === 'already_queued') return { ok: true, queued: true, id: out.id };
  if (out.error === 'not_published') {
    return { error: 'not_merged', detail: 'This never went live, so there is nothing to put back.' };
  }
  if (out.error) return { error: out.error };

  // A ship that had not started yet was cancelled instead — nothing was published,
  // so there is nothing to reverse.
  if (out.cancelled) {
    updateReview(id, { status: 'approved' });
    broadcastReview(id);
    return { ok: true, cancelled: true };
  }

  updateReview(id, { status: 'reverting' });
  broadcastReview(id);
  return { ok: true, queued: true, id: out.id };
}

// "Not like this." Keeps the work, refuses to publish it.
export function requestChanges(id, { reason = null } = {}) {
  const review = getReview(id);
  if (!review) return { error: 'not_found' };
  if (review.status === 'merged' || review.status === 'reverted') return { error: 'locked' };
  updateReview(id, {
    status: 'changes_requested',
    concerns: JSON.stringify(reason ? [reason] : ['You asked for changes.']),
  });
  broadcastReview(id);
  return { ok: true, review: getReview(id) };
}

// "Bin it." The branch is left alone — the work stays recoverable in git, which is
// the entire reason the runner commits in the first place.
export function rejectReview(id) {
  const review = getReview(id);
  if (!review) return { error: 'not_found' };
  if (review.status === 'merged') return { error: 'already_merged' };
  updateReview(id, { status: 'rejected' });
  broadcastReview(id);
  return { ok: true };
}

// ─── Applying what the Mac reports back ───────────────────────────────────────
// Registered as a callback rather than imported by gitJobs.js, which would make the
// two modules import each other.
setGitJobHandler((job, payload) => {
  const review = getReview(job.review_id);
  if (!review) return;

  if (job.kind === 'ship') {
    if (payload.ok) {
      updateReview(job.review_id, {
        status: 'merged',
        merge_commit: payload.merge_commit || null,
        merged_at: new Date().toISOString(),
        concerns: null,
      });
      console.log(`[reviews] ${job.review_id} is live (${payload.merge_commit?.slice(0, 8) || 'no sha'})${payload.already ? ' — was already published' : ''}`);
      // Something just went live, so the tree's picture of what is built is now out
      // of date — re-check every witness (services/witnessCheck.js). Fire-and-forget
      // and free: a grep and a SELECT, no model. Publishing must never wait on it,
      // and it can never fail the ship.
      kickWitnessRecheck('after a ship');
    } else {
      // Words Antoine can act on, per failure. The generic fallback still says what
      // to do rather than naming a git error he cannot use.
      const message = {
        conflict: 'Not live — the app changed underneath this work. Run the task again and it will fit.',
        post_merge_failed: 'Not live — on its own it was fine, but combined with what is already live it breaks. Run the task again.',
        push_rejected: 'Not live yet — something else was published at the same moment. Press "Send it live" to try again.',
        network: 'Not live yet — your Mac could not reach the internet. Press "Send it live" to try again.',
        dry_run: 'Not published: the publishing brake is on (GIT_SHIP_DRY_RUN). Everything else worked.',
      }[payload.error] || `Not live — ${payload.detail || payload.error || 'publishing did not work'}.`;
      updateReview(job.review_id, {
        status: 'changes_requested',
        concerns: JSON.stringify([message]),
        conflicts_with: payload.conflicts ? JSON.stringify(payload.conflicts) : null,
      });
      console.log(`[reviews] ${job.review_id} did not publish: ${payload.error || 'unknown'}`);
    }
    broadcastReview(job.review_id);
    return;
  }

  if (job.kind === 'undo') {
    if (payload.ok) {
      updateReview(job.review_id, { status: 'reverted', reverted_at: new Date().toISOString(), concerns: null });
      console.log(`[reviews] ${job.review_id} put back`);
    } else {
      // The change stays live — that is the honest outcome, and safer than trying
      // to resolve someone else's conflict automatically.
      updateReview(job.review_id, {
        status: 'merged',
        concerns: JSON.stringify([
          payload.error === 'revert_conflict'
            ? 'Could not put this back on its own — a later change touched the same lines. The app is unchanged. Ask for a task to remove it instead.'
            : `Could not put this back — ${payload.detail || payload.error || 'it did not work'}. The app is unchanged.`,
        ]),
      });
      console.log(`[reviews] ${job.review_id} undo failed: ${payload.error || 'unknown'}`);
    }
    broadcastReview(job.review_id);
  }
});
