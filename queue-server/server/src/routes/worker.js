// Routes for the local task runner (scripts/queue-runner.js).
//
// Execution lives on Antoine's Mac now, not in this container: the opencode CLI
// is installed and authenticated there, it has real memory, and a runner holding
// its own subprocess can tell a working model from a dead one in seconds instead
// of waiting out a 20-35 minute timeout. This server stays the queue — it
// decides what runs next and records what came back.
//
// Three calls, all behind the normal single-user auth:
//   POST /worker/claim         → the next runnable task, or {none:true}
//   POST /worker/:id/stream    → transcript chunks + proof of life, while running
//   POST /worker/:id/result    → final status/report, once
// Plus the Claude helper lane (see helper_jobs in db/schema.js) — small text
// calls the container cannot make, because the Claude subscription is on the Mac:
//   POST /worker/helper/claim       → one parked text job, or {none:true}
//   POST /worker/helper/:jobId/result → its answer
//   POST /worker/git/claim          → one publish/undo job, or {none:true}
//   POST /worker/git/:jobId/heartbeat → proof of life while it works
//   POST /worker/git/:jobId/result  → what happened
import { Router } from 'express';
import {
  claimNextTask, recordRunnerStream, recordRunnerResult,
  noteRunnerPoll, runnerStatus, releaseStaleClaims, isLocalExecution, noteRunnerUsage,
} from '../services/taskRunner.js';
import * as queue from '../services/promptQueue.js';
import { claimHelperJob, recordHelperResult } from '../services/ai/text.js';
import { claimGitJob, recordGitJobResult, noteGitJobHeartbeat, strandedReviews } from '../services/gitJobs.js';
import { markReviewLive } from '../services/reviewRunner.js';

export function workerRoutes() {
  const router = Router();

  // Is a runner attached, and is this server even in local-execution mode? The
  // UI shows this so a queue with no runner reads as "nothing will run right
  // now" rather than looking silently stuck.
  router.get('/worker/status', (req, res) => {
    res.json(runnerStatus());
  });

  router.post('/worker/claim', (req, res) => {
    if (!isLocalExecution()) return res.status(409).json({ error: 'server_execution_mode' });
    const runnerId = String(req.body?.runner_id || 'local').slice(0, 64);
    noteRunnerPoll(runnerId);
    // The runner rides its Claude usage reading along on this poll (see
    // noteRunnerUsage) — it's the only process that can read the local account.
    if (req.body?.usage) noteRunnerUsage(req.body.usage);

    // Free anything whose previous runner died before handing this one a new
    // task — otherwise a task stranded by a closed laptop would never come back.
    try { releaseStaleClaims(); } catch (e) { console.error('[worker] stale-claim release failed:', e.message); }

    // Promote queued prompts into runnable agent tasks first. In local mode
    // advanceQueue creates the task rows but spawns nothing (kick() no-ops), so
    // this is purely "make sure there is something to claim".
    try { queue.advanceQueue(); } catch (e) { console.error('[worker] advanceQueue failed:', e.message); }

    const task = claimNextTask({ runnerId });
    if (!task) return res.json({ none: true });
    res.json({ task });
  });

  // Registered before the /worker/:id/* routes so 'helper' can never be read as
  // a task id.
  router.post('/worker/helper/claim', (req, res) => {
    if (!isLocalExecution()) return res.status(409).json({ error: 'server_execution_mode' });
    noteRunnerPoll();
    const job = claimHelperJob();
    if (!job) return res.json({ none: true });
    res.json({ job });
  });

  router.post('/worker/helper/:jobId/result', (req, res) => {
    noteRunnerPoll();
    const ok = recordHelperResult(req.params.jobId, {
      text: req.body?.text || null,
      error: req.body?.error || null,
    });
    if (!ok) return res.status(409).json({ error: 'not_claimable' });
    res.json({ ok: true });
  });

  // Git work this server cannot do itself: it has no repository. Registered
  // before /worker/:id/* so 'git' is never read as a task id, same as 'helper'.
  // One job runs at a time system-wide — claimGitJob enforces that in the DB.
  router.post('/worker/git/claim', (req, res) => {
    if (!isLocalExecution()) return res.status(409).json({ error: 'server_execution_mode' });
    noteRunnerPoll();
    const job = claimGitJob();
    if (!job) return res.json({ none: true });
    res.json({ job });
  });

  // Without this, a long push would look like a dead runner and the job would be
  // handed to someone else half-way through.
  router.post('/worker/git/:jobId/heartbeat', (req, res) => {
    noteRunnerPoll();
    if (!noteGitJobHeartbeat(req.params.jobId)) return res.status(409).json({ error: 'not_running' });
    res.json({ ok: true });
  });

  router.post('/worker/git/:jobId/result', (req, res) => {
    noteRunnerPoll();
    const out = recordGitJobResult(req.params.jobId, req.body || {});
    if (out.error) return res.status(409).json(out);
    res.json({ ok: true });
  });

  // Reviews that say "not live yet" but might already be — see gitJobs.js's
  // strandedReviews(). This is a pure read; the runner decides what to do with it.
  router.get('/worker/git/stranded', (req, res) => {
    if (!isLocalExecution()) return res.status(409).json({ error: 'server_execution_mode' });
    res.json({ reviews: strandedReviews() });
  });

  // The runner checked git itself and found the commit already on the trunk.
  // Catches the record up — never merges or pushes anything from this side.
  router.post('/worker/git/reconcile', (req, res) => {
    if (!isLocalExecution()) return res.status(409).json({ error: 'server_execution_mode' });
    noteRunnerPoll();
    const { review_id, merge_commit } = req.body || {};
    if (!review_id) return res.status(400).json({ error: 'no_review_id' });
    const out = markReviewLive(review_id, { merge_commit: merge_commit || null });
    if (out.error) return res.status(409).json(out);
    res.json({ ok: true });
  });

  router.post('/worker/:id/stream', (req, res) => {
    noteRunnerPoll();
    const { chunks, model, cost_usd, session_id, usage } = req.body || {};
    // The runner rides its usage reading on these too, not just on the idle
    // claim poll — otherwise the app's usage bar goes blank for the whole
    // duration of every task.
    if (usage) noteRunnerUsage(usage);
    const result = recordRunnerStream(req.params.id, {
      chunks: Array.isArray(chunks) ? chunks : [],
      model: model || null,
      cost_usd: Number(cost_usd),
      session_id: session_id || null,
    });
    // 409 tells the runner to stop: either the task was cancelled/reclaimed
    // server-side, or it crossed the per-task cost cap and must not continue.
    if (!result.ok) return res.status(409).json({ error: result.reason, cap: result.cap });
    res.json({ ok: true });
  });

  router.post('/worker/:id/result', (req, res) => {
    noteRunnerPoll();
    const finalTask = recordRunnerResult(req.params.id, req.body || {});
    if (!finalTask) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true, status: finalTask.status });
  });

  return router;
}
