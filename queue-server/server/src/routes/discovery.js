// Routes for "Building blocks" — evidence-backed discovery. Same db-as-argument
// pattern as routes/architecture.js.
import { Router } from 'express';
import {
  listQueries, getResults, recordFeedback, runIdeaSearch, listReports, getReport, findReportBySource,
  isWorldLookRunning, runWorldLookGuarded, plant, plantProject, listUnplantedBoldPicks, CURATED_QUERIES,
  addCustomBoldPick,
} from '../services/codeDiscovery.js';
import { asyncHandler } from '../lib/asyncHandler.js';

export function discoveryRoutes(db) {
  const router = Router();

  router.get('/queries', (req, res) => {
    res.json({ queries: listQueries() });
  });

  router.get('/results', asyncHandler(async (req, res) => {
    const queryId = req.query.query_id;
    const entry = CURATED_QUERIES.find(q => q.id === queryId);
    if (!entry) return res.status(404).json({ error: 'unknown_query_id' });
    const out = await getResults(db, entry.id, entry.query, { forceRefresh: req.query.refresh === '1' });
    if (out.error) return res.status(502).json(out);
    res.json(out);
  }));

  router.post('/feedback', (req, res) => {
    const out = recordFeedback(db, req.body || {});
    if (out.error) return res.status(400).json(out);
    res.json(out);
  });

  // Explicit user click only — the 2-pass AI pipeline never runs on page load.
  router.post('/ideas', asyncHandler(async (req, res) => {
    const out = await runIdeaSearch(db, req.body || {});
    if (out.error) return res.status(502).json(out);
    res.json(out);
  }));

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

  // Bold/imagined world-look ideas not yet planted into the tech tree — feeds the
  // "On the Horizon" section alongside real unbuilt architecture_nodes.
  router.get('/unplanted', (req, res) => {
    res.json({ items: listUnplantedBoldPicks(db) });
  });

  // ── World-look for any item (suggestion, seed, component) ──────────────────
  // The same three-shelf inspiration pass the queue runs on every implement
  // task, but attached to the item itself (source + item id) instead of a queue
  // prompt — so ideas appear right in their own section without queueing first.
  // Start returns immediately (the pass takes a while); the caller polls GET,
  // which also reports whether a look is still running (started here or by the
  // background sweep in codeDiscovery.autoWorldLookSuggestions).
  router.post('/world-look', (req, res) => {
    const { source, source_id, idea_text } = req.body || {};
    if (!source || !source_id || !String(idea_text || '').trim()) {
      return res.status(400).json({ error: 'source, source_id and idea_text are required' });
    }
    if (isWorldLookRunning(source, source_id)) return res.status(202).json({ started: false, running: true });
    const run = runWorldLookGuarded(db, {
      idea_text: String(idea_text),
      source: String(source),
      source_id: String(source_id),
    });
    res.status(202).json({ started: true });
    run.catch((e) => console.error('[discovery] world-look failed:', e.message));
  });

  router.get('/world-look', (req, res) => {
    const { source, source_id } = req.query;
    if (!source || !source_id) return res.status(400).json({ error: 'source and source_id are required' });
    const key = { source: String(source), source_id: String(source_id) };
    res.json({
      report: findReportBySource(db, key.source, key.source_id),
      running: isWorldLookRunning(key.source, key.source_id),
    });
  });

  // Add a custom bold idea to a task's world-look report
  router.post('/world-look/prompt/:taskId/custom-pick', (req, res) => {
    const { taskId } = req.params;
    const pick = req.body || {};

    if (!pick.name || !String(pick.name).trim()) {
      return res.status(400).json({ error: 'name_required' });
    }

    const out = addCustomBoldPick(db, {
      source: 'prompt',
      source_id: taskId,
      pick: {
        name: String(pick.name).trim(),
        vision: pick.vision ? String(pick.vision).trim() : '',
        why_possible: pick.why_possible ? String(pick.why_possible).trim() : '',
        how_fmcns: pick.how_fmcns ? String(pick.how_fmcns).trim() : '',
      },
    });

    if (out?.error) return res.status(404).json(out);
    res.json({ report: out });
  });

  return router;
}
