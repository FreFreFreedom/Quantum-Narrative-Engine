// Boot-time cache warm-up for the generate-once-and-cache pattern in books.js and
// tagLens.js: an entity nobody has opened yet has nothing cached, so the first person
// to click it eats a live generation. This module pre-generates the two
// things a user sees the instant they click an entity (book suggestions, and the
// first tag's lens) for every character and country in the background, right after
// boot, so that by the time anyone is actually navigating the app those responses
// come straight out of the cache instead of waiting on a live generation.
//
// Fire-and-forget from index.js — does not block server start. Runs with a small
// concurrency cap and a short stagger between requests to stay well under
// Anthropic API rate limits rather than firing 60+ entities at once.

import { searchEntities } from './ontologyQuery.js';

const CONCURRENCY = 2;
const STAGGER_MS = 350;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function runWithLimit(items, limit, worker) {
  let cursor = 0;
  async function next() {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        await worker(items[i], i);
      } catch (e) {
        console.error('Cache warm-up: item failed, continuing:', e.message);
      }
      await sleep(STAGGER_MS);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
}

export async function warmCaches(db, { getBooks, getTagLens }) {
  const entities = searchEntities(db, {}).filter((e) => e.type === 'character' || e.type === 'country');
  const bookCache = db.prepare(`SELECT entity_id FROM entity_book_suggestions`);
  const lensCache = db.prepare(`SELECT entity_id, tag FROM entity_tag_lenses`);
  const cachedBookIds = new Set(bookCache.all().map((r) => r.entity_id));
  const cachedLensKeys = new Set(lensCache.all().map((r) => `${r.entity_id}::${r.tag}`));

  const jobs = [];
  for (const e of entities) {
    if (!cachedBookIds.has(e.id)) jobs.push({ kind: 'books', entity: e });
    const firstTag = (e.tags || [])[0];
    if (firstTag && !cachedLensKeys.has(`${e.id}::${firstTag}`)) jobs.push({ kind: 'lens', entity: e, tag: firstTag });
  }

  if (!jobs.length) {
    console.log('Cache warm-up: nothing to do, all entities already cached.');
    return;
  }
  console.log(`Cache warm-up: starting, ${jobs.length} job(s) across ${entities.length} entities.`);
  const start = Date.now();
  let done = 0;

  // Count real outcomes, not just attempts. These handlers RETURN {error} objects
  // rather than throwing, so an earlier version of this loop happily reported
  // "369/369 done" while every single call was failing upstream — the cache stayed
  // empty and the failure was invisible until a user clicked something. Track
  // failures explicitly and make them loud.
  let failed = 0;
  const errorCounts = new Map();

  await runWithLimit(jobs, CONCURRENCY, async (job) => {
    const out = job.kind === 'books'
      ? await getBooks(job.entity, { force: false, feature: 'warmup' })
      : await getTagLens(job.entity, job.tag, { force: false, feature: 'warmup' });
    done++;
    if (out && out.error) {
      failed++;
      const key = `${out.error}${out.status ? ' ' + out.status : ''}`;
      errorCounts.set(key, (errorCounts.get(key) || 0) + 1);
    }
    if (done % 25 === 0 || done === jobs.length) {
      console.log(`Cache warm-up: ${done}/${jobs.length} attempted, ${failed} failed (${Math.round((Date.now() - start) / 1000)}s elapsed).`);
    }
  });

  const secs = Math.round((Date.now() - start) / 1000);
  const succeeded = jobs.length - failed;
  if (failed === 0) {
    console.log(`Cache warm-up: complete — ${succeeded}/${jobs.length} cached in ${secs}s.`);
  } else {
    const breakdown = [...errorCounts.entries()].map(([k, n]) => `${k} x${n}`).join(', ');
    console.error(
      `Cache warm-up: FINISHED WITH FAILURES — only ${succeeded}/${jobs.length} actually cached in ${secs}s. ` +
      `${failed} failed: ${breakdown}. Those entities will retry on next boot and will hit a live call (slow) if clicked before then.`
    );
  }
}
