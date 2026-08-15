// Background pre-generation (plan "make model features fast", Option 2) — the
// same generate-in-advance-and-serve-from-DB pattern warmup.js already uses for
// books and tag lenses, extended to the two on-demand generation features:
//
//   1. The Suggestion Engine (chantier + integration) — results are stored in
//      work_suggestions, so opening the tab is an instant DB read if the engines
//      have run recently. Stale = no rows or the newest row older than 12h.
//   2. Architecture "what's next" suggestions — stored per component in
//      architecture_components.suggestions_json; regenerated when missing or
//      older than 24h.
//
// Runs once shortly after boot (so it never competes with warmup's opening
// burst) and then every 6 hours. Same discipline as warmup.js: small concurrency
// cap, a stagger between calls to stay under free-tier rate limits, loud failure
// logging, and it must never throw into the server.

import { runSuggestionEngines } from './workSuggestions.js';
import { generateSuggestions as generateArchSuggestions } from './architecture.js';
import { syncFromGit } from './treeSync.js';
import { autoWorldLookSuggestions } from './codeDiscovery.js';

const SUGGESTIONS_TTL_MS = 12 * 3600_000;
const ARCH_TTL_MS = 24 * 3600_000;
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

function suggestionStale(db) {
  const row = db.prepare(`SELECT MAX(created_at) AS t FROM work_suggestions WHERE deleted_at IS NULL`).get();
  if (!row || !row.t) return true;
  return Date.now() - new Date(row.t).getTime() > SUGGESTIONS_TTL_MS;
}

async function pregenSuggestions(db) {
  if (!suggestionStale(db)) {
    console.log('Pre-gen: suggestions fresh — skipping.');
    return;
  }
  console.log('Pre-gen: running suggestion engines (background).');
  const start = Date.now();
  const results = await runSuggestionEngines();
  for (const [kind, out] of Object.entries(results)) {
    if (out?.error) console.error(`Pre-gen: ${kind} engine failed — ${out.error} ${out.message || ''}`);
    else console.log(`Pre-gen: ${kind} engine added ${out?.added?.length ?? 0} suggestion(s), skipped ${out?.skipped ?? 0}.`);
  }
  console.log(`Pre-gen: suggestion engines done in ${Math.round((Date.now() - start) / 1000)}s.`);
}

function archJobs(db) {
  const cutoff = new Date(Date.now() - ARCH_TTL_MS).toISOString();
  return db.prepare(`
    SELECT id FROM architecture_components
    WHERE suggestions_json IS NULL
       OR suggestions_generated_at IS NULL
       OR suggestions_generated_at < ?
  `).all(cutoff);
}

async function pregenArchitecture(db) {
  const jobs = archJobs(db);
  if (!jobs.length) {
    console.log('Pre-gen: architecture suggestions fresh — skipping.');
    return;
  }
  console.log(`Pre-gen: regenerating architecture suggestions for ${jobs.length} component(s).`);
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

// Catch-up sweep: any suggestion that still has no world-look (e.g. one created
// while the server was down, or an engine run that ended before its sweep could
// finish) gets it here. Idempotent — existing reports are skipped.
async function pregenWorldLooks(db) {
  const out = await autoWorldLookSuggestions(db);
  if (out.ran || out.skipped) console.log(`Pre-gen: world-look sweep — ran ${out.ran}, skipped ${out.skipped}.`);
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
