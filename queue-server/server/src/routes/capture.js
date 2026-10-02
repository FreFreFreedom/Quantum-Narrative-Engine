// /api/capture — the side panel and what reads the captured pile
// (plans/web-capture.md). The extension's capture key reaches only /page, /ask and
// /stack here (auth.js#CAPTURE_DOORS); the readings are the app's.
import { Router } from 'express';
import * as capture from '../services/capture.js';

const statusFor = (e) => (e === 'not_found' ? 404 : e === 'empty' || e === 'too_few' ? 400 : 500);

export function captureRoutes() {
  const router = Router();

  router.get('/page', (req, res) => {
    res.json(capture.pageLookup({ url: req.query.url, title: req.query.title, heading: req.query.heading }));
  });

  router.post('/ask', async (req, res) => {
    const out = await capture.askAboutPage(req.body || {});
    if (out.error) return res.status(statusFor(out.error)).json(out);
    res.json(out);
  });

  router.post('/stack', (req, res) => {
    const out = capture.sendStack(req.body?.items);
    if (out.error) return res.status(statusFor(out.error)).json(out);
    res.json(out);
  });

  router.get('/reading', (req, res) => res.json(capture.latestReading()));
  router.post('/reading', async (req, res) => {
    const out = await capture.readPile();
    if (out.error) return res.status(statusFor(out.error)).json(out);
    res.json(out);
  });

  router.get('/instruments', (req, res) => res.json({ round: capture.latestInstruments() }));
  router.post('/instruments', async (req, res) => {
    const out = await capture.suggestInstruments();
    if (out.error) return res.status(statusFor(out.error)).json(out);
    res.json(out);
  });
  router.post('/instruments/:id/:index/seed', (req, res) => {
    const out = capture.instrumentToSeed(req.params.id, req.params.index);
    if (out.error) return res.status(statusFor(out.error)).json(out);
    res.json(out);
  });

  return router;
}
