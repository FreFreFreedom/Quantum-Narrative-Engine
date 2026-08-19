// Routes for the work queue — subset of §9's HTTP contract, backed by promptQueue.js.
import { Router } from 'express';
import * as queue from '../services/promptQueue.js';
import { listOpenCodeModels, listAiRouterModels, defaultOpenCodeModel } from '../services/providers/index.js';
import { resolveBin as resolveClaudeBin } from '../services/providers/claudeCode.js';
import { findAgentTask, execOutputBytes, getExecTimeoutMinutes, isLocalExecution } from '../services/taskRunner.js';
import { getAiSettings, updateAiSettings } from '../services/ai/text.js';
import { asyncHandler } from '../lib/asyncHandler.js';

export function queueRoutes() {
  const router = Router();

  router.get('/providers', async (req, res) => {
    // Execution-provider picker data for the New-prompt form: the OpenCode model
    // list (free first — sorted by the discovery code) plus a cheap liveness
    // signal for each provider so the UI can show what's actually runnable.
    const discovery = await listOpenCodeModels({ force: req.query.force === '1' }).catch((e) => ({ models: [], error: e.message }));
    // Curated default for NEW tasks (plan B): step 1 of the Go chain when the
    // live list has it, else the free floor. The New-prompt form preselects it.
    let defaultModel = null;
    try { defaultModel = await defaultOpenCodeModel(); } catch {}
    let aiRouterModels = [];
    let aiRouterError = null;
    try { aiRouterModels = listAiRouterModels(); } catch (e) { aiRouterError = e.message; }
    res.json({
      claude: {
        available: !!(process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.CLAUDE_BIN),
        bin: resolveClaudeBin(),
      },
      opencode: {
        available: discovery.models.length > 0 || !discovery.error,
        models: discovery.models,
        defaultModel,
        error: discovery.error || null,
      },
      aiRouter: {
        available: aiRouterModels.length > 0,
        models: aiRouterModels,
        error: aiRouterError,
      },
    });
  });

  // AI Settings panel (plan Part 7R step 8): per-feature model defaults, quota
  // policy, and live cooldown state. Backed by the same ai_settings row the
  // ai/text.js seam reads on every generation call.
  router.get('/ai-settings', (req, res) => {
    res.json(getAiSettings());
  });

  router.put('/ai-settings', (req, res) => {
    const { defaults, policy, queue, intel } = req.body || {};
    res.json(updateAiSettings({ defaults, policy, queue, intel }));
  });

  router.get('/prompts', (req, res) => {
    const space = req.query.space || 'fmcns';
    const prompts = queue.listPrompts({ space }).map((p) => {
      // Surface the RUNNING task's process state (run_state + heartbeat) so the UI
      // can tell a wedged agent from a busy one — plan Part 3. Null for prompts
      // with no live agent task.
      const task = p.agent_task_id ? findAgentTask(p.agent_task_id) : null;
      const running = p.status === 'running';
      return {
        ...p,
        pending_question: p.pending_question ? JSON.parse(p.pending_question) : null,
        messages: queue.listMessages(p.id),
        run_state: task?.run_state ?? null,
        heartbeat_at: task?.heartbeat_at ?? null,
        // Which models this task has actually been through. Tracked in the DB
        // since the fallback chain existed, but never sent to the UI — so a
        // model switch was invisible unless you read the raw stream log.
        tried_models: task?.tried_models ?? null,
        // Work-meter data for the UI's progress bar: real output volume so far,
        // plus the run's time budget (both only meaningful while running).
        output_bytes: running ? execOutputBytes(p.agent_task_id) : null,
        // Only meaningful when the container itself runs the task. In local mode
        // execution is the runner's, and its limits are per-ATTEMPT (first output
        // 90s / silence 5min / attempt cap 30min) — reporting a per-task budget
        // here drew a progress bar against a deadline nothing enforced.
        timeout_minutes: running && !isLocalExecution() ? getExecTimeoutMinutes() : null,
      };
    });
    res.json({
      prompts,
      queue_paused: queue.getQueuePauseState().paused,
      queue_paused_at: queue.getQueuePauseState().paused_at,
      queue_paused_reason: queue.getQueuePauseState().reason,
    });
  });

  router.post('/prompts', async (req, res) => {
    let row;
    try {
      row = await queue.createPrompt({ ...req.body, created_by: req.user?.sub || 'antoine' });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    // The response for the CREATE is sent before advanceQueue() runs — advanceQueue can
    // spawn a process and touch disk, so a failure in it must never try to send a second
    // response onto a request that's already been answered (that used to crash the
    // process with ERR_HTTP_HEADERS_SENT and silently strand the item at 'queued').
    res.status(201).json(row);
    try {
      queue.advanceQueue();
    } catch (e) {
      console.error('advanceQueue failed after prompt creation (prompt still queued, will retry on next advance):', e.message);
    }
  });

  router.patch('/prompts/:id', (req, res) => {
    const row = queue.updatePrompt(req.params.id, req.body || {});
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json(row);
  });

  router.delete('/prompts/:id', (req, res) => {
    const ok = queue.deletePrompt(req.params.id);
    if (!ok) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  });

  router.post('/prompts/reorder', (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    res.json({ prompts: queue.reorderPrompts(ids) });
  });

  router.post('/prompts/:id/seen', (req, res) => {
    const row = queue.markSeen(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  });

  // Purpose summary for a task's detail view: 3-5 plain-language bullets on what
  // the task is FOR. Normally pre-generated in the background (createPrompt /
  // finishPrompt eager hooks) so it's already cached when the task is opened —
  // this lazy path only serves the rare first-open race or a failed eager pass.
  // Cached on the row; in-flight dedup shared with the eager hooks.
  router.post('/prompts/:id/summarize', async (req, res) => {
    try {
      const out = await queue.summarizePrompt(req.params.id);
      if (!out) return res.status(404).json({ error: 'not_found' });
      res.json(out);
    } catch (e) {
      res.status(502).json({ error: 'summary_failed', message: e.message });
    }
  });

  router.post('/prompts/:id/first', (req, res) => {
    const row = queue.moveToFront(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json(row);
  });

  // Escape hatch for a task frozen in a preparation step (see sweepStuckStages).
  // The 60s sweep clears these on its own after 10 minutes; this is the button
  // for when the owner is looking right at it and does not want to wait.
  router.post('/prompts/:id/unstick', (req, res) => {
    const row = queue.unstickPrompt(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json(row);
  });

  router.post('/prompts/:id/pause', (req, res) => {
    const row = queue.pausePrompt(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json(row);
  });

  router.get('/prompts/:id/messages', (req, res) => {
    res.json({ messages: queue.listMessages(req.params.id) });
  });

  router.post('/prompts/:id/clear-context', (req, res) => {
    const row = queue.clearContext(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json(row);
  });

  // Retroactive plan-first drafting for a task created before that feature existed.
  router.post('/prompts/:id/backfill-plan', asyncHandler(async (req, res) => {
    const row = await queue.backfillPlan(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json(row);
  }));

  // Inspiration step: the automatic world-look pass (open / hidden / bold shelves)
  // that runs for every implement-mode task before its plan is written. This view
  // serves the task detail's "Inspired by" panel; refresh re-runs the pass (also
  // the entry point for tasks created before the feature); apply stores the
  // human's picks and re-drafts the plan with them emphasized.
  router.get('/prompts/:id/inspiration', (req, res) => {
    const out = queue.inspirationPayload(req.params.id);
    if (!out) return res.status(404).json({ error: 'not_found' });
    res.json(out);
  });

  router.post('/prompts/:id/inspiration/refresh', asyncHandler(async (req, res) => {
    const row = await queue.refreshInspiration(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json(row);
  }));

  router.post('/prompts/:id/inspiration/skip', asyncHandler(async (req, res) => {
    const row = await queue.skipInspiration(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json(row);
  }));

  router.post('/prompts/:id/inspiration/apply', asyncHandler(async (req, res) => {
    const row = await queue.applyInspiration(req.params.id, req.body || {});
    if (!row) return res.status(404).json({ error: 'not_found' });
    if (row.error) return res.status(400).json({ error: row.error });
    res.json(row);
  }));

  // One-off migration: shorten the descriptions of world-look reports created
  // before the "one short sentence" rule. Idempotent — cheap model calls only
  // for reports that still have long descriptions.
  router.post('/inspiration/condense-existing', asyncHandler(async (req, res) => {
    const out = await queue.condenseExistingInspiration();
    res.json(out);
  }));

  router.post('/prompts/:id/reply', asyncHandler(async (req, res) => {
    const out = await queue.replyToPrompt(req.params.id, {
      text: req.body?.text, userId: req.user?.sub, placement: req.body?.placement === 'back' ? 'back' : 'front',
    });
    if (!out) return res.status(404).json({ error: 'not_found' });
    if (out.error === 'running') return res.status(409).json({ error: 'running' });
    if (out.error) return res.status(400).json({ error: out.error });
    res.status(201).json(out.prompt);
  }));

  // Instant conversational reply (plan: cheap-by-design queue). Posts the user
  // message to the thread, asks a free model (fast floor, or the strongest free
  // model for deep-tier tasks) to answer using the full thread as context, and
  // posts the answer back to the thread — seconds, no agent launch. If the task
  // is currently running, the same text is ALSO forwarded to the live run as a
  // steer so a directive reaches the agent immediately while the answer lands
  // in-thread for reference.
  router.post('/prompts/:id/reply/chat', asyncHandler(async (req, res) => {
    const out = await queue.chatReplyToPrompt(req.params.id, {
      text: req.body?.text, userId: req.user?.sub,
    });
    if (!out) return res.status(404).json({ error: 'not_found' });
    if (out.error) return res.status(400).json({ error: out.error });
    res.status(201).json(out);
  }));

  router.post('/prompts/:id/message', (req, res) => {
    const out = queue.steerPrompt(req.params.id, { text: req.body?.text, userId: req.user?.sub });
    if (!out) return res.status(404).json({ error: 'not_found' });
    if (out.error === 'not-running') return res.status(409).json({ error: 'not-running' });
    if (out.error) return res.status(400).json({ error: out.error });
    res.status(201).json({ ...out.prompt, delivered: out.delivered });
  });

  router.post('/prompts/advance', (req, res) => {
    const out = queue.advanceQueue();
    res.json({ started: out.started ? out.started.prompt : null, startedCount: out.startedCount, reason: out.reason });
  });

  router.get('/queue/pause', (req, res) => res.json(queue.getQueuePauseState()));
  router.post('/queue/pause', (req, res) => {
    const body = req.body || {};
    res.json(body.paused === false ? queue.resumeQueue() : queue.pauseQueue({ reason: body.reason }));
  });

  return router;
}
