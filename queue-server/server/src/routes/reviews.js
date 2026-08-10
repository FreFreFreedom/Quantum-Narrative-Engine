// Routes for the review/merge gate (plan Part 4, step 5) — the "À valider"
// cards. All mutations are human-initiated from the queue UI; nothing here
// happens on its own except the checks, which run when a review is created.
import { Router } from 'express';
import * as reviews from '../services/reviewRunner.js';

export function reviewsRoutes() {
  const router = Router();

  router.get('/reviews', (req, res) => {
    const status = req.query.status || null;
    res.json({ reviews: reviews.listReviews({ status }) });
  });

  router.get('/reviews/:id', (req, res) => {
    const review = reviews.getReview(req.params.id);
    if (!review) return res.status(404).json({ error: 'not_found' });
    res.json({ review });
  });

  // The human-pressed button: merge + deploy. Gated in the UI by typing FUSIONNER.
  router.post('/reviews/:id/merge', async (req, res) => {
    const out = await reviews.mergeReview(req.params.id);
    if (out.error) return res.status(out.error === 'not_found' ? 404 : 409).json(out);
    res.json({ ok: true, review: reviews.getReview(req.params.id), merge_commit: out.merge_commit });
  });

  // Undo button — available on merged reviews.
  router.post('/reviews/:id/revert', (req, res) => {
    const out = reviews.revertReview(req.params.id);
    if (out.error) return res.status(out.error === 'not_found' ? 404 : 409).json(out);
    res.json({ ok: true, review: reviews.getReview(req.params.id) });
  });

  router.post('/reviews/:id/request-changes', (req, res) => {
    const out = reviews.requestChanges(req.params.id, { reason: req.body?.reason });
    if (out.error) return res.status(409).json(out);
    res.json({ ok: true, review: out.review });
  });

  router.post('/reviews/:id/reject', (req, res) => {
    const out = reviews.rejectReview(req.params.id);
    if (out.error) return res.status(409).json(out);
    res.json({ ok: true, review: out.review });
  });

  return router;
}
