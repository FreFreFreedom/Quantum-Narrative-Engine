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
import { Router } from 'express';
import {
  claimNextTask, recordRunnerStream, recordRunnerResult,
  noteRunnerPoll, runnerStatus, releaseStaleClaims, isLocalExecution, noteRunnerUsage,
} from '../services/taskRunner.js';
import * as queue from '../services/promptQueue.js';
import { claimHelperJob, recordHelperResult } from '../services/ai/text.js';

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
