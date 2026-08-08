// Routes for the work queue — subset of §9's HTTP contract, backed by promptQueue.js.
import { Router } from 'express';
import * as queue from '../services/promptQueue.js';

export function queueRoutes() {
  const router = Router();

  router.get('/prompts', (req, res) => {
    const space = req.query.space || 'fmcns';
    const prompts = queue.listPrompts({ space }).map((p) => ({
      ...p,
      pending_question: p.pending_question ? JSON.parse(p.pending_question) : null,
      messages: queue.listMessages(p.id),
    }));
    res.json({
      prompts,
      queue_paused: queue.getQueuePauseState().paused,
      queue_paused_at: queue.getQueuePauseState().paused_at,
      queue_paused_reason: queue.getQueuePauseState().reason,
    });
  });

  router.post('/prompts', (req, res) => {
    let row;
    try {
      row = queue.createPrompt({ ...req.body, created_by: req.user?.sub || 'antoine' });
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

  router.post('/prompts/:id/first', (req, res) => {
    const row = queue.moveToFront(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json(row);
  });

  router.get('/prompts/:id/messages', (req, res) => {
    res.json({ messages: queue.listMessages(req.params.id) });
  });

  router.post('/prompts/:id/reply', (req, res) => {
    const out = queue.replyToPrompt(req.params.id, { text: req.body?.text, userId: req.user?.sub });
    if (!out) return res.status(404).json({ error: 'not_found' });
    if (out.error === 'running') return res.status(409).json({ error: 'running' });
    if (out.error) return res.status(400).json({ error: out.error });
    res.status(201).json(out.prompt);
  });

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
