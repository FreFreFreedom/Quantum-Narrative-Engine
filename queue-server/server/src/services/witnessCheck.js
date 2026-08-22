// The checker that makes the architecture tree self-pruning.
//
// Why this exists. Every node in `architecture_nodes` used to sit at 'Concept'
// forever: the tree could only ever grow, because nothing in the app could tell
// the difference between an idea and a thing that was actually built. A witness
// is how a node proves itself — one grep or one SQL query, no model call, so this
// can run on every ship and on demand at literally no cost.
//
// Five kinds, split by what they need to read:
//
//   table  ·  query          → the database. Runs HERE, on Railway, for free.
//   file   ·  symbol · route → the working tree. Railway has NO git repository
//                              (gitOps.mainRepo() returns null there), so these
//                              are parked as a model-free 'witness' helper job and
//                              answered on Antoine's Mac by the local runner, the
//                              same route codeReviewPass.js and the repo probe take.
//
// Dependency-free in the same sense as shipChecks.js and codeReviewPass.js: no npm
// package, no config, no network of its own, and — importantly — no static import
// of anything that drags the server's provider stack in, because
// queue-server/scripts/queue-runner.js imports the repo half of this file and runs
// it on the Mac. The one server-only import is dynamic, inside the one function
// that needs it.
//
// ── The rule that matters most ────────────────────────────────────────────────
// NEVER retire on uncertainty. A check has three outcomes, not two:
//
//   ok === true   the witness passed          → live, and stamp first-ok once
//   ok === false  the witness ran and failed  → retired IF it had ever passed
//   ok === null   we could not tell           → nothing is written at all
//
// The runner being off, a probe timing out, a malformed reply, a witness that is
// blank or nonsense — all of those are `null`, and `null` leaves the row exactly
// as it was, so the UI can say "not checked recently" rather than inventing a
// retirement. A witness system that wrongly retires work is worse than no witness
// system, which is the same reason the code-review pass can never strand a task.

export const WITNESS_KINDS = ['file', 'symbol', 'route', 'table', 'query'];
export const REPO_KINDS = ['file', 'symbol', 'route'];
export const LIFECYCLES = ['concept', 'planned', 'building', 'live', 'retired'];

export const isRepoKind = (kind) => REPO_KINDS.includes(kind);

// ─── Reading a witness off a node ─────────────────────────────────────────────

// Accepts a node row, or the shorthand `"file:services/witnessCheck.js"` a person
// would actually type. Returns null when there is nothing usable — a node with no
// witness is simply never checked, which is the correct "unknown", not a failure.
export function parseWitness(input) {
  if (!input) return null;

  if (typeof input === 'string') {
    const i = input.indexOf(':');
    if (i < 1) return null;
    return parseWitness({ witness_kind: input.slice(0, i), witness_value: input.slice(i + 1) });
  }

  const kind = String(input.witness_kind || input.kind || '').trim().toLowerCase();
  const value = String(input.witness_value ?? input.value ?? '').trim();
  if (!WITNESS_KINDS.includes(kind) || !value) return null;
  return { kind, value };
}

// The rows worth checking at all, in the shape both halves of the check consume.
export function witnessesFor(db) {
  const rows = db.prepare(`
    SELECT id, name, witness_kind, witness_value, witness_ok, witness_first_ok_at, lifecycle
    FROM architecture_nodes WHERE deleted_at IS NULL
  `).all();
  const out = [];
  for (const r of rows) {
    const w = parseWitness(r);
    if (!w) continue;
    out.push({ id: r.id, name: r.name, kind: w.kind, value: w.value, ever_ok: !!r.witness_first_ok_at });
  }
  return out;
}

// ─── The repo half — runs on the Mac ──────────────────────────────────────────

// A route witness is written the way a person says it out loud
// ("POST /api/architecture/witness/recheck"), but Express never contains that
// string: the path is split between where the router is mounted and what the
// handler declares. So search for the whole path first, then for the tail left
// after dropping the `/api/<mount>` prefix, which is what routes/*.js actually
// contains. Any hit counts.
export function routeCandidates(value) {
  const path = String(value || '').replace(/^\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+/i, '').trim();
  if (!path) return [];
  const out = [path];
  const m = path.match(/^\/api\/[^/]+(\/.+)$/);
  if (m) out.push(m[1]);
  return out.filter((t, i, a) => t.length >= 3 && a.indexOf(t) === i);
}

// Proof has to come from code. Without this, a route witness passes because
// RUN_LOG.md mentions the address and a symbol witness passes because a plan
// document names the function — the tree would then call something "live" on the
// strength of having written about it, which is the exact self-deception the
// witness exists to prevent.
const CODE_FILE = /\.(js|mjs|cjs|ts|tsx|jsx|html|sql)$/i;
const codeHits = (g) => (g && g.hits ? g.hits.filter((h) => CODE_FILE.test(h.file || '')) : []);

// Answer file/symbol/route witnesses from a checkout. The two git readers are
// injected rather than imported so this stays testable and so the server never
// pulls a git dependency it cannot use — on the Mac, queue-runner.js passes
// gitOps.gitPathFacts and gitOps.gitGrepHits.
//
// `items` is [{ id, kind, value }]; the reply is [{ id, ok, detail }] with ok=null
// for anything this could not answer. Individual failures are contained per item:
// one unreadable witness must not turn the whole batch into "unknown".
export function answerRepoWitnesses(items, { pathFacts, grepHits } = {}) {
  const list = Array.isArray(items) ? items : [];
  if (typeof pathFacts !== 'function' || typeof grepHits !== 'function') {
    return list.map((it) => ({ id: it.id, ok: null, detail: 'no checkout to read' }));
  }

  return list.map((it) => {
    const w = parseWitness(it);
    if (!w || !isRepoKind(w.kind)) return { id: it.id, ok: null, detail: 'not a repo witness' };
    try {
      if (w.kind === 'file') {
        const facts = pathFacts([w.value]) || [];
        const f = facts[0];
        if (!f) return { id: it.id, ok: null, detail: 'the checkout did not answer' };
        return { id: it.id, ok: !!f.exists, detail: f.exists ? `${w.value} is there` : (f.note || `${w.value} is not in the code`) };
      }

      if (w.kind === 'symbol') {
        const g = (grepHits([w.value]) || [])[0];
        if (!g) return { id: it.id, ok: null, detail: 'the checkout did not answer' };
        const hits = codeHits(g);
        return { id: it.id, ok: hits.length > 0, detail: hits.length ? `${w.value} is in ${hits[0].file}` : `${w.value} is written nowhere in the code` };
      }

      // route
      const terms = routeCandidates(w.value);
      if (!terms.length) return { id: it.id, ok: null, detail: 'that address is not readable' };
      const found = grepHits(terms) || [];
      if (!found.length) return { id: it.id, ok: null, detail: 'the checkout did not answer' };
      const hit = found.map(codeHits).find((h) => h.length);
      return { id: it.id, ok: !!hit, detail: hit ? `answered in ${hit[0].file}` : `nothing serves ${w.value}` };
    } catch (e) {
      // Could not tell — deliberately not a failure. See the header.
      return { id: it.id, ok: null, detail: `could not check: ${e.message}` };
    }
  });
}

// ─── The database half — runs here ────────────────────────────────────────────

// A `query` witness is data the caller wrote, so it is fenced rather than trusted:
// one read-only SELECT, nothing else. Anything with a second statement, or a verb
// that could change the database, is refused — and refused is `null`, not a
// failure, because a witness we declined to run proves nothing either way.
function safeSelect(sql) {
  const q = String(sql || '').trim().replace(/;\s*$/, '');
  if (!q) return { error: 'the query is empty' };
  if (q.includes(';')) return { error: 'only one query at a time' };
  if (!/^(SELECT|WITH)\b/i.test(q)) return { error: 'only a SELECT can be a witness' };
  if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|DETACH|PRAGMA|VACUUM)\b/i.test(q)) {
    return { error: 'a witness may not change anything' };
  }
  return { sql: q };
}

export function checkDbWitnesses(db, items) {
  const list = Array.isArray(items) ? items : [];
  return list.map((it) => {
    const w = parseWitness(it);
    if (!w || isRepoKind(w.kind)) return { id: it.id, ok: null, detail: 'not a database witness' };

    try {
      if (w.kind === 'table') {
        const row = db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name=?`).get(w.value);
        return { id: it.id, ok: !!row, detail: row ? `${w.value} is in the database` : `there is no ${w.value}` };
      }

      const fenced = safeSelect(w.value);
      if (fenced.error) return { id: it.id, ok: null, detail: fenced.error };
      const row = db.prepare(fenced.sql).get();
      if (!row) return { id: it.id, ok: false, detail: 'the query found nothing' };
      const first = Object.values(row)[0];
      const ok = !(first === 0 || first === null || first === undefined || first === '' || first === false);
      return { id: it.id, ok, detail: ok ? 'the query found something' : 'the query found nothing' };
    } catch (e) {
      // A query that errors is a BROKEN witness, not proof the thing is gone —
      // and the difference is exactly what stops a typo retiring real work.
      return { id: it.id, ok: null, detail: `could not check: ${e.message}` };
    }
  });
}

// ─── Turning results into a lifecycle ─────────────────────────────────────────

// Pure, so the whole rule is one readable function and the selftest can hold it
// to account without a database.
//   passed                        → live
//   failed, and it once passed    → retired (something built is no longer there)
//   failed, and it never passed   → leave it on the frontier; it is still an idea
//   unknown                       → touch nothing at all
export function decideLifecycle(node, result) {
  if (!result || result.ok === null || result.ok === undefined) return null;
  if (result.ok) return 'live';
  return node && node.ever_ok ? 'retired' : null;
}

// Write the results down. Returns a plain-English-ready tally; `unchecked` is a
// first-class number here rather than a silent gap, because "the runner was off"
// and "nothing is built" must never look the same on screen.
export function applyWitnessResults(db, items, results) {
  const byId = new Map();
  for (const r of results || []) if (r && r.id) byId.set(r.id, r);
  const now = new Date().toISOString();
  const tally = { checked: 0, live: 0, retired: 0, failed: 0, unchecked: 0, changed: [] };

  // Iterating the NODES rather than the results is what makes "the Mac was off"
  // visible: those nodes simply have no result, and a missing result has to count
  // as one node not checked, not as one node quietly skipped.
  for (const node of items || []) {
    const r = byId.get(node.id);

    if (!r || r.ok === null || r.ok === undefined) { tally.unchecked += 1; continue; }
    tally.checked += 1;

    const before = db.prepare(`SELECT lifecycle FROM architecture_nodes WHERE id=?`).get(r.id);
    const next = decideLifecycle(node, r);

    if (r.ok) {
      db.prepare(`
        UPDATE architecture_nodes
        SET witness_ok=1, witness_checked_at=?,
            witness_first_ok_at=COALESCE(witness_first_ok_at, ?),
            lifecycle='live',
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id=?
      `).run(now, now, r.id);
      tally.live += 1;
    } else if (next === 'retired') {
      db.prepare(`
        UPDATE architecture_nodes
        SET witness_ok=0, witness_checked_at=?, lifecycle='retired',
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id=?
      `).run(now, r.id);
      tally.retired += 1;
    } else {
      // Checked, failed, never passed: record the check, leave the lifecycle alone.
      db.prepare(`
        UPDATE architecture_nodes SET witness_ok=0, witness_checked_at=? WHERE id=?
      `).run(now, r.id);
      tally.failed += 1;
    }

    const after = next || before?.lifecycle || 'concept';
    if (before && before.lifecycle !== after) {
      tally.changed.push({ id: r.id, name: node.name, from: before.lifecycle, to: after, detail: r.detail || '' });
    }
  }

  return tally;
}

// ─── The whole pass ───────────────────────────────────────────────────────────

let boundDb = null;
export function bindWitnessDb(database) { boundDb = database; }

// Park the repo half with the Mac. Dynamically imported so the runner — which
// imports answerRepoWitnesses from this same file — never pulls the server's
// provider stack in behind it.
//
// Returns [] rather than throwing when there is no runner, which is precisely the
// "not checked" outcome: applyWitnessResults sees no result for those nodes and
// writes nothing.
async function askTheMac(items, { waitMs }) {
  if (!items.length) return [];
  try {
    const { runWitnessProbe } = await import('./ai/text.js');
    const out = await runWitnessProbe({
      request: { items: items.map((it) => ({ id: it.id, kind: it.kind, value: it.value })) },
      waitMs,
    });
    return Array.isArray(out?.results) ? out.results : [];
  } catch (e) {
    console.error('[witness] the Mac could not be reached —', e.message);
    return [];
  }
}

// Check every node that declares a witness. Free: a grep and a SELECT.
// `waitMs` is how long the repo half may take; with no runner attached the helper
// lane refuses immediately rather than burning it.
export async function recheckAllWitnesses(dbInput = null, { waitMs = 30_000 } = {}) {
  const db = dbInput || boundDb;
  if (!db) return { error: 'no_db' };

  const items = witnessesFor(db);
  if (!items.length) return { checked: 0, live: 0, retired: 0, failed: 0, unchecked: 0, changed: [], total: 0 };

  const repo = items.filter((it) => isRepoKind(it.kind));
  const local = items.filter((it) => !isRepoKind(it.kind));

  const results = [
    ...checkDbWitnesses(db, local),
    ...(await askTheMac(repo, { waitMs })),
  ];

  const tally = applyWitnessResults(db, items, results);
  return { ...tally, total: items.length };
}

// Fire-and-forget, for the ship hook. A publish must never wait on, or be failed
// by, a witness pass.
export function kickWitnessRecheck(reason = 'ship') {
  recheckAllWitnesses()
    .then((out) => {
      if (out?.error) return;
      if (out?.changed?.length) {
        for (const c of out.changed) console.log(`[witness] ${c.name}: ${c.from} → ${c.to} (${c.detail})`);
      }
      console.log(`[witness] ${reason}: ${out.checked}/${out.total} checked · ${out.live} live · ${out.retired} retired · ${out.unchecked} not checked`);
    })
    .catch((e) => console.error('[witness] recheck failed —', e.message));
}
