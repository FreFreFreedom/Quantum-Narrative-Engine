// Mounted at /api/watching — the Plex extension pings these as he watches.
import { Router } from 'express';
import { recordWatch, listWatched, watchedSummary, watchedDialogue } from '../services/watching.js';
import { asyncHandler } from '../lib/asyncHandler.js';

export function watchingRoutes() {
  const router = Router();

  // { id, kind, series, season, episode, title, durationMs, offsetMs, finished, cues? }
  router.post('/seen', asyncHandler(async (req, res) => {
    const out = recordWatch(req.body || {});
    if (out.error) return res.status(out.error === 'id_required' ? 400 : 500).json(out);
    res.json(out);
  }));

  router.get('/list', (req, res) => res.json({
    items: listWatched({ query: req.query.query || '', limit: req.query.limit || 60 }),
    summary: watchedSummary({}),
  }));

  router.get('/dialogue', (req, res) => {
    const out = watchedDialogue({ series: req.query.series || '' });
    if (out.error) return res.status(out.error === 'nothing_watched' ? 404 : 500).json(out);
    res.json(out);
  });

  return router;
}
