// Idea Studio conversation routes — mounted at /api/convos (plan
// "universal-conversations-core-architecture"). Backed by services/conversations.js
// and the subject registry in services/subjectContext.js.
import { Router } from 'express';
import * as convos from '../services/conversations.js';
import { asyncHandler } from '../lib/asyncHandler.js';

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
    // `acts` tells the studio which of fold / more / reframe this subject can
    // actually do, so it never offers a button that would only apologise.
    res.json({
      convo: out.convo,
      messages: convos.listMessages(out.convo.id),
      created: out.created,
      acts: convos.writeActsForConvo(out.convo.id),
      edits: convos.convoSubjectEdits(out.convo.id),
    });
  });

  // GET /api/convos/for?type=arch_component&ids=a,b,c — which of these subjects
  // already have a conversation (for the ✨/💬 markers in the "Not built" list).
  // Declared before /:id so "for" is not captured as an id.
  router.get('/for', (req, res) => {
    const type = String(req.query.type || '');
    const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 100);
    if (!type || !ids.length) return res.json({ convos: {} });
    res.json({ convos: convos.listConvosForSubjects(type, ids) });
  });

  // GET /api/convos/:id — fetch a specific conversation + its messages.
  router.get('/:id', (req, res) => {
    const convo = convos.getConvo(req.params.id);
    if (!convo) return res.status(404).json({ error: 'not_found' });
    res.json({ convo, messages: convos.listMessages(convo.id), acts: convos.writeActsForConvo(convo.id), edits: convos.convoSubjectEdits(convo.id) });
  });

  // POST /api/convos/:id/message — one user turn (or a command like /plan, /handoff).
  //
  // Two response shapes from one endpoint:
  //   Accept: application/x-ndjson  → chunked, one JSON object per line, tokens
  //                                    forwarded as they arrive
  //   anything else                 → the original single res.json(), unchanged
  //
  // NDJSON rather than SSE because EventSource cannot send an Authorization
  // header, and everything in this app authenticates with a bearer token. It also
  // needs no new endpoint and no new client library — plain fetch() can read a
  // chunked body.
  router.post('/:id/message', asyncHandler(async (req, res) => {
    const wantsStream = /application\/x-ndjson/i.test(String(req.headers.accept || ''));

    if (!wantsStream) {
      const out = await convos.sendMessage(req.params.id, { text: req.body?.text, userId: req.user?.id });
      if (out.error && !out.ok) return res.status(statusFor(out.error)).json(out);
      return res.json(out);
    }

    // Once the first byte is written the status code is committed and res.json()
    // is no longer available — so from here every outcome, errors included,
    // travels as a line in the body.
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no'); // ask any proxy in front not to buffer
    res.flushHeaders?.();

    const write = (obj) => {
      try { res.write(JSON.stringify(obj) + '\n'); res.flush?.(); } catch {}
    };

    // If the reader hangs up we stop writing, but we do NOT abort the model turn:
    // conversations.js saves the assistant message itself, so a closed browser
    // still ends with the answer in the thread rather than a half-turn.
    let clientGone = false;
    req.on('aborted', () => { clientGone = true; });

    try {
      const out = await convos.sendMessage(req.params.id, {
        text: req.body?.text,
        userId: req.user?.id,
        onToken: (t) => { if (!clientGone) write({ type: 'token', text: t }); },
      });
      write({ type: 'done', ...out });
    } catch (e) {
      write({ type: 'error', error: 'send_failed', message: e.message });
    }
    res.end();
  }));

  // POST /api/convos/:id/plan — generate the coder brief (TITLE + BRIEF).
  router.post('/:id/plan', asyncHandler(async (req, res) => {
    const out = await convos.requestPlan(req.params.id);
    if (out.error && !out.ok) return res.status(statusFor(out.error)).json(out);
    res.json(out);
  }));

  // POST /api/convos/:id/handoff — queue the plan as a paused task (idempotent).
  router.post('/:id/handoff', asyncHandler(async (req, res) => {
    const out = await convos.handoffToQueue(req.params.id, { title: req.body?.title || null, prompt: req.body?.prompt || null });
    if (out.error && !out.ok) return res.status(statusFor(out.error)).json(out);
    res.json(out);
  }));

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
