// Routes for "Building blocks" — evidence-backed discovery. Same db-as-argument
// pattern as routes/architecture.js.
import { Router } from 'express';
import {
  listQueries, getResults, recordFeedback, runIdeaSearch, listReports, getReport, plant, plantProject, CURATED_QUERIES,
} from '../services/codeDiscovery.js';

export function discoveryRoutes(db) {
  const router = Router();

  router.get('/queries', (req, res) => {
    res.json({ queries: listQueries() });
  });

  router.get('/results', async (req, res) => {
    const queryId = req.query.query_id;
    const entry = CURATED_QUERIES.find(q => q.id === queryId);
    if (!entry) return res.status(404).json({ error: 'unknown_query_id' });
    const out = await getResults(db, entry.id, entry.query, { forceRefresh: req.query.refresh === '1' });
    if (out.error) return res.status(502).json(out);
    res.json(out);
  });

  router.post('/feedback', (req, res) => {
    const out = recordFeedback(db, req.body || {});
    if (out.error) return res.status(400).json(out);
    res.json(out);
  });

  // Explicit user click only — the 2-pass AI pipeline never runs on page load.
  router.post('/ideas', async (req, res) => {
    const out = await runIdeaSearch(db, req.body || {});
    if (out.error) return res.status(502).json(out);
    res.json(out);
  });

  router.get('/reports', (req, res) => {
    res.json({ reports: listReports(db) });
  });

  router.get('/reports/:id', (req, res) => {
    const report = getReport(db, req.params.id);
    if (!report) return res.status(404).json({ error: 'report_not_found' });
    res.json({ report });
  });

  router.post('/plant', (req, res) => {
    const out = plant(db, req.body || {});
    if (out.error) return res.status(400).json(out);
    res.json(out);
  });

  router.post('/plant-project', (req, res) => {
    const out = plantProject(db, req.body || {});
    if (out.error) return res.status(400).json(out);
    res.json(out);
  });

  return router;
}
