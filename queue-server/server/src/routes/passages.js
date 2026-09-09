// /api/passages — the shelf of kept lines. The world-look for a passage is NOT
// here: it rides the generic /api/discovery/world-look with source 'passage',
// which already takes any source/source_id pair.
import { Router } from 'express';
import * as passages from '../services/passages.js';

export function passagesRoutes() {
  const router = Router();

  router.get('/', (req, res) => {
    res.json({ passages: passages.listPassages({ limit: req.query.limit }) });
  });

  router.post('/', (req, res) => {
    const out = passages.savePassage({
      text: req.body?.text,
      convoId: req.body?.convoId,
      messageId: req.body?.messageId,
      sourceTitle: req.body?.sourceTitle,
      createdBy: req.user?.id || 'antoine',
    });
    if (out.error) return res.status(out.error === 'empty' ? 400 : 500).json(out);
    // The reading writes itself in the background — the save must not wait on a
    // model call, and the shelf polls anyway.
    if (!out.already) passages.readPassageSoon(out.passage.id);
    res.json(out);
  });

  // Ask again for the reading (or a first one, if the background pass failed).
  router.post('/:id/read', async (req, res) => {
    const out = await passages.readPassage(req.params.id, { force: req.body?.force === true });
    if (out.error) return res.status(out.error === 'not_found' ? 404 : 500).json(out);
    res.json(out);
  });

  router.delete('/:id', (req, res) => {
    const out = passages.deletePassage(req.params.id);
    if (out.error) return res.status(out.error === 'not_found' ? 404 : 500).json(out);
    res.json(out);
  });

  return router;
}
