import { Router } from 'express';
import * as recommendations from '../services/roomRecommendations.js';
export function recommendationRoutes() {
  const router = Router();
  const action = fn => async (req, res) => {
    try { res.json(await fn(req)); }
    catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'Could not update recommendations.' }); }
  };
  router.get('/', action(req => recommendations.listRecommendations(String(req.query.kind || ''), String(req.query.scope || 'all'))));
  router.post('/initialize', action(req => recommendations.initializeCollection(req.body?.kind, req.body?.scope)));
  router.patch('/settings', action(req => recommendations.changeSettings(req.body?.kind, req.body?.scope, req.body || {})));
  router.post('/requests', async (req, res) => {
    try { res.status(202).json(recommendations.requestRecommendations(req.body?.kind, req.body?.scope, req.body?.text)); }
    catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'Could not request recommendations.' }); }
  });
  router.post('/requests/:id/cancel', action(req => recommendations.cancelRequest(req.params.id)));
  router.post('/requests/:id/resume', action(req => recommendations.resumeRequest(req.params.id)));
  router.delete('/:id', action(req => recommendations.dismissRecommendation(req.params.id)));
  router.post('/:id/open', action(req => recommendations.openApp(req.params.id, req.body?.convoId)));
  return router;
}
