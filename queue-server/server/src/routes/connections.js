import { Router } from 'express';
import * as connections from '../services/connections.js';

// Outside sources the Room could reach (plans/room-connections.md). Thin; the
// service holds the catalogue and the reaches. A token goes in and never comes out.
export function connectionsRoutes() {
  const router = Router();
  const action = (fn) => async (req, res) => {
    try { res.json(await fn(req)); }
    catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'Could not update connections.' }); }
  };
  const owner = (req) => req.user?.sub || req.user?.id || 'antoine';
  router.get('/', action((req) => connections.listConnections(owner(req))));
  router.post('/seen', action((req) => connections.markConnectionsSeen(owner(req))));
  router.post('/:id/on', action((req) => connections.setConnection(owner(req), String(req.params.id), {
    on: typeof req.body?.on === 'boolean' ? req.body.on : undefined,
    token: typeof req.body?.token === 'string' ? req.body.token : undefined,
  })));
  router.post('/:id/dismiss', action((req) => connections.dismissConnection(owner(req), String(req.params.id))));
  return router;
}
