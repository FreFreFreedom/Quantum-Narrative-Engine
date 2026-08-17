// Prompt queue (§5) — ported close to as-is per §12 step 3. Owns order, business
// statuses, the per-item conversation thread, and hand-off to taskRunner.js. Never
// talks to `claude` directly — it calls taskRunner's enqueueAgentTask/kick surface and
// gets called back via onAgentTaskFinalized (dynamic import to avoid a circular
// static import, same as the original).
//
// Adapted vs. the original (§10.5): Slack recap replaced with a generic optional
// webhook (NOTIFY_WEBHOOK_URL) posting the same one-line format — swap for any
// channel. APP_URL is env-configurable and the recap link is simply omitted if unset.
//
// FMCNS has one space ('fmcns') where the spec had two ('finance'/'agent'); the
// space column and per-space position/scheduling logic are kept as-is so a second
// space can be added later without a migration.
//
// Provider support (see providers/README.md): every prompt carries a provider
// ('claude-code' or 'opencode') and the provider-specific model picked at creation
// (provider_model). Each provider keeps its OWN CLI session column (session_id vs
// opencode_session_id) — the two CLIs cannot resume each other's sessions, so the
// same-context chain follows the task's provider, and switching provider drops the
// stale session link. 'auto' preset (judged by the model policy) applies to
// claude-code tasks; opencode tasks default their model explicitly instead.

import { randomUUID } from 'node:crypto';
import { broadcastAll } from '../realtime.js';
import {
  enqueueAgentTask, findAgentTask, getSettings, presetFor, getMaxParallelQuestions,
  generateUserSummary, isQueuePaused, setQueuePaused,
  updatePendingAgentTask, cancelPendingAgentTask, sendSteeringMessage, stopTask,
  MAX_CONCURRENT_WRITERS, OOM_KILL_MARKER,
} from './taskRunner.js';
import { resolvePreset, escalate } from './modelPolicy.js';
import { resolveParent } from './contextPolicy.js';
import { defaultOpenCodeModel, getDefaultAiRouterModel, modelContextWindow } from './providers/index.js';
import { listAgents, pickAgentFor } from './agents.js';
import { draftPlan } from './taskPlanner.js';
import { generateText } from './ai/text.js';
import { USER_FACING_STYLE } from './ai/style.js';
import { runInspiration, getReport, inspirationDigestFor, reviewInspiration, storeReportReview } from './codeDiscovery.js';
import { syncFromTask } from './treeSync.js';

const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');
const NOTIFY_WEBHOOK_URL = process.env.NOTIFY_WEBHOOK_URL || '';

export const PROMPT_SPACES = ['fmcns'];

const _resumeRetried = new Set();

// OOM-killed runs (exit 137) retry themselves once — see the block in
// onAgentTaskFinalized. Delay gives the container time to shed memory before
// the retry is even eligible; the runner's memory guard gates the actual
// dispatch. Woken by the 60s quota-scheduler tick (same resume_after mechanism
// as quota deferrals), so the real wait is 2–3 minutes.
const _oomRetried = new Set();
const OOM_RETRY_DELAY_MS = 2 * 60_000;

let db = null;
export function bindDb(database) { db = database; }

function SELECT() { return 'SELECT * FROM work_prompts WHERE deleted_at IS NULL'; }

export function listPrompts({ space = null } = {}) {
  const where = space ? ' AND space=?' : '';
  const rows = db.prepare(`${SELECT()}${where} ORDER BY
    CASE WHEN pending_question IS NOT NULL AND status NOT IN ('running','cancelled') THEN 0
         ELSE CASE status WHEN 'running' THEN 1 WHEN 'queued' THEN 2 WHEN 'paused' THEN 3 ELSE 4 END END,
    position, created_at`).all(...(space ? [space] : []));
  return rows.map((r) => ({ ...r, context_pct: contextPct(r) }));
}

export function getPrompt(id) {
  const row = db.prepare(`${SELECT()} AND id=?`).get(id) || null;
  return row ? { ...row, context_pct: contextPct(row) } : null;
}

// Mark a prompt as read by the human (the unread dot on finished items).
export function markSeen(id) {
  const row = getPrompt(id);
  if (!row) return null;
  db.prepare(`UPDATE work_prompts SET seen_at=COALESCE(seen_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id=?`).run(id);
  return getPrompt(id);
}

function nextPosition(space) {
  const row = db.prepare(`SELECT MAX(position) AS m FROM work_prompts WHERE deleted_at IS NULL AND space=?`).get(space);
  return (row?.m ?? 0) + 1;
}
function frontPosition(space) {
  const row = db.prepare(`SELECT MIN(position) AS m FROM work_prompts WHERE deleted_at IS NULL AND status='queued' AND space=?`).get(space);
  return (row?.m ?? 1) - 1;
}

function broadcast() { broadcastAll('travaux:prompts:updated', {}); }

// Providers whose task model is picked directly (provider_model), not resolved
// from a Claude-Code preset tier — opencode and ai-router both work this way.
function usesModelPicker(provider) {
  return provider === 'opencode' || provider === 'ai-router';
}

function heuristicTitle(text) {
  const first = String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  return first.length > 80 ? first.slice(0, 79) + '…' : first || '(untitled)';
}

// Tier a row is actually running at: for a manual preset, exactly that; for 'auto',
// whatever the model policy judged (resolvePreset, called once at creation and
// remembered in resolved_preset so replies/retries don't re-judge every turn), falling
// back to 'standard' if judging hasn't happened yet for some reason — never 'fast'.
function effectivePreset(row) {
  return row.preset === 'auto' ? (row.resolved_preset || 'standard') : row.preset;
}

// Candidate parents for auto context resolution (contextPolicy.js) — same set
// qParentOptions() used to offer manually: the last 10 finished/blocked tasks by
// the same agent, on the same provider (sessions don't cross providers).
function candidateParents({ agentKey, provider }) {
  return db.prepare(`
    SELECT id, title, prompt FROM work_prompts
    WHERE deleted_at IS NULL AND COALESCE(agent_key,'dev1')=? AND provider=? AND status IN ('done','blocked')
    ORDER BY completed_at DESC LIMIT 10
  `).all(agentKey || 'dev1', provider);
}

export async function createPrompt({
  title = '', prompt, mode = 'implement', preset = 'deep', same_context = 0,
  created_by = null, suggestion_id = null, status = 'queued', priority = false, space = 'fmcns',
  component_id = null, provider = 'opencode', provider_model = null, agent_key = null,
  parent_prompt_id = null, strategy = 'single', plan_source = 'auto', context_mode = 'manual',
  convo_id = null, thought_id = null, inspiration = null,
}) {
  const text = String(prompt || '').trim();
  if (!text) throw new Error('prompt is required');
  if (!isValidModelId(provider_model)) throw new Error('invalid provider_model');
  const useMode = mode === 'question' ? 'question' : 'implement';
  // Free-first platform policy (plan self-aware-platform.md): an unspecified or
  // unknown provider resolves to the OpenCode lane, never to the Claude
  // subscription — Claude tasks only exist when explicitly chosen.
  const useProvider = ['opencode', 'ai-router'].includes(provider) ? provider : 'opencode';
  const id = randomUUID();
  const given = String(title || '').trim();
  const label = given || heuristicTitle(text);
  const initial = status === 'paused' ? 'paused' : 'queued';
  const inSpace = PROMPT_SPACES.includes(space) ? space : 'fmcns';
  // Agent assignment (plan Part 1): NULL falls back to dev1 at dispatch time.
  const useAgentKey = String(agent_key || '').trim() || null;
  // Explicit continuation link (plan 2d): chaining onto a parent implies the
  // same-context semantics the old checkbox expressed.
  let useParent = parent_prompt_id || null;
  // Auto context resolution: only when the caller opted in (context_mode:'auto',
  // used by the New-prompt form) and didn't already pin a parent explicitly.
  // Implement-mode tasks resolve this later in runPlanDraft(), against the
  // drafted brief rather than the raw text — skip here so it isn't judged twice.
  let autoContextNote = null;
  const willDraftPreCheck = useMode === 'implement' && plan_source !== 'skip';
  if (context_mode === 'auto' && !useParent && !willDraftPreCheck) {
    const candidates = candidateParents({ agentKey: useAgentKey, provider: useProvider });
    const picked = await resolveParent({ mode: useMode, text, candidates }).catch(() => null);
    if (picked) { useParent = picked.id; autoContextNote = `Auto-continuing the session of "${picked.title}".`; }
  }
  const chained = !!(same_context || useParent);
  let useModel = provider_model || null;
  if (useProvider === 'opencode' && !useModel) {
    // No model chosen — remember the best available default (free models first) at
    // creation time, so the sync execution path never has to discover it lazily.
    try { useModel = await defaultOpenCodeModel(); } catch { /* stays null — executeTask blocks with a clear reason */ }
  } else if (useProvider === 'ai-router' && !useModel) {
    try { useModel = await getDefaultAiRouterModel(); } catch { /* stays null — executeTask blocks with a clear reason */ }
  }

  // Plan-first queue (Part A): every implement-mode task is auto-drafted into an
  // unambiguous brief before it runs. Question-mode tasks and any caller that
  // already produced a deliberated plan (plan_source:'skip', e.g. a future
  // conversation handoff) skip this and behave exactly as before — resolvePreset
  // runs synchronously against the text as submitted.
  const willDraft = willDraftPreCheck;
  // Inspiration step (plan inspiration-before-planning): EVERY implement-mode
  // task — suggestion, hand-typed, seed, thought, handoff — gets a background
  // pass that looks at the world (open / hidden / bold shelves) before its plan
  // is written. Question-mode tasks skip it. The pass never blocks creation:
  // the row lands with inspire_state='pending' and the draft simply waits up to
  // its timeout for the report (below), then proceeds without it on failure.
  const willInspire = useMode === 'implement';
  // Precomputed world-look: the item's own section (suggestion / seed / not-built
  // component) already ran the pass, so the task reuses it instead of searching
  // again. Picks are validated against the report; state lands 'applied' when
  // picks came along, else 'ready' (shelves shown, nothing chosen yet).
  let preInsp = null;
  if (willInspire && inspiration && inspiration.report_id) {
    const rep = getReport(db, inspiration.report_id);
    if (rep) {
      const applied = [];
      for (const sel of inspiration.picks || []) {
        const pi = Number(sel.part_index) || 0;
        const ii = Number(sel.pick_index) || 0;
        const pick = rep.parts?.[pi]?.picks?.[ii];
        if (!pick) continue;
        applied.push({ part_index: pi, pick_index: ii, kind: pick.kind, name: pick.repo || pick.name || pick.kind });
      }
      preInsp = { report: rep, applied, digest: inspirationDigestFor(rep, applied, rep.review) };
    }
  }
  const preState = preInsp ? (preInsp.applied.length ? 'applied' : 'ready') : (willInspire ? 'pending' : 'off');
  const resolved = (!willDraft && preset === 'auto' && useProvider === 'claude-code')
    ? await resolvePreset({ mode: useMode, prompt: text }).catch(() => 'standard') : null;

  db.prepare(`
    INSERT INTO work_prompts (id, title, prompt, status, position, same_context, mode, preset, resolved_preset, suggestion_id, created_by, title_auto, space, component_id, provider, provider_model, agent_key, parent_prompt_id, strategy, strategy_state, raw_prompt, plan_source, plan_pending, convo_id, thought_id, inspire_state, inspire_report_id, inspire_picks_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(id, label, text, initial, priority ? frontPosition(inSpace) : nextPosition(inSpace), chained ? 1 : 0,
    useMode, preset, resolved, suggestion_id, created_by, given ? 0 : 1, inSpace, component_id, useProvider, useModel, useAgentKey, useParent, strategy, strategy === 'single' ? 'idle' : 'running',
    willDraft ? text : null, plan_source, willDraft ? 1 : 0, convo_id, thought_id, preState, preInsp ? preInsp.report.id : null, preInsp ? JSON.stringify(preInsp.applied) : '[]');

  if (autoContextNote) addMessage(id, { role: 'agent', text: autoContextNote });
  broadcast();
  if (willInspire && !preInsp) {
    startInspiration(id, { title: label, prompt: text });
  }
  if (willDraft) {
    runPlanDraft(id, {
      title: label, prompt: text, mode: useMode, preset, provider: useProvider, targetStatus: initial,
      agentKey: useAgentKey, contextMode: context_mode, explicitParent: !!useParent,
      inspirationOverride: preInsp ? preInsp.digest : null,
    });
  }
  eagerSummarize(id); // free-lane purpose bullets ready before the owner opens it
  return getPrompt(id);
}

// Background continuation for the plan-first drafting stage: the row already
// exists (status queued/paused as requested, plan_pending=1 so advanceQueue()
// skips it) — this fills in the drafted title/prompt, resolves the preset, clears
// plan_pending, and — only if the requested status was 'queued' — kicks the queue.
// Never throws past draftPlan(), which already swallows its own failures; on a
// null draft the raw text just stays as-is.
//
// Speed note: the draft, the preset judge and the auto context match used to run
// one after another — three serial model calls of invisible warm-up before the
// task could even start. All three are now fired in parallel (Promise.all); the
// judge and the context match judge the RAW submitted text instead of the drafted
// brief (a fine signal — the brief is mostly reformatting of the same content, and
// the judge is explicitly instructed to err upward). Total warm-up drops to the
// slowest single call.
async function runPlanDraft(id, { title, prompt, mode, preset, provider, targetStatus, agentKey = null, contextMode = 'manual', explicitParent = false, inspirationOverride = null }) {
  const needPreset = preset === 'auto' && provider === 'claude-code';
  const needParent = contextMode === 'auto' && !explicitParent;

  // Inspiration step: the draft waits (bounded) for the automatic world-look
  // pass so the plan is written with real-world context — this is the "wait for
  // inspiration before starting" behavior for tasks added straight to the
  // queue. The quick check (review) runs inside that pass; if it asks the owner
  // a question, the wait extends (unbounded) until the answer, the skip, or the
  // task's deletion. On timeout or failure the draft proceeds without it; the
  // report may still land later and the human can re-draft by applying picks.
  // inspirationOverride: the world-look already ran in the item's own section
  // (suggestion / seed / not-built) — use that digest directly, no wait.
  const inspiration = inspirationOverride !== null
    ? { digest: inspirationOverride }
    : await waitForInspiration(id, INSPIRE_WAIT_MS);
  const inspDigest = inspiration ? (typeof inspiration === 'string' ? inspiration : inspiration.digest) : null;
  const inspNote = inspiration && typeof inspiration === 'object' ? inspiration.note : null;

  const [draft, presetOut, parentOut] = await Promise.all([
    draftPlan({ title, prompt, mode, inspiration: inspDigest, ownerNote: inspNote }),
    needPreset ? resolvePreset({ mode, prompt }).catch(() => 'standard') : Promise.resolve(null),
    needParent
      ? (async () => {
          const candidates = candidateParents({ agentKey, provider });
          const picked = await resolveParent({ mode, text: prompt, candidates }).catch(() => null);
          return picked;
        })()
      : Promise.resolve(null),
  ]);

  const finalTitle = draft?.title || title;
  const finalPrompt = draft?.brief || prompt;
  const resolved = needPreset ? presetOut : null;
  const parentId = parentOut ? parentOut.id : null;
  const contextNote = parentOut ? `Auto-continuing the session of "${parentOut.title}".` : null;

  // The task may have been deleted while the draft (or the question wait) ran.
  if (!getPrompt(id)) return;

  db.prepare(`
    UPDATE work_prompts SET title=?, prompt=?, resolved_preset=COALESCE(?, resolved_preset),
      ${parentId ? 'parent_prompt_id=?, same_context=1,' : ''}
      plan_pending=0, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?
  `).run(finalTitle, finalPrompt, resolved, ...(parentId ? [parentId] : []), id);
  if (contextNote) addMessage(id, { role: 'agent', text: contextNote });
  _inspireWaiters.delete(id);
  broadcast();
  if (targetStatus === 'queued') advanceQueue();
}

// ─── Inspiration step ─────────────────────────────────────────────────────────
// Every implement-mode task gets an automatic pass that looks at the world
// (codeDiscovery.runInspiration: open / hidden / bold shelves) before its plan
// is written. The pass never blocks creation and never blocks the queue — the
// draft waits for it only up to INSPIRE_WAIT_MS, and a failure simply leaves
// the task inspire_state='failed' with a retry button in the UI.
const INSPIRE_WAIT_MS = 75_000;
const _inspiring = new Map();

function parseInspirePicks(row) {
  try { return JSON.parse(row?.inspire_picks_json || '[]'); } catch { return []; }
}

// The quick check's verdict on the report (see codeDiscovery.reviewInspiration):
// removed picks with reasons, alternative groups with a best-per-group, an
// optional owner question, and — after the owner answered — their note.
function parseInspireReview(row) {
  try { return row?.inspire_review_json ? JSON.parse(row.inspire_review_json) : null; } catch { return null; }
}

// True when the pending question was asked by the quick check (kind:'review'),
// not by an executing agent — the two have different answer paths.
function isReviewQuestion(row) {
  try {
    const q = row?.pending_question ? JSON.parse(row.pending_question) : null;
    return !!(q && q.question && q.kind === 'review');
  } catch { return false; }
}

// ─── Draft-stage waiters ──────────────────────────────────────────────────────
// When the quick check asks the owner a question, runPlanDraft parks on a promise
// resolved by the answer path (answerInspireQuestion), the skip, the deletion, or
// a refresh (which voids the old question; the loop re-waits if the new pass asks
// a new one). A parked draft holds its promise reference, so removing the entry
// on settle is safe. Cleaned up at the end of runPlanDraft.
const _inspireWaiters = new Map(); // id -> { promise, resolve }

function inspireWaiter(id) {
  let entry = _inspireWaiters.get(id);
  if (!entry) {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    entry = { promise, resolve };
    _inspireWaiters.set(id, entry);
  }
  return entry;
}

function settleInspireWaiter(id) {
  const entry = _inspireWaiters.get(id);
  if (entry) entry.resolve();
  _inspireWaiters.delete(id);
}

function startInspiration(id, { title, prompt }, { force = false } = {}) {
  const run = (async () => {
    try {
      const report = await runInspiration(db, {
        idea_text: [title, prompt].filter(Boolean).join('\n'),
        source: 'prompt',
        source_id: id,
        forceRefresh: force,
      });
      if (report?.error) throw new Error(report.message || report.error);
      // The quick check runs before the report is marked ready: one cheap pass
      // that filters what does not earn its place. Its own failure is NOT a
      // world-look failure — the full report is used, exactly as before.
      db.prepare(`
        UPDATE work_prompts SET inspire_state='reviewing', inspire_report_id=?, inspire_error=NULL,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?
      `).run(report.id, id);
      broadcast();
      let review = null;
      try {
        review = await reviewInspiration({ report, prompt: [title, prompt].filter(Boolean).join('\n') });
      } catch (e) {
        console.error('🤖 File de travaux: quick check —', e.message);
      }
      if (review) storeReportReview(db, report.id, review); // canonical home on the report
      if (review?.question) {
        // The quick check needs the owner: the question shows on the card (same
        // mechanism as agent questions) and the draft waits for the answer.
        db.prepare(`
          UPDATE work_prompts SET inspire_state='ready', inspire_review_json=?, pending_question=?,
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?
        `).run(JSON.stringify(review), JSON.stringify({ ...review.question, kind: 'review' }), id);
      } else {
        db.prepare(`
          UPDATE work_prompts SET inspire_state='ready', inspire_review_json=?,
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?
        `).run(review ? JSON.stringify(review) : null, id);
      }
    } catch (e) {
      db.prepare(`
        UPDATE work_prompts SET inspire_state='failed', inspire_error=?,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?
      `).run(String(e.message || 'unknown error').slice(0, 400), id);
    } finally {
      _inspiring.delete(id);
      broadcast();
      // The inspiration gate: a queued task held at 'off'/'pending'/'failed' is
      // released the moment the pass settles (ready → runs, failed → stays held
      // for the retry/skip buttons). advanceQueue is a no-op for rows that are
      // still held or still drafting — safe to call on every completion.
      advanceQueue();
    }
  })();
  _inspiring.set(id, run);
  return run;
}

// Antoine chose to let this task run on a plain plan without the world-look
// ("Start without inspiration"). The gate then treats it like a ready task.
export async function skipInspiration(id) {
  const row = getPrompt(id);
  if (!row) return null;
  if (row.mode !== 'implement') return row;
  db.prepare(`
    UPDATE work_prompts SET inspire_state='skipped', inspire_error=NULL, pending_question=NULL,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?
  `).run(id);
  settleInspireWaiter(id);
  broadcast();
  if (row.status === 'queued') advanceQueue();
  return getPrompt(id);
}

// Wait for the task's inspiration pass, bounded. Resolves to { digest, note }
// (the digest already filtered by the quick check and emphasizing any applied
// picks; the note carries the owner's answer when a quick-check question was
// answered), or null when there is no pass to wait for, it failed, or the
// timeout elapsed first. When the quick check asked the owner a question, the
// wait extends without timeout until the answer, the skip, or deletion — the
// question card is visible and the plan should be written with their answer.
// A refresh (new pass) while waiting is given one more bounded chance, then
// the settled row is used as-is.
export async function waitForInspiration(id, timeoutMs = INSPIRE_WAIT_MS) {
  const racePass = (run) => Promise.race([
    run.catch(() => {}),
    new Promise((res) => setTimeout(res, timeoutMs)),
  ]);
  let run = _inspiring.get(id);
  if (run) await racePass(run);

  let extraWaits = 0;
  for (;;) {
    const row = getPrompt(id);
    if (!row) return null;
    if (isReviewQuestion(row)) {
      // Attach the waiter BEFORE re-checking: an answer that lands between the
      // two reads either resolves this entry or shows up in the re-check.
      const entry = inspireWaiter(id);
      if (isReviewQuestion(getPrompt(id))) await entry.promise;
      continue;
    }
    run = _inspiring.get(id);
    if (run && extraWaits < 1) {
      extraWaits++;
      await racePass(run);
      continue;
    }
    if (!row.inspire_report_id) return null;
    const report = getReport(db, row.inspire_report_id);
    // Task-level review wins (it may carry the owner's answer), else the
    // report's own quick-check verdict — section looks store it there.
    const review = parseInspireReview(row) || report?.review || null;
    return {
      digest: inspirationDigestFor(report, parseInspirePicks(row), review),
      note: parseInspireReview(row)?.owner_note || null,
    };
  }
}

// Manual re-run from the task detail (also the entry point for tasks created
// before this feature: their state is 'off' and this starts their first pass).
export async function refreshInspiration(id) {
  const row = getPrompt(id);
  if (!row) return null;
  if (row.mode !== 'implement') return row;
  if (_inspiring.has(id)) return row; // one pass at a time
  // A new world-look voids the previous quick-check verdict (the review keys
  // belong to the old report) and any question it asked. Settling the waiter
  // wakes a parked plan draft, which loops and re-waits if the new pass asks.
  if (isReviewQuestion(row) || parseInspireReview(row)) {
    db.prepare(`
      UPDATE work_prompts SET pending_question=NULL, inspire_review_json=NULL
        WHERE id=?
    `).run(id);
  }
  settleInspireWaiter(id);
  db.prepare(`
    UPDATE work_prompts SET inspire_state='pending', inspire_error=NULL,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?
  `).run(id);
  broadcast();
  startInspiration(id, { title: row.title, prompt: row.raw_prompt || row.prompt }, { force: true });
  return getPrompt(id);
}

// The human picked shelves/blocks → store them and re-draft the plan once with
// the chosen items emphasized ("you pick, plan re-drafts"). The raw submitted
// text stays the drafting source so drafts never compound on themselves. Guarded
// against running tasks — steering is the right tool once it is executing.
export async function applyInspiration(id, { picks = [] } = {}) {
  const row = getPrompt(id);
  if (!row) return null;
  if (row.status === 'running') return { ...row, error: 'running' };
  // A finished task's plan is the historical record of what ran — picks on a
  // done/cancelled task are read-only (its world-look stays visible to read).
  if (['done', 'cancelled'].includes(row.status)) return { ...row, error: 'finished' };
  const report = row.inspire_report_id ? getReport(db, row.inspire_report_id) : null;
  if (!report) return { ...row, error: 'no_report' };
  const applied = [];
  for (const sel of picks || []) {
    const pi = Number(sel.part_index) || 0;
    const ii = Number(sel.pick_index) || 0;
    const pick = report.parts?.[pi]?.picks?.[ii];
    if (!pick) continue;
    applied.push({ part_index: pi, pick_index: ii, kind: pick.kind, name: pick.repo || pick.name || pick.kind });
  }
  if (!applied.length) return { ...row, error: 'no_valid_picks' };
  db.prepare(`
    UPDATE work_prompts SET inspire_picks_json=?, inspire_state='applied',
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?
  `).run(JSON.stringify(applied), id);

  // The quick check still shapes the draft around the owner's picks: their
  // choices always win, everything else keeps the filtered form.
  const digest = inspirationDigestFor(report, applied, parseInspireReview(row) || report.review);
  const draft = await draftPlan({ title: row.title, prompt: row.raw_prompt || row.prompt, mode: row.mode, inspiration: digest });
  if (draft) {
    db.prepare(`
      UPDATE work_prompts SET title=?, prompt=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?
    `).run(draft.title, draft.brief, id);
  }
  broadcast();
  return getPrompt(id);
}

// One-time plain-language pass for world-look report descriptions — both the
// old "one paragraph" style and the technical one-sentence style are rewritten
// for a non-programmer: one short sentence (max 20 words), everyday words, no
// jargon, no internal names. Picks untouched. One cheap model call per report;
// idempotent (already-plain short descriptions come back unchanged).
export async function condenseExistingInspiration() {
  const rows = db.prepare(`SELECT DISTINCT inspire_report_id AS rid FROM work_prompts WHERE inspire_report_id IS NOT NULL AND deleted_at IS NULL`).all();
  let condensed = 0, skipped = 0, failed = 0;
  for (const { rid } of rows) {
    const row = db.prepare(`SELECT * FROM discovery_reports WHERE id=?`).get(rid);
    if (!row) { skipped++; continue; }
    let parts;
    try { parts = JSON.parse(row.parts_json || '[]'); } catch { parts = []; }
    const idxs = [];
    parts.forEach((p, i) => { if (String(p.description || '').trim().length > 60) idxs.push(i); });
    if (!idxs.length) { skipped++; continue; }
    const descs = idxs.map(i => parts[i].description);
    const out = await generateText({
      prompt: `Rewrite each description below for a NON-programmer, in plain everyday language: ONE short sentence (max 20 words). No jargon, no technical terms, no internal component or system names (like "SQLite" or "API") — say what it does for the person using the app, in everyday words. Keep the meaning. Return ONLY a JSON array of strings, same order, nothing else.\n${JSON.stringify(descs)}`,
      feature: 'studio',
      maxTokens: 300,
      label: 'inspire-condense-existing',
    });
    if (out.error) { failed++; continue; }
    let short = null;
    const m = (out.text || '').match(/\[[\s\S]*\]/);
    if (m) { try { short = JSON.parse(m[0]); } catch {} }
    if (!Array.isArray(short) || short.length !== idxs.length) { failed++; continue; }
    idxs.forEach((pi, i) => { const s = String(short[i] || '').trim(); if (s) parts[pi].description = s; });
    db.prepare(`UPDATE discovery_reports SET parts_json=? WHERE id=?`).run(JSON.stringify(parts), rid);
    condensed++;
  }
  return { condensed, skipped, failed };
}

// One-time (idempotent) retroactive pass: every world-look report that predates
// the quick check gets its verdict — stored on the report itself — and any
// WAITING queue task whose plan was drafted from unfiltered ideas gets the plan
// re-drafted from the filtered digest (using its original request). Guards:
// only tasks still queued/set aside, never started, auto-drafted, with no open
// question and no owner reply in the thread. Runs at boot (preGen) and can be
// re-triggered — reports with a review are skipped, so it costs nothing twice.
export async function backfillInspirationReviews() {
  const reportIds = db.prepare(`SELECT id FROM discovery_reports WHERE review_json IS NULL`).all();
  let reviewed = 0, redrafted = 0, skipped = 0, failed = 0;
  for (const { id } of reportIds) {
    const report = getReport(db, id);
    if (!report || !(report.parts || []).some(p => (p.picks || []).length)) { skipped++; continue; }
    const review = await reviewInspiration({ report, prompt: report.idea_text || '', allowQuestion: false })
      .catch(() => null);
    if (!review) { failed++; continue; }
    storeReportReview(db, id, review);
    reviewed++;

    if (report.source !== 'prompt' || !report.source_id) continue;
    const row = db.prepare(`SELECT * FROM work_prompts WHERE id=? AND deleted_at IS NULL`).get(report.source_id);
    if (!row) continue;
    // The task panel reads its own review first — fill it so markers show
    // immediately; an existing review (fresh tasks) is never overwritten.
    if (!row.inspire_review_json) {
      db.prepare(`UPDATE work_prompts SET inspire_review_json=? WHERE id=?`).run(JSON.stringify(review), row.id);
    }
    const safe = ['queued', 'paused'].includes(row.status)
      && !row.started_at && !!row.raw_prompt && !row.plan_pending
      && !row.pending_question && row.plan_source === 'auto';
    if (!safe) continue;
    const replied = db.prepare(`SELECT 1 AS x FROM work_prompt_messages WHERE prompt_id=? AND role='user' LIMIT 1`).get(row.id);
    if (replied) continue;
    const digest = inspirationDigestFor(report, parseInspirePicks(row), review);
    const draft = await draftPlan({ title: row.title, prompt: row.raw_prompt, mode: row.mode, inspiration: digest });
    if (draft) {
      db.prepare(`
        UPDATE work_prompts SET title=?, prompt=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?
      `).run(draft.title, draft.brief, row.id);
      redrafted++;
    }
  }
  if (reviewed || redrafted) broadcast();
  return { reviewed, redrafted, skipped, failed };
}

// ─── Background sweep for legacy tasks ───────────────────────────────────────
// Tasks queued before the world-look feature shipped sit at inspire_state='off'
// (the column default) with no report — opening one shows a "✨ Look" button
// instead of the ideas. This pre-runs their world-look at boot and every 6h, the
// same way the suggestion/seed/not-built sweeps do theirs, so every task the user
// can click on already has its shelves ready (grey-outs, alternatives, our pick
// included) instead of making them wait. Idempotent: tasks with a report or an
// in-flight pass are skipped; refreshInspiration() dedups an already-running pass
// via `_inspiring`. Reuses the free-model-first seam; never throws.
export async function autoWorldLookTasks({ limit = 16 } = {}) {
  const rows = db.prepare(`
    SELECT id, title, raw_prompt, prompt
    FROM work_prompts
    WHERE mode='implement' AND deleted_at IS NULL
      AND (inspire_state IS NULL OR inspire_state IN ('off','failed'))
      AND inspire_report_id IS NULL
    ORDER BY created_at ASC
    LIMIT ?
  `).all(limit);
  let ran = 0, skipped = 0, failed = 0;
  for (const r of rows) {
    if (_inspiring.has(r.id)) { skipped++; continue; }          // already running
    const row = await refreshInspiration(r.id);                 // -> 'pending' + starts runInspiration
    if (!row) { skipped++; continue; }
    const run = _inspiring.get(r.id);                           // grab the in-flight promise
    if (run) {
      await run;                                                // settle (look + quick check)
      const st = getPrompt(r.id)?.inspire_state;
      if (st === 'ready' || st === 'applied') ran++;
      else failed++;                                            // review settled as failed/held
    } else {
      skipped++;                                                // started elsewhere between the check and the call
    }
  }
  return { ran, skipped, failed };
}

// Everything the task detail's "Inspired by" panel needs in one call: the state,
// the last error (for the retry note), the applied picks, the quick-check review
// (removed picks with reasons, alternative groups, best-per-group) and the full
// report. A task promoted from a section carries its report's review.
export function inspirationPayload(id) {
  const row = getPrompt(id);
  if (!row) return null;
  const report = row.inspire_report_id ? getReport(db, row.inspire_report_id) : null;
  return {
    state: row.inspire_state,
    error: row.inspire_error || null,
    picks: parseInspirePicks(row),
    review: parseInspireReview(row) || report?.review || null,
    report,
  };
}

// Retroactive plan-first drafting for a task created before that feature existed
// (raw_prompt still NULL). Only touches implement-mode tasks sitting queued/paused
// (never a running/finished one — a finished task's prompt is the historical record
// of what actually ran). Reuses draftPlan() exactly like runPlanDraft() does, just
// triggered manually instead of at creation time.
export async function backfillPlan(id) {
  const p = getPrompt(id);
  if (!p) return null;
  if (p.mode !== 'implement') return { ...p, backfill_skipped: 'not_implement' };
  if (p.raw_prompt) return { ...p, backfill_skipped: 'already_drafted' };
  if (!['queued', 'paused'].includes(p.status)) return { ...p, backfill_skipped: 'not_pending' };
  db.prepare(`UPDATE work_prompts SET plan_pending=1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(id);
  broadcast();
  const draft = await draftPlan({ title: p.title, prompt: p.prompt, mode: p.mode });
  const finalTitle = draft?.title || p.title;
  const finalPrompt = draft?.brief || p.prompt;
  db.prepare(`
    UPDATE work_prompts SET raw_prompt=?, title=?, prompt=?, plan_pending=0, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?
  `).run(p.prompt, finalTitle, finalPrompt, id);
  broadcast();
  return getPrompt(id);
}

// run_model is editable ONLY so unfinished tasks can shed a stale "ran with"
// label from an earlier attempt — the queue overwrites it at the next dispatch.
const EDITABLE =['title', 'prompt', 'mode', 'preset', 'same_context', 'status', 'position', 'stop_after', 'provider', 'provider_model', 'run_model', 'agent_key', 'parent_prompt_id', 'strategy', 'summary'];

// provider_model/run_model reach a shell command string (taskRunner.js's spawned
// CLI invocation) — buildRunCommand shell-quotes every value it interpolates, so
// this isn't the only thing standing between a bad value and command injection,
// but rejecting anything outside a plain model-id shape here means a malformed
// value never gets past the API in the first place. Real model ids look like
// "sonnet", "opencode/deepseek-v4-flash-free", "google-ai-studio/gemini-2.0-flash".
const MODEL_ID_RE = /^[a-zA-Z0-9_.\/:-]{1,200}$/;
function isValidModelId(v) {
  return v == null || v === '' || MODEL_ID_RE.test(String(v));
}

function isPending(row) {
  if (!row || row.status !== 'running' || !row.agent_task_id) return false;
  const task = findAgentTask(row.agent_task_id);
  return !!task && task.status === 'approved';
}

function reclaimPending(row) {
  if (!isPending(row)) return row;
  if (!cancelPendingAgentTask(row.agent_task_id)) return row;
  db.prepare(`
    UPDATE work_prompts SET status='queued', agent_task_id=NULL, started_at=NULL,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?
  `).run(row.id);
  return getPrompt(row.id);
}

// Same idea as reclaimPending(), for a task that's actually mid-execution rather than
// still waiting in taskRunner's own queue. Flips the prompt row back to 'queued'
// immediately rather than waiting on the OS process to actually die (that can take a
// few seconds, or — if something went wrong spawning it in the first place — never
// happen at all) so the UI reflects "stopped" the moment you click pause. stopTask()'s
// stop_requested flag is the backstop: whenever the kill DOES get noticed by
// taskRunner's poll loop, onAgentTaskFinalized() sees that flag and skips re-recording
// this as 'blocked' over the top of the 'queued' state set here.
function reclaimRunning(row) {
  if (row.status !== 'running' || !row.agent_task_id) return row;
  stopTask(row.agent_task_id);
  db.prepare(`
    UPDATE work_prompts SET status='queued', agent_task_id=NULL, started_at=NULL,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?
  `).run(row.id);
  return getPrompt(row.id);
}

function syncPendingTask(row) {
  if (!isPending(row)) return;
  const { model, effort } = usesModelPicker(row.provider) ? { model: row.provider_model, effort: null } : presetFor(effectivePreset(row));
  updatePendingAgentTask(row.agent_task_id, { title: row.title, description: row.prompt, mode: row.mode, model, effort });
}

// ─── AI purpose summary ────────────────────────────────────────────────────────
// One cheap free-lane call, cached on the row so revisits and list polls never pay
// again. In-flight dedup: concurrent callers (route + eager hooks + rapid re-opens)
// share a single generation instead of fanning out. Failures are silent — the
// frontend keeps its instant prompt preview and the next open retries.
const _summarizing = new Map();

export async function summarizePrompt(id) {
  const row = getPrompt(id);
  if (!row || row.summary) return row ? { summary: row.summary } : null;
  if (_summarizing.has(row.id)) return { summary: await _summarizing.get(row.id) };
  const attempt = (async () => {
    const text = [row.title, row.raw_prompt || '', row.prompt].filter(Boolean).join('\n\n');
    const out = await generateText({
      prompt: [
        'Summarize the PURPOSE of this task for its owner: what it is for, what it produces, what it touches — NOT the mechanics.',
        'Answer as 3-5 short bullet points, one line each, plain language, no preamble, no markdown headers.',
        'If the task is a question, say what the owner wanted to know.',
        USER_FACING_STYLE,
        '\nTask:\n' + text.slice(-16000),
      ].join('\n'),
      feature: 'summary',
      maxTokens: 300,
      label: 'prompt:summarize',
    });
    const summary = (out.text || '').trim();
    if (!summary) throw new Error('empty summary');
    updatePrompt(row.id, { summary });
    return summary;
  })();
  _summarizing.set(row.id, attempt);
  try { return { summary: await attempt }; }
  finally { _summarizing.delete(row.id); }
}

// Eager, fire-and-forget: pre-generate the summary at creation and again when a
// task finishes, so the owner usually finds it already there on first open. The
// dedup map plus the cached row keep this to at most one call per task, and any
// failure just leaves the lazy path for later.
function eagerSummarize(id) {
  setImmediate(() => { summarizePrompt(id).catch(() => {}); });
}

export function updatePrompt(id, patch) {
  let row = getPrompt(id);
  if (!row) return null;
  if (patch.status !== undefined || patch.position !== undefined) row = reclaimPending(row) || row;
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!EDITABLE.includes(k)) continue;
    if (k === 'status' && !['queued', 'paused', 'cancelled'].includes(v)) continue;
    if (k === 'status' && row.status === 'running') continue;
    if (k === 'provider' && !['claude-code', 'opencode', 'ai-router'].includes(v)) continue;
    if ((k === 'provider_model' || k === 'run_model') && !isValidModelId(v)) continue;
    if (k === 'title') {
      const given = String(v ?? '').trim();
      sets.push('title=?', 'title_auto=?');
      vals.push(given || heuristicTitle(patch.prompt ?? row.prompt), given ? 0 : 1);
      continue;
    }
    sets.push(`${k}=?`);
    vals.push(['same_context', 'stop_after'].includes(k) ? (v ? 1 : 0) : v);
  }
  if (!sets.length) return row;
  // Chaining onto a parent (plan 2d) implies the same-context semantics the old
  // checkbox expressed — the dropdown and the column must not disagree.
  if (patch.parent_prompt_id !== undefined && patch.same_context === undefined) {
    sets.push('same_context=?');
    vals.push(patch.parent_prompt_id ? 1 : 0);
  }
  db.prepare(`UPDATE work_prompts SET ${sets.join(', ')}, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(...vals, id);
  const swapped = patch.provider !== undefined && patch.provider !== row.provider;
  if (swapped) {
    // Provider switch = fresh start on the other CLI's session store: the old
    // provider's session id means nothing to the new one, and carrying it over
    // would make the next same-context run try to resume a foreign session.
    db.prepare(`UPDATE work_prompts SET session_id=NULL, opencode_session_id=NULL, context_turns=0, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(id);
  }
  broadcast();
  const updated = getPrompt(id);
  syncPendingTask(updated);
  return updated;
}

// Per-task pause: unlike pauseQueue()/reclaimRunning() (which reclaim a killed
// task back to 'queued' so it's immediately eligible to restart), this leaves
// the row 'paused' so it's actually skipped by advanceQueue() until resumed.
// Mirrors reclaimRunning()'s kill for the running case; a queued row just
// flips status directly since there's no process to stop.
export function pausePrompt(id) {
  let row = getPrompt(id);
  if (!row) return null;
  row = reclaimPending(row) || row;
  if (row.status === 'running' && row.agent_task_id) {
    stopTask(row.agent_task_id);
    db.prepare(`
      UPDATE work_prompts SET status='paused', agent_task_id=NULL, started_at=NULL,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?
    `).run(row.id);
  } else if (row.status === 'queued') {
    db.prepare(`UPDATE work_prompts SET status='paused', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(row.id);
  }
  broadcast();
  return getPrompt(id);
}

export function deletePrompt(id) {
  const row = getPrompt(id);
  if (!row) return false;
  const wasPending = isPending(row);
  if (wasPending) reclaimPending(row);
  db.prepare(`UPDATE work_prompts SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(id);
  settleInspireWaiter(id); // a parked plan draft must wake and see the row gone
  broadcast();
  if (wasPending) advanceQueue();
  return true;
}

export function reorderPrompts(ids) {
  let reclaimed = false;
  for (const id of ids) {
    const row = getPrompt(id);
    if (!isPending(row)) continue;
    reclaimPending(row);
    reclaimed = true;
  }
  ids.forEach((id, i) => {
    db.prepare(`UPDATE work_prompts SET position=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND deleted_at IS NULL`).run(i + 1, id);
  });
  broadcast();
  if (reclaimed) advanceQueue();
  return listPrompts();
}

export function moveToFront(id) {
  const target = getPrompt(id);
  if (!target) return null;
  reclaimPending(target);
  const row = db.prepare(`SELECT MIN(position) AS m FROM work_prompts WHERE deleted_at IS NULL AND status='queued' AND space=?`).get(target.space);
  db.prepare(`UPDATE work_prompts SET position=?, status='queued', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status IN ('queued','paused')`)
    .run((row?.m ?? 1) - 1, id);
  broadcast();
  return getPrompt(id);
}

export function getQueuePauseState() {
  const s = getSettings();
  return { paused: !!s.queuePaused, paused_at: s.queuePausedAt || null, reason: s.queuePausedReason || null };
}

export function pauseQueue({ reason = null } = {}) {
  const state = setQueuePaused(true, { reason });
  // Actually stop what's running, not just block new starts — otherwise a task already
  // in flight (up to 30 min) keeps going and "Pause queue" looks like it did nothing.
  for (const row of db.prepare(`${SELECT()} AND status='running'`).all()) {
    reclaimRunning(row);
  }
  broadcast();
  return { paused: state.paused, paused_at: state.pausedAt, reason: state.reason };
}

export function resumeQueue() {
  setQueuePaused(false);
  broadcast();
  const out = advanceQueue();
  return { ...getQueuePauseState(), started: out.started ? out.started.prompt : null, startedCount: out.startedCount };
}

export function advanceQueue() {
  for (const running of db.prepare(`${SELECT()} AND status='running' ORDER BY started_at`).all()) {
    const task = running.agent_task_id ? findAgentTask(running.agent_task_id) : null;
    if (!task) {
      finishPrompt(running.id, { status: 'blocked', agent_result: '(task not found — execution lost)', user_summary: null, session_id: null });
    } else if (task.stop_requested) {
      // Being (or about to be) handled by onAgentTaskFinalized's stop_requested branch —
      // don't race it by recording this deliberate stop as a 'blocked' failure here.
    } else if (['done', 'blocked', 'cancelled'].includes(task.status)) {
      finishPrompt(running.id, task);
    }
  }

  if (isQueuePaused()) return { started: null, startedCount: 0, reason: 'queue-paused' };
  if (!getSettings().enabled) return { started: null, startedCount: 0, reason: 'agent-disabled' };

  const runningRows = db.prepare(`${SELECT()} AND status='running'`).all();
  const runningQuestions = runningRows.filter((r) => r.mode === 'question').length;
  const started = [];

  const agents = new Map(listAgents().map((a) => [a.key, a]));
  const runningImpl = runningRows.filter((r) => r.mode !== 'question');
  const runningByAgent = new Map();
  for (const r of runningImpl) {
    const k = r.agent_key || 'dev1';
    runningByAgent.set(k, (runningByAgent.get(k) || 0) + 1);
  }

  const slots = getMaxParallelQuestions() - runningQuestions;
  if (slots > 0) {
    const questions = db.prepare(`${SELECT()} AND status='queued' AND mode='question' AND same_context=0 AND plan_pending=0 AND (resume_after IS NULL OR resume_after <= strftime('%Y-%m-%dT%H:%M:%fZ','now')) ORDER BY position, created_at LIMIT ?`).all(slots);
    for (const q of questions) {
      const agentKey = q.agent_key || pickAgentFor(q, runningByAgent) || 'dev1';
      started.push(startPrompt(q, { agentKey }));
    }
  }

  // Writer lane, per agent (plan 2b): instead of the old single-implement gate,
  // start every queued implement prompt whose agent has a free slot and whose
  // start keeps the global MAX_CONCURRENT_WRITERS cap intact. This is the prompt
  // level of the same guard taskRunner's kick() applies at the task level — two
  // agents can genuinely run in parallel; a paused/disabled agent's prompts wait.
  //
  // Inspiration gate (plan inspiration-before-planning): an implement task only
  // starts once its world-look pass finished — 'ready' (ideas waiting for picks),
  // 'applied' (picks baked in) or 'skipped' (Antoine explicitly chose a plain
  // plan). 'off' (pre-feature rows), 'pending' and 'failed' all hold it — the
  // pass completes and this function is re-kicked from startInspiration. Question
  // rows are exempt (the pass never runs for them). A task with an unanswered
  // question (a quick-check question, or any question that outlived a state
  // change) is held too — it waits for the owner, never starts on its own.
  const queuedImpl = db.prepare(`${SELECT()} AND status='queued' AND space='fmcns' AND (mode!='question' OR same_context=1) AND plan_pending=0 AND pending_question IS NULL AND (mode='question' OR COALESCE(inspire_state,'off') NOT IN ('off','pending','failed')) AND (resume_after IS NULL OR resume_after <= strftime('%Y-%m-%dT%H:%M:%fZ','now')) ORDER BY position, created_at`).all();
  for (const next of queuedImpl) {
    if (runningImpl.length + started.length >= MAX_CONCURRENT_WRITERS) break;
    // Auto-assign (plan "auto devs"): no agent picked → least-loaded enabled
    // dev; chained tasks prefer their parent's dev so session resumption
    // keeps working. All devs busy → the prompt stays queued and the next
    // dispatch retries.
    let agentKey = next.agent_key;
    if (!agentKey) {
      agentKey = pickAgentFor(next, runningByAgent);
      if (!agentKey) continue;
    }
    const agent = agents.get(agentKey);
    if (agent && (!agent.enabled || agent.paused)) continue;
    const agentCap = agent ? Math.max(1, Math.min(4, agent.max_parallel || 1)) : 1;
    if ((runningByAgent.get(agentKey) || 0) >= agentCap) continue;
    started.push(startPrompt(next, { agentKey }));
    runningImpl.push(next);
    runningByAgent.set(agentKey, (runningByAgent.get(agentKey) || 0) + 1);
  }

  if (!started.length) {
    const anyQueued = db.prepare(`SELECT 1 FROM work_prompts WHERE deleted_at IS NULL AND status='queued' LIMIT 1`).get();
    return { started: null, startedCount: 0, reason: anyQueued ? 'busy' : 'empty' };
  }
  return { started: started[0], startedCount: started.length, reason: null };
}

// Continuation context (plan 2d): instead of inferring "the previous row in this
// space" positionally (which under parallelism is somebody else's task), the row
// carries an explicit parent_prompt_id. Resuming is only allowed when the parent
// matches on BOTH the agent and the provider (the two CLIs cannot resume each
// other's sessions). Parent missing or mismatched → fresh session, with a note
// posted in the thread — NEVER a positional fallback. Also returns the parent's
// worktree + branch (from its last agent task) so a continuation lands on the
// same branch as the work it continues.
function sessionOfParent(row) {
  if (!row.parent_prompt_id) return null;
  const parent = getPrompt(row.parent_prompt_id);
  if (!parent) {
    return { sessionId: null, note: 'The task this item was chained onto is gone — starting a fresh session.' };
  }
  if (String(parent.agent_key || 'dev1') !== String(row.agent_key || 'dev1')) {
    return { sessionId: null, note: `Cannot continue the session of "${parent.title}" — it belongs to another agent. Starting a fresh session.` };
  }
  if ((parent.provider || 'opencode') !== (row.provider || 'opencode')) {
    return { sessionId: null, note: `Cannot continue the session of "${parent.title}" — it ran on another provider. Starting a fresh session.` };
  }
  const sessionId = (row.provider === 'opencode' ? parent.opencode_session_id : parent.session_id) || null;
  const lastTask = db.prepare(`SELECT worktree_path, branch FROM agent_tasks WHERE work_prompt_id=? ORDER BY created_at DESC LIMIT 1`).get(parent.id);
  return {
    sessionId,
    worktreePath: lastTask?.worktree_path || null,
    branch: lastTask?.branch || null,
  };
}

function startPrompt(row, { forceFresh = false, agentKey = null } = {}) {
  const { model, effort } = usesModelPicker(row.provider) ? { model: row.provider_model, effort: null } : presetFor(effectivePreset(row));
  const useAgentKey = agentKey || row.agent_key || 'dev1';
  let resume = null;
  let worktreePath = null;
  let branch = null;
  if (!forceFresh && row.parent_prompt_id) {
    const ctx = sessionOfParent(row);
    if (ctx) {
      resume = ctx.sessionId;
      worktreePath = ctx.worktreePath;
      branch = ctx.branch;
      if (ctx.note) addMessage(row.id, { role: 'agent', text: ctx.note });
    }
  }
  const task = enqueueAgentTask({
    title: row.title, description: row.prompt, kind: 'queue', mode: row.mode, model, effort,
    author: 'work queue', work_prompt_id: row.id, resume_session_id: resume,
    provider: row.provider || 'opencode', provider_model: usesModelPicker(row.provider) ? model : null,
    agent_key: useAgentKey,
    worktree_path: worktreePath, branch,
  });
  db.prepare(`
    UPDATE work_prompts SET status='running', agent_task_id=?, agent_key=COALESCE(agent_key, ?),
      started_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), pending_question=NULL,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?
  `).run(task.id, useAgentKey, row.id);
  broadcast();
  return { prompt: getPrompt(row.id), task };
}

function finishPrompt(id, task) {
  const status = task.status === 'done' ? 'done' : 'blocked';
  const q = task.pending_question && task.pending_question.question ? JSON.stringify(task.pending_question) : null;
  const isOpen = (task.provider || 'opencode') === 'opencode';
  const sessionCol = isOpen ? 'opencode_session_id' : 'session_id';
  db.prepare(`
    UPDATE work_prompts SET status=?, ${sessionCol}=COALESCE(?, ${sessionCol}), pending_question=?,
      cost_usd=COALESCE(?, cost_usd), tokens_in=COALESCE(?, tokens_in), tokens_out=COALESCE(?, tokens_out),
      run_model=COALESCE(?, run_model),
      completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=?
  `).run(status, task.session_id || null, q, task.cost_usd ?? null, task.tokens_in ?? null, task.tokens_out ?? null, task.run_model || null, id);
  broadcast();
  eagerSummarize(id); // purpose bullets ready by the time the finished task is opened
  const done = getPrompt(id);
  // Self-updating tree: a finished implement task may have built something
  // significant — classify its worktree diff in the background (fire-and-forget,
  // never throws, never blocks task completion or the queue). Worktree-less runs
  // and tweaks are cheap no-ops inside syncFromTask; merged work is also caught
  // later by the git-history watcher.
  if (done.status === 'done' && done.mode === 'implement') {
    syncFromTask(db, id).catch(() => {});
  }
  return done;
}

// ─── Conversation thread ───────────────────────────────────────────────────────
export function listMessages(promptId) {
  return db.prepare(`
    SELECT m.*, u.name AS author_name FROM work_prompt_messages m
    LEFT JOIN users u ON u.id = m.author
    WHERE m.prompt_id=? ORDER BY m.created_at
  `).all(promptId);
}

function addMessage(promptId, { role, text, agentTaskId = null, author = null }) {
  const clean = String(text || '').trim();
  if (!clean) return null;
  const id = randomUUID();
  db.prepare(`INSERT INTO work_prompt_messages (id, prompt_id, role, text, agent_task_id, author) VALUES (?,?,?,?,?,?)`)
    .run(id, promptId, role, clean, agentTaskId, author);
  broadcast();
  return db.prepare('SELECT * FROM work_prompt_messages WHERE id=?').get(id);
}

// Credit control, threshold #1: when resuming a CLI session (resume_session_id
// set), the CLI already has the full transcript on its side — re-sending the whole
// thread as prompt text on top of that was pure duplication, and its cost grew
// with every single reply (reply #10 resent 9 replies' worth of thread, every
// time). Once resuming, only the tail (what the CLI does NOT already have: this
// latest human message, or a fresh session's recap) needs to go in the prompt.
const FOLLOWUP_TAIL = 2; // last human message + the agent turn just before it, for footing
// Credit control, threshold #2: even with the thread text capped, the CLI's OWN
// internal context still grows by one full exchange on every --resume, and that
// growth compounds the same way a long chat session's would. Past this many
// continuations on one session, force a brand-new session instead of another
// --resume — carrying forward only a short recap, not the accumulated transcript.
// Tier-aware: the same number of turns costs far more on a deep (opus) thread than a
// fast (haiku) one, so deep resets sooner and fast can run longer before resetting.
export const CONTEXT_RESET_THRESHOLD = 6;
const CONTEXT_RESET_BY_TIER = { fast: 8, standard: 6, deep: 4 };
export function contextResetThresholdFor(row) {
  return CONTEXT_RESET_BY_TIER[effectivePreset(row)] ?? CONTEXT_RESET_THRESHOLD;
}

// ─── Context budget (plan "context budget") ───────────────────────────────────
// Memory-aware credit control on top of the turn-count reset: the last run's
// input tokens INCLUDE the accumulated session history (the CLI resends the
// growing transcript on every --resume), so tokens_in IS the live session size.
// Past BUDGET_FRACTION of the model's context window, the next follow-up starts
// fresh instead of resuming — before per-turn input costs balloon near the
// window edge. The turn-count rule stays as an upper bound for models whose
// token reporting is missing.
const CONTEXT_BUDGET_FRACTION = 0.75;

function modelWindowFor(row) {
  return modelContextWindow(row.run_model || row.provider_model || '');
}

// Real session size: last run's input tokens (CLI-reported) when present, else
// a text-length estimate of the stored thread, else 0.
export function sessionSizeTokens(row) {
  const last = row.agent_task_id ? findAgentTask(row.agent_task_id) : null;
  const n = last?.tokens_in ?? row.tokens_in ?? null;
  if (Number.isFinite(n) && n > 0) return n;
  const text = listMessages(row.id).map((m) => m.text || '').join(' ');
  return Math.round(text.length / 4);
}

export function overContextBudget(row) {
  return sessionSizeTokens(row) >= CONTEXT_BUDGET_FRACTION * modelWindowFor(row);
}

// Cheap variant for list views (no per-row task/message queries): tokens_in is
// written back to the prompt row on every finish, so it needs no joins.
export function contextPct(row) {
  const n = Number(row.tokens_in) || 0;
  if (n <= 0) return null;
  return Math.min(999, Math.round((n / modelWindowFor(row)) * 100));
}

function clip(text, max) {
  const t = String(text || '').trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

export function buildFollowUpPrompt(row, messages, { fresh = false } = {}) {
  if (!fresh) {
    // Resuming — the CLI already has everything before this tail.
    const tail = messages.slice(-FOLLOWUP_TAIL);
    const thread = tail.map((m) => `${m.role === 'user' ? 'Human' : 'You'}: ${m.text}`).join('\n\n');
    return [
      'Continuing a conversation on a work-queue task (your session already has the full history — this is just the latest exchange, not a summary):\n\n',
      `${thread}\n\n`,
      '=== DO NOW ===\n',
      'Respond to the LAST human message and continue the task accordingly. ',
      'If you still need information, say precisely what — do not guess.',
    ].join('');
  }
  // Fresh session — no CLI memory at all. Instead of re-dumping the raw thread
  // (the old behavior: the "cheap" reset immediately re-paid the whole history),
  // hand over a compact digest: original request + purpose + last milestone +
  // the latest exchange. Cheaper first turn, dev still lands with footing.
  const tail = messages.slice(-FOLLOWUP_TAIL);
  const prior = messages.slice(0, -FOLLOWUP_TAIL);
  const lastAgent = [...prior].reverse().find((m) => m.role === 'agent');
  return [
    'Continuing a work-queue task in a NEW session (memory budget reached — the previous session is gone; this digest is all you get).\n\n',
    `=== TASK ===\n${clip(row.title, 120)}\n\n`,
    `=== ORIGINAL REQUEST ===\n${clip(row.raw_prompt || row.prompt, 800)}\n\n`,
    row.summary ? `=== PURPOSE ===\n${clip(row.summary, 600)}\n\n` : '',
    lastAgent ? `=== LAST MILESTONE ===\n${clip(lastAgent.text, 900)}\n\n` : '',
    `=== LATEST EXCHANGE ===\n${tail.map((m) => `${m.role === 'user' ? 'Human' : 'You'}: ${clip(m.text, 600)}`).join('\n\n')}\n\n`,
    '=== DO NOW ===\n',
    'Respond to the LAST human message and continue the task accordingly. ',
    'If you still need information, say precisely what — do not guess.',
  ].join('');
}

export async function replyToPrompt(id, { text, userId = null, placement = 'front' }) {
  const row = getPrompt(id);
  if (!row) return null;
  if (row.status === 'running') return { error: 'running' };
  const clean = String(text || '').trim();
  if (!clean) return { error: 'empty' };
  // A quick-check question on a task that has not started is answered before
  // anything runs: the answer shapes the world-look, then the plan is drafted
  // (or re-drafted) — no agent launch. Agent questions (kind absent) keep the
  // classic relaunch path.
  if (row.pending_question && isReviewQuestion(row) && !row.started_at && ['queued', 'paused'].includes(row.status)) {
    return answerInspireQuestion(row, clean, userId);
  }
  addMessage(id, { role: 'user', text: clean, author: userId });
  if (placement === 'back') return requeueToBack(row);
  return relaunchWithThread(row);
}

// Save the answer without relaunching this instant — the task goes back to the
// ordinary scheduler and resumes on its normal turn. Reuses the same
// append-to-back semantics createPrompt already uses (nextPosition), not a new
// ordering concept (this app has no wait_rank/lane column).
function requeueToBack(row) {
  db.prepare(`
    UPDATE work_prompts SET status='queued', position=?, pending_question=NULL,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?
  `).run(nextPosition(row.space), row.id);
  broadcast();
  advanceQueue(); // starts right away if nothing else is ahead, otherwise waits its turn
  return { prompt: getPrompt(row.id), task: null };
}

/**
 * The owner answered a quick-check question about the world-look. Their answer
 * goes to the thread, the question is cleared, and the review is re-run once
 * with the answer as the decision (never asking again). Two exits:
 *   • plan still drafting → the parked runPlanDraft wakes and drafts with the
 *     answer as its note (single drafting owner);
 *   • plan already drafted (the world-look landed after the draft timeout) →
 *     re-draft here, exactly like applyInspiration, with the answer as the note.
 */
async function answerInspireQuestion(row, text, userId) {
  const report = row.inspire_report_id ? getReport(db, row.inspire_report_id) : null;
  addMessage(row.id, { role: 'user', text, author: userId });

  const prev = parseInspireReview(row) || report?.review || null;
  const reviewed = report
    ? await reviewInspiration({ report, prompt: row.raw_prompt || row.prompt, answer: text, allowQuestion: false })
    : null;
  const review = { ...(reviewed || prev || {}), owner_note: text };

  db.prepare(`
    UPDATE work_prompts SET pending_question=NULL, inspire_review_json=?,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?
  `).run(JSON.stringify(review), row.id);
  if (report && reviewed) storeReportReview(db, report.id, reviewed); // canonical home on the report
  settleInspireWaiter(row.id);
  broadcast();

  const fresh = getPrompt(row.id);
  if (!fresh) return null;
  if (fresh.plan_pending) return { prompt: fresh, task: null }; // runPlanDraft drafts

  // The caller's own plan stays untouched (plan_source:'skip' — e.g. a
  // conversation handoff): the answer only settles the world-look, and the
  // queue gate releases the task as it now has no open question.
  if (fresh.plan_source === 'skip') {
    advanceQueue();
    return { prompt: getPrompt(row.id), task: null };
  }

  const digest = inspirationDigestFor(report, parseInspirePicks(fresh), review);
  const draft = await draftPlan({ title: fresh.title, prompt: fresh.raw_prompt || fresh.prompt, mode: fresh.mode, inspiration: digest, ownerNote: text });
  if (draft) {
    db.prepare(`
      UPDATE work_prompts SET title=?, prompt=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?
    `).run(draft.title, draft.brief, row.id);
  }
  broadcast();
  if (fresh.status === 'queued') advanceQueue();
  return { prompt: getPrompt(row.id), task: null };
}

// Deliberate, user-triggered version of the same reset the threshold does
// automatically — lets a long thread be cut short "whenever you feel like it"
// rather than waiting for the counter, without losing the visible conversation
// (thread messages are untouched; only the CLI session link + counter reset).
export function clearContext(id) {
  const row = getPrompt(id);
  if (!row) return null;
  db.prepare(`UPDATE work_prompts SET session_id=NULL, opencode_session_id=NULL, context_turns=0, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(id);
  return getPrompt(id);
}

function relaunchWithThread(row) {
  const messages = listMessages(row.id);
  const isOpen = row.provider === 'opencode';
  const { model, effort } = usesModelPicker(row.provider) ? { model: row.provider_model, effort: null } : presetFor(effectivePreset(row));
  const overThreshold = (row.context_turns || 0) >= contextResetThresholdFor(row);
  const overBudget = overContextBudget(row);
  const activeSession = isOpen ? row.opencode_session_id : row.session_id;
  const fresh = !activeSession || overThreshold || overBudget;
  // Follow-ups stay on the dev that ran the original (persisted at dispatch);
  // legacy rows without one get the least-loaded dev.
  const runningByAgent = new Map();
  for (const r of db.prepare(`SELECT agent_key FROM work_prompts WHERE deleted_at IS NULL AND status='running'`).all()) {
    const k = r.agent_key || 'dev1';
    runningByAgent.set(k, (runningByAgent.get(k) || 0) + 1);
  }
  const useAgentKey = row.agent_key || pickAgentFor(row, runningByAgent) || 'dev1';
  const task = enqueueAgentTask({
    title: row.title, description: buildFollowUpPrompt(row, messages, { fresh }), kind: 'queue', mode: row.mode, model, effort,
    author: 'work queue (follow-up)', work_prompt_id: row.id, resume_session_id: fresh ? null : activeSession,
    provider: row.provider || 'opencode', provider_model: usesModelPicker(row.provider) ? model : null,
    agent_key: useAgentKey,
  });
  const nextTurns = fresh ? 0 : (row.context_turns || 0) + 1;
  db.prepare(`
    UPDATE work_prompts SET status='running', agent_task_id=?, agent_key=COALESCE(agent_key, ?),
      started_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      completed_at=NULL, pending_question=NULL, context_turns=?,
      session_id=CASE WHEN ? THEN NULL ELSE session_id END,
      opencode_session_id=CASE WHEN ? THEN NULL ELSE opencode_session_id END,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?
  `).run(task.id, useAgentKey, nextTurns, fresh ? 1 : 0, fresh ? 1 : 0, row.id);
  broadcast();
  return { prompt: getPrompt(row.id), task };
}

export function steerPrompt(id, { text, userId = null }) {
  const row = getPrompt(id);
  if (!row) return null;
  const clean = String(text || '').trim();
  if (!clean) return { error: 'empty' };
  if (row.status !== 'running' || !row.agent_task_id) return { error: 'not-running' };
  const task = findAgentTask(row.agent_task_id);
  if (!task) return { error: 'not-running' };

  if (task.status === 'in_progress' && sendSteeringMessage(row.agent_task_id, clean)) {
    addMessage(id, { role: 'user', text: clean, author: userId, agentTaskId: row.agent_task_id });
    return { prompt: getPrompt(id), delivered: 'live' };
  }
  if (task.status === 'approved') {
    const marked = `${task.description}\n\n=== USER MESSAGE (added while waiting) ===\n${clean}`;
    if (updatePendingAgentTask(row.agent_task_id, { description: marked })) {
      addMessage(id, { role: 'user', text: clean, author: userId, agentTaskId: row.agent_task_id });
      return { prompt: getPrompt(id), delivered: 'queued' };
    }
    if (sendSteeringMessage(row.agent_task_id, clean)) {
      addMessage(id, { role: 'user', text: clean, author: userId, agentTaskId: row.agent_task_id });
      return { prompt: getPrompt(id), delivered: 'live' };
    }
  }
  return { error: 'not-running' };
}

export async function resolveReply(task) {
  let summary = (task.user_summary || '').trim();
  if (!summary) {
    try { await generateUserSummary(task.id); } catch {}
    summary = (findAgentTask(task.id)?.user_summary || '').trim();
  }
  if (summary) return summary;
  const report = (task.agent_result || '').trim();
  const clean = report && report !== '(finished without a report)' ? report : '';
  if (clean) {
    const excerpt = clean.length > 2500 ? `…${clean.slice(-2500)}` : clean;
    const head = task.status === 'done' ? 'Plain-language summary unavailable — raw technical report:' : 'Execution interrupted, no summary — raw technical report:';
    return `${head}\n\n${excerpt}`;
  }
  return task.status === 'done'
    ? 'Done, but the agent produced no usable report. Re-run if the result is not visible.'
    : 'Execution interrupted before producing any output (timeout, killed, or restart). Re-run.';
}

export async function onAgentTaskFinalized(task) {
  if (!task || task.kind !== 'queue' || !task.work_prompt_id) return;
  const row = getPrompt(task.work_prompt_id);
  if (!row) return;

  // Deliberately interrupted via Pause queue (taskRunner.stopTask) — put it back in
  // line rather than recording a manual stop as if the model had failed.
  if (task.stop_requested) {
    db.prepare(`
      UPDATE work_prompts SET status='queued', agent_task_id=NULL, started_at=NULL, completed_at=NULL,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?
    `).run(row.id);
    broadcast();
    return;
  }

  const producedNothing = !(task.agent_result || '').trim() && !(task.user_summary || '').trim();
  if (task.resume_session_id && task.status !== 'done' && producedNothing && !_resumeRetried.has(row.id)) {
    _resumeRetried.add(row.id);
    startPrompt(row, { forceFresh: true });
    return;
  }

  let reply = await resolveReply(task);
  if (task.pending_question?.question) reply += `\n\n❓ ${task.pending_question.question}`;
  addMessage(row.id, { role: 'agent', text: reply, agentTaskId: task.id });

  const finished = finishPrompt(row.id, task);

  // OOM-killed runs (exit 137 — the container's memory allowance was exhausted)
  // retry themselves once. The run produced nothing; the honest answer is a
  // clear message and a fresh attempt after the container has had a couple of
  // minutes to shed memory. The task's own memory guard (taskRunner.memoryBlocked)
  // then only lets the retry dispatch once headroom is back. A second OOM ends
  // the loop: the prompt stays blocked with the honest report, no infinite
  // retry storm. _oomRetried is in-memory — a server restart allows one extra
  // retry, which is harmless and usually desirable after a crash.
  if (finished.status === 'blocked' && String(task.agent_result || '').includes(OOM_KILL_MARKER) && !_oomRetried.has(row.id)) {
    _oomRetried.add(row.id);
    const resumeAt = new Date(Date.now() + OOM_RETRY_DELAY_MS).toISOString();
    db.prepare(`
      UPDATE work_prompts SET status='queued', agent_task_id=NULL, started_at=NULL, completed_at=NULL,
        resume_after=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?
    `).run(resumeAt, row.id);
    addMessage(row.id, {
      role: 'agent',
      text: 'The server ran out of memory and the system stopped this task before it could finish. It will retry itself automatically in a couple of minutes — nothing to do on your side.',
      agentTaskId: task.id,
    });
    broadcast();
    return;
  }

  // Step 5: an implement task that finished done on a branch enters the review
  // gate — five deterministic checks run in its worktree; the human then merges
  // (or reverts) from the queue UI. Fire-and-forget: the checks are slow (they
  // boot a throwaway server) and must never block the queue loop.
  if (finished.status === 'done' && task.mode !== 'question' && task.branch) {
    import('./reviewRunner.js')
      .then((m) => m.createReviewForTask(task))
      .catch((e) => console.error('queue: review creation failed —', e.message));
  }

  // Reliability valve for the auto policy: a blocked auto-resolved task probably ran
  // out of depth, not luck — bump the remembered tier so the next "Run again" retries
  // stronger instead of repeating the same (apparently insufficient) tier.
  if (finished.status === 'blocked' && finished.preset === 'auto' && finished.resolved_preset) {
    const next = escalate(finished.resolved_preset);
    if (next !== finished.resolved_preset) {
      db.prepare(`UPDATE work_prompts SET resolved_preset=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(next, row.id);
      broadcast();
    }
  }

  const stopHere = !!finished.stop_after;
  if (stopHere) {
    db.prepare(`UPDATE work_prompts SET stop_after=0, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(row.id);
    pauseQueue({ reason: `Stop requested after "${finished.title}"` });
  }

  if (!stopHere && String(task.missed_user_message || '').trim()) {
    relaunchWithThread(finished);
    return;
  }

  try { await sendRecap(finished, task, { stopped: stopHere }); } catch (e) { console.error('queue: recap failed —', e.message); }
  advanceQueue();
}

export function onAgentTaskDeferred(task, { label = '', resumeAfter = null } = {}) {
  if (!task || task.kind !== 'queue' || !task.work_prompt_id) return;
  const row = getPrompt(task.work_prompt_id);
  if (!row) return;
  db.prepare(`
    UPDATE work_prompts SET status='queued', started_at=NULL, agent_task_id=NULL, completed_at=NULL,
      resume_after=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?
  `).run(resumeAfter, row.id);
  if (usesModelPicker(task.provider || 'opencode')) {
    // OpenCode / AI Router have no subscription quota to "wait out" — the fix is
    // picking another model, so the thread note says exactly that instead of a
    // vague usage hint.
    const label = task.provider === 'ai-router' ? 'AI Router model' : 'OpenCode model';
    addMessage(row.id, {
      role: 'agent',
      text: `Hit the usage limit on ${task.run_model || task.provider_model || `the selected ${label}`}. Pick another model in the task panel (free models are listed first), then resume the queue.`,
      agentTaskId: task.id,
    });
  }
  broadcast();
  notifyLimitOnce(label);
}

let _limitNotified = '';
async function notifyLimitOnce(label) {
  if (_limitNotified === label) return;
  _limitNotified = label;
  if (!NOTIFY_WEBHOOK_URL) return;
  const text = `Queue paused — ${label ? `usage limit reached, resuming at ${label}` : 'usage limit reached, waiting for a slot'}.`;
  try { await fetch(NOTIFY_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }); }
  catch (e) { console.error('queue: quota notice not sent —', e.message); }
}

// ─── One-line recap notification ───────────────────────────────────────────────
export function buildRecapMessage(prompt, task, { stopped = false } = {}) {
  const ok = prompt.status === 'done';
  const asking = !!task?.pending_question?.question;
  const head = asking
    ? `Question to answer — ${prompt.title}`
    : `${ok ? 'Task done' : 'Task blocked'} — ${prompt.title}`;
  const link = APP_URL ? ` · ${APP_URL}` : '';
  const pause = stopped ? ' · queue paused' : '';
  return `${head}${link}${pause}`;
}

async function sendRecap(prompt, task, { stopped = false } = {}) {
  const text = buildRecapMessage(prompt, task, { stopped });
  if (!NOTIFY_WEBHOOK_URL) {
    console.log(`[recap] ${text}`);
    return;
  }
  const resp = await fetch(NOTIFY_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  if (!resp.ok) throw new Error(`webhook HTTP ${resp.status}`);
}

export function initPromptQueue() {
  const timer = setTimeout(() => {
    try { advanceQueue(); } catch (e) { console.error('queue: startup advance failed —', e.message); }
  }, 3000);
  timer.unref?.();
}
