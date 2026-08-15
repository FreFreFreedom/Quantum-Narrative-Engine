// Routes for "Building blocks" — evidence-backed discovery. Same db-as-argument
// pattern as routes/architecture.js.
import { Router } from 'express';
import {
  listQueries, getResults, recordFeedback, runIdeaSearch, runInspiration, listReports, getReport, findReportBySource, plant, plantProject, CURATED_QUERIES,
} from '../services/codeDiscovery.js';

export function discoveryRoutes(db) {
  const router = Router();
  const worldLookRunning = new Set();

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

  // ── World-look for any item (suggestion, seed, component) ──────────────────
  // The same three-shelf inspiration pass the queue runs on every implement
  // task, but attached to the item itself (source + item id) instead of a queue
  // prompt — so ideas appear right in their own section without queueing first.
  // Start returns immediately (the pass takes a while); the caller polls GET.
  router.post('/world-look', (req, res) => {
    const { source, source_id, idea_text } = req.body || {};
    const key = `${source}:${source_id}`;
    if (!source || !source_id || !String(idea_text || '').trim()) {
      return res.status(400).json({ error: 'source, source_id and idea_text are required' });
    }
    if (worldLookRunning.has(key)) return res.status(202).json({ started: false, running: true });
    worldLookRunning.add(key);
    res.status(202).json({ started: true });
    runInspiration(db, {
      idea_text: String(idea_text),
      source: String(source),
      source_id: String(source_id),
    }).catch((e) => console.error('[discovery] world-look failed:', e.message))
      .finally(() => worldLookRunning.delete(key));
  });

  router.get('/world-look', (req, res) => {
    const { source, source_id } = req.query;
    if (!source || !source_id) return res.status(400).json({ error: 'source and source_id are required' });
    res.json({ report: findReportBySource(db, String(source), String(source_id)) });
  });

  return router;
}
