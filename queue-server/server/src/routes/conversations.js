// Idea Studio conversation routes — mounted at /api/convos (plan
// "universal-conversations-core-architecture"). Backed by services/conversations.js
// and the subject registry in services/subjectContext.js.
import { Router } from 'express';
import * as convos from '../services/conversations.js';
import * as docExtraction from '../services/docExtraction.js';
import { asyncHandler } from '../lib/asyncHandler.js';

// The lanes the manual model picker (plan "chat-model-picker") may point a
// conversation at. Kept in sync by hand with turnRouter.js's FORCED_LANES and
// the frontend's picker options — a short, deliberately-curated list, not the
// full provider catalogue.
const VALID_LANE_PROVIDERS = new Set(['claude-code', 'claude-side', 'opencode', 'google-ai-studio']);

function isConvoError(out) {
  return out && typeof out === 'object' && out.error && !out.ok;
}

function statusFor(err) {
  if (err === 'not_found' || err === 'not_exist' || err === 'no_plan' || err === 'not_attached') return 404;
  if (err === 'unknown_subject_type' || err === 'empty' || err === 'too_many_subjects'
      || err === 'cannot_detach_primary' || err === 'cannot_attach_open' || err === 'text_required') return 400;
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
      chat_override: convos.getChatLane(out.convo.id),
      messages: convos.listMessages(out.convo.id),
      created: out.created,
      acts: convos.writeActsForConvo(out.convo.id),
      edits: convos.convoSubjectEdits(out.convo.id),
      subjects: convos.listConvoSubjects(out.convo.id),
    });
  });

  // ─── Roaming conversations (plan "roaming-conversations-backend") ──────────
  // Declared before /:id so "open" is not captured as an id.

  // GET /api/convos/open — the roaming threads, newest activity first.
  router.get('/open', (req, res) => {
    res.json({ convos: convos.listOpenConvos(req.query.limit) });
  });

  // GET /api/convos/plans — the plan backlog mirrored into the knowledge store,
  // as a light list ({id, title, status}) for the Room's attach picker. Titles
  // and statuses only; the picker must not download 400-line plans to draw a list.
  router.get('/plans', (req, res) => {
    res.json({ plans: convos.listPlans() });
  });

  // GET /api/convos/files — the file backlog mirrored into the knowledge store,
  // as a light list ({id, title, status}) for the Room's attach picker. Titles
  // and statuses only; the picker must not download the full document to draw a list.
  router.get('/files', (req, res) => {
    res.json({ files: convos.listFiles() });
  });

  // GET /api/convos/notes — the notes saved with /note, mirrored into the
  // knowledge store under the `Note: ` prefix, as a light list ({id, title,
  // description}) for the Room's attach picker.
  router.get('/notes', (req, res) => {
    res.json({ notes: convos.listNotes() });
  });

  // POST /api/convos/open — start one. No subject to pick: it gets a synthetic
  // one, and cards are attached afterwards (or never).
  router.post('/open', (req, res) => {
    const out = convos.createOpenConvo({
      title: req.body?.title || null,
      createdBy: req.user?.id || 'antoine',
    });
    if (isConvoError(out)) return res.status(statusFor(out.error)).json(out);
    res.json({ convo: out.convo, messages: [], created: true, acts: convos.writeActsForConvo(out.convo.id), edits: [], subjects: convos.listConvoSubjects(out.convo.id) });
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
    // chat_override rides on the row as a raw JSON string (or null) — parsed here
    // into { provider, model, account, tag } so the frontend never re-implements
    // the parse, same shape as GET/POST /:id/lane below.
    res.json({ convo, chat_override: convos.getChatLane(convo.id), messages: convos.listMessages(convo.id), acts: convos.writeActsForConvo(convo.id), edits: convos.convoSubjectEdits(convo.id), subjects: convos.listConvoSubjects(convo.id) });
  });

  // POST /api/convos/:id/lane — the manual model picker's sticky pick (plan
  // "chat-model-picker"): body { provider, model?, account? }, or {} / provider:
  // null to clear back to Auto. Every message on this conversation runs on this
  // lane until it is cleared.
  router.post('/:id/lane', (req, res) => {
    const convo = convos.getConvo(req.params.id);
    if (!convo) return res.status(404).json({ error: 'not_found' });
    const provider = req.body?.provider || null;
    if (provider && !VALID_LANE_PROVIDERS.has(provider)) return res.status(400).json({ error: 'unknown_provider' });
    const lane = convos.setChatLane(req.params.id, provider ? { provider, model: req.body?.model || null, account: req.body?.account || null } : null);
    res.json({ chat_override: lane });
  });

  // GET /api/convos/:id/subjects — every card attached to this conversation,
  // primary first.
  router.get('/:id/subjects', (req, res) => {
    const convo = convos.getConvo(req.params.id);
    if (!convo) return res.status(404).json({ error: 'not_found' });
    res.json({ subjects: convos.listConvoSubjects(convo.id), max: convos.MAX_ATTACHED_SUBJECTS });
  });

  // POST /api/convos/:id/subjects — attach a card. Capped; every attached card
  // is re-sent on every turn, so the cap is a cost control, not tidiness.
  router.post('/:id/subjects', (req, res) => {
    const out = convos.attachSubject(req.params.id, {
      subjectType: req.body?.type,
      subjectId: req.body?.id,
      subjectHint: req.body?.hint || null,
    });
    if (isConvoError(out)) return res.status(statusFor(out.error)).json(out);
    res.json(out);
  });

  // DELETE /api/convos/:id/subjects/:type/:subjectId — take one off. The card the
  // conversation started from cannot be removed; it is the conversation's identity.
  router.delete('/:id/subjects/:type/:subjectId', (req, res) => {
    const out = convos.detachSubject(req.params.id, req.params.type, req.params.subjectId);
    if (isConvoError(out)) return res.status(statusFor(out.error)).json(out);
    // Detaching a file must stop its background reading immediately — see
    // plans/cancel-extraction-on-detach.md.
    if (req.params.type === 'file') {
      docExtraction.cancelExtraction({ convoId: req.params.id, knowledgeDocTitle: 'File: ' + req.params.subjectId });
    }
    res.json(out);
  });

  // POST /api/convos/:id/rename — a roaming thread earns its name as it goes.
  router.post('/:id/rename', (req, res) => {
    const out = convos.renameConvo(req.params.id, req.body?.title);
    if (isConvoError(out)) return res.status(statusFor(out.error)).json(out);
    res.json(out);
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
    // An explicit one-off override in the request body (the picker changing lane
    // right before this send) takes effect immediately, same call, no separate
    // /lane round trip required first. Omitting it entirely means "use whatever
    // this conversation is stickily pinned to" (see sendMessage's effectiveOverride).
    const bodyOverride = req.body?.override;
    const override = bodyOverride === undefined
      ? undefined
      : (bodyOverride?.provider && VALID_LANE_PROVIDERS.has(bodyOverride.provider)
        ? { provider: bodyOverride.provider, model: bodyOverride.model || null, account: bodyOverride.account || null }
        : null);

    if (!wantsStream) {
      const out = await convos.sendMessage(req.params.id, { text: req.body?.text, userId: req.user?.id, override });
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
        override,
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

// POST /api/convos/:id/files — upload a file and store it in knowledge_docs
  // as a File: subject. Expects multipart/form-data with a "file" field.
  // Returns { id, title, status } so it can be attached to the conversation.
  // POST /api/convos/:id/files — attach a file. The browser has already
  // extracted the text (a file never rides raw into the prompt or the DB — see
  // plans/files-in-the-room.md), so this is a plain JSON body, not multipart.
  router.post('/:id/files', asyncHandler(async (req, res) => {
    const { filename, mimeType, text, bytes, sha, outline } = req.body || {};
    const out = convos.attachFile(req.params.id, { filename, mimeType, text, bytes, sha, outline });
    if (isConvoError(out)) return res.status(statusFor(out.error)).json(out);
    res.json(out);
  }));

  // ─── Section-by-section PDF extraction (plan "pdf-section-extraction") ─────
  // POST /api/convos/:id/extract/start — plan this doc's chunks (idempotent) and
  // fire the sweep in the background; returns immediately, same shape as the
  // world-look's runWorldLookGuarded callers.
  router.post('/:id/extract/start', (req, res) => {
    const convoId = req.params.id;
    const knowledgeDocTitle = req.body?.knowledgeDocTitle;
    if (!knowledgeDocTitle) return res.status(400).json({ error: 'knowledge_doc_title_required' });
    // Full reset: always stop any in-flight read and wipe every prior section
    // for this conversation, then plan this document from scratch (section 1) —
    // even if a previous read is still running.
    docExtraction.resetExtraction({ convoId });
    const planned = docExtraction.planChunks({ convoId, knowledgeDocTitle });
    if (planned.error) return res.status(planned.error === 'not_found' ? 404 : 400).json(planned);
    // No websocket message for this — same as the world-look sweep, the
    // frontend polls GET .../extract/status instead (plan's explicit choice).
    docExtraction.startExtractionSweep({ convoId });
    res.json({ started: true, ...planned });
  });

  // GET /api/convos/:id/extract/status — counts for the "Read N of M sections" line.
  router.get('/:id/extract/status', (req, res) => {
    res.json(docExtraction.extractionStatus(req.params.id));
  });

  // GET /api/convos/:id/extract/chunks?status=extracted — rows awaiting review
  // (or confirmed/rejected, for a status filter later).
  router.get('/:id/extract/chunks', (req, res) => {
    const status = String(req.query.status || 'extracted');
    res.json({ chunks: docExtraction.listChunks(req.params.id, status) });
  });

  // POST /api/convos/:id/extract/chunks/:chunkId/confirm — freeze this section's
  // reading and append it into the running "confirmed findings" note.
  router.post('/:id/extract/chunks/:chunkId/confirm', (req, res) => {
    const out = docExtraction.confirmChunk(req.params.chunkId);
    if (out.error) return res.status(out.error === 'not_found' ? 404 : 400).json(out);
    res.json(out);
  });

  // POST /api/convos/:id/extract/chunks/:chunkId/reject — mark this section
  // wrong; capturing the note is manual re-work for now (see plan's out-of-scope).
  router.post('/:id/extract/chunks/:chunkId/reject', (req, res) => {
    const out = docExtraction.rejectChunk(req.params.chunkId, req.body?.reviewer_note);
    if (out.error) return res.status(out.error === 'not_found' ? 404 : 400).json(out);
    res.json(out);
  });

  // POST /api/convos/:id/extract/cancel — stop reading a document explicitly
  // (the detach route above already calls this internally for file detaches;
  // this exists for completeness — see plans/cancel-extraction-on-detach.md).
  router.post('/:id/extract/cancel', (req, res) => {
    const knowledgeDocTitle = req.body?.knowledgeDocTitle;
    if (!knowledgeDocTitle) return res.status(400).json({ error: 'knowledge_doc_title_required' });
    const out = docExtraction.cancelExtraction({ convoId: req.params.id, knowledgeDocTitle });
    if (out.error) return res.status(400).json(out);
    res.json(out);
  });

  // POST /api/convos/:id/extract/clear — reject every section still awaiting
  // review in one call (the Room panel's "Clear all" button).
  router.post('/:id/extract/clear', (req, res) => {
    const out = docExtraction.rejectAllExtracted({ convoId: req.params.id });
    if (out.error) return res.status(out.error === 'missing_args' ? 400 : 400).json(out);
    res.json(out);
  });

  // POST /api/convos/:id/reset — fold conversation into a recap.
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
