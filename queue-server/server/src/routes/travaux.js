// Routes for the "Suggestions de Claude" and "Idées" modules — mounted alongside
// queueRoutes() under /api/travaux (that router owns /prompts*, this one owns
// /suggestions* and /ideas*, so both can share the same base path).
import { Router } from 'express';
import * as suggestions from '../services/workSuggestions.js';
import { TERRITORY_IDS } from '../services/ai/appModel.js';
import * as ideas from '../services/workIdeas.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import * as landing from '../services/inspireLanding.js';

export function travauxRoutes() {
  const router = Router();

  // ── Suggestions ────────────────────────────────────────────────────────────
  router.get('/suggestions', (req, res) => {
    const { status, kind } = req.query;
    // Dismissed suggestions are out of the browsing list by default — you already
    // said no to them. They come back only when asked for by name
    // (?status=dismissed, the "Dismissed" filter button) or with ?includeDismissed=1.
    res.json({
      suggestions: suggestions.listSuggestions({
        status: status || null,
        kind: kind || null,
        includeDismissed: req.query.includeDismissed === '1',
      }),
    });
  });

  router.post('/suggestions/generate', (req, res) => {
    // Returns immediately — the engines take a while (an LLM call each), and the
    // client reloads the list on a 'travaux:suggestions:updated'-style poll rather
    // than blocking the request.
    res.status(202).json({ started: true });
    // `catalog` is the browser's own component list. The app's map of itself lives in
    // fmcns_navigator.html, not the database, so the client has to ship it — exactly as
    // it already does for POST /api/architecture/next and /intel/signals. Without it the
    // engine can still read the stored pieces, so the timed background run in preGen.js
    // (which has no browser to ask) degrades to a shorter digest rather than breaking.
    suggestions.runSuggestionEngines({
      kind: req.body?.kind || null,
      catalog: Array.isArray(req.body?.catalog) ? req.body.catalog : [],
      // Which part of the app to stay inside, from the Flow's filter chips. Anything
      // unrecognised becomes null, i.e. the normal whole-app run: the 202 above has
      // already gone out, so there is no way to report a bad value back, and quietly
      // widening the scope is a better failure than generating nothing at all.
      territory: TERRITORY_IDS.includes(req.body?.territory) ? req.body.territory : null,
    })
      .catch((e) => console.error('[travaux] suggestion engine run failed:', e.message));
  });

  // Sorts the suggestions that predate the territory field into their territories.
  // Waits for the answer rather than returning 202 like /generate does: it is one
  // cheap call, the button that fires it wants to report how many it placed, and
  // there is nothing to poll for.
  router.post('/suggestions/classify', asyncHandler(async (req, res) => {
    const out = await suggestions.classifyUnplacedSuggestions();
    if (out.error) return res.status(502).json(out);
    res.json(out);
  }));

  router.post('/suggestions/:id/accept', asyncHandler(async (req, res) => {
    const out = await suggestions.acceptSuggestion(req.params.id, {
      editedPrompt: req.body?.prompt || null,
      editedTitle: req.body?.title || null,
      inspiration: req.body?.inspiration || null,
    });
    if (!out) return res.status(404).json({ error: 'not_found' });
    res.json(out);
  }));

  router.post('/suggestions/:id/dismiss', (req, res) => {
    const row = suggestions.dismissSuggestion(req.params.id, { reason: req.body?.reason || null });
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json(row);
  });

  router.delete('/suggestions/:id', (req, res) => {
    const ok = suggestions.deleteSuggestion(req.params.id);
    if (!ok) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  });

  // ── Hand to the Hive: the "Clear done" button surrenders finished tasks here ──
  router.post('/prompts/feed-recommender', (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    res.json(suggestions.feedCompletedToRecommender(ids));
  });

  // ── Idées ───────────────────────────────────────────────────────────────────
  router.get('/ideas', (req, res) => {
    res.json({ ideas: ideas.listIdeas() });
  });

  router.post('/ideas', (req, res) => {
    try {
      res.status(201).json(ideas.createIdea({ ...req.body, created_by: req.user?.sub || 'antoine' }));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.patch('/ideas/:id', (req, res) => {
    const row = ideas.updateIdea(req.params.id, req.body || {});
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json(row);
  });

  router.delete('/ideas/:id', (req, res) => {
    const ok = ideas.deleteIdea(req.params.id);
    if (!ok) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  });

  // The one line the closed seed row shows. Lazy: the frontend fires this on first
  // render and keeps its instant preview if it fails.
  router.post('/ideas/:id/summarize', asyncHandler(async (req, res) => {
    try {
      const out = await ideas.summarizeIdea(req.params.id);
      if (!out) return res.status(404).json({ error: 'not_found' });
      // Kept for anything still calling the per-card route; the shared service
      // speaks in `line`, this endpoint has always answered with `summary`.
      res.json({ summary: out.line });
    } catch (e) {
      res.status(502).json({ error: 'summary_failed', message: e.message });
    }
  }));

  router.post('/ideas/reorder', (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    res.json({ ideas: ideas.reorderIdeas(ids) });
  });

  router.post('/ideas/:id/promote', asyncHandler(async (req, res) => {
    const out = await ideas.promoteIdea(req.params.id, {
      userId: req.user?.sub || 'antoine',
      prompt: req.body?.prompt || null,
      inspiration: req.body?.inspiration || null,
    });
    if (!out) return res.status(404).json({ error: 'not_found' });
    res.json(out);
  }));

  router.post('/ideas/:id/plant', (req, res) => {
    const out = ideas.plantIdea(req.params.id, req.body || {});
    if (!out) return res.status(404).json({ error: 'not_found' });
    if (out.error) return res.status(400).json(out);
    res.json(out);
  });

  // ── Did the world ideas he picked actually get built? ──────────────────────
  // The list, grouped. Free: reading rows and, unless ?recheck=0, re-asking the one
  // question that stays true only if it is re-asked — can he reach it from the app
  // as the app stands right now. No model, no git, no cost.
  router.get('/ideas-landed/audit', asyncHandler(async (req, res) => {
    if (req.query.recheck !== '0') {
      try { await landing.auditReachability(); }
      catch (e) { /* the list is worth more than the refresh; show what is stored */ }
    }
    res.json(landing.auditSummary());
  }));

  // What was picked on one card, for the card itself to show.
  router.get('/ideas-landed/for/:promptId', (req, res) => {
    const rows = landing.listForPrompt(req.params.promptId)
      .map((r) => ({ ...r, line: landing.verdictLine(r) }));
    res.json({ ideas: rows });
  });

  // The one button. Queues the missing half as a paused follow-up carrying the same
  // idea, so its own check closes the loop when it ships.
  router.post('/ideas-landed/:id/fix', asyncHandler(async (req, res) => {
    const out = await landing.queueFix(req.params.id);
    if (!out) return res.status(404).json({ error: 'not_found' });
    res.json(out);
  }));

  return router;
}
