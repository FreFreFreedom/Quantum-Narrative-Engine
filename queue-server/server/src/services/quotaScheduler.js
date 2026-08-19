// Auto-resume (plan "Always-On Models") — the piece that closes the loop on
// "defer with a known reset time": a 60s timer that clears any provider whose
// reset window has passed, un-pauses the Dispatch Queue if it was paused for a
// quota reason, wakes any prompt parked with a resume_after that has elapsed,
// and kicks the runner so deferred work actually restarts instead of sitting
// queued until someone notices.

import { clearExpired } from './ai/router.js';

const TICK_MS = 60_000;
let timer = null;
let db = null;

export function bindQuotaSchedulerDb(database) { db = database; }

async function tick() {
  try {
    const cleared = clearExpired();

    const { isQueuePaused, getSettings, setQueuePaused, kickQueue, releaseStaleClaims } = await import('./taskRunner.js');

    // Stuck-stage recovery. A restart mid-plan-draft or mid-world-look leaves a
    // task's flags set in the DB with nothing alive to clear them, and the
    // dispatch gate then hides it forever. Sweeping here rather than on a new
    // timer keeps this to one background clock.
    const { sweepStuckStages } = await import('./promptQueue.js');
    sweepStuckStages();

    // The matching hole one layer down: releaseStaleClaims() frees a task whose
    // runner died mid-execution, but it is only called from POST /worker/claim —
    // which the runner issues ONLY while idle. A task wedged in_progress while
    // the runner is busy (or gone) was therefore never checked at all.
    try { releaseStaleClaims(); } catch (e) { console.error('quotaScheduler: stale-claim release failed —', e.message); }

    if (cleared.length && isQueuePaused()) {
      const reason = getSettings().queuePausedReason || '';
      // Only auto-clear pauses this system itself put in place for a quota reason —
      // never override a pause the user set manually for an unrelated purpose.
      if (/usage limit|quota|exhausted/i.test(reason)) {
        setQueuePaused(false);
      }
    }

    if (db) {
      const now = new Date().toISOString();
      const woken = db.prepare(`SELECT id FROM work_prompts WHERE resume_after IS NOT NULL AND resume_after <= ? AND status='queued'`).all(now);
      if (woken.length) {
        db.prepare(`UPDATE work_prompts SET resume_after=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE resume_after IS NOT NULL AND resume_after <= ?`).run(now);
        kickQueue();
        const { advanceQueue } = await import('./promptQueue.js');
        advanceQueue();
      }
    }
  } catch (e) {
    console.error('quotaScheduler: tick failed —', e.message);
  }
}

export function startQuotaScheduler() {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
  // Fire once shortly after boot too, so a reset that already passed while the
  // server was down clears immediately rather than waiting a full tick.
  setTimeout(tick, 5_000);
}

export function stopQuotaScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
