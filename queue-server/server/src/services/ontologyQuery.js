// Query functions over the shared entities tables — used by both the plain HTTP API
// (routes/ontology.js) and the chat assistant's tools (services/chat.js), so the two
// never drift out of sync with each other.

import { getTagCommunities } from './tagCommunities.js';

export function hydrate(db, row) {
  if (!row) return null;
  const tags = db.prepare(`SELECT tag FROM entity_tags WHERE entity_id=?`).all(row.id).map((t) => t.tag);
  const continuum = {};
  for (const c of db.prepare(`SELECT axis_key, value FROM entity_continuum WHERE entity_id=?`).all(row.id)) {
    continuum[c.axis_key] = c.value;
  }
  return { ...row, clusters: JSON.parse(row.clusters || '[]'), grounded: !!row.grounded, meta: JSON.parse(row.meta || '{}'), tags, continuum };
}

export function searchEntities(db, { type, cluster, tag, name, grounded, source } = {}) {
  let rows = db.prepare(`SELECT * FROM entities`).all();
  if (type) rows = rows.filter((r) => r.type === type);
  if (source) rows = rows.filter((r) => (r.source || 'archive') === source);
  if (grounded !== undefined && grounded !== null) rows = rows.filter((r) => !!r.grounded === !!grounded);
  if (cluster) rows = rows.filter((r) => JSON.parse(r.clusters || '[]').includes(cluster));
  if (name) rows = rows.filter((r) => r.name.toLowerCase().includes(String(name).toLowerCase()));
  let hydrated = rows.map((r) => hydrate(db, r));
  if (tag) hydrated = hydrated.filter((e) => e.tags.includes(tag));
  return hydrated;
}

export function getEntity(db, id) {
  const row = db.prepare(`SELECT * FROM entities WHERE id=?`).get(id);
  if (!row) return null;
  const entity = hydrate(db, row);
  if (entity.container_id) entity.container = hydrate(db, db.prepare(`SELECT * FROM entities WHERE id=?`).get(entity.container_id));
  entity.children = db.prepare(`SELECT * FROM entities WHERE container_id=?`).all(entity.id).map((r) => hydrate(db, r));
  return entity;
}

export function listClusters(db) { return db.prepare(`SELECT * FROM clusters`).all(); }
export function listContinuumAxes(db) { return db.prepare(`SELECT * FROM continuum_axes`).all(); }

export function nearbyOnAxis(db, key, value, limit = 10) {
  const rows = db.prepare(`
    SELECT e.*, ec.value AS axis_value FROM entity_continuum ec
    JOIN entities e ON e.id = ec.entity_id
    WHERE ec.axis_key = ?
    ORDER BY ABS(ec.value - ?) ASC LIMIT ?
  `).all(key, value, limit);
  return rows.map((r) => ({ ...hydrate(db, r), axis_value: r.axis_value }));
}

// Live facet values, computed from what's actually in the DB rather than hardcoded in
// the client. This is what lets a new entity source (Reddit-derived pattern-instances)
// appear in Exploration's filters automatically the moment such rows exist, instead of
// needing a new checkbox shipped in the frontend.
export function listFacets(db) {
  const types = db.prepare(`SELECT type AS value, COUNT(*) AS n FROM entities GROUP BY type ORDER BY n DESC`).all();
  const sources = db.prepare(`SELECT COALESCE(source,'archive') AS value, COUNT(*) AS n FROM entities GROUP BY COALESCE(source,'archive') ORDER BY n DESC`).all();
  const axes = db.prepare(`
    SELECT a.key, a.name, a.low, a.high,
           COUNT(ec.entity_id) AS scored,
           MIN(ec.value) AS min_value,
           MAX(ec.value) AS max_value
    FROM continuum_axes a LEFT JOIN entity_continuum ec ON ec.axis_key = a.key
    GROUP BY a.key, a.name, a.low, a.high
  `).all();
  const total = db.prepare(`SELECT COUNT(*) AS n FROM entities`).get().n;
  return { types, sources, axes, total };
}

// ─── Theme clusters (tag communities) ────────────────────────────────────────
// The index itself is computed once at boot from entity_tags (services/tagCommunities.js).
// These two read it; nothing here touches the frozen data-seed snapshot.

export function listTagCommunities() { return getTagCommunities(); }

// Everything the detail panel needs for one tag in one call: the community it belongs
// to, its sibling tags, and the entities that carry any of them — heaviest sharers
// first, so "what else lives here" is answered in reading order.
export function tagCommunity(db, tag, limit = 200) {
  const idx = getTagCommunities();
  const id = idx.tagCommunity[tag];
  if (!id) return null;
  const community = idx.communities.find((c) => c.id === id);
  if (!community) return null;
  const placeholders = community.tags.map(() => '?').join(',');
  const entities = db.prepare(`
    SELECT e.id, e.name, e.type, COALESCE(e.source,'archive') AS source, COUNT(*) AS shared
    FROM entity_tags t JOIN entities e ON e.id = t.entity_id
    WHERE t.tag IN (${placeholders})
    GROUP BY e.id, e.name, e.type, source
    ORDER BY shared DESC, e.name ASC
    LIMIT ?
  `).all(...community.tags, limit);
  return {
    tag,
    community,
    siblings: community.tags.filter((t) => t !== tag),
    entities,
    entityCount: entities.length,
  };
}
