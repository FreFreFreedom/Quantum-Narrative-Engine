import { Router } from 'express';
import * as q from '../services/ontologyQuery.js';

export function ontologyRoutes(db) {
  const router = Router();

  router.get('/entities', (req, res) => {
    const { type, cluster, tag, name, grounded } = req.query;
    const entities = q.searchEntities(db, { type, cluster, tag, name, grounded: grounded === undefined ? undefined : grounded === 'true' });
    res.json({ entities, count: entities.length });
  });

  router.get('/entities/:id', (req, res) => {
    const entity = q.getEntity(db, req.params.id);
    if (!entity) return res.status(404).json({ error: 'not_found' });
    res.json(entity);
  });

  router.get('/clusters', (req, res) => res.json({ clusters: q.listClusters(db) }));
  router.get('/continuum-axes', (req, res) => res.json({ axes: q.listContinuumAxes(db) }));

  router.get('/continuum-axes/:key/nearby', (req, res) => {
    const value = parseFloat(req.query.value);
    if (Number.isNaN(value)) return res.status(400).json({ error: 'value_required' });
    const limit = Math.min(parseInt(req.query.limit || '10', 10), 50);
    res.json({ entities: q.nearbyOnAxis(db, req.params.key, value, limit) });
  });

  return router;
}
