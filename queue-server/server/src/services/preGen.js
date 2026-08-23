// Background pre-generation (plan "make model features fast", Option 2) — the
// same generate-in-advance-and-serve-from-DB pattern warmup.js already uses for
// books and tag lenses, extended to the two on-demand generation features:
//
//   1. The Suggestion Engine (chantier + integration) — results are stored in
//      work_suggestions, so opening the tab is an instant DB read if the engines
//      have run recently.
//   2. Architecture "what's next" suggestions — stored per component in
//      architecture_components.suggestions_json.
//
// Both used to refresh on a CLOCK (12h / 24h). That spent a model call on every
// component every day whether or not anything had changed, while a component we
// shipped against an hour ago kept its stale suggestions until the clock said
// otherwise — wrong in both directions at once. They now refresh on CHANGE: a
// component is stale when work has actually shipped against it since its last
// refresh (shipFacts.js, all free SQL — no model call is ever spent to detect
// staleness). The old TTLs survive only as a long floor, so a component nobody
// ever ships against still gets looked at occasionally.
//
// Runs once shortly after boot (so it never competes with warmup's opening
// burst) and then every 6 hours. Same discipline as warmup.js: small concurrency
// cap, a stagger between calls to stay under free-tier rate limits, loud failure
// logging, and it must never throw into the server.

import { runSuggestionEngines } from './workSuggestions.js';
import { generateSuggestions as generateArchSuggestions } from './architecture.js';
import { syncFromGit } from './treeSync.js';
import { autoWorldLookSuggestions, autoWorldLookComponents, autoWorldLookIdeas } from './codeDiscovery.js';
import { backfillInspirationReviews, autoWorldLookTasks } from './promptQueue.js';
import { lastShipByComponent, completedExamplesSince } from './shipFacts.js';

// The floors: refresh even with no change at all, this long after the last one.
// Deliberately long (Antoine's choice: a week) — the whole point is that time alone
// is a bad reason to spend a call, so it takes a week of silence to justify one.
const SUGGESTIONS_FLOOR_MS = 7 * 24 * 3600_000;
const ARCH_FLOOR_MS = 7 * 24 * 3600_000;
const INTERVAL_MS = 6 * 3600_000;
const BOOT_DELAY_MS = 2 * 60_000;
const CONCURRENCY = 2;
const STAGGER_MS = 350;
// The tree watcher runs its own, more frequent cadence (roughly hourly, per the
// plan) — but each run only does a model call when main has NEW commits, so the
// idle cost is one cheap git log per hour.
const TREE_INTERVAL_MS = 60 * 60_000;
const TREE_BOOT_DELAY_MS = 90_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runWithLimit(items, limit, worker) {
  let cursor = 0;
  async function next() {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        await worker(items[i], i);
      } catch (e) {
        console.error('Pre-gen: item failed, continuing:', e.message);
      }
      await sleep(STAGGER_MS);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
}

// Stale = something has actually FINISHED since the newest suggestion was written,
// or nothing has been refreshed in a week. The suggestion engines read
// work_completed_examples for their "what did we just finish" context, so new rows
// there are exactly the change that would make them answer differently; without new
// rows, re-running them re-derives the same shelves from the same facts.
// Returns a reason string (or null) rather than a bare boolean, so a skip can say
// why — a quiet day should read as a quiet day, not as a broken pre-generator.
function suggestionStaleReason(db) {
  const row = db.prepare(`SELECT MAX(created_at) AS t FROM work_suggestions WHERE deleted_at IS NULL`).get();
  if (!row || !row.t) return 'no suggestions on the shelves yet';
  const finished = completedExamplesSince(db, row.t);
  if (finished > 0) return `${finished} task(s) finished since the newest suggestion`;
  const age = Date.now() - new Date(row.t).getTime();
  if (age > SUGGESTIONS_FLOOR_MS) return `nothing has finished, but the shelves are ${Math.round(age / 86_400_000)} days old`;
  return null;
}

async function pregenSuggestions(db) {
  const why = suggestionStaleReason(db);
  if (!why) {
    console.log('Pre-gen: suggestions skipped — nothing has finished since they were written.');
    return;
  }
  console.log(`Pre-gen: running suggestion engines (background) — ${why}.`);
  const start = Date.now();
  const results = await runSuggestionEngines();
  for (const [kind, out] of Object.entries(results)) {
    if (out?.error) console.error(`Pre-gen: ${kind} engine failed — ${out.error} ${out.message || ''}`);
    else console.log(`Pre-gen: ${kind} engine added ${out?.added?.length ?? 0} suggestion(s), skipped ${out?.skipped ?? 0}.`);
  }
  console.log(`Pre-gen: suggestion engines done in ${Math.round((Date.now() - start) / 1000)}s.`);
}

// Which components deserve a fresh set of suggestions. Three reasons, in order of
// how much they justify a model call:
//   • never generated — there is nothing to serve, so this is not optional;
//   • shipped against since the last refresh — the exact signal, from
//     work_prompts.component_id (recorded when the task is created, not guessed);
//   • the floor — untouched for a week, look anyway.
// Everything else is skipped, which is the saving: the old version selected every
// component every day regardless.
//
// Returns rows carrying the reason so pregenArchitecture can log a truthful count
// instead of "regenerating N components" with no way to tell why.
function archJobs(db) {
  const floor = new Date(Date.now() - ARCH_FLOOR_MS).toISOString();
  const rows = db.prepare(`
    SELECT id, suggestions_json, suggestions_generated_at FROM architecture_components
  `).all();
  const lastShip = lastShipByComponent(db);

  const out = [];
  for (const r of rows) {
    if (!r.suggestions_json || !r.suggestions_generated_at) {
      out.push({ id: r.id, why: 'never generated' });
      continue;
    }
    const shipped = lastShip.get(r.id);
    if (shipped && shipped > r.suggestions_generated_at) {
      out.push({ id: r.id, why: 'shipped against since the last refresh' });
      continue;
    }
    if (r.suggestions_generated_at < floor) {
      out.push({ id: r.id, why: 'untouched for a week (floor)' });
    }
  }
  return out;
}

async function pregenArchitecture(db) {
  const jobs = archJobs(db);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM architecture_components`).get()?.n ?? 0;
  if (!jobs.length) {
    console.log(`Pre-gen: architecture suggestions — nothing shipped against any of the ${total} component(s), skipping all of them.`);
    return;
  }
  // Say the ratio out loud. The saving this change exists for is exactly
  // "jobs.length instead of total", and it should be visible in the log rather
  // than taken on trust.
  const byReason = jobs.reduce((m, j) => { m[j.why] = (m[j.why] || 0) + 1; return m; }, {});
  const reasons = Object.entries(byReason).map(([w, n]) => `${n} ${w}`).join(', ');
  console.log(`Pre-gen: regenerating architecture suggestions for ${jobs.length} of ${total} component(s) — ${reasons}.`);
  const start = Date.now();
  let done = 0;
  let failed = 0;
  await runWithLimit(jobs, CONCURRENCY, async (job) => {
    const out = await generateArchSuggestions(db, job.id);
    done++;
    if (out?.error) {
      failed++;
      console.error(`Pre-gen: architecture suggestions failed for ${job.id} — ${out.error}${out.message ? ' ' + out.message : ''}`);
    }
    if (done % 5 === 0 || done === jobs.length) {
      console.log(`Pre-gen: architecture ${done}/${jobs.length} attempted, ${failed} failed (${Math.round((Date.now() - start) / 1000)}s elapsed).`);
    }
  });
}

// The self-updating tree watcher: reads main's git history since the last
// processed commit and proposes nodes for significant changes (see treeSync.js).
// First run just records the baseline — no proposals for pre-existing history.
async function pregenTreeSync(db) {
  const out = await syncFromGit(db);
  if (out?.error) console.error(`Pre-gen: tree sync failed — ${out.error} ${out.message || ''}`);
  else if (out?.skipped) console.log(`Pre-gen: tree sync skipped — ${out.skipped}.`);
  else console.log(`Pre-gen: tree sync ${out.baseline ? 'baseline recorded (' + out.baseline.slice(0, 8) + ')' : 'created ' + (out.created ?? 0) + ' proposal(s)'}.`);
}

// Catch-up sweeps (all idempotent — existing reports are skipped):
//   1. Quick-check backfill: reports that predate the check get their verdict,
//      and waiting queue tasks get their plan re-drafted from filtered ideas.
//   2. Task world-look sweep: any implement task still without shelves gets one.
//      Runs FIRST among the four — all of them draw on the same daily side-call
//      budget, and whichever runs last is the one that starves when it runs out.
//      The task list is what Antoine actually opens, so it goes first (the other
//      three are re-tried every sweep anyway).
//   3. World-look sweeps: any suggestion / not-built component / seed that still
//      has no world-look gets one (the quick check runs inside the same pass).
async function pregenWorldLooks(db) {
  const bf = await backfillInspirationReviews().catch((e) => {
    console.error('Pre-gen: review backfill failed —', e.message);
    return null;
  });
  if (bf && (bf.reviewed || bf.redrafted)) {
    console.log(`Pre-gen: review backfill — ${bf.reviewed} reviewed, ${bf.redrafted} plans re-drafted, ${bf.skipped} skipped, ${bf.failed} failed.`);
  }
  const t = await autoWorldLookTasks();
  const s = await autoWorldLookSuggestions(db);
  const c = await autoWorldLookComponents(db);
  const i = await autoWorldLookIdeas(db);
  const done = [s, c, i, t].filter(Boolean);
  if (done.some(o => o.ran || o.skipped || o.reviewed)) {
    console.log(`Pre-gen: world-look sweeps — suggestions ran ${s?.ran ?? '?'} / skipped ${s?.skipped ?? '?'}; components ran ${c?.ran ?? '?'} / skipped ${c?.skipped ?? '?'}; seeds ran ${i?.ran ?? '?'} / skipped ${i?.skipped ?? '?'}; tasks ran ${t?.ran ?? '?'} / skipped ${t?.skipped ?? '?'} / failed ${t?.failed ?? '?'}).`);
  }
}

let running = false;
let started = false;

async function runOnce(db) {
  if (running) return;
  running = true;
  try {
    await pregenSuggestions(db);
    await pregenArchitecture(db);
    await pregenWorldLooks(db);
  } catch (e) {
    console.error('Pre-gen: run failed —', e.message);
  } finally {
    running = false;
  }
}

// Fire-and-forget from index.js. First run is delayed so it doesn't stack on top
// of the boot cache warm-up; then a fixed interval keeps everything fresh.
export function startPreGen(db) {
  if (started) return;
  started = true;
  setTimeout(() => { runOnce(db).catch(() => {}); }, BOOT_DELAY_MS).unref?.();
  const timer = setInterval(() => { runOnce(db).catch(() => {}); }, INTERVAL_MS);
  timer.unref?.();
  setTimeout(() => { pregenTreeSync(db).catch(() => {}); }, TREE_BOOT_DELAY_MS).unref?.();
  const treeTimer = setInterval(() => { pregenTreeSync(db).catch(() => {}); }, TREE_INTERVAL_MS);
  treeTimer.unref?.();
  console.log('Pre-gen: scheduled (first run after boot warm-up, then every 6h; tree watcher hourly).');
}
