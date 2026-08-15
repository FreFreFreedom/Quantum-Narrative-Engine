// Idea Studio conversations (plan "universal-conversations-core-architecture").
// One conversation per subject (seed / suggestion / arch component / tech-tree
// node), stored in convos + convo_messages. Each turn calls the model fresh with
// the windowed history + the subject context — never a persistent session.
//
// Cost controls: nothing bills until you type; chat turns use a cheap model by
// default, the plan turn a stronger one; history is windowed and older turns are
// folded into a recap. Commands (/grill-me, /plan, /handoff, /help) are handled
// here, before anything hits the model. Tools are read-only — the advisor can say
// "this already exists" but never edits anything.

import { randomUUID } from 'node:crypto';
import { broadcastAll } from '../realtime.js';
import { runToolLoop } from './anthropicLoop.js';
import {
  registerSubject, subjectSpec, buildSubjectContext,
} from './subjectContext.js';
import { generateText } from './ai/text.js';
import { getComponents } from './architecture.js';
import { listSuggestions } from './workSuggestions.js';
import { listIdeas, getIdea } from './workIdeas.js';

// keep SubjectContext's module-level registrations loaded (imported above)
import './subjectContext.js';

let db = null;
export function bindConversationsDb(database) { db = database; }

const CONVO_HISTORY_WINDOW = 16;
const CONVO_CHAT_MODEL = process.env.CONVO_CHAT_MODEL || 'claude-sonnet-4-5';
const CONVO_PLAN_MODEL = process.env.CONVO_PLAN_MODEL || 'claude-sonnet-4-5';

// ─── Read paths ──────────────────────────────────────────────────────────────

export function getConvo(id) {
  if (!db) return null;
  return db.prepare(`SELECT * FROM convos WHERE id=? AND deleted_at IS NULL`).get(id) || null;
}

export function findConvo(subjectType, subjectId) {
  if (!db) return null;
  return db.prepare(`SELECT * FROM convos WHERE subject_type=? AND subject_id=? AND deleted_at IS NULL`).get(subjectType, subjectId) || null;
}

export function listMessages(convoId) {
  if (!db) return [];
  return db.prepare(`SELECT * FROM convo_messages WHERE convo_id=? ORDER BY created_at ASC, rowid ASC`).all(convoId);
}

export function listConvosForSubjects(subjectType, ids) {
  if (!db || !ids.length) return {};
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM convos WHERE subject_type=? AND subject_id IN (${placeholders}) AND deleted_at IS NULL`).all(subjectType, ...ids);
  return Object.fromEntries(rows.map((r) => [r.subject_id, r]));
}

// ─── Write paths ─────────────────────────────────────────────────────────────

export function getOrCreateConvo({ subjectType, subjectId, subjectHint = null, createdBy = 'antoine' }) {
  const spec = subjectSpec(subjectType);
  if (!spec) return { error: 'unknown_subject_type' };

  const existing = findConvo(subjectType, subjectId);
  if (existing) return { convo: existing, created: false };

  const id = randomUUID();
  const title = spec.title?.(db, subjectId, subjectHint) || subjectId;
  db.prepare(`INSERT INTO convos (id, subject_type, subject_id, title, subject_hint, created_by) VALUES (?,?,?,?,?,?)`)
    .run(id, subjectType, subjectId, title, subjectHint || null, createdBy);
  broadcastAll('convos:updated', { convoId: id, subjectType, subjectId });
  return { convo: getConvo(id), created: true };
}

export function resetConvoContext(id) {
  if (!db) return { error: 'no_db' };
  const convo = getConvo(id);
  if (!convo) return { error: 'not_found' };
  // fold everything into a short recap row and clear the message history
  const msgs = listMessages(id);
  const recap = msgs.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${String(m.text).slice(0, 300)}`).join('\n');
  db.prepare(`UPDATE convos SET recap=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(recap || null, id);
  db.prepare(`DELETE FROM convo_messages WHERE convo_id=?`).run(id);
  broadcastAll('convos:updated', { convoId: id });
  return { ok: true, recap };
}

export function deleteConvo(id) {
  if (!db) return { error: 'no_db' };
  const convo = getConvo(id);
  if (!convo) return { error: 'not_found' };
  db.prepare(`UPDATE convos SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(id);
  broadcastAll('convos:updated', { convoId: id });
  return { ok: true };
}

export function latestConvoPlan(id) {
  const convo = getConvo(id);
  if (!convo) return { error: 'not_exist' };
  const planMsg = listMessages(id).filter((m) => m.kind === 'plan').pop();
  if (!planMsg) return { error: 'no_plan', message: 'no plan in this conversation yet' };
  const raw = planMsg.text || '';
  const titleMatch = raw.match(/^TITLE:\s*(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : (convo.title || 'Work');
  const brief = raw.replace(/^TITLE:\s*.+\n?/i, '').replace(/^BRIEF:\s*/i, '').trim();
  return { title, brief, text: raw, planId: planMsg.id };
}

// ─── Read-only tools the advisor can call ────────────────────────────────────

function toolSpecs() {
  return [
    {
      name: 'list_architecture',
      description: 'List all architecture components with their current status and one-line current state.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'list_queue_items',
      description: 'List Dispatch Queue items (optional status filter: queued/running/done/paused/blocked/cancelled, optional limit).',
      input_schema: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          limit: { type: 'integer' },
        },
      },
    },
    {
      name: 'list_subject_info',
      description: 'Fetch a specific subject row: seed -> { title, notes }, suggestion -> { title, rationale, area }, arch_component -> { name, status }, arch_node -> { name, what, why }.',
      input_schema: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          id: { type: 'string' },
        },
        required: ['type', 'id'],
      },
    },
    {
      name: 'project_stats',
      description: 'Project-wide statistics: entity counts, clusters, queued vs done tasks.',
      input_schema: { type: 'object', properties: {} },
    },
  ];
}

function dispatchByName(name, input) {
  switch (name) {
    case 'list_architecture': return getComponents(db).map((c) => ({ id: c.id, name: c.name, status: c.status })).slice(0, 200);
    case 'list_queue_items': {
      const { status, limit = 40 } = input || {};
      const rows = db.prepare(`SELECT id, title, status, mode FROM work_prompts WHERE (:status IS NULL OR status = :status) AND deleted_at IS NULL ORDER BY created_at DESC LIMIT :limit`)
        .all({ status: status || null, limit });
      return rows;
    }
    case 'list_subject_info': {
      const { type, id } = input || {};
      if (type === 'seed') return getIdea(id) || { error: 'not_found' };
      if (type === 'suggestion') return listSuggestions({}).find((s) => s.id === id) || { error: 'not_found' };
      if (type === 'arch_component') return (getComponents(db).find((c) => c.id === id) || { error: 'not_found' });
      if (type === 'arch_node') return db?.prepare(`SELECT * FROM architecture_nodes WHERE id=?`).get(id) || { error: 'not_found' };
      return { error: 'unknown_type' };
    }
    case 'project_stats': {
      const entities = db.prepare(`SELECT COUNT(*) AS n FROM entities`).get()?.n ?? 0;
      const clusters = db.prepare(`SELECT COUNT(DISTINCT cluster_id) AS n FROM entity_clusters`).get()?.n ?? 0;
      const queue = db.prepare(`SELECT COUNT(*) AS n FROM work_prompts WHERE deleted_at IS NULL`).get()?.n ?? 0;
      const done = db.prepare(`SELECT COUNT(*) AS n FROM work_prompts WHERE status='done' AND deleted_at IS NULL`).get()?.n ?? 0;
      return { entities, clusters, queue, done };
    }
    default: return { error: `unknown tool: ${name}` };
  }
}

// ─── System prompt builders ──────────────────────────────────────────────────

const BASE_SYSTEM = `You are the Idea Studio assistant inside FMCNS — you help turn raw ideas into a concrete plan for a coding agent, chatting about one subject at a time.

You can look things up in the live project using the tools (read-only — you can never edit anything here). Prefer answering from what the user already said plus what the tools tell you; if something already exists, say so rather than proposing to rebuild it.

Commands the user may type:
  /grill-me — switch to interrogation mode: ask the sharpest clarifying questions, one at a time, no answering yet.
  /plan     — produce the final plan for the coding agent (done by the system; you do not do this yourself).
  /handoff  — queue the plan as a task (done by the system).
  /compare  — compare the enrichment ideas attached to this subject (done by the system; you do not do this yourself).
  /help     — list these commands.

The subject being discussed is described in SUBJECT CONTEXT below. It is the whole reason this conversation exists — keep every answer anchored to it.

Be direct, plain-English, no jargon. Keep answers short unless the user asks for detail. Never mention internal component ids, codes or file names in your answers — say what the thing DOES for the user, in everyday words. The user is not a programmer.`;

function subjectSystemPrompt(ctxText) {
  return `${BASE_SYSTEM}

=== SUBJECT CONTEXT ===
${ctxText}`;
}

const PLAN_INSTRUCTION = `You are drafting an execution brief for a coding agent that has real file access to a codebase, based on the conversation below. Turn the discussed idea into a brief with zero ambiguity left in it.

Respond in exactly this format, nothing else:
TITLE: <one short line>
BRIEF:
<the brief>

The brief must:
- Restate the goal in one line.
- List concrete steps to do it.
- Name specific files or areas of the codebase likely involved, if inferable — do not invent files.
- State a clear, checkable definition of done.
- Note anything the request implies is out of scope.

Write for the coding agent, not for a human reader. Be concise.`;

function buildMessages(convo, msgs, windowSize) {
  const visible = msgs.slice(-windowSize).filter((m) => m.kind === 'chat');
  const pairs = [];
  if (convo.recap) pairs.push({ role: 'user', content: `(folded earlier context)\n${convo.recap}` });
  for (const m of visible) pairs.push({ role: m.role, content: m.text });
  return pairs;
}

// ─── Turn machinery ───────────────────────────────────────────────────────────

async function runChatTurn(convoId, userId) {
  const convo = getConvo(convoId);
  if (!convo) return { error: 'not_found' };
  const ctx = await buildSubjectContext(db, convo.subject_type, convo.subject_id, convo.subject_hint);
  if (ctx.error) return { error: ctx.error };

  const msgs = listMessages(convo.id);
  const system = subjectSystemPrompt(ctx.contextText);
  const messages = buildMessages(convo, msgs, CONVO_HISTORY_WINDOW);
  const tools = toolSpecs();

  const result = await runToolLoop({
    model: CONVO_CHAT_MODEL,
    system,
    messages,
    tools,
    dispatch: (name, input) => dispatchByName(name, input),
    maxTokens: 1200,
    maxRounds: 4,
    toolResultCap: 6000,
  });
  if (result.error) return result;

  const mid = randomUUID();
  db.prepare(`INSERT INTO convo_messages (id, convo_id, role, kind, text) VALUES (?,?,?,?,?)`)
    .run(mid, convoId, 'assistant', 'chat', result.text || '');
  db.prepare(`UPDATE convos SET turns=turns+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(convoId);
  broadcastAll('convos:updated', { convoId });
  return { text: result.text, via: result.via };
}

async function runPlanTurn(convoId, userId) {
  const convo = getConvo(convoId);
  if (!convo) return { error: 'not_found' };
  const ctx = await buildSubjectContext(db, convo.subject_type, convo.subject_id, convo.subject_hint);
  if (ctx.error) return { error: ctx.error };

  const msgs = listMessages(convoId);
  const chatText = msgs.filter((m) => m.kind === 'chat')
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
    .join('\n\n');
  const prompt = `${PLAN_INSTRUCTION}\n\n=== SUBJECT CONTEXT ===\n${ctx.contextText}\n\n=== CONVERSATION ===\n${chatText || '(no prior messages — plan from the subject alone)'}`;

  const result = await generateText({
    prompt,
    feature: 'plan_draft',
    label: 'conversations:plan',
    model: CONVO_PLAN_MODEL,
    maxTokens: 2200,
  });
  if (result.error) return result;

  const titleMatch = result.text.match(/^TITLE:\s*(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : (convo.title || 'Work');
  const brief = result.text.replace(/^TITLE:\s*.+\n?/i, '').replace(/^BRIEF:\s*/i, '').trim();

  const mid = randomUUID();
  db.prepare(`INSERT INTO convo_messages (id, convo_id, role, kind, text) VALUES (?,?,?,?,?)`)
    .run(mid, convoId, 'assistant', 'plan', result.text || '');
  db.prepare(`UPDATE convos SET turns=turns+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(convoId);
  broadcastAll('convos:updated', { convoId });
  return { title, brief, planId: mid, text: result.text, via: result.via };
}

// /compare — one condensed verdict over the enrichment ideas attached to the
// subject (world-look picks, generated next steps, or sibling suggestions).
// Nothing attached -> a free text answer, no model call at all.
async function runCompareTurn(convoId) {
  const convo = getConvo(convoId);
  if (!convo) return { error: 'not_found' };
  const ctx = await buildSubjectContext(db, convo.subject_type, convo.subject_id, convo.subject_hint);
  if (ctx.error) return { error: ctx.error };
  const collected = ctx.compare ? await ctx.compare() : { items: [], note: 'No enrichment ideas attached to this subject.' };
  const items = (collected.items || []).slice(0, 8);
  if (!items.length) {
    return { text: collected.note || 'Nothing attached to compare here yet.' };
  }
  const listing = items.map((it, i) => `${i + 1}. ${it.label}: ${it.text}`).join('\n');
  const prompt = `The owner asked to compare the ideas attached to the subject below.

=== SUBJECT ===
${ctx.contextText}

=== IDEAS ===
${listing}

Give a short comparison verdict: for each idea, one line on what it offers; then say which ONE you would pick and why (1-2 sentences). Plain English, no jargon, be concise.`;
  const result = await generateText({ prompt, feature: 'studio', label: 'conversations:compare', model: CONVO_CHAT_MODEL, maxTokens: 900 });
  if (result.error) return result;
  const mid = randomUUID();
  db.prepare(`INSERT INTO convo_messages (id, convo_id, role, kind, text) VALUES (?,?,?,?,?)`)
    .run(mid, convoId, 'assistant', 'chat', result.text || '');
  db.prepare(`UPDATE convos SET turns=turns+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(convoId);
  broadcastAll('convos:updated', { convoId });
  return { text: result.text, via: result.via };
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function sendMessage(convoId, { text, userId = 'antoine' } = {}) {
  if (!db) return { error: 'no_db' };
  const convo = getConvo(convoId);
  if (!convo) return { error: 'not_found' };
  const trimmed = String(text || '').trim();
  if (!trimmed) return { error: 'empty' };

  // Commands — handled before any model cost.
  const cmd = trimmed.match(/^\/([a-z-]+)/i);
  if (cmd) {
    const slash = cmd[1].toLowerCase();
    if (slash === 'plan') return requestPlan(convoId);
    if (slash === 'handoff') return handoffToQueue(convoId);
    if (slash === 'help') {
      return {
        text: 'Available commands:\n  /grill-me — I ask you sharp clarifying questions, one at a time.\n  /plan — turn this conversation into a coder brief (TITLE + BRIEF).\n  /handoff — queue the plan as a paused task in the Dispatch Queue (idempotent).\n  /compare — compare the ideas attached to this subject (world-look picks, generated next steps, or sibling suggestions).\n  /help — this list.\n\nOtherwise just type — I\'ll answer from the subject context + live project data.',
      };
    }
    if (slash === 'compare') return runCompareTurn(convoId);
    if (slash === 'grill-me') {
      // interrogation mode: a single turn where the model asks questions only
      const ctx = await buildSubjectContext(db, convo.subject_type, convo.subject_id, convo.subject_hint);
      if (ctx.error) return { error: ctx.error };
      const msgs = listMessages(convo.id);
      const system = `${subjectSystemPrompt(ctx.contextText)}\n\nYou are now in GRILL MODE. Ask the user the sharpest clarifying questions you can, ONE at a time, in order of importance. Do not propose solutions yet. End with a question mark. Keep the first question short.`;
      const result = await runToolLoop({
        model: CONVO_CHAT_MODEL,
        system,
        messages: buildMessages(convo, msgs, CONVO_HISTORY_WINDOW),
        tools: toolSpecs(),
        dispatch: (name, input) => dispatchByName(name, input),
        maxTokens: 600,
        maxRounds: 3,
        toolResultCap: 6000,
      });
      if (result.error) return result;
      const mid = randomUUID();
      db.prepare(`INSERT INTO convo_messages (id, convo_id, role, kind, text) VALUES (?,?,?,?,?)`)
        .run(mid, convoId, 'assistant', 'chat', result.text || '');
      db.prepare(`UPDATE convos SET turns=turns+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(convoId);
      broadcastAll('convos:updated', { convoId });
      return { text: result.text, via: result.via };
    }
  }

  // Ordinary user turn: persist, then run one model turn.
  const mid = randomUUID();
  db.prepare(`INSERT INTO convo_messages (id, convo_id, role, kind, text) VALUES (?,?,?,?,?)`)
    .run(mid, convoId, 'user', 'chat', trimmed);
  const out = await runChatTurn(convoId, userId);
  if (out.error) return out;
  return out;
}

export async function requestPlan(convoId) {
  if (!db) return { error: 'no_db' };
  const convo = getConvo(convoId);
  if (!convo) return { error: 'not_found' };
  return runPlanTurn(convo.id, convo.created_by || 'antoine');
}

export async function handoffToQueue(convoId, { title = null, prompt = null } = {}) {
  if (!db) return { error: 'no_db' };
  const convo = getConvo(convoId);
  if (!convo) return { error: 'not_found' };

  // idempotent: if this conversation already handed off, return the existing task
  if (convo.work_prompt_id) {
    const existing = db.prepare(`SELECT * FROM work_prompts WHERE id=?`).get(convo.work_prompt_id);
    if (existing) return { ok: true, already: true, prompt: existing };
  }

  // A plan is required — either the conversation produced one, or the caller supplied text.
  const plan = await latestConvoPlan(convoId);
  const brief = prompt || plan?.brief || plan?.title || '';
  if (!brief) return { error: 'no_plan', message: 'Run /plan first (or pass a prompt).' };

  const queue = await import('./promptQueue.js');
  const created = await queue.createPrompt({
    title: title || plan.title || convo.title || 'Work',
    prompt: brief,
    mode: 'implement',
    preset: 'standard',
    space: 'fmcns',
    status: 'paused', // set aside, not auto-dispatched — Antoine decides
    plan_source: 'skip', // the conversation already deliberated — no auto-draft
    created_by: convo.created_by || 'antoine',
    convo_id: convoId,
  });

  const promptId = created.id;
  db.prepare(`UPDATE convos SET work_prompt_id=?, handed_off_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(promptId, convoId);

  // owner-row back-reference via the subject registration
  const spec = subjectSpec(convo.subject_type);
  if (spec?.handoff) {
    try { spec.handoff(db, convoId, convo.subject_id, promptId); } catch (e) { console.warn('[convos] handoff backref failed:', e.message); }
  }

  broadcastAll('convos:updated', { convoId });
  broadcastAll('queue:updated', {});
  return { ok: true, prompt: created };
}
