// Search by bone — plans/anatomy-replaces-tags.md, Part 2; fractal_operational_core.md §21.
//
// "They do not share a single word. But their anatomy is identical." The acceptance test for
// this module, stated in the conversation it comes from: a match that shares vocabulary with
// the query proves nothing. The strongest result is the one sharing no tag at all.
//
// What "bone" means here, concretely: the SHAPE field already recorded on a written relation
// (entity_relations.shape — sh_boundary_miscut, sh_load_down, sh_protect_becomes_prey,
// sh_exile_to_hold). A shape is deliberately a structural category, not a vocabulary word —
// it was named that way from the start, and the horizontal relation between Pittsburgh's
// sanitation department and the Baltimore police (both sh_boundary_miscut, thirty years and
// one city apart, sharing not one tag) is the proof this mechanism already has material to
// find. Two entities match when a relation touching one carries the same shape as a relation
// touching the other — regardless of rung, regardless of domain, regardless of vocabulary.
//
// Computed, never stored — same discipline as peers.js and for the same reason: a search
// result is a resemblance the app noticed, not a claim anyone is answerable for. And ranked
// by a COUNT (how many shapes two entities share), never a threshold anyone could move —
// `limit` below is a display cap, exactly like PEER_CAP in peers.js, and changing it changes
// how many results are shown, never which entities match.
//
// What this does NOT do, and must not claim to: it does not "re-draw the map" (§21's harder
// standard — the output that does not exist anywhere, here included). It returns a ranked
// list. That is a real, useful thing, and it is not the instrument the vision asks for.

import { relationsFor } from './entityRelations.js';

export const BONE_CAP = 20;

function shapesOf(db, entityId) {
  return new Set(relationsFor(db, entityId).map((r) => r.shape).filter(Boolean));
}

// All tags for every entity, one query, grouped — so ranking 492 candidates costs one pass
// over entity_tags rather than one query per candidate.
function allTagsByEntity(db) {
  const rows = db.prepare(`SELECT entity_id, tag FROM entity_tags`).all();
  const byEntity = new Map();
  for (const r of rows) {
    if (!byEntity.has(r.entity_id)) byEntity.set(r.entity_id, []);
    byEntity.get(r.entity_id).push(r.tag);
  }
  return byEntity;
}

export function boneSearch(db, entityId, { limit = BONE_CAP } = {}) {
  const me = db.prepare(`SELECT id, name, type, scale FROM entities WHERE id=?`).get(entityId);
  if (!me) return null;

  const myShapes = shapesOf(db, entityId);
  if (!myShapes.size) {
    return {
      of: { id: me.id, name: me.name, scale: me.scale },
      reason: `${me.name} has no written-down relation yet, so there is no shape to search on. `
        + `Write one down, with a source and a falsifier, and it becomes searchable.`,
      matchCount: 0,
      matches: [],
    };
  }

  const tagsByEntity = allTagsByEntity(db);
  const myTags = new Set(tagsByEntity.get(entityId) || []);

  const candidates = db.prepare(`SELECT id, name, type, scale FROM entities WHERE id != ?`).all(entityId);
  const matches = [];
  for (const o of candidates) {
    const theirShapes = shapesOf(db, o.id);
    const sharedShapes = [...myShapes].filter((s) => theirShapes.has(s));
    if (!sharedShapes.length) continue;
    const sharedTags = (tagsByEntity.get(o.id) || []).filter((t) => myTags.has(t));
    matches.push({
      id: o.id, name: o.name, type: o.type, scale: o.scale,
      sharedShapes, sharedTags,
      // The honest headline: does this match prove the point, or merely agree with it?
      boneOnly: sharedTags.length === 0,
    });
  }

  // Most shared shapes first; among ties, the bone-only matches first — they are the
  // stronger evidence, per the acceptance test above.
  matches.sort((a, b) =>
    b.sharedShapes.length - a.sharedShapes.length
    || Number(b.boneOnly) - Number(a.boneOnly)
    || a.id.localeCompare(b.id));

  return {
    of: { id: me.id, name: me.name, scale: me.scale },
    myShapes: [...myShapes],
    matchCount: matches.length,
    matches: matches.slice(0, limit),
  };
}
