// Routes for Building blocks — evidence-backed discovery (plan "github-code-discovery.md").
// Mounted at /api/discovery.
import { Router } from 'express';
import * as discovery from '../services/codeDiscovery.js';

export function discoveryRoutes() {
  const router = Router();

  router.get('/queries', (req, res) => {
    res.json({ queries: discovery.listQueries() });
  });

  router.get('/results', async (req, res) => {
    const out = await discovery.getResults(String(req.query.query_id || ''), { forceRefresh: req.query.refresh === '1' });
    if (out.error) return res.status(400).json(out);
    res.json(out);
  });

  router.post('/refresh', async (req, res) => {
    const results = [];
    for (const q of discovery.listQueries()) {
      results.push(await discovery.getResults(q.id, { forceRefresh: true }));
    }
    res.json({ refreshed: results.length });
  });

  router.post('/feedback', (req, res) => {
    const out = discovery.submitFeedback(req.body || {});
    if (out.error) return res.status(400).json(out);
    res.json(out);
  });

  router.post('/ideas', async (req, res) => {
    const out = await discovery.runIdeaDiscovery(req.body?.idea_text || '', {
      source: req.body?.context_type || 'idea_box',
      sourceId: req.body?.context_id || null,
    });
    if (out?.error) return res.status(400).json(out);
    res.json(out);
  });

  router.get('/reports', (req, res) => {
    res.json({ reports: discovery.listReports() });
  });

  router.post('/reports/:id/rerun', async (req, res) => {
    const out = await discovery.rerunReport(req.params.id);
    if (out.error) return res.status(404).json(out);
    res.json(out);
  });

  router.post('/plant', (req, res) => {
    const { report_id, pick_index, target_node_id } = req.body || {};
    const out = discovery.plantPick(report_id, pick_index, { targetNodeId: target_node_id || null });
    if (out.error) return res.status(400).json(out);
    res.json(out);
  });

  router.get('/evidence/:nodeId', (req, res) => {
    res.json({ evidence: discovery.evidenceForNode(req.params.nodeId) });
  });

  return router;
}
