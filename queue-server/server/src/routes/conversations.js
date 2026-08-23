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
  if (err === 'not_found' || err === 'not_exist' || err === 'no_plan' || err === 'not_attached') return 404;
  if (err === 'unknown_subject_type' || err === 'empty' || err === 'too_many_subjects'
      || err === 'cannot_detach_primary' || err === 'cannot_attach_open') return 400;
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
    res.json({ convo, messages: convos.listMessages(convo.id), acts: convos.writeActsForConvo(convo.id), edits: convos.convoSubjectEdits(convo.id), subjects: convos.listConvoSubjects(convo.id) });
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

// POST /api/convos/:id/files — upload a file and store it in knowledge_docs
  // as a File: subject. Expects multipart/form-data with a "file" field.
  // Returns { id, title, status } so it can be attached to the conversation.
  router.post('/:id/files', asyncHandler(async (req, res) => {
    const convo = convos.getConvo(req.params.id);
    if (!convo) return res.status(404).json({ error: 'not_found' });

    // Parse multipart/form-data manually (no extra dependencies)
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) return res.status(400).json({ error: 'missing boundary' });
    const boundary = `--${boundaryMatch[1]}`;
    
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', async () => {
      const parts = body.split(boundary).filter((p) => p.trim().length > 0);
      let fileName = 'uploadedfile';
      let fileContent = '';
      
      for (const part of parts) {
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;
        const headers = part.slice(0, headerEnd);
        const payload = part.slice(headerEnd + 4);
        
        // Check if this is the file part
        const nameMatch = headers.match(/name="file"/);
        const filenameMatch = headers.match(/filename="([^"]+)"/);
        
        if (nameMatch) {
          fileName = filenameMatch ? filenameMatch[1] : 'uploadedfile';
          // Extract content — strip trailing \r\n-- and leading boundary
          const contentEnd = payload.lastIndexOf('\r\n');
          if (contentEnd > 0) {
            fileContent = payload.slice(0, contentEnd).replace(/\r\n$/, '');
          }
          break;
        }
      }
      
      if (!fileContent) return res.status(400).json({ error: 'no file content' });
      
      // Generate stable id from filename
      const id = fileName.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9]/g, '_') || 'upload';
      const title = fileName.replace(/\.[^/.]+$/, '') || 'uploaded file';
      const description = `FILE — ${fileName} uploaded via drag-and-drop.`;
      const status = 'PLANNED';
      
      db.prepare(`
        INSERT INTO knowledge_docs (id, title, description, content, updated_at)
        VALUES (?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        ON CONFLICT(title) DO UPDATE SET description=excluded.description, content=excluded.content, updated_at=excluded.updated_at
      `).run(randomUUID(), 'File: ' + title, description, fileContent);
      
      // Attach the file to the conversation
      db.prepare(
        `INSERT INTO convo_subjects (convo_id, subject_type, subject_id, is_primary, subject_hint) VALUES (?,?,?,0,?)`,
      ).run(convo.id, 'file', title, '');
      
      db.prepare(`UPDATE convos SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(convo.id);
      broadcastAll('convos:updated', { convoId: convo.id });
      
      res.json({ id: title, title: title, status: status });
    });
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
