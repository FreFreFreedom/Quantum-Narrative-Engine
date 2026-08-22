// Routes for the Architecture Navigator's live backend surface.
import { Router } from 'express';
import { getComponents, getQueueStatus, getComponentHistory, generateSuggestions } from '../services/architecture.js';
import { listNodes, createNode, updateNode, deleteNode, speculate, autoPlaceNode, askGraph, routeIdea, rankUnbuilt, shortlistUnbuilt } from '../services/architectureNodes.js';
import { nextSteps } from '../services/nextSteps.js';
import { listProposals, acceptProposal, rejectProposal, syncFromGit } from '../services/treeSync.js';
import { getQueuePauseState } from '../services/promptQueue.js';
import { autoShipEnabled, sideCallBudgetLimit, sideCallsToday } from '../services/ai/text.js';
import { containerFreeBytes } from '../lib/memHeadroom.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { findUnreachable, explainedFromCache, kickExplain, buildTaskFor } from '../services/reachability.js';
import { DB_PATH } from '../db/schema.js';
import { recheckAllWitnesses } from '../services/witnessCheck.js';

// Is the database sitting on storage that survives a redeploy?
//
// This exists because the failure is silent. On 2026-08-18 the DB_PATH variable was
// overwritten while following an env-var checklist; the app switched to a different,
// empty file and nothing errored — the Queue, suggestions, ideas and architecture
// tabs simply went blank, looking exactly like catastrophic data loss, while the
// real 26MB database sat untouched at the old path. The only signal was one line in
// the boot log.
//
// Off Railway there is no volume and that is correct, not a fault — a laptop must
// never see this warning, or the warning stops meaning anything. On Railway it
// catches both shapes of the mistake: no volume at all, and a path that misses it.
//
// What it cannot catch is the exact 2026-08-18 case: a path that IS on the volume
// but is the wrong file on it. Nothing here can know which file is the right one.
// The boot log still prints the exact path for that.
function storageState() {
  const onRailway = !!process.env.RAILWAY_ENVIRONMENT;
  const volumeMount = process.env.RAILWAY_VOLUME_MOUNT_PATH || null;
  const durable = !onRailway || (!!volumeMount && DB_PATH.startsWith(volumeMount));
  return { durable, dbPath: DB_PATH, volumeMount, onRailway };
}

export function architectureRoutes(db) {
  const router = Router();

  // Tech-tree growth: nodes authored by hand plus Claude-proposed branches. The
  // frontend merges these over its hardcoded trunk by id.
  router.get('/nodes', (req, res) => {
    res.json({ nodes: listNodes(db) });
  });

  router.post('/nodes', (req, res) => {
    const out = createNode(db, req.body || {});
    if (out.error) return res.status(out.error === 'duplicate' ? 409 : 400).json(out);
    res.json(out);
  });

  router.patch('/nodes/:id', (req, res) => {
    const out = updateNode(db, req.params.id, req.body || {});
    // A refused edit is not a missing node: emptying the witness is a bad request.
    if (out.error) return res.status(out.error === 'not_found' ? 404 : 400).json(out);
    res.json(out);
  });

  router.delete('/nodes/:id', (req, res) => {
    const out = deleteNode(db, req.params.id);
    if (out.error) return res.status(404).json(out);
    res.json(out);
  });

  // Self-updating tree: proposals the tree watchers found in real work (finished
  // queue tasks or git commits outside the app), waiting for Antoine's word.
  router.get('/proposals', (req, res) => {
    res.json({ proposals: listProposals(db) });
  });

  router.post('/proposals/:id/accept', (req, res) => {
    const out = acceptProposal(db, req.params.id);
    if (out.error) return res.status(out.error === 'not_found' ? 404 : 400).json(out);
    res.json(out);
  });

  router.post('/proposals/:id/reject', (req, res) => {
    const out = rejectProposal(db, req.params.id);
    if (out.error) return res.status(out.error === 'not_found' ? 404 : 400).json(out);
    res.json(out);
  });

  // "Re-check" from the Architecture tab — ask every node with a witness to prove
  // itself again. Free (a grep and a SELECT, no model), so it is safe to press as
  // often as you like, and it is the same pass that runs by itself on every ship.
  //
  // `unchecked` is reported separately from `failed` on purpose. With the Mac
  // asleep, every file/symbol/route witness comes back unchecked and NOTHING is
  // retired — the outcome has to read as "we could not look", never as "it is
  // gone". See services/witnessCheck.js.
  router.post('/witness/recheck', asyncHandler(async (req, res) => {
    const out = await recheckAllWitnesses(db);
    if (out.error) return res.status(500).json(out);
    res.json(out);
  }));

  // Manual "Sync now" from the Architecture tab — runs the git-history watcher
  // immediately (cheap: one model call only when main has new commits).
  router.post('/tree/sync', asyncHandler(async (req, res) => {
    const out = await syncFromGit(db);
    res.json(out);
  }));

  // Explicit user click only — never called on page load (cost control).
  router.post('/nodes/:id/speculate', asyncHandler(async (req, res) => {
    const out = await speculate(db, req.params.id, req.body || {});
    if (out.error) return res.status(out.error === 'all_duplicates' ? 409 : 502).json(out);
    res.json(out);
  }));

  // "Add an idea": one free-text concept -> one speculative, structurally-placed node.
  // Frontend sends { concept, catalog } (the trunk lives in the HTML, not the DB).
  router.post('/nodes/auto', asyncHandler(async (req, res) => {
    const out = await autoPlaceNode(db, req.body?.concept || '', req.body || {});
    if (out.error) {
      if (out.error === 'concept_required') return res.status(400).json(out);
      if (out.error === 'duplicate') return res.status(409).json(out);
      return res.status(502).json(out);
    }
    res.json(out);
  }));

  // "Ask about this architecture": a question in, an answer + highlighted ids out.
  router.post('/graph/ask', asyncHandler(async (req, res) => {
    const out = await askGraph(req.body?.question || '', req.body || {});
    if (out.error) {
      if (out.error === 'question_required') return res.status(400).json(out);
      return res.status(502).json(out);
    }
    res.json(out);
  }));

  // The project's ranked next steps — the one authoritative answer to "what do I
  // build next, and in what order?". Free: no model call, SQL and arithmetic only,
  // so it can be the default the screen always shows rather than something you
  // have to ask (and pay) for. POSTed rather than GET because the component trunk
  // lives in the frontend file, not the DB — same reason /intel/signals does.
  router.post('/next', (req, res) => {
    const limit = Math.min(10, Math.max(1, Number(req.body?.limit) || 3));
    res.json(nextSteps(db, req.body?.catalog || [], { limit }));
  });

  // "AI recommends order" in the Not built list — the client sends its items,
  // the model returns their ids best-first. Explicit click only.
  router.post('/rank-unbuilt', asyncHandler(async (req, res) => {
    const out = await rankUnbuilt(req.body?.items);
    if (out.error) return res.status(out.error === 'empty' ? 400 : 502).json(out);
    res.json(out);
  }));

  // "Show my next 3" in the Not built list — a 3-pick shortlist with a one-line
  // plain-English reason each. Explicit click only.
  router.post('/notbuilt-shortlist', asyncHandler(async (req, res) => {
    const out = await shortlistUnbuilt(req.body?.items);
    if (out.error) return res.status(out.error === 'empty' ? 400 : 502).json(out);
    res.json(out);
  }));

  // "Built, but you cannot use it yet" — abilities the server has that the interface
  // never calls. Free to detect (it is a text match over the route files and the
  // interface file, no model), so it is safe to load with the page. The plain-English
  // write-up costs one cheap call for the whole list and is cached against that exact
  // list, so it is written once and reused until the list itself changes.
  //
  // The write-up is never waited on: this answers immediately with whatever has been
  // written already and starts writing in the background if the list has changed. The
  // detection is the load-bearing part and must not be held hostage to a model being
  // reachable. ?explain=0 does not even start it.
  router.get('/unreachable', (req, res) => {
    const found = findUnreachable();
    if (found.error) return res.json({ items: [], error: found.error });
    const items = explainedFromCache(db, found.items);
    if (req.query.explain !== '0') kickExplain(db, found.items);
    res.json({ items: items.map(it => ({ ...it, task: buildTaskFor(it) })) });
  });

  // The one idea door: any entry point can POST here with { concept, catalog }.
  // One AI call routes the idea — speculative tree node or Seed.
  router.post('/ideas', asyncHandler(async (req, res) => {
    const out = await routeIdea(db, req.body?.concept || '', req.body || {});
    if (out.error) {
      if (out.error === 'concept_required') return res.status(400).json(out);
      if (out.error === 'duplicate') return res.status(409).json(out);
      return res.status(502).json(out);
    }
    res.json(out);
  }));

  router.get('/components', (req, res) => {
    res.json({ components: getComponents(db) });
  });

  router.get('/queue-status', (req, res) => {
    // The queue status line (plan "auto-ship" item 4): everything Antoine checks
    // before he ships his own work, so his edits never clash with a running task.
    // Counts come from the DB; paused state + the auto-ship gate live in the
    // settings stores, so this endpoint composes them.
    const status = getQueueStatus(db);
    const pause = getQueuePauseState();
    const memMb = containerFreeBytes();
    // Today's spend + the per-task cost cap (free-only plan): the status line
    // shows what the queue has cost today and the cap that stops one task from
    // ever draining the credit bank.
    const dayStart = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
    const today = db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM work_prompts WHERE cost_usd > 0 AND started_at >= ?`).get(dayStart);
    const capRow = db.prepare(`SELECT queue_cost_cap_usd FROM ai_settings WHERE id='global'`).get();
    const costCapUsd = (capRow && typeof capRow.queue_cost_cap_usd === 'number' && capRow.queue_cost_cap_usd > 0)
      ? capRow.queue_cost_cap_usd : 0.1;
    // Daily helper budget (free-only plan): today's short-call count + the
    // configured budget — the status line shows the free allowance at a glance.
    const sideCallsTodayN = sideCallsToday();
    const sideBudget = sideCallBudgetLimit();
    res.json({
      ...status,
      paused: pause.paused,
      pausedReason: pause.reason || null,
      autoShip: autoShipEnabled(),
      memFreeMb: memMb === null ? null : Math.round(memMb / 1024 / 1024),
      todayCostUsd: Number(today.total) || 0,
      costCapUsd,
      sideCallsToday: sideCallsTodayN,
      sideBudget,
      // Rides along on a line the app already polls every 30s, so knowing the data
      // is safe costs nothing extra.
      storage: storageState(),
    });
  });

  router.get('/components/:id/history', (req, res) => {
    res.json(getComponentHistory(db, req.params.id));
  });

  router.post('/components/:id/suggestions/regenerate', asyncHandler(async (req, res) => {
    const out = await generateSuggestions(db, req.params.id);
    if (out.error) return res.status(out.error === 'no_api_key' ? 500 : 502).json(out);
    res.json(out);
  }));

  return router;
}
