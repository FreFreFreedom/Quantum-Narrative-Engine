// Mounted at /api/screen — the dictionary for whatever he is watching, called by
// the Edge extension over the same token login the QNE extension already uses.
import { Router } from 'express';
import { lookupOnScreen, glossaryOnScreen, episodeGlossary, askOnScreen, nameChapter } from '../services/showLookup.js';
import { asyncHandler } from '../lib/asyncHandler.js';

export function showLookupRoutes() {
  const router = Router();

  // { show, term, line, reading } — reading: a page or a PDF rather than a paused show
  router.post('/lookup', asyncHandler(async (req, res) => {
    const out = await lookupOnScreen({
      show: req.body?.show || '',
      term: req.body?.term || '',
      line: req.body?.line || '',
      opening: req.body?.opening || '',
      reading: req.body?.reading === true,
    });
    if (out.error) return res.status(out.error === 'not_a_word' ? 400 : 500).json(out);
    res.json(out);
  }));

  // { term, show, line, meaning, question, turns, reading } — the card's "Ask…".
  router.post('/ask', asyncHandler(async (req, res) => {
    const b = req.body || {};
    const out = await askOnScreen({ term: b.term, show: b.show, line: b.line, meaning: b.meaning, question: b.question, turns: b.turns || [], reading: b.reading === true });
    if (out.error) return res.status(out.error === 'empty' ? 400 : 500).json(out);
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

  // { text, book } — a name for a chapter he placed by hand in a PDF.
  router.post('/chapter-name', asyncHandler(async (req, res) => {
    const out = await nameChapter({ text: req.body?.text || '', book: req.body?.book || '' });
    if (out.error) return res.status(out.error === 'too_short' ? 400 : 500).json(out);
    res.json(out);
  }));

  return router;
}
