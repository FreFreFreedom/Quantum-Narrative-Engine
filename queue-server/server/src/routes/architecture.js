// Routes for the Architecture Navigator's live backend surface.
import { Router } from 'express';
import { getComponents, getQueueStatus, getComponentHistory, generateSuggestions } from '../services/architecture.js';

export function architectureRoutes(db) {
  const router = Router();

  router.get('/components', (req, res) => {
    res.json({ components: getComponents(db) });
  });

  router.get('/queue-status', (req, res) => {
    res.json(getQueueStatus(db));
  });

  router.get('/components/:id/history', (req, res) => {
    res.json(getComponentHistory(db, req.params.id));
  });

  router.post('/components/:id/suggestions/regenerate', async (req, res) => {
    const out = await generateSuggestions(db, req.params.id);
    if (out.error) return res.status(out.error === 'no_api_key' ? 500 : 502).json(out);
    res.json(out);
  });

  return router;
}
