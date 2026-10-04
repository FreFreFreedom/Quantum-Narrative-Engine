// Mounted at /api/screen — the dictionary for whatever he is watching, called by
// the Edge extension over the same token login the QNE extension already uses.
import { Router } from 'express';
import { lookupOnScreen } from '../services/showLookup.js';
import { asyncHandler } from '../lib/asyncHandler.js';

export function showLookupRoutes() {
  const router = Router();

  // { show, term, line }
  router.post('/lookup', asyncHandler(async (req, res) => {
    const out = await lookupOnScreen({
      show: req.body?.show || '',
      term: req.body?.term || '',
      line: req.body?.line || '',
    });
    if (out.error) return res.status(out.error === 'not_a_word' ? 400 : 500).json(out);
    res.json(out);
  }));

  return router;
}
