// Routes for the Architecture Navigator's live backend surface.
import { Router } from 'express';
import { getComponents, getQueueStatus, getComponentHistory, generateSuggestions } from '../services/architecture.js';
import { listNodes, createNode, updateNode, deleteNode, speculate } from '../services/architectureNodes.js';

export function architectureRoutes(db) {
  const router = Router();

  // Tech-tree growth: nodes authored by hand plus Claude-proposed branches. The
  // frontend merges these over its hardcoded trunk by id.
  router.get('/nodes', (req, res) => {
    res.json({ nodes: listNodes(db) });
  });

  router.post('/nodes', (req, res) => {
    const out = createNode(db, req.body || {});
    if (out.error) return res.status(out.error === 'duplicate' ? 409 : 400).json(out);
    res.json(out);
  });

  router.patch('/nodes/:id', (req, res) => {
    const out = updateNode(db, req.params.id, req.body || {});
    if (out.error) return res.status(404).json(out);
    res.json(out);
  });

  router.delete('/nodes/:id', (req, res) => {
    const out = deleteNode(db, req.params.id);
    if (out.error) return res.status(404).json(out);
    res.json(out);
  });

  // Explicit user click only — never called on page load (cost control).
  router.post('/nodes/:id/speculate', async (req, res) => {
    const out = await speculate(db, req.params.id, req.body || {});
    if (out.error) return res.status(out.error === 'all_duplicates' ? 409 : 502).json(out);
    res.json(out);
  });

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
