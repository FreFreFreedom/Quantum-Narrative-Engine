// Query functions over the shared entities tables — used by both the plain HTTP API
// (routes/ontology.js) and the chat assistant's tools (services/chat.js), so the two
// never drift out of sync with each other.

export function hydrate(db, row) {
  if (!row) return null;
  const tags = db.prepare(`SELECT tag FROM entity_tags WHERE entity_id=?`).all(row.id).map((t) => t.tag);
  const continuum = {};
  for (const c of db.prepare(`SELECT axis_key, value FROM entity_continuum WHERE entity_id=?`).all(row.id)) {
    continuum[c.axis_key] = c.value;
  }
  return { ...row, clusters: JSON.parse(row.clusters || '[]'), grounded: !!row.grounded, meta: JSON.parse(row.meta || '{}'), tags, continuum };
}

export function searchEntities(db, { type, cluster, tag, name, grounded } = {}) {
  let rows = db.prepare(`SELECT * FROM entities`).all();
  if (type) rows = rows.filter((r) => r.type === type);
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
