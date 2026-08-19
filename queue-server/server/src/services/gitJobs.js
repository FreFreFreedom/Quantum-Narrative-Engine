// services/gitJobs.js — the lane that gets git work done on the Mac.
//
// Why this exists. Publishing a finished task means running git: merge the task's
// branch onto the trunk and push it. This server cannot do that. It runs in a
// Railway container built from a tarball, with no git repository anywhere near it
// ("[gitOps] no git repository found at/above /app"), so every merge and revert it
// ever attempted returned `no_git` and no task in the app's history was ever
// published. The checkout lives on Antoine's Mac, and so does the local runner.
//
// So the server records the intention and the runner carries it out — exactly the
// pattern already proven by `helper_jobs`, which is how a server-side text step
// borrows the Mac's Claude subscription. Same shape: a row here, a claim endpoint,
// a result endpoint.
//
// Not folded into helper_jobs, deliberately: those rows are disposable (their own
// comment says "a redeploy losing them costs nothing") and are consumed by an
// in-process waiter on a 120-second deadline. These are the opposite — nobody waits
// on them, they must survive a redeploy, they are the record of what went live, and
// they need a global one-at-a-time lock that would be wrong for text jobs.

import { randomUUID } from 'node:crypto';

let db = null;
export function bindGitJobsDb(database) { db = database; }

// A job whose runner went away mid-flight is re-offered after this long. The
// runner heartbeats every 10s while working, so a slow-but-alive push is safe.
const STALE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 2;

function parseJsonOr(v, fallback) {
  if (v == null) return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}

function rowToJob(row) {
  if (!row) return null;
  return { ...row, result: parseJsonOr(row.result, null) };
}

export function getGitJob(id) {
  if (!db) return null;
  return rowToJob(db.prepare(`SELECT * FROM git_jobs WHERE id=?`).get(id));
}

// The newest job for a review — what the UI's state is derived from.
export function latestGitJobForReview(reviewId) {
  if (!db || !reviewId) return null;
  return rowToJob(db.prepare(
    `SELECT * FROM git_jobs WHERE review_id=? ORDER BY created_at DESC LIMIT 1`
  ).get(reviewId));
}

function openJobFor(reviewId, kind = null) {
  const sql = kind
    ? `SELECT * FROM git_jobs WHERE review_id=? AND kind=? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1`
    : `SELECT * FROM git_jobs WHERE review_id=? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1`;
  const row = kind ? db.prepare(sql).get(reviewId, kind) : db.prepare(sql).get(reviewId);
  return rowToJob(row);
}

// ─── Enqueue ──────────────────────────────────────────────────────────────────

// Publish this review's branch. `commit_subject` is composed here, on the server,
// because it is the only side that knows the prompt's title.
export function enqueueShipJob(review, { subject = null } = {}) {
  if (!db) return { error: 'no_db' };
  if (!review?.branch) return { error: 'no_branch' };
  if (!review.head_sha) return { error: 'nothing_to_publish' };

  const open = openJobFor(review.id);
  if (open) return { error: 'already_queued', id: open.id };

  const id = randomUUID();
  db.prepare(`
    INSERT INTO git_jobs (id, kind, review_id, branch, head_sha, commit_subject, status)
    VALUES (?, 'ship', ?, ?, ?, ?, 'queued')
  `).run(id, review.id, review.branch, review.head_sha, subject || `ship: ${review.branch}`);
  return { ok: true, id };
}

// Put a shipped change back. If its ship is still only QUEUED, nothing was ever
// pushed — cancel it instead of queueing an undo behind it, or we would publish
// something only to immediately unpublish it.
export function enqueueUndoJob(review) {
  if (!db) return { error: 'no_db' };

  const queuedShip = db.prepare(
    `SELECT * FROM git_jobs WHERE review_id=? AND kind='ship' AND status='queued' ORDER BY created_at DESC LIMIT 1`
  ).get(review.id);
  if (queuedShip) {
    db.prepare(`UPDATE git_jobs SET status='cancelled', finished_at=? WHERE id=? AND status='queued'`)
      .run(new Date().toISOString(), queuedShip.id);
    return { ok: true, cancelled: true };
  }

  if (!review?.merge_commit) return { error: 'not_published' };
  const open = openJobFor(review.id, 'undo');
  if (open) return { error: 'already_queued', id: open.id };

  const id = randomUUID();
  db.prepare(`
    INSERT INTO git_jobs (id, kind, review_id, branch, merge_commit, status)
    VALUES (?, 'undo', ?, ?, ?, 'queued')
  `).run(id, review.id, review.branch || null, review.merge_commit);
  return { ok: true, id };
}

// ─── Claim / heartbeat / result ───────────────────────────────────────────────

// One git job in flight across the whole system, enforced in the database rather
// than in a module variable. The old design serialized merges on an in-process
// promise chain, which stopped meaning anything the moment the git work moved to
// another machine — and would also have been defeated by a container restart or a
// second instance.
export function claimGitJob() {
  if (!db) return null;
  releaseStaleGitJobs();
  if (db.prepare(`SELECT COUNT(*) AS n FROM git_jobs WHERE status='running'`).get().n > 0) return null;

  // Oldest first, so an undo can never overtake the ship it undoes.
  const next = db.prepare(`SELECT * FROM git_jobs WHERE status='queued' ORDER BY created_at LIMIT 1`).get();
  if (!next) return null;

  const now = new Date().toISOString();
  const won = db.prepare(`
    UPDATE git_jobs SET status='running', attempts=attempts+1, claimed_at=?, heartbeat_at=?
    WHERE id=? AND status='queued'
  `).run(now, now, next.id);
  if (!won.changes) return null;                       // another runner took it

  return getGitJob(next.id);
}

export function noteGitJobHeartbeat(id) {
  if (!db) return false;
  const r = db.prepare(`UPDATE git_jobs SET heartbeat_at=? WHERE id=? AND status='running'`)
    .run(new Date().toISOString(), id);
  return !!r.changes;
}

// A runner that died mid-job would otherwise hold the single-in-flight lock
// forever, freezing all publishing with no error anywhere — the exact failure mode
// this whole rework exists to remove.
export function releaseStaleGitJobs() {
  if (!db) return 0;
  const cutoff = new Date(Date.now() - STALE_MS).toISOString();
  const stale = db.prepare(
    `SELECT * FROM git_jobs WHERE status='running' AND COALESCE(heartbeat_at, claimed_at) < ?`
  ).all(cutoff);
  for (const job of stale) {
    if (job.attempts < MAX_ATTEMPTS) {
      db.prepare(`UPDATE git_jobs SET status='queued', claimed_at=NULL, heartbeat_at=NULL WHERE id=?`).run(job.id);
      console.log(`[gitJobs] ${job.id} (${job.kind}) went quiet — queued again (attempt ${job.attempts + 1}/${MAX_ATTEMPTS})`);
    } else {
      db.prepare(`UPDATE git_jobs SET status='failed', error=?, finished_at=? WHERE id=?`).run(
        'Your Mac stopped part-way through publishing this. Nothing was lost — press "Send it live" to try again.',
        new Date().toISOString(), job.id,
      );
      console.log(`[gitJobs] ${job.id} (${job.kind}) gave up after ${job.attempts} attempts`);
    }
  }
  return stale.length;
}

// The runner reports back. `onDone` lets reviewRunner apply the consequence to the
// review row without this module importing it (they would import each other).
let _onDone = null;
export function setGitJobHandler(fn) { _onDone = fn; }

export function recordGitJobResult(id, payload = {}) {
  if (!db) return { error: 'no_db' };
  const job = getGitJob(id);
  if (!job) return { error: 'not_found' };
  if (job.status !== 'running') return { error: 'not_running' };

  const ok = !!payload.ok && !payload.error;
  db.prepare(`UPDATE git_jobs SET status=?, result=?, error=?, finished_at=? WHERE id=?`).run(
    ok ? 'done' : 'failed',
    JSON.stringify(payload),
    ok ? null : String(payload.detail || payload.error || 'it did not work'),
    new Date().toISOString(),
    id,
  );
  try { _onDone?.(getGitJob(id), payload); } catch (e) { console.error('[gitJobs] handler failed:', e.message); }
  return { ok: true };
}

// ─── What the app shows ───────────────────────────────────────────────────────

// One place decides the word Antoine sees, so the frontend has no logic to get
// wrong. Every state name here is plain English on purpose — never "merged",
// never "approved" (AGENTS.md: everything the app writes for him is plain English).
export function shipStateFor(review, { runnerConnected = true } = {}) {
  if (!review) return null;
  const job = latestGitJobForReview(review.id);

  const base = {
    review_id: review.id,
    merge_commit: review.merge_commit || null,
    files: (review.files_changed || []).length,
    insertions: review.insertions || 0,
    deletions: review.deletions || 0,
    at: review.merged_at || review.reverted_at || null,
  };

  if (review.status === 'reverted') {
    return { ...base, state: 'put_back', message: 'Put back the way it was. You can send it live again.' };
  }
  if (review.status === 'merged') {
    return { ...base, state: 'live', message: 'Live in the app.' };
  }
  if (job && job.kind === 'undo' && job.status === 'running') {
    return { ...base, state: 'putting_back', message: 'Putting it back…' };
  }
  if (job && job.status === 'failed') {
    return { ...base, state: 'needs_fix', message: job.error || 'It could not be published.' };
  }
  if (job && (job.status === 'queued' || job.status === 'running')) {
    return runnerConnected
      ? { ...base, state: 'shipping', message: 'Going live…' }
      : { ...base, state: 'waiting_runner', message: 'Waiting for your Mac. Start the runner and this goes live on its own.' };
  }
  // Reviews written before publishing worked at all. Every one of them carries the
  // old gate's failure text, and their file counts are the meaningless 2/0/0 it
  // recorded — so showing them as a live failure would tell Antoine the bug is
  // still there, on tasks that were never given a fair chance. Say what is
  // actually true instead, and drop the bogus numbers.
  if (!review.head_sha && /working folder no longer exists/i.test((review.concerns || []).join(' '))) {
    return {
      ...base, files: 0, insertions: 0, deletions: 0,
      state: 'legacy',
      message: 'This finished before publishing worked. Run it again if you still want it.',
    };
  }

  if (review.status === 'changes_requested') {
    const why = (review.concerns || [])[0] || 'It is not ready to go live.';
    const nothing = /^Nothing changed/.test(why);
    return { ...base, state: nothing ? 'nothing_changed' : 'needs_fix', message: why };
  }
  if (review.status === 'approved') {
    return { ...base, state: 'ready', message: 'Ready to go live — waiting for you to send it.' };
  }
  return { ...base, state: 'not_shipped', message: '' };
}
