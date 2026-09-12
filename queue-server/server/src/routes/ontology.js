import { Router } from 'express';
import * as q from '../services/ontologyQuery.js';
import * as rel from '../services/entityRelations.js';
import * as men from '../services/entityMentions.js';
import { peersOf } from '../services/peers.js';
import { boneSearch } from '../services/boneSearch.js';
import { createScenePair, getScenePair, listScenePairs, deleteScenePair } from '../services/splitScreen.js';
import { makeBooksHandler } from '../services/books.js';
import { makeTagLensHandler } from '../services/tagLens.js';
import { makeTagPatternHandler } from '../services/tagPattern.js';
import { makeBookDetailHandler } from '../services/bookDetail.js';
import { enrichFilm, enrichAllFilms, listEnrichments, batchStatus } from '../services/filmEnrichment.js';
import { getTagGaps } from '../services/tagGaps.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { listTensions, setTension, generateTension, fillMissingTensions } from '../services/tagTensions.js';
import { signatureFor, setSignature, deleteSignature, signatureByRungAudit } from '../services/entitySignature.js';
import { spectrumFor, compareEntities, allSpectralEdges } from '../services/graphSpectrum.js';

// Two ends can be in the same loop; report it once.
function dedupeLoops(loops) {
  const seen = new Set();
  return loops.filter((l) => {
    const k = l.steps.map((s) => s.id).sort().join('|');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function ontologyRoutes(db) {
  const router = Router();
  const getBooks = makeBooksHandler(db);
  const getTagLens = makeTagLensHandler(db);
  const getTagPattern = makeTagPatternHandler(db);
  const getBookDetail = makeBookDetailHandler(db);

  router.get('/enrichments', (req, res) => res.json({ enrichments: listEnrichments(db) }));

  router.post('/entities/:id/enrich-film', asyncHandler(async (req, res) => {
    const entity = q.getEntity(db, req.params.id);
    if (!entity) return res.status(404).json({ error: 'not_found' });
    if (entity.type !== 'film') return res.status(400).json({ error: 'not_a_film' });
    const out = await enrichFilm(db, entity, { force: !!req.body?.force });
    if (out.error) return res.status(out.status || 500).json(out);
    res.json(out);
  }));

  router.post('/enrich-films/all', asyncHandler(async (req, res) => {
    const out = await enrichAllFilms(db);
    if (out.error) return res.status(out.status || 500).json(out);
    res.json(out);
  }));

  router.get('/enrich-films/status', (req, res) => res.json(batchStatus()));

  router.get('/entities', (req, res) => {
    const { type, cluster, tag, name, source } = req.query;
    const entities = q.searchEntities(db, { type, cluster, tag, name, source });
    res.json({ entities, count: entities.length });
  });

  router.get('/entities/:id', (req, res) => {
    const entity = q.getEntity(db, req.params.id);
    if (!entity) return res.status(404).json({ error: 'not_found' });
    res.json(entity);
  });

  // Stored relations — plans/civic-structures-and-loops.md Stage 4. Unlike the computed
  // echoes, these are claims somebody made, each carrying where it came from and what would
  // break it. The service refuses a vertical relation that skips a rung; the 400 it throws
  // says which rungs were skipped, so the message is a fix rather than a complaint.
  router.get('/entities/:id/relations', (req, res) => {
    if (!q.getEntity(db, req.params.id)) return res.status(404).json({ error: 'not_found' });
    res.json({ relations: rel.relationsFor(db, req.params.id) });
  });

  router.post('/entities/:id/relations', (req, res) => {
    try {
      res.status(201).json({ relation: rel.createRelation(db, { ...req.body, from_id: req.params.id }) });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // The four readings that replace a tag — fractal_operational_core.md §21,
  // plans/anatomy-replaces-tags.md. Same shape as /relations: a GET that returns whatever
  // exists (missing readings are absent, not null-filled — a blank is a finding, not an
  // apology), a POST that refuses without a source and a falsifier the same way a relation
  // does, and a DELETE for taking one back.
  router.get('/entities/:id/signature', (req, res) => {
    if (!q.getEntity(db, req.params.id)) return res.status(404).json({ error: 'not_found' });
    res.json(signatureFor(db, req.params.id));
  });

  router.post('/entities/:id/signature', (req, res) => {
    try {
      res.status(201).json(setSignature(db, { ...req.body, entity_id: req.params.id }));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  router.delete('/entities/:id/signature/:reading', (req, res) => {
    res.json({ deleted: deleteSignature(db, req.params.id, req.params.reading) });
  });

  // The blind-spot report — a count over (reading × rung), so an empty cell is a place
  // nobody has looked rather than a rendering gap. Same shape as /shape-audit below.
  router.get('/signature-audit', (req, res) => res.json(signatureByRungAudit(db)));

  // The horizontal move: who else is on this entity's rung, and who is further along.
  // Computed, never stored — a peer listing is a resemblance the app noticed, while a
  // stored relation is a claim someone is answerable for. Two lists come back because
  // "who else is here" and "who is doing it better" are different orderings.
  router.get('/entities/:id/peers', (req, res) => {
    const out = peersOf(db, req.params.id, { limit: Number(req.query.limit) || undefined });
    if (!out) return res.status(404).json({ error: 'not_found' });
    res.json(out);
  });

  // Search by bone — plans/anatomy-replaces-tags.md, Part 2; fractal_operational_core.md §21.
  // "They do not share a single word. But their anatomy is identical." Unlike /peers, this is
  // not restricted to one rung: two entities match here across any distance on the ladder,
  // on the strength of a shared SHAPE (a structural category, not a tag) recorded on a
  // written relation touching each. The acceptance test is on screen, not just in the code:
  // each match says whether it shares a tag with the query — the ones that do not are the
  // stronger evidence.
  router.get('/entities/:id/bone-search', (req, res) => {
    const out = boneSearch(db, req.params.id, { limit: Number(req.query.limit) || undefined });
    if (!out) return res.status(404).json({ error: 'not_found' });
    res.json(out);
  });

  // What Antoine has written about this entity — plans/testimony-in-the-ontology.md.
  // A note is testimony, never a node: these rows point at an entity and stop there.
  router.get('/entities/:id/mentions', (req, res) => {
    if (!q.getEntity(db, req.params.id)) return res.status(404).json({ error: 'not_found' });
    res.json({ mentions: men.mentionsFor(db, req.params.id) });
  });

  // Walk every note and every active fact. Manual, never on boot: boot already reseeds the
  // ontology, and this is also how a redeploy that added entities picks up older text.
  router.post('/mentions/rescan', (req, res) => res.json(men.rescanAll(db)));

  // Single-token matches, waiting for one confirming click. Measured over the real corpus
  // this is about five rows, once.
  router.get('/review', (req, res) => res.json({ mentions: men.listProposed(db, req.query.limit) }));

  router.post('/mentions/:id/confirm', (req, res) => {
    try { res.json({ mention: men.decideMention(db, req.params.id, 'linked') }); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // A rejected row is kept, not deleted — its presence is what stops the next rescan
  // proposing the same match again.
  router.post('/mentions/:id/reject', (req, res) => {
    try { res.json({ mention: men.decideMention(db, req.params.id, 'rejected') }); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  router.delete('/relations/:relId', (req, res) => {
    res.json({ deleted: rel.deleteRelation(db, req.params.relId) });
  });

  // Everything the Narrative Mirror needs about one relation, composed here so the client
  // makes one call instead of four and cannot assemble a half-set: both entities with
  // their rungs and postures, the mapped interiors on either side if any, and the scene —
  // the verified lines behind the claim. Every quote returned has already passed a
  // byte-for-byte check against its source file, which is why nothing here can hand the
  // Room an invented line.
  // One entity's mapped interior. Two exist, and that is the honest number — an anatomy
  // costs a careful read of a real scene. 404 is the normal answer.
  router.get('/entities/:id/anatomy', (req, res) => {
    // A read anatomy first, because it is the stronger answer: real parts, signed
    // weights, a tested split. Failing that, what containment already records — which
    // says who is inside without claiming to know how they stand.
    const read = rel.anatomyFor(req.params.id);
    if (read) return res.json({ anatomy: { kind: 'read', ...read } });
    const recorded = rel.recordedInside(db, req.params.id);
    if (recorded) return res.json({ anatomy: recorded });
    return res.status(404).json({ error: 'no_interior' });
  });

  // The spectral fingerprint of a read anatomy — needs a mapped interior, same 404 as
  // above when there isn't one. See graphSpectrum.js for what it means.
  router.get('/entities/:id/spectrum', (req, res) => {
    const s = spectrumFor(req.params.id);
    if (!s) return res.status(404).json({ error: 'no_interior' });
    res.json({ spectrum: s });
  });

  router.get('/spectral-compare', (req, res) => {
    const { a, b } = req.query;
    if (!a || !b) return res.status(400).json({ error: 'a and b are both required.' });
    res.json(compareEntities(a, b));
  });

  // Every deep connection the graph can currently draw — one edge per pair of entities
  // that both have a mapped interior. Replaces shared-tag/shared-author edges there.
  router.get('/spectral-edges', (req, res) => res.json({ edges: allSpectralEdges() }));

  router.get('/relations/:relId/mirror', (req, res) => {
    const r = rel.getRelation(db, req.params.relId);
    if (!r) return res.status(404).json({ error: 'not_found' });
    const side = (id) => {
      const e = q.getEntity(db, id);
      if (!e) return null;
      return {
        id: e.id, name: e.name, type: e.type, scale: e.scale,
        note: e.meta?.note || null,
        postures: e.meta?.postures || [],
        testimony: e.meta?.testimony || [],
        anatomy: rel.anatomyFor(e.id),
      };
    };
    res.json({
      relation: r,
      from: side(r.from_id),
      to: side(r.to_id),
      scene: r.moment ? rel.resolveMoment(r.moment) : null,
      // Loops either END sits in, not just the `from` one. Looking only at `from` was the
      // first version and it reported none for a relation whose other end was in a
      // circuit — which is precisely the case a reader is most likely to be looking at.
      loops: dedupeLoops([
        ...rel.findLoops(db, { entityId: r.from_id }),
        ...rel.findLoops(db, { entityId: r.to_id }),
      ]),
    });
  });

  // A loop is a query, never a row: vertical relations that leave a rung and come back to
  // it with time moving forward. Pass ?entity=<id> to ask only about one starting point.
  router.get('/loops', (req, res) => {
    res.json({ loops: rel.findLoops(db, { entityId: req.query.entity || undefined }) });
  });

  // Which anatomies have been asserted at which rungs, and which cells are empty. The
  // empty cells are the output worth having.
  router.get('/shape-audit', (req, res) => res.json(rel.shapeByRungAudit(db)));

  // The split screen — plans/anatomy-replaces-tags.md, Part 4. Two verified scenes and a
  // written reading of what they share. GET resolves both moments fresh on every call —
  // the verified quotes live in data-seed/interiors/, this table only ever points at them.
  router.get('/scene-pairs', (req, res) => res.json({ pairs: listScenePairs(db) }));

  router.get('/scene-pairs/:id', (req, res) => {
    const pair = getScenePair(db, req.params.id);
    if (!pair) return res.status(404).json({ error: 'not_found' });
    res.json({ pair });
  });

  router.post('/scene-pairs', (req, res) => {
    try {
      res.status(201).json({ pair: createScenePair(db, req.body) });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  router.delete('/scene-pairs/:id', (req, res) => {
    res.json({ deleted: deleteScenePair(db, req.params.id) });
  });

  // Saved maps — a walk kept so it can be returned to and deepened.
  router.get('/maps', (req, res) => res.json({ maps: rel.listSavedMaps(db) }));
  router.post('/maps', (req, res) => {
    try { res.status(201).json({ map: rel.saveMap(db, req.body || {}) }); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });
  router.delete('/maps/:mapId', (req, res) => res.json({ deleted: rel.deleteSavedMap(db, req.params.mapId) }));

  // Live facets (entity types, sources, continuum axes with their scored counts) so the
  // client's filter UI is built from real data instead of a hardcoded list of three types.
  router.get('/facets', (req, res) => res.json(q.listFacets(db)));

  // Theme clusters: which archetypal tags travel together, recomputed from the live
  // entity_tags table at every boot (services/tagCommunities.js).
  router.get('/tag-communities', (req, res) => res.json(q.listTagCommunities()));

  router.get('/tag-communities/:tag', (req, res) => {
    const out = q.tagCommunity(db, req.params.tag);
    if (!out) return res.status(404).json({ error: 'unknown_tag' });
    res.json(out);
  });

  // The same grouping read for its holes: which theme clusters barely touch
  // (services/tagGaps.js). Ranked, never a verdict.
  router.get('/tag-gaps', (req, res) => res.json(getTagGaps()));

  router.get('/clusters', (req, res) => res.json({ clusters: q.listClusters(db) }));
  router.get('/continuum-axes', (req, res) => res.json({ axes: q.listContinuumAxes(db) }));

  router.get('/continuum-axes/:key/nearby', (req, res) => {
    const value = parseFloat(req.query.value);
    if (Number.isNaN(value)) return res.status(400).json({ error: 'value_required' });
    const limit = Math.min(parseInt(req.query.limit || '10', 10), 50);
    res.json({ entities: q.nearbyOnAxis(db, req.params.key, value, limit) });
  });

  router.post('/entities/:id/books', asyncHandler(async (req, res) => {
    const entity = q.getEntity(db, req.params.id);
    if (!entity) return res.status(404).json({ error: 'not_found' });
    const out = await getBooks(entity, { force: !!req.body?.force });
    if (out.error) return res.status(500).json(out);
    res.json(out);
  }));

  router.post('/entities/:id/tag-lens', asyncHandler(async (req, res) => {
    const entity = q.getEntity(db, req.params.id);
    if (!entity) return res.status(404).json({ error: 'not_found' });
    const tag = req.body?.tag;
    const out = await getTagLens(entity, tag, { force: !!req.body?.force });
    if (out.error) return res.status(out.error === 'invalid_tag' ? 400 : 500).json(out);
    res.json(out);
  }));

  router.post('/entities/:id/books/detail', asyncHandler(async (req, res) => {
    const entity = q.getEntity(db, req.params.id);
    if (!entity) return res.status(404).json({ error: 'not_found' });
    const book = req.body?.book;
    const out = await getBookDetail(entity, book, { force: !!req.body?.force });
    if (out.error) return res.status(out.error === 'invalid_book' ? 400 : 500).json(out);
    res.json(out);
  }));

  // Tag tensions: the tag each tag stands against. Hand rows win over model rows.
  router.get('/tags/tensions', (req, res) => res.json({ tensions: listTensions(db) }));

  router.put('/tags/:tag/tension', (req, res) => {
    const against = String(req.body?.against || '').trim();
    const why = String(req.body?.why || '').trim();
    if (!against || !why) return res.status(400).json({ error: 'against_and_why_required' });
    res.json(setTension(db, req.params.tag, { against, why }, 'hand'));
  });

  // Fill every tag that has no tension yet, in the background. Warm-up does the same on
  // boot only under PREGEN_ENABLED; this lets the Mac kick it on a live instance.
  router.post('/tags/tensions/fill', (req, res) => {
    const missing = db.prepare(`SELECT COUNT(DISTINCT tag) AS n FROM entity_tags WHERE tag NOT IN (SELECT tag FROM tag_tensions)`).get().n;
    fillMissingTensions(db).catch((e) => console.warn('[tag-tension] fill failed:', e.message));
    res.json({ started: true, missing });
  });

  router.post('/tags/:tag/tension/regenerate', asyncHandler(async (req, res) => {
    const tag = req.params.tag;
    const existing = db.prepare(`SELECT * FROM tag_tensions WHERE tag=?`).get(tag);
    if (existing?.source === 'hand') return res.json({ ...existing, kept: 'hand' });
    db.prepare(`DELETE FROM tag_tensions WHERE tag=?`).run(tag);
    const out = await generateTension(db, tag);
    if (out.error) return res.status(502).json(out);
    res.json(out);
  }));

  router.post('/tags/:tag/explain', asyncHandler(async (req, res) => {
    const out = await getTagPattern(req.params.tag, { force: !!req.body?.force });
    if (out.error) return res.status(out.error === 'invalid_tag' ? 400 : 500).json(out);
    res.json(out);
  }));

  return router;
}
