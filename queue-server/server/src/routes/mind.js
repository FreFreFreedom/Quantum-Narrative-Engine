// Routes for the Room's shared memory (plan "room-shared-memory").
// Thin router behind requireAuth, same shape as every other route file.
import { Router } from 'express';
import * as mind from '../services/mind.js';
import { asyncHandler } from '../lib/asyncHandler.js';

const KINDS = ['about', 'taste', 'decision', 'project', 'person', 'style'];

export function mindRoutes() {
  const router = Router();

  router.get('/', (req, res) => {
    res.json({ facts: mind.listFacts({ activeOnly: true }) });
  });

  router.post('/', (req, res) => {
    const b = req.body || {};
    if (!b.text || !String(b.text).trim()) return res.status(400).json({ error: 'text_required' });
    if (b.kind && !KINDS.includes(b.kind)) return res.status(400).json({ error: 'bad_kind' });
    const saved = mind.saveFact({ kind: b.kind || 'about', text: b.text, detail: b.detail || null, sourceNote: 'manual' });
    if (saved.error === 'duplicate') return res.status(409).json({ error: 'duplicate', id: saved.id });
    if (saved.error) return res.status(400).json(saved);
    res.json({ fact: saved });
  });

  router.patch('/:id', (req, res) => {
    const b = req.body || {};
    const out = mind.reviseFact(req.params.id, { text: b.text, detail: b.detail });
    if (out.error) return res.status(out.error === 'not_found' ? 404 : 400).json(out);
    res.json({ fact: out });
  });

  router.delete('/:id', (req, res) => {
    const out = mind.forgetFact(req.params.id);
    if (out.error) return res.status(out.error === 'not_found' ? 404 : 400).json(out);
    res.json({ ok: true });
  });

  // Manual trigger for the harvest job (useful for testing without 8 turns).
  router.post('/harvest', asyncHandler(async (req, res) => {
    const b = req.body || {};
    if (!b.convoId) return res.status(400).json({ error: 'convoId_required' });
    await mind.harvest(b.convoId, { force: true });
    res.json({ ok: true });
  }));

  return router;
}
