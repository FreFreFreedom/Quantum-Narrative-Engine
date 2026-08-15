import { Router } from 'express';
import * as q from '../services/ontologyQuery.js';
import { makeBooksHandler } from '../services/books.js';
import { makeTagLensHandler } from '../services/tagLens.js';
import { makeTagPatternHandler } from '../services/tagPattern.js';
import { makeBookDetailHandler } from '../services/bookDetail.js';
import { enrichFilm, enrichAllFilms, listEnrichments, batchStatus } from '../services/filmEnrichment.js';

export function ontologyRoutes(db) {
  const router = Router();
  const getBooks = makeBooksHandler(db);
  const getTagLens = makeTagLensHandler(db);
  const getTagPattern = makeTagPatternHandler(db);
  const getBookDetail = makeBookDetailHandler(db);

  router.get('/enrichments', (req, res) => res.json({ enrichments: listEnrichments(db) }));

  router.post('/entities/:id/enrich-film', async (req, res) => {
    const entity = q.getEntity(db, req.params.id);
    if (!entity) return res.status(404).json({ error: 'not_found' });
    if (entity.type !== 'film') return res.status(400).json({ error: 'not_a_film' });
    const out = await enrichFilm(db, entity, { force: !!req.body?.force });
    if (out.error) return res.status(out.status || 500).json(out);
    res.json(out);
  });

  router.post('/enrich-films/all', async (req, res) => {
    const out = await enrichAllFilms(db);
    if (out.error) return res.status(out.status || 500).json(out);
    res.json(out);
  });

  router.get('/enrich-films/status', (req, res) => res.json(batchStatus()));

  router.get('/entities', (req, res) => {
    const { type, cluster, tag, name, grounded, source } = req.query;
    const entities = q.searchEntities(db, { type, cluster, tag, name, source, grounded: grounded === undefined ? undefined : grounded === 'true' });
    res.json({ entities, count: entities.length });
  });

  router.get('/entities/:id', (req, res) => {
    const entity = q.getEntity(db, req.params.id);
    if (!entity) return res.status(404).json({ error: 'not_found' });
    res.json(entity);
  });

  // Live facets (entity types, sources, continuum axes with their scored counts) so the
  // client's filter UI is built from real data instead of a hardcoded list of three types.
  router.get('/facets', (req, res) => res.json(q.listFacets(db)));

  router.get('/clusters', (req, res) => res.json({ clusters: q.listClusters(db) }));
  router.get('/continuum-axes', (req, res) => res.json({ axes: q.listContinuumAxes(db) }));

  router.get('/continuum-axes/:key/nearby', (req, res) => {
    const value = parseFloat(req.query.value);
    if (Number.isNaN(value)) return res.status(400).json({ error: 'value_required' });
    const limit = Math.min(parseInt(req.query.limit || '10', 10), 50);
    res.json({ entities: q.nearbyOnAxis(db, req.params.key, value, limit) });
  });

  router.post('/entities/:id/books', async (req, res) => {
    const entity = q.getEntity(db, req.params.id);
    if (!entity) return res.status(404).json({ error: 'not_found' });
    const out = await getBooks(entity, { force: !!req.body?.force });
    if (out.error) return res.status(500).json(out);
    res.json(out);
  });

  router.post('/entities/:id/tag-lens', async (req, res) => {
    const entity = q.getEntity(db, req.params.id);
    if (!entity) return res.status(404).json({ error: 'not_found' });
    const tag = req.body?.tag;
    const out = await getTagLens(entity, tag, { force: !!req.body?.force });
    if (out.error) return res.status(out.error === 'invalid_tag' ? 400 : 500).json(out);
    res.json(out);
  });

  router.post('/entities/:id/books/detail', async (req, res) => {
    const entity = q.getEntity(db, req.params.id);
    if (!entity) return res.status(404).json({ error: 'not_found' });
    const book = req.body?.book;
    const out = await getBookDetail(entity, book, { force: !!req.body?.force });
    if (out.error) return res.status(out.error === 'invalid_book' ? 400 : 500).json(out);
    res.json(out);
  });

  router.post('/tags/:tag/explain', async (req, res) => {
    const out = await getTagPattern(req.params.tag, { force: !!req.body?.force });
    if (out.error) return res.status(out.error === 'invalid_tag' ? 400 : 500).json(out);
    res.json(out);
  });

  return router;
}
