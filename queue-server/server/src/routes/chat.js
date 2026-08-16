import { Router } from 'express';
import * as chat from '../services/chat.js';
import { asyncHandler } from '../lib/asyncHandler.js';

export function chatRoutes(db) {
  const router = Router();
  const handleChat = chat.makeChatHandler(db);

  router.get('/sessions', (req, res) => res.json({ sessions: chat.listSessions(db) }));

  router.post('/sessions', (req, res) => {
    res.status(201).json(chat.createSession(db, { title: req.body?.title || null }));
  });

  router.get('/sessions/:id/messages', (req, res) => {
    const session = chat.getSession(db, req.params.id);
    if (!session) return res.status(404).json({ error: 'not_found' });
    res.json({ session, messages: chat.listMessages(db, req.params.id) });
  });

  // { sessionId, text, attachments?: [{ filename, mimeType, dataBase64 }] }
  router.post('/message', asyncHandler(async (req, res) => {
    const { sessionId, text, attachments } = req.body || {};
    if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text_required' });
    const out = await handleChat({ sessionId, text, attachments: Array.isArray(attachments) ? attachments : [] });
    if (out.error) return res.status(out.error === 'invalid_session' ? 404 : 500).json(out);
    res.json(out);
  }));

  return router;
}
