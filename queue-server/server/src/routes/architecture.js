// Routes for the Architecture Navigator's live backend surface.
import { Router } from 'express';
import { getComponents, getQueueStatus, getComponentHistory, generateSuggestions } from '../services/architecture.js';
import { listNodes, createNode, updateNode, deleteNode, speculate, autoPlaceNode, askGraph, routeIdea, rankUnbuilt, shortlistUnbuilt } from '../services/architectureNodes.js';
import { listProposals, acceptProposal, rejectProposal, syncFromGit } from '../services/treeSync.js';

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

  // Self-updating tree: proposals the tree watchers found in real work (finished
  // queue tasks or git commits outside the app), waiting for Antoine's word.
  router.get('/proposals', (req, res) => {
    res.json({ proposals: listProposals(db) });
  });

  router.post('/proposals/:id/accept', (req, res) => {
    const out = acceptProposal(db, req.params.id);
    if (out.error) return res.status(out.error === 'not_found' ? 404 : 400).json(out);
    res.json(out);
  });

  router.post('/proposals/:id/reject', (req, res) => {
    const out = rejectProposal(db, req.params.id);
    if (out.error) return res.status(out.error === 'not_found' ? 404 : 400).json(out);
    res.json(out);
  });

  // Manual "Sync now" from the Architecture tab — runs the git-history watcher
  // immediately (cheap: one model call only when main has new commits).
  router.post('/tree/sync', async (req, res) => {
    const out = await syncFromGit(db);
    res.json(out);
  });

  // Explicit user click only — never called on page load (cost control).
  router.post('/nodes/:id/speculate', async (req, res) => {
    const out = await speculate(db, req.params.id, req.body || {});
    if (out.error) return res.status(out.error === 'all_duplicates' ? 409 : 502).json(out);
    res.json(out);
  });

  // "Add an idea": one free-text concept -> one speculative, structurally-placed node.
  // Frontend sends { concept, catalog } (the trunk lives in the HTML, not the DB).
  router.post('/nodes/auto', async (req, res) => {
    const out = await autoPlaceNode(db, req.body?.concept || '', req.body || {});
    if (out.error) {
      if (out.error === 'concept_required') return res.status(400).json(out);
      if (out.error === 'duplicate') return res.status(409).json(out);
      return res.status(502).json(out);
    }
    res.json(out);
  });

  // "Ask about this architecture": a question in, an answer + highlighted ids out.
  router.post('/graph/ask', async (req, res) => {
    const out = await askGraph(req.body?.question || '', req.body || {});
    if (out.error) {
      if (out.error === 'question_required') return res.status(400).json(out);
      return res.status(502).json(out);
    }
    res.json(out);
  });

  // "AI recommends order" in the Not built list — the client sends its items,
  // the model returns their ids best-first. Explicit click only.
  router.post('/rank-unbuilt', async (req, res) => {
    const out = await rankUnbuilt(req.body?.items);
    if (out.error) return res.status(out.error === 'empty' ? 400 : 502).json(out);
    res.json(out);
  });

  // "Show my next 3" in the Not built list — a 3-pick shortlist with a one-line
  // plain-English reason each. Explicit click only.
  router.post('/notbuilt-shortlist', async (req, res) => {
    const out = await shortlistUnbuilt(req.body?.items);
    if (out.error) return res.status(out.error === 'empty' ? 400 : 502).json(out);
    res.json(out);
  });

  // The one idea door: any entry point can POST here with { concept, catalog }.
  // One AI call routes the idea — speculative tree node or Seed.
  router.post('/ideas', async (req, res) => {
    const out = await routeIdea(db, req.body?.concept || '', req.body || {});
    if (out.error) {
      if (out.error === 'concept_required') return res.status(400).json(out);
      if (out.error === 'duplicate') return res.status(409).json(out);
      return res.status(502).json(out);
    }
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
