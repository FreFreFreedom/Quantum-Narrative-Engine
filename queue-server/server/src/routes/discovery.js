// Routes for "Building blocks" — evidence-backed discovery. Same db-as-argument
// pattern as routes/architecture.js.
import { Router } from 'express';
import {
  listQueries, getResults, recordFeedback, runIdeaSearch, listReports, getReport, findReportBySource,
  isWorldLookRunning, runWorldLookGuarded, plant, plantProject, listUnplantedBoldPicks, CURATED_QUERIES,
  addCustomBoldPick, rewriteWorldLooks, staleWorldLooks, WORLD_LOOK_GEN,
  updatePickInPlace, appendPicks, updatePartFraming, removeConvoPicks, swapOnePick,
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

  // The same question for a whole list at once. The app used to ask per card, and only
  // when you opened one — so a list of suggestions drew with no ✨ on any of them and
  // every untouched card offered to "look at the world" as though nothing had ever been
  // found. The reports were there the whole time (they are rows in discovery_reports,
  // written by the background sweeps and kept for good); the app simply had not asked.
  // After a redeploy that reads exactly like the ideas were thrown away.
  //
  // Free — a lookup per id, no model calls. Capped so one call cannot walk the table.
  const MAX_BATCH_IDS = 200;
  router.get('/world-look/for', (req, res) => {
    const source = String(req.query.source || '');
    if (!source) return res.status(400).json({ error: 'source is required' });
    const ids = String(req.query.ids || '').split(',').map(x => x.trim()).filter(Boolean).slice(0, MAX_BATCH_IDS);
    const out = {};
    for (const id of ids) {
      const report = findReportBySource(db, source, id);
      const running = isWorldLookRunning(source, id);
      // Only the ids that have something to say are returned, so a list of a hundred
      // suggestions with three reports answers with three entries.
      if (report || running) out[id] = { report, running };
    }
    res.json({ items: out });
  });

  // ── Rewriting the looks that already exist ─────────────────────────────────
  // GET says how many reports were written by an older generation of the prompts and
  // are therefore still the drifting ones. Free — a count, no model calls.
  router.get('/world-look/rewrite', asyncHandler(async (req, res) => {
    const out = await rewriteWorldLooks(db, {
      dryRun: true,
      limit: Number(req.query.limit) || 25,
      sources: req.query.sources ? String(req.query.sources).split(',').filter(Boolean) : null,
    });
    res.json(out);
  }));

  // POST actually redoes them. Returns immediately and works through the backlog in
  // the background: this is a long sweep (a few model calls per item, one item at a
  // time), it is resumable, and running it again after it finishes costs nothing
  // because every report it redid is stamped with the current generation.
  router.post('/world-look/rewrite', (req, res) => {
    const limit = Math.max(1, Math.min(500, Number(req.body?.limit) || 25));
    const sources = Array.isArray(req.body?.sources) && req.body.sources.length ? req.body.sources : null;
    const pending = staleWorldLooks(db, { sources }).length;
    res.status(202).json({ started: true, generation: WORLD_LOOK_GEN, pending, limit });
    rewriteWorldLooks(db, { limit, sources })
      .then((out) => console.log(`[discovery] world-look rewrite: ${out.rewritten} redone, ${out.skipped} skipped, ${out.failed} failed, ${out.remaining} left.`))
      .catch((e) => console.error('[discovery] world-look rewrite failed:', e.message));
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

  // ── Report writes addressed by report id ──────────────────────────────────
  // Used by the Idea Studio's world-idea commands (/fold, /more, /reframe) and
  // available on its own. Edits happen IN PLACE and additions APPEND, so every
  // stored (part_index, pick_index) keeps pointing at the same idea.

  // Rewrite one idea where it stands.
  router.patch('/world-look/report/:reportId/pick/:partIndex/:pickIndex', (req, res) => {
    const out = updatePickInPlace(db, {
      reportId: req.params.reportId,
      partIndex: Number(req.params.partIndex),
      pickIndex: Number(req.params.pickIndex),
      fields: req.body?.fields || req.body || {},
      convoId: req.body?.convo_id || null,
    });
    if (out?.error) return res.status(out.error === 'empty' ? 400 : 404).json(out);
    res.json({ report: out });
  });

  // Swap ONE idea for a fresh one, in place — the per-row alternative to redoing the
  // whole report. Awaited (not backgrounded like the whole-report rerun) because it is
  // a single short call and the row is waiting on screen for its answer. One swap per
  // row at a time, so a double click cannot spend twice.
  const swapsInFlight = new Set();
  router.post('/world-look/report/:reportId/pick/:partIndex/:pickIndex/swap', asyncHandler(async (req, res) => {
    const key = `${req.params.reportId}~${req.params.partIndex}:${req.params.pickIndex}`;
    if (swapsInFlight.has(key)) return res.status(409).json({ error: 'busy', message: 'That idea is already being swapped.' });
    swapsInFlight.add(key);
    try {
      const out = await swapOnePick(db, {
        reportId: req.params.reportId,
        partIndex: Number(req.params.partIndex),
        pickIndex: Number(req.params.pickIndex),
      });
      if (out?.error) {
        const notFound = ['no_report', 'no_pick', 'bad_index'].includes(out.error);
        const refused = ['planted', 'in_conversation', 'applied'].includes(out.error);
        return res.status(notFound ? 404 : refused ? 409 : 502).json(out);
      }
      res.json({ report: out });
    } finally {
      swapsInFlight.delete(key);
    }
  }));

  // Append ideas to a part.
  router.post('/world-look/report/:reportId/part/:partIndex/picks', (req, res) => {
    const out = appendPicks(db, {
      reportId: req.params.reportId,
      partIndex: Number(req.params.partIndex),
      picks: req.body?.picks || [],
      from: req.body?.convo_id || null,
    });
    if (out?.error) return res.status(out.error === 'empty' ? 400 : 404).json(out);
    res.json({ report: out });
  });

  // Take back the ideas a conversation added. Only ever removes them from the end
  // of a part, so no surviving idea changes position.
  router.delete('/world-look/report/:reportId/convo-picks', (req, res) => {
    const pi = req.query.part_index;
    const out = removeConvoPicks(db, {
      reportId: req.params.reportId,
      partIndex: pi === undefined || pi === '' ? null : Number(pi),
      convoId: req.query.convo_id || null,
    });
    if (out?.error) return res.status(out.error === 'no_report' ? 404 : 400).json(out);
    res.json(out);
  });

  // Rewrite the question above a part's ideas. No idea is touched.
  router.patch('/world-look/report/:reportId/part/:partIndex', (req, res) => {
    const out = updatePartFraming(db, {
      reportId: req.params.reportId,
      partIndex: Number(req.params.partIndex),
      name: req.body?.name || null,
      description: req.body?.description || null,
      convoId: req.body?.convo_id || null,
    });
    if (out?.error) return res.status(out.error === 'empty' ? 400 : 404).json(out);
    res.json({ report: out });
  });

  return router;
}
