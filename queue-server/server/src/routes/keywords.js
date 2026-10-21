// /api/keywords — the keyword bank the dictionary card's Keyword button fills.
// Listing and removing go through the Library (/api/recommendations/library).
import { Router } from 'express';
import * as keywords from '../services/keywords.js';

export function keywordsRoutes() {
  const router = Router();
  router.get('/', (req, res) => res.json({ keywords: keywords.listKeywords(req.user?.id || 'antoine') }));
  router.post('/', (req, res) => {
    const out = keywords.saveKeyword(req.user?.id || 'antoine', {
      term: req.body?.term, meaning: req.body?.meaning, sourceTitle: req.body?.sourceTitle, line: req.body?.line,
    });
    if (out.error) return res.status(out.error === 'empty' ? 400 : 500).json(out);
    res.json(out);
  });
  return router;
}
