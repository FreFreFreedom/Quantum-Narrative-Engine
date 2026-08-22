// Umbrellas that are earned, not decreed (plan an-architecture-that-knows-what-it-is,
// section 3).
//
// The five `territory` values (perception / knowledge / reasoning / experience /
// interface) were named BEFORE the nodes existed. The result was 42 nodes of which
// only 3 had a parent, so "reasoning" was fifteen undifferentiated siblings: a label
// carrying no weight, unable to absorb growth. This module derives the grouping from
// the nodes' OWN text instead, and keeps `territory` untouched as a legacy field —
// the frontend trunk, the prompts in ai/appModel.js and the node colouring all still
// read it.
//
// Cost discipline (CLAUDE.md), and the whole reason this file is shaped the way it
// is: ONE cheap call per derivation, through the ai/text.js feature seam (feature
// key 'umbrellas', exactly as treeSync does it) so it obeys the model policy and the
// free-first lane. A derivation runs only when the node set has actually moved —
// >= UMBRELLA_CHURN_THRESHOLD churn since the last one — or on an explicit click.
// NEVER on a read: getUmbrellaMap() cannot make a model call, by construction.
//
// Churn needs no state table of its own, because the assignment IS the record of
// what was present last time:
//   baseline = every node carrying an umbrella_id, soft-deleted ones included
//   added    = live nodes with no umbrella_id      (planted since the derivation)
//   removed  = soft-deleted nodes with an umbrella (retired since the derivation)
// A finished derivation clears umbrella_id off the soft-deleted rows, which resets
// the baseline to exactly the live set.

import { generateText } from './ai/text.js';
import { USER_FACING_STYLE } from './ai/style.js';
import { APP_BLURB } from './ai/appModel.js';
import { parseJsonObject } from './codeDiscovery.js';

// The pressure rule. An umbrella holding more than this at rest is flagged: it must
// split, or something inside it must retire. The flag is surfaced, never acted on —
// deciding which of the two is Antoine's call, not the app's.
export const PRESSURE_LIMIT = 7;

// Re-derive once a tenth of the node set has changed. Below that the existing
// grouping is still a fair description of the tree and a call would buy nothing.
export const UMBRELLA_CHURN_THRESHOLD = 0.1;

const TARGET_MIN = 5;
const TARGET_MAX = 8;

// The prior art the prompt is asked to IMPROVE ON rather than replace. Handing the
// model a blank page here produces bland categories ("Core", "Features", "Data") —
// the risk called out in the plan.
const LEGACY_TERRITORIES = [
  'perception — how new material gets in',
  'knowledge — the shared shape of the material, its tags and cross-type links',
  'reasoning — working things out over the graph',
  'experience — how it feels to explore',
  'interface — what you touch',
  'self — the app\'s own build system',
];

// Obviously-junk nodes, cleaned up as part of a derivation (the plan asks for the
// literal node named `test` to go). Deliberately a fixed list and an exact,
// case-insensitive name match — no model judgement anywhere near a delete. The
// delete is the same soft delete the rest of the tree uses, so nothing is lost.
const JUNK_NAMES = new Set([
  'test', 'tests', 'testing', 'todo', 'tbd', 'foo', 'bar', 'baz',
  'asdf', 'qwerty', 'xxx', 'placeholder', 'untitled', 'dummy', 'temp', 'tmp',
]);

const isJunkName = (name) => {
  const n = String(name || '').trim().toLowerCase();
  return n.length <= 1 || JUNK_NAMES.has(n);
};

const now = () => new Date().toISOString();

// Ids are derived from the name (the architectureNodes.js convention) so an umbrella
// reads as `the-machine-that-builds-itself` rather than a uuid — and so a re-derivation
// that lands on the same name REUSES the same id instead of accumulating `-2`, `-3`
// suffixes every time the grouping is refreshed. `used` only guards against two
// umbrellas in the SAME run slugging to the same string.
function slugId(name, used) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'umbrella';
  let id = base, n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  used.add(id);
  return id;
}

// The one line each node contributes to the prompt. `summary` is the written
// one-liner where one exists; `what` is a paragraph by contract, so it is cut.
function nodeLine(r) {
  const text = String(r.summary || r.what || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  return `- ${r.id} — ${r.name} [${r.territory}]${text ? `: ${text}` : ''}`;
}

function liveNodes(db) {
  return db.prepare(`
    SELECT id, name, territory, what, summary, status, provenance, proposed, umbrella_id
    FROM architecture_nodes WHERE deleted_at IS NULL ORDER BY created_at
  `).all();
}

// ─── Churn ────────────────────────────────────────────────────────────────────
// Free: three COUNT(*)s. This is what the derive endpoint consults before it is
// allowed to spend anything.
export function umbrellaChurn(db) {
  const one = (sql) => db.prepare(sql).get()?.n || 0;
  const umbrellas = one(`SELECT COUNT(*) n FROM architecture_umbrellas`);
  const baseline = one(`SELECT COUNT(*) n FROM architecture_nodes WHERE umbrella_id IS NOT NULL`);
  const added = one(`SELECT COUNT(*) n FROM architecture_nodes WHERE deleted_at IS NULL AND umbrella_id IS NULL`);
  const removed = one(`SELECT COUNT(*) n FROM architecture_nodes WHERE deleted_at IS NOT NULL AND umbrella_id IS NOT NULL`);
  const derivedAt = db.prepare(`SELECT MAX(derived_at) d FROM architecture_umbrellas`).get()?.d || null;
  // Never derived (or derived and then every umbrella dropped) — treat as fully
  // stale so the first run is never blocked by a threshold.
  const ratio = (!umbrellas || !baseline) ? 1 : (added + removed) / baseline;
  return {
    umbrellas, baseline, added, removed,
    ratio: Math.round(ratio * 1000) / 1000,
    threshold: UMBRELLA_CHURN_THRESHOLD,
    stale: ratio >= UMBRELLA_CHURN_THRESHOLD,
    derived_at: derivedAt,
  };
}

// ─── The prompt ───────────────────────────────────────────────────────────────
function buildPrompt(nodes) {
  return `You are re-organising the map an app keeps of its own architecture.

The app: ${APP_BLURB}

Below is every component currently on that map, one per line, in the form:
  id — name [old category]: what it is

${nodes.map(nodeLine).join('\n')}

Group these components into ${TARGET_MIN} to ${TARGET_MAX} umbrella categories.

The app already has these categories, and they are the problem: they were named BEFORE any of the components existed, so one of them now holds fifteen unrelated things and the rest hold almost nothing. Treat them as prior art to BEAT, not as a starting point:
${LEGACY_TERRITORIES.map(t => `  ${t}`).join('\n')}

Rules:
- Read what the components actually ARE and let the categories fall out of that. A good category is one you could add three more components to and still have it mean something.
- Every component must be assigned to exactly one umbrella. Use the ids exactly as written above.
- No umbrella should hold more than ${PRESSURE_LIMIT} components. If a natural group is bigger than that, split it along a real distinction and name both halves.
- No umbrella should hold a single component unless it genuinely belongs nowhere else.
- Do not reuse a category name from the list above unless it is honestly the best name for that group.
- Each name is at most four words. Each blurb is ONE sentence saying what belongs in it and what does not.

${USER_FACING_STYLE}

Respond with ONLY a JSON object, no prose, no markdown fence:
{"umbrellas":[{"name":"Short Name","blurb":"one sentence","nodes":["node-id","node-id"]}]}`;
}

// ─── Assignment ───────────────────────────────────────────────────────────────
// Take what the model returned and make it total and disjoint: unknown ids
// dropped, a node claimed twice kept by its first claim, and anything the model
// forgot placed by its legacy territory (whichever umbrella already holds the most
// of its old category — the best available guess, and always a real umbrella).
// "every node assigned" is a promise this function keeps, not one the model does.
function assign(nodes, proposed) {
  const known = new Map(nodes.map(n => [n.id, n]));
  const claimed = new Set();
  const groups = [];

  for (const u of proposed) {
    const name = String(u?.name || '').trim().slice(0, 60);
    if (!name) continue;
    const ids = (Array.isArray(u.nodes) ? u.nodes : [])
      .filter(id => typeof id === 'string' && known.has(id) && !claimed.has(id));
    ids.forEach(id => claimed.add(id));
    groups.push({ name, blurb: String(u.blurb || '').trim().slice(0, 400), ids });
  }
  if (!groups.length) return null;

  const leftovers = nodes.filter(n => !claimed.has(n.id));
  for (const n of leftovers) {
    let best = groups[0], bestScore = -1;
    for (const g of groups) {
      const score = g.ids.reduce((s, id) => s + (known.get(id).territory === n.territory ? 1 : 0), 0);
      if (score > bestScore) { bestScore = score; best = g; }
    }
    best.ids.push(n.id);
  }

  // An umbrella the model named but never filled is noise on the map.
  return groups.filter(g => g.ids.length);
}

// ─── Derivation ───────────────────────────────────────────────────────────────
// The only path in this file that can spend anything. `force` is the explicit
// click; without it the churn gate decides, and a gated call returns
// `skipped: 'no_churn'` having asked no model at all.
export async function deriveUmbrellas(db, { force = false } = {}) {
  const churn = umbrellaChurn(db);
  if (!force && !churn.stale) return { skipped: 'no_churn', churn };

  // Junk is held out of the prompt so it can never land in an umbrella — but it is
  // only actually retired at write time below, so a failed or unusable model reply
  // leaves the tree exactly as it found it.
  const all = liveNodes(db);
  const junk = all.filter(n => isJunkName(n.name));
  const nodes = all.filter(n => !isJunkName(n.name));
  if (nodes.length < TARGET_MIN) {
    return { error: 'too_few_nodes', message: 'There are not enough components on the map to group yet.', nodes: nodes.length };
  }

  const out = await generateText({
    prompt: buildPrompt(nodes),
    feature: 'umbrellas',
    maxTokens: 1600,
    label: 'arch-umbrellas',
  });
  if (out.error) return { error: out.error, message: out.message };

  const parsed = parseJsonObject(out.text);
  const proposed = Array.isArray(parsed?.umbrellas) ? parsed.umbrellas : [];
  const groups = proposed.length ? assign(nodes, proposed) : null;
  if (!groups || !groups.length) {
    return { error: 'unparseable', message: 'The grouping came back unusable, so nothing was changed.' };
  }

  // Write order matters: new umbrellas in, nodes repointed, only then the old rows
  // out — so no node is ever pointing at a row that no longer exists. There are no
  // transactions anywhere in this schema (see the other services), so the ordering
  // is the safety.
  const stamp = now();
  for (const n of junk) {
    db.prepare(`UPDATE architecture_nodes SET deleted_at=?, fingerprint=NULL WHERE id=?`).run(stamp, n.id);
  }
  const keep = [];
  const used = new Set();
  for (const g of groups) {
    const id = slugId(g.name, used);
    db.prepare(`
      INSERT INTO architecture_umbrellas (id, name, blurb, derived_at) VALUES (?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, blurb=excluded.blurb, derived_at=excluded.derived_at
    `).run(id, g.name, g.blurb, stamp);
    keep.push(id);
    for (const nodeId of g.ids) {
      db.prepare(`UPDATE architecture_nodes SET umbrella_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
        .run(id, nodeId);
    }
  }
  const placeholders = keep.map(() => '?').join(',');
  db.prepare(`DELETE FROM architecture_umbrellas WHERE id NOT IN (${placeholders})`).run(...keep);
  // Reset the churn baseline to the live set: a retired node's old umbrella has
  // been counted once and must not be counted again on the next check.
  db.prepare(`UPDATE architecture_nodes SET umbrella_id=NULL WHERE deleted_at IS NOT NULL`).run();

  const map = getUmbrellaMap(db);
  return {
    derived_at: stamp,
    umbrellas: map.umbrellas.length,
    nodes: nodes.length,
    retired: junk.map(n => n.name),
    flags: map.flags,
    churn_before: churn,
  };
}

// Fire-and-forget churn check for callers that just changed the node set (the tree
// sync). Never throws, never blocks them: a grouping that could break a task
// finishing is worse than a stale grouping.
export async function maybeDeriveUmbrellas(db) {
  try {
    const churn = umbrellaChurn(db);
    if (!churn.stale) return { skipped: 'no_churn', churn };
    return await deriveUmbrellas(db, { force: false });
  } catch (e) {
    console.error('[umbrellas] auto-derive failed —', e.message);
    return { error: e.message };
  }
}

// ─── Read ─────────────────────────────────────────────────────────────────────
// Shaped for d3.pack(), which is already vendored in the frontend: `root` is a
// two-level {name, children} tree whose leaves carry `value`, so
// d3.hierarchy(root).sum(d => d.value) then d3.pack() consumes it as-is with no
// reshaping on the client. Every node also carries its own fields, so a click on a
// circle has the whole node without a second request.
//
// This function must never make a model call. It is the "never on view" half of
// the cost rule.
export function getUmbrellaMap(db) {
  const rows = db.prepare(`SELECT * FROM architecture_umbrellas ORDER BY name`).all();
  const nodes = liveNodes(db);

  const leaf = (n) => ({
    id: n.id,
    name: n.name,
    value: 1,
    status: n.status,
    territory: n.territory,          // legacy field, still read by the trunk and the colouring
    provenance: n.provenance,
    proposed: !!n.proposed,
    summary: n.summary || '',
    what: n.what || '',
  });

  const byUmbrella = new Map(rows.map(r => [r.id, []]));
  const unsorted = [];
  for (const n of nodes) {
    const bucket = n.umbrella_id && byUmbrella.has(n.umbrella_id) ? byUmbrella.get(n.umbrella_id) : null;
    (bucket || unsorted).push(leaf(n));
  }

  const groups = rows.map(r => {
    const children = byUmbrella.get(r.id);
    return {
      id: r.id,
      name: r.name,
      blurb: r.blurb || '',
      derived_at: r.derived_at,
      count: children.length,
      // The pressure rule, surfaced. Not acted on: the split-or-retire decision is
      // the owner's.
      over_pressure: children.length > PRESSURE_LIMIT,
      pressure_limit: PRESSURE_LIMIT,
      children,
    };
  });

  // Nodes planted since the last derivation are shown as their own group rather
  // than dropped — a component missing from the map is the worse failure. It is
  // marked so the renderer can draw it as the waiting room it is.
  if (unsorted.length) {
    groups.push({
      id: 'unsorted',
      name: 'Not sorted yet',
      blurb: 'Added since the last grouping.',
      derived_at: null,
      count: unsorted.length,
      unsorted: true,
      over_pressure: false,
      pressure_limit: PRESSURE_LIMIT,
      children: unsorted,
    });
  }

  const flags = groups.filter(g => g.over_pressure)
    .map(g => ({ umbrella_id: g.id, name: g.name, count: g.count, limit: PRESSURE_LIMIT }));

  return {
    root: { id: 'root', name: 'Architecture', children: groups },
    umbrellas: groups,
    flags,
    derived_at: rows.length ? rows.reduce((a, r) => (r.derived_at > a ? r.derived_at : a), '') : null,
    churn: umbrellaChurn(db),
  };
}
