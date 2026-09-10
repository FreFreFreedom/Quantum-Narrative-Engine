// The horizontal move — plans/civic-structures-and-loops.md's third navigation move, and
// the last of the three to get anything that FINDS it.
//
// The paradigm names three moves (fractal_operational_core.md §9). Vertical traces a real
// path down or up the scale ladder, every rung visited. An entanglement jump asserts
// structural kinship across scale AND domain with no path at all. Horizontal compares peers
// on the same rung: *who else is here, and who is doing it better?* All three can be
// STORED as relations and the validator enforces each one's rule — but until now only
// vertical and jump had anything that looked for them, and horizontal had exactly one
// instance in the whole corpus, put there by hand.
//
// WHY THIS ONE IS CHEAP, AND THE HEALING SEARCH IS NOT. Comparing a gut to a police
// department needs a domain-free, label-free way to say two structures match — an
// invention nobody has (see plans/cross-domain-healing-search.md). Two police departments
// need no such thing: they are already comparable, on fields they both actually have. That
// is exactly why §9 calls horizontal "the cheapest of the three, and the only one that
// needs no interpretation to get started".
//
// WHAT "BETTER" IS ALLOWED TO MEAN. The Integration Continuum supplies a direction — its
// high pole is literally *Integrated Accountability* — so "further along" is a claim the
// paradigm licenses. What it does NOT license is "right": §16's correction says a fractal
// boundary has no correct location, so integration is a direction and never a destination.
// And the score is SOMEBODY'S ASSIGNMENT, not a measurement. Every field that carries one
// says so, in `source`, so no caller can render it as fact without stepping over the word.
//
// COMPUTED, NEVER STORED. A peer listing is a resemblance this module noticed. A stored
// relation is a claim someone is answerable for, with a source and a falsifier the
// validator refuses to do without. Those must not blur, so nothing here writes.

import { rungOf, rungName } from './scaleLadder.js';
import { relationsFor, findLoops } from './entityRelations.js';
import { mentionsFor } from './entityMentions.js';

// The individual rung holds 237 entities. A peer list is read by a person and, through the
// Room tool, re-sent with every subsequent round — so it is capped rather than complete.
export const PEER_CAP = 20;

// How much structure two entities share, for the "who else is here" ordering. Deliberately
// NOT a tuned score: it counts things that are either present or absent, so there is no
// threshold anyone could move to get a nicer answer.
function alikeness(mine, theirs) {
  return (theirs.sharedShapes.length * 3)          // an asserted shape, weighted most
    + (theirs.postures.length && mine.postures.length ? 2 : 0)
    + (theirs.relationProfile.inLoop === mine.relationProfile.inLoop ? 1 : 0)
    + Math.min(theirs.sharedTags.length, 3);       // label overlap, capped so it cannot dominate
}

function profileOf(db, entityId) {
  const rows = relationsFor(db, entityId);
  const p = { total: rows.length, down: 0, up: 0, horizontal: 0, jump: 0, inLoop: false, shapes: [] };
  for (const r of rows) {
    if (r.move === 'vertical') p[r.direction === 'down' ? 'down' : 'up'] += 1;
    else if (r.move === 'horizontal') p.horizontal += 1;
    else p.jump += 1;
    if (r.shape) p.shapes.push(r.shape);
  }
  p.shapes = [...new Set(p.shapes)];
  p.inLoop = findLoops(db, { entityId }).length > 0;
  return p;
}

function axisRows(db) {
  return db.prepare(`SELECT key, name, low, high FROM continuum_axes`).all();
}

function scoresOf(db, entityId) {
  const out = {};
  for (const r of db.prepare(`SELECT axis_key, value FROM entity_continuum WHERE entity_id=?`).all(entityId)) {
    out[r.axis_key] = r.value;
  }
  return out;
}

function tagsOf(db, entityId) {
  return db.prepare(`SELECT tag FROM entity_tags WHERE entity_id=?`).all(entityId).map((t) => t.tag);
}

/**
 * Peers of one entity on its own rung.
 *
 * Two ordered lists come back rather than one, because the question has two halves and no
 * single sort answers both:
 *   alongside    — who else is here, most structurally alike first
 *   furtherAlong — who is doing it better, biggest gap on a shared axis first
 */
export function peersOf(db, entityId, { limit = PEER_CAP } = {}) {
  const me = db.prepare(`SELECT id, name, type, scale FROM entities WHERE id=?`).get(entityId);
  if (!me) return null;

  const myRung = rungOf(me.scale);
  if (myRung === null) {
    // A medium sits on no rung, so it has no peers — and saying that plainly is the point.
    // Comparing two films would be comparing two records of testimony as though they were
    // things that maintain themselves (§1), which is the error the ladder exists to prevent.
    return {
      of: { id: me.id, name: me.name, scale: me.scale },
      rung: null,
      reason: `${me.name} is a medium — a record carrying testimony, not an entity that sits on the scale ladder — so it has no peers. The institutions, families and cities it testifies about do.`,
      alongside: [],
      furtherAlong: [],
    };
  }

  // Same RUNG, not same type: the legacy stored value `national` maps onto the nation rung,
  // and matching on type would split countries from any future nation-scaled entity.
  const candidates = db.prepare(`SELECT id, name, type, scale FROM entities WHERE id != ?`).all(entityId)
    .filter((e) => rungOf(e.scale) === myRung);

  const axes = axisRows(db);
  const myScores = scoresOf(db, entityId);
  const myTags = new Set(tagsOf(db, entityId));
  const myProfile = profileOf(db, entityId);
  const myPostures = posturesOf(db, entityId);
  const mine = { postures: myPostures, relationProfile: myProfile };

  const peers = candidates.map((c) => {
    const theirScores = scoresOf(db, c.id);
    const theirTags = tagsOf(db, c.id);
    const profile = profileOf(db, c.id);
    return {
      id: c.id,
      name: c.name,
      type: c.type,
      // Every axis BOTH are scored on. `source` is 'assigned' for all of them today and is
      // present from the first commit on purpose: it is the field an imported policy metric
      // fills later, so "outside data" costs a value rather than a reshape.
      axes: axes.filter((a) => typeof myScores[a.key] === 'number' && typeof theirScores[a.key] === 'number')
        .map((a) => ({
          key: a.key,
          name: a.name,
          low: a.low,
          high: a.high,
          mine: myScores[a.key],
          theirs: theirScores[a.key],
          delta: Number((theirScores[a.key] - myScores[a.key]).toFixed(3)),
          direction: theirScores[a.key] > myScores[a.key] ? 'further' : theirScores[a.key] < myScores[a.key] ? 'behind' : 'level',
          source: 'assigned',   // a person scored this; it was not measured
        })),
      relationProfile: profile,
      postures: posturesOf(db, c.id),
      mentions: mentionsFor(db, c.id).length,
      // Secondary: `shape` is a DECLARED handle, hand-written in the seed, not derived from
      // structure. Useful for grouping within a rung; never a basis for matching across one.
      sharedShapes: profile.shapes.filter((s) => myProfile.shapes.includes(s)),
      // Last, and it is label-matching: a tag is a token with no interior (§18). Kept
      // because it is cheap signal between two entities that are already comparable.
      sharedTags: theirTags.filter((t) => myTags.has(t)),
    };
  }).map((p) => ({
    ...p,
    // The axis this peer is RANKED on, decided here so a caller cannot rank by one number
    // and print another. It shipped broken for exactly that reason: the card rendered
    // axes[0] while the sort used the largest delta, so an entity scored on two axes was
    // ordered by one and labelled with the other — Macbeth ranked at +0.65 and displayed
    // +0.12. One place decides, and everything downstream reads it.
    leadAxis: p.axes.length
      ? p.axes.reduce((best, a) => (a.delta > best.delta ? a : best), p.axes[0])
      : null,
  }));

  const alongside = [...peers]
    .map((p) => ({ ...p, alikeness: alikeness(mine, p) }))
    .filter((p) => p.alikeness > 0)
    .sort((a, b) => b.alikeness - a.alikeness || a.name.localeCompare(b.name))
    .slice(0, limit);

  const furtherAlong = [...peers]
    .filter((p) => p.leadAxis && p.leadAxis.delta > 0)
    .sort((a, b) => b.leadAxis.delta - a.leadAxis.delta || a.name.localeCompare(b.name))
    .slice(0, limit);

  return {
    of: { id: me.id, name: me.name, scale: me.scale, postures: myPostures, relationProfile: myProfile },
    rung: rungName(me.scale),
    peerCount: peers.length,
    alongside,
    furtherAlong,
    // The "worth importing" answer: what the peer furthest along holds that this one does
    // not. A set difference over data that already exists — nothing is generated, and the
    // caller can check every item against the entity it came from.
    difference: furtherAlong.length ? differenceFrom(db, entityId, furtherAlong[0], myTags, myProfile, myPostures) : null,
  };
}

function posturesOf(db, entityId) {
  const row = db.prepare(`SELECT meta FROM entities WHERE id=?`).get(entityId);
  if (!row) return [];
  try { return JSON.parse(row.meta || '{}').postures || []; } catch { return []; }
}

function differenceFrom(db, entityId, peer, myTags, myProfile, myPostures) {
  const myPostureNames = new Set(myPostures.map((p) => p.name));
  return {
    peer: peer.name,
    peerId: peer.id,
    // Lead first, so the sentence names the same axis the ranking did.
    onAxis: [peer.leadAxis, ...peer.axes.filter((a) => a !== peer.leadAxis)]
      .filter((a) => a && a.delta > 0)
      .map((a) => `${a.name} ${a.mine} → ${a.theirs} (+${a.delta.toFixed(2)}, toward "${a.high}")`),
    holdsPosturesYouDoNot: peer.postures.filter((p) => !myPostureNames.has(p.name)).map((p) => p.name),
    carriesShapesYouDoNot: peer.relationProfile.shapes.filter((s) => !myProfile.shapes.includes(s)),
    taggedThingsYouAreNot: tagsOf(db, peer.id).filter((t) => !myTags.has(t)),
    // Said here rather than left to the reader, because a float rendered without it reads
    // as a measurement and this one is not.
    caveat: 'The axis score is a hand-assigned reading, not a measurement. "Further along" means further toward integration on an axis a person scored — never that this peer is right.',
  };
}
