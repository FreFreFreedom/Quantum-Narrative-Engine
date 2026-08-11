// Routes for the agent roster (plan Part 1) — GET list, POST create, PATCH update,
// DELETE. Backed by services/agents.js; mounted under /api/travaux like the rest.
import { Router } from 'express';
import * as agents from '../services/agents.js';

export function agentsRoutes() {
  const router = Router();

  router.get('/agents', (req, res) => {
    res.json({ agents: agents.listAgents() });
  });

  router.post('/agents', (req, res) => {
    try {
      const row = agents.createAgent(req.body || {});
      res.status(201).json(row);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.patch('/agents/:key', (req, res) => {
    const row = agents.updateAgent(req.params.key, req.body || {});
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json(row);
  });

  router.delete('/agents/:key', (req, res) => {
    const ok = agents.deleteAgent(req.params.key);
    if (!ok) return res.status(400).json({ error: 'cannot_delete' });
    res.json({ ok: true });
  });

  return router;
}
