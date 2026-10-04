// Mounted at /api/screen — the dictionary for whatever he is watching, called by
// the Edge extension over the same token login the QNE extension already uses.
import { Router } from 'express';
import { lookupOnScreen, glossaryOnScreen, episodeGlossary } from '../services/showLookup.js';
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

  // { show, lines } — the jargon in what was just said, found and read without being asked.
  router.post('/glossary', asyncHandler(async (req, res) => {
    const out = await glossaryOnScreen({ show: req.body?.show || '', lines: req.body?.lines || '' });
    if (out.error) return res.status(500).json(out);
    res.json(out);
  }));

  // { key, show, transcript } — one pass over a whole episode's subtitles.
  router.post('/episode', asyncHandler(async (req, res) => {
    const out = await episodeGlossary({ key: req.body?.key || '', show: req.body?.show || '', transcript: req.body?.transcript || '' });
    if (out.error) return res.status(out.error === 'key_required' || out.error === 'transcript_too_short' ? 400 : 500).json(out);
    res.json(out);
  }));

  return router;
}
