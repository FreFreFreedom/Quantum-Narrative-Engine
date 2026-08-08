// Boot-time cache warm-up: because Railway's free tier resets the DB on every
// deploy (see index.js), the generate-once-and-cache pattern used by books.js and
// tagLens.js means every entity starts "cold" after a redeploy — the first person
// to click it eats the live Claude-API latency. This module pre-generates the two
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

  await runWithLimit(jobs, CONCURRENCY, async (job) => {
    if (job.kind === 'books') await getBooks(job.entity, { force: false });
    else await getTagLens(job.entity, job.tag, { force: false });
    done++;
    if (done % 10 === 0 || done === jobs.length) {
      console.log(`Cache warm-up: ${done}/${jobs.length} done (${Math.round((Date.now() - start) / 1000)}s elapsed).`);
    }
  });

  console.log(`Cache warm-up: complete, ${jobs.length} job(s) in ${Math.round((Date.now() - start) / 1000)}s.`);
}
