// One endpoint for every card's one-line summary — see services/cardLines.js for
// why the line exists and what it says per kind of card. Deliberately one route
// rather than a summarize endpoint per card type: the front end has a single
// helper that fires this for whatever cards are on screen, and adding a new kind
// of card means adding a row to KINDS, not another route.
import { Router } from 'express';
import { cardLine, cardKinds } from '../services/cardLines.js';
import { asyncHandler } from '../lib/asyncHandler.js';

export function cardLinesRoutes() {
  const router = Router();

  router.post('/:kind/:id/line', asyncHandler(async (req, res) => {
    const { kind, id } = req.params;
    try {
      // `text` is only consulted for cards with no row of their own (most of the
      // architecture trunk lives in the frontend, not the DB) — a stored row
      // always wins, so this cannot be used to overwrite real content.
      const out = await cardLine(kind, id, String(req.body?.text || '').slice(0, 8000));
      if (out === null) return res.status(404).json({ error: 'not_found' });
      if (out.error) return res.status(400).json({ error: out.error, kinds: cardKinds() });
      res.json(out);
    } catch (e) {
      // The front end keeps its stand-in line on any failure, so this status is
      // for the log and for anyone testing by hand — the message carries which
      // backends actually failed.
      res.status(502).json({ error: 'line_failed', message: e.message });
    }
  }));

  return router;
}
