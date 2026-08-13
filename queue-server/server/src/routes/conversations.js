// Idea Studio conversation routes — mounted at /api/convos (plan
// "universal-conversations-core-architecture"). Backed by services/conversations.js
// and the subject registry in services/subjectContext.js.
import { Router } from 'express';
import * as convos from '../services/conversations.js';

function isConvoError(out) {
  return out && typeof out === 'object' && out.error && !out.ok;
}

function statusFor(err) {
  if (err === 'not_found' || err === 'not_exist' || err === 'no_plan') return 404;
  if (err === 'unknown_subject_type' || err === 'empty') return 400;
  return 500;
}

export function conversationsRoutes() {
  const router = Router();

  // GET /api/convos/subject/:type/:id — fetch (or create) the conversation for a
  // subject, plus its message history.
  router.get('/subject/:type/:id', (req, res) => {
    const { type, id } = req.params;
    const out = convos.getOrCreateConvo({
      subjectType: type,
      subjectId: id,
      subjectHint: req.query.hint || null,
      createdBy: req.user?.id || 'antoine',
    });
    if (isConvoError(out)) return res.status(statusFor(out.error)).json(out);
    res.json({ convo: out.convo, messages: convos.listMessages(out.convo.id), created: out.created });
  });

  // GET /api/convos/:id — fetch a specific conversation + its messages.
  router.get('/:id', (req, res) => {
    const convo = convos.getConvo(req.params.id);
    if (!convo) return res.status(404).json({ error: 'not_found' });
    res.json({ convo, messages: convos.listMessages(convo.id) });
  });

  // POST /api/convos/:id/message — one user turn (or a command like /plan, /handoff).
  router.post('/:id/message', async (req, res) => {
    const out = await convos.sendMessage(req.params.id, { text: req.body?.text, userId: req.user?.id });
    if (out.error && !out.ok) return res.status(statusFor(out.error)).json(out);
    res.json(out);
  });

  // POST /api/convos/:id/plan — generate the coder brief (TITLE + BRIEF).
  router.post('/:id/plan', async (req, res) => {
    const out = await convos.requestPlan(req.params.id);
    if (out.error && !out.ok) return res.status(statusFor(out.error)).json(out);
    res.json(out);
  });

  // POST /api/convos/:id/handoff — queue the plan as a paused task (idempotent).
  router.post('/:id/handoff', async (req, res) => {
    const out = await convos.handoffToQueue(req.params.id, { title: req.body?.title || null, prompt: req.body?.prompt || null });
    if (out.error && !out.ok) return res.status(statusFor(out.error)).json(out);
    res.json(out);
  });

  // POST /api/convos/:id/reset — fold conversation into a recap, clear messages.
  router.post('/:id/reset', (req, res) => {
    const out = convos.resetConvoContext(req.params.id);
    if (out.error && !out.ok) return res.status(statusFor(out.error)).json(out);
    res.json(out);
  });

  // DELETE /api/convos/:id — soft-delete the conversation.
  router.delete('/:id', (req, res) => {
    const out = convos.deleteConvo(req.params.id);
    if (out.error && !out.ok) return res.status(statusFor(out.error)).json(out);
    res.json(out);
  });

  return router;
}
