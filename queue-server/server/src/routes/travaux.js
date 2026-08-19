// Routes for the "Suggestions de Claude" and "Idées" modules — mounted alongside
// queueRoutes() under /api/travaux (that router owns /prompts*, this one owns
// /suggestions* and /ideas*, so both can share the same base path).
import { Router } from 'express';
import * as suggestions from '../services/workSuggestions.js';
import * as ideas from '../services/workIdeas.js';
import { asyncHandler } from '../lib/asyncHandler.js';

export function travauxRoutes() {
  const router = Router();

  // ── Suggestions ────────────────────────────────────────────────────────────
  router.get('/suggestions', (req, res) => {
    const { status, kind } = req.query;
    res.json({ suggestions: suggestions.listSuggestions({ status: status || null, kind: kind || null }) });
  });

  router.post('/suggestions/generate', (req, res) => {
    // Returns immediately — the engines take a while (an LLM call each), and the
    // client reloads the list on a 'travaux:suggestions:updated'-style poll rather
    // than blocking the request.
    res.status(202).json({ started: true });
    suggestions.runSuggestionEngines({ kind: req.body?.kind || null })
      .catch((e) => console.error('[travaux] suggestion engine run failed:', e.message));
  });

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

  return router;
}
