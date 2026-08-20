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
  registerSubject, subjectSpec, buildSubjectContext, parseWorldPickId,
} from './subjectContext.js';
import {
  getReport, updatePickInPlace, appendPicks, updatePartFraming,
} from './codeDiscovery.js';
import { writeTarget, writeActsFor, applySubjectWrite, subjectEdits } from './subjectWrite.js';
import { createIdea } from './workIdeas.js';
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
      if (type === 'task') return db?.prepare(`SELECT id, title, status, mode, summary FROM work_prompts WHERE id=?`).get(id) || { error: 'not_found' };
      if (type === 'world_pick') {
        const ref = parseWorldPickId(id);
        const pick = ref ? getReport(db, ref.reportId)?.parts?.[ref.partIndex]?.picks?.[ref.pickIndex] : null;
        return pick || { error: 'not_found' };
      }
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

// NOTE: toolSpecs/dispatchByName/buildMessages below feed runToolLoop, which is
// the metered Messages-API path. Turns now go through generateText (the routed,
// subscription/free lane) instead, which is one prompt in and one answer out —
// the lookups those tools did are pre-answered by projectDigestBlock(). Kept so
// the tool path still works if ALLOW_METERED_API is ever turned on.

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

// Flatten a conversation into one prompt. The lane that reaches the Claude
// subscription (the Mac helper) is one-prompt-in, one-answer-out — there is no
// mid-turn tool round trip — so the lookups the tool loop used to make are
// pre-answered here instead, from the DB, for free.
function projectDigestBlock() {
  try {
    const comps = getComponents(db) || [];
    const built = comps.filter((c) => c.status === 'built' || c.status === 'live');
    const lines = comps.slice(0, 40).map((c) => `- ${c.id}: ${String(c.now_text || '').slice(0, 90)} [${c.status || '?'}]`);
    const queued = db.prepare(`SELECT title, status FROM work_prompts WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 15`).all();
    return `\n=== WHAT ALREADY EXISTS IN THE PROJECT (so you never propose rebuilding it) ===\n`
      + `${comps.length} pieces, ${built.length} already built.\n${lines.join('\n')}\n`
      + `Recent work in the queue:\n${queued.map((q) => `- [${q.status}] ${q.title}`).join('\n')}`;
  } catch { return ''; }
}

function transcriptOf(convo, msgs, windowSize) {
  const visible = msgs.slice(-windowSize).filter((m) => m.kind === 'chat');
  const lines = [];
  if (convo.recap) lines.push(`(folded earlier context)\n${convo.recap}`);
  for (const m of visible) lines.push(`${m.role === 'user' ? 'OWNER' : 'YOU'}: ${m.text}`);
  return lines.join('\n\n');
}

// One turn against the routed lane (AI Settings decides which; the Claude
// subscription when 'studio' points there). Returns { text, via } | { error }.
async function runRoutedTurn({ convo, ctx, instruction = null, model, maxTokens, feature, label, includeDigest = true }) {
  const msgs = listMessages(convo.id);
  const prompt = [
    subjectSystemPrompt(ctx.contextText),
    includeDigest ? projectDigestBlock() : '',
    `\n=== THE CONVERSATION SO FAR ===\n${transcriptOf(convo, msgs, CONVO_HISTORY_WINDOW) || '(nothing yet)'}`,
    instruction ? `\n=== WHAT TO DO NOW ===\n${instruction}` : `\n=== WHAT TO DO NOW ===\nReply to the owner's last message. Nothing else.`,
  ].filter(Boolean).join('\n');
  return generateText({ prompt, feature, label, model, maxTokens, allowLongOutput: true, timeoutMs: 150_000, helperWaitMs: 120_000 });
}

function saveAssistantTurn(convoId, text, meta = null) {
  const mid = randomUUID();
  db.prepare(`INSERT INTO convo_messages (id, convo_id, role, kind, text, meta) VALUES (?,?,?,?,?,?)`)
    .run(mid, convoId, 'assistant', 'chat', text || '', meta ? JSON.stringify(meta) : null);
  db.prepare(`UPDATE convos SET turns=turns+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(convoId);
  broadcastAll('convos:updated', { convoId });
  return mid;
}

async function runChatTurn(convoId, userId) {
  const convo = getConvo(convoId);
  if (!convo) return { error: 'not_found' };
  const ctx = await buildSubjectContext(db, convo.subject_type, convo.subject_id, convo.subject_hint);
  if (ctx.error) return { error: ctx.error };

  const result = await runRoutedTurn({
    convo, ctx, model: CONVO_CHAT_MODEL, maxTokens: 1400,
    feature: 'studio', label: 'conversations:chat',
  });
  if (result.error) return result;
  saveAssistantTurn(convoId, result.text);
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

// ─── Writing the conversation back into a world idea ─────────────────────────
// Three explicit commands, one model call each, only on a 'world_pick' subject.
// They are what turns "the suggestions are conversation starters" into something
// the app actually remembers: the idea itself changes, or new ideas appear beside
// it, or the question above them is rewritten. Nothing here ever moves or deletes
// an idea — positions are load-bearing (see codeDiscovery's write-back notes).

const PICK_SHAPES = {
  open: '{"kind":"open","repo":"owner/name","why_fits":"...","use":"..."}',
  hidden: '{"kind":"hidden","name":"...","what":"...","lesson":"...","use":"..."}',
  bold: '{"kind":"bold","name":"...","vision":"...","why_possible":"...","how_fmcns":"..."}',
};

// Model replies arrive as JSON, sometimes fenced, sometimes with a sentence in
// front. Take the first balanced object and parse that.
function firstJson(text) {
  const t = String(text || '').replace(/```(?:json)?/gi, '');
  const start = t.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < t.length; i++) {
    if (t[i] === '{') depth++;
    else if (t[i] === '}') { depth--; if (!depth) { try { return JSON.parse(t.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

function worldPickRef(convo) {
  if (convo.subject_type !== 'world_pick') return null;
  const ref = parseWorldPickId(convo.subject_id);
  if (!ref) return null;
  const report = getReport(db, ref.reportId);
  const part = report?.parts?.[ref.partIndex];
  const pick = part?.picks?.[ref.pickIndex];
  if (!pick) return null;
  return { ...ref, report, part, pick };
}

// ── The same three gestures, for everything else the studio can talk to ──────
// On a world idea they act on the idea inside its report. On a seed, suggestion,
// task, component or tech-tree node they act on the thing's own row: fold
// rewrites what it IS, reframe rewrites why it exists, and more turns the
// conversation's leftovers into fresh seeds in the notebook. Which of these a
// subject offers comes from subjectWrite.js, so nothing has to be special-cased
// twice.

// One rewrite turn against a subject's own row.
async function runSubjectWriteTurn(convoId, act) {
  const convo = getConvo(convoId);
  if (!convo) return { error: 'not_found' };
  const target = writeTarget(convo.subject_type, act);
  if (!target) {
    return { text: act === 'reframe'
      ? 'There is no separate purpose to rewrite on this one — "fold it in" already rewrites what it is.'
      : 'There is nothing on this one I can rewrite from here.' };
  }
  const ctx = await buildSubjectContext(db, convo.subject_type, convo.subject_id, convo.subject_hint);
  if (ctx.error) return { error: ctx.error };

  const asks = Object.entries(target.fields)
    .filter(([, ask]) => ask)
    .map(([k, ask]) => `  "${k}": "${ask}"`)
    .join(',\n');
  const instruction = act === 'fold'
    ? `Rewrite ${target.label} so it carries everything this conversation arrived at — the sharper version of the thing itself, not a summary of the chat. Keep what still holds, fold in what we added, drop what we rejected. Write it for someone reading it cold, with no knowledge of this conversation.
Respond with ONLY this JSON object and nothing else:
{
${asks}
}`
    : `The conversation suggests ${target.label} is aimed at the wrong thing. Rewrite why it exists — not what it does. Plain English, no jargon.
Respond with ONLY this JSON object and nothing else:
{
${asks}
}`;

  const result = await runRoutedTurn({
    convo, ctx, model: CONVO_PLAN_MODEL, maxTokens: 1600,
    feature: 'studio', label: `conversations:${act}`, includeDigest: false,
    instruction,
  });
  if (result.error) return result;

  const fields = firstJson(result.text);
  if (!fields) return { text: 'I could not get a clean rewrite out of that — say in one line what it should say, then ask again.' };
  const out = applySubjectWrite(db, { subjectType: convo.subject_type, subjectId: convo.subject_id, act, fields, convoId });
  if (out.error) return { text: out.message || 'Could not write that back.' };

  const what = out.changed.map((c) => c.field).join(' and ');
  const text = act === 'fold'
    ? `Folded into ${target.label} — its ${what} now carries what we worked out here. What it said before is kept, so nothing is lost.`
    : `Rewrote why ${target.label} exists (${what}). What it said before is kept.`;
  saveAssistantTurn(convoId, text, { act, subject_type: convo.subject_type, subject_id: convo.subject_id, fields: out.changed.map((c) => c.field) });
  broadcastAll('queue:updated', {});
  broadcastAll('convos:updated', { convoId });
  return { text, via: result.via, act, wrote: out.changed.map((c) => c.field) };
}

// New ideas from a conversation that has no report to append to: they land as
// seeds in the notebook, which is where a loose idea belongs in this app.
async function runSeedIdeasTurn(convoId) {
  const convo = getConvo(convoId);
  if (!convo) return { error: 'not_found' };
  const ctx = await buildSubjectContext(db, convo.subject_type, convo.subject_id, convo.subject_hint);
  if (ctx.error) return { error: ctx.error };

  const result = await runRoutedTurn({
    convo, ctx, model: CONVO_PLAN_MODEL, maxTokens: 1600,
    feature: 'studio', label: 'conversations:more-seeds',
    instruction: `Propose between one and three NEW ideas that this conversation opened up — things worth building that are not what we are already discussing, and not a rehash of the chat. Each must stand on its own, readable by someone who was not here.
Respond with ONLY this JSON object and nothing else:
{"ideas":[{"title":"a short title","notes":"what it is and what it would do, in a few sentences"}]}`,
  });
  if (result.error) return result;

  const parsed = firstJson(result.text);
  const ideas = (Array.isArray(parsed?.ideas) ? parsed.ideas : []).filter((i) => String(i?.title || '').trim()).slice(0, 3);
  if (!ideas.length) return { text: 'Nothing usable came back that time — say which direction you want more of and ask again.' };

  const made = [];
  for (const idea of ideas) {
    try {
      createIdea({ title: String(idea.title).trim().slice(0, 200), notes: String(idea.notes || '').trim().slice(0, 4000), tag: 'from a chat' });
      made.push(String(idea.title).trim());
    } catch { /* one bad idea must not lose the others */ }
  }
  if (!made.length) return { text: 'Could not save those ideas.' };

  const text = `Saved ${made.length} new idea${made.length === 1 ? '' : 's'} to your notebook, tagged "from a chat": ${made.join(', ')}. They are seeds — nothing runs until you queue one.`;
  saveAssistantTurn(convoId, text, { act: 'more', made });
  broadcastAll('ideas:updated', {});
  broadcastAll('convos:updated', { convoId });
  return { text, via: result.via, act: 'more', made };
}

// Everything a conversation has already rewritten on its subject, so the studio
// can show what the thing said before. World ideas keep their own `original`
// inside the report and are not listed here.
export function convoSubjectEdits(convoId) {
  const convo = getConvo(convoId);
  if (!convo || convo.subject_type === 'world_pick') return [];
  return subjectEdits(db, convo.subject_type, convo.subject_id, 12);
}

// Which of the three buttons this subject can offer — read by the studio so it
// never shows one that would only apologise.
export function writeActsForConvo(convoId) {
  const convo = getConvo(convoId);
  if (!convo) return [];
  if (convo.subject_type === 'world_pick') return ['fold', 'more', 'reframe'];
  return [...writeActsFor(convo.subject_type), 'more'];
}

// /fold — rewrite THIS idea with what the conversation arrived at.
async function runFoldTurn(convoId) {
  const convo = getConvo(convoId);
  if (!convo) return { error: 'not_found' };
  const ref = worldPickRef(convo);
  if (!ref) return runSubjectWriteTurn(convoId, 'fold');
  const ctx = await buildSubjectContext(db, convo.subject_type, convo.subject_id, convo.subject_hint);
  if (ctx.error) return { error: ctx.error };

  const kind = ref.pick.kind || 'bold';
  const result = await runRoutedTurn({
    convo, ctx, model: CONVO_PLAN_MODEL, maxTokens: 1600,
    feature: 'studio', label: 'conversations:fold', includeDigest: false,
    instruction: `Rewrite THIS idea so it carries everything the conversation arrived at — the sharper version of it, not a summary of the chat. Keep what still holds, fold in what we added, drop what we rejected. Write it for someone reading the idea cold, with no knowledge of this conversation. Plain English, no jargon, no file names.
Respond with ONLY this JSON object and nothing else — same shape, same kind:
${PICK_SHAPES[kind]}`,
  });
  if (result.error) return result;

  const fields = firstJson(result.text);
  if (!fields) return { text: 'I could not turn that into a clean rewrite of the idea — try saying in one line what the developed version should say, then ask me to fold it in again.' };
  const out = updatePickInPlace(db, {
    reportId: ref.reportId, partIndex: ref.partIndex, pickIndex: ref.pickIndex,
    fields, convoId,
  });
  if (out?.error) return { text: out.message || 'Could not write that back into the idea.' };

  const title = fields.repo || fields.name || 'the idea';
  const text = `Folded into **${title}**. The idea now carries what we worked out here — the version before this conversation is kept underneath it, so you can compare.`;
  saveAssistantTurn(convoId, text, { act: 'fold', report_id: ref.reportId, part_index: ref.partIndex, pick_index: ref.pickIndex });
  broadcastAll('worldlook:updated', { reportId: ref.reportId });
  return { text, via: result.via, act: 'fold', report: out };
}

// /more — new ideas shaped by where the conversation went, appended beside this one.
async function runMoreIdeasTurn(convoId) {
  const convo = getConvo(convoId);
  if (!convo) return { error: 'not_found' };
  const ref = worldPickRef(convo);
  if (!ref) return runSeedIdeasTurn(convoId);
  const ctx = await buildSubjectContext(db, convo.subject_type, convo.subject_id, convo.subject_hint);
  if (ctx.error) return { error: ctx.error };

  const existing = (ref.part?.picks || [])
    .map((p) => p.repo || p.name).filter(Boolean).join(', ');
  const result = await runRoutedTurn({
    convo, ctx, model: CONVO_PLAN_MODEL, maxTokens: 1800,
    feature: 'studio', label: 'conversations:more-ideas',
    instruction: `Propose between one and three NEW ideas that this conversation opened up — not variations on what is already listed, and not a rehash of the chat. Each must be something that could actually be built, and each must be an answer to the same question these ideas answer.
Already on the table, do not repeat: ${existing || '(nothing)'}.
An idea can be any of the three kinds: a real open-source project we could use, an existing product worth learning from, or a bold idea nobody has built.
Respond with ONLY this JSON object and nothing else:
{"picks":[ ${PICK_SHAPES.bold} ]}
Each entry may instead use ${PICK_SHAPES.open} or ${PICK_SHAPES.hidden}. Only name a real repository or a real product if you are sure it exists — otherwise use the bold shape.`,
  });
  if (result.error) return result;

  const parsed = firstJson(result.text);
  const picks = Array.isArray(parsed?.picks) ? parsed.picks : (parsed?.kind ? [parsed] : []);
  if (!picks.length) return { text: 'Nothing usable came back that time — say which direction you want more of and ask again.' };

  const out = appendPicks(db, {
    reportId: ref.reportId, partIndex: ref.partIndex, picks: picks.slice(0, 3), from: convoId,
  });
  if (out?.error) return { text: out.message || 'Could not add those ideas.' };

  const added = picks.slice(0, 3).map((p) => p.repo || p.name).filter(Boolean);
  const text = `Added ${added.length} idea${added.length === 1 ? '' : 's'} beside this one: ${added.join(', ')}. They are in the list now, marked as coming from this conversation — tick the ones you want.`;
  saveAssistantTurn(convoId, text, { act: 'more', report_id: ref.reportId, part_index: ref.partIndex, added });
  broadcastAll('worldlook:updated', { reportId: ref.reportId });
  return { text, via: result.via, act: 'more', report: out };
}

// /reframe — rewrite the question above the ideas. No idea is touched.
async function runReframeTurn(convoId) {
  const convo = getConvo(convoId);
  if (!convo) return { error: 'not_found' };
  const ref = worldPickRef(convo);
  if (!ref) return runSubjectWriteTurn(convoId, 'reframe');
  const ctx = await buildSubjectContext(db, convo.subject_type, convo.subject_id, convo.subject_hint);
  if (ctx.error) return { error: ctx.error };

  const result = await runRoutedTurn({
    convo, ctx, model: CONVO_PLAN_MODEL, maxTokens: 900,
    feature: 'studio', label: 'conversations:reframe', includeDigest: false,
    instruction: `The conversation suggests we were answering the wrong question. Rewrite the QUESTION these ideas are answers to — the heading above them — so it states what we are actually trying to do now. Do not touch the ideas themselves. Plain English, no jargon.
Respond with ONLY this JSON object and nothing else:
{"name":"<a short heading, a few words>","description":"<one or two sentences saying what we are really solving>"}`,
  });
  if (result.error) return result;

  const parsed = firstJson(result.text);
  if (!parsed?.description && !parsed?.name) return { text: 'I could not get a clean new framing out of that — say in one line what you think we are really solving, and ask again.' };
  const out = updatePartFraming(db, {
    reportId: ref.reportId, partIndex: ref.partIndex,
    name: parsed.name || null, description: parsed.description || null, convoId,
  });
  if (out?.error) return { text: out.message || 'Could not change the question.' };

  const text = `Changed the question above these ideas to: **${parsed.name || ''}** — ${parsed.description || ''}\n\nNone of the ideas moved. The original wording is kept.`;
  saveAssistantTurn(convoId, text, { act: 'reframe', report_id: ref.reportId, part_index: ref.partIndex });
  broadcastAll('worldlook:updated', { reportId: ref.reportId });
  return { text, via: result.via, act: 'reframe', report: out };
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
        text: 'Available commands:\n  /grill-me — I ask you sharp clarifying questions, one at a time.\n  /plan — turn this conversation into a coder brief (TITLE + BRIEF).\n  /handoff — queue the plan as a paused task in the Dispatch Queue (idempotent).\n  /compare — compare the ideas attached to this subject.\n  /fold — (world ideas) rewrite this idea with what we worked out here.\n  /more — (world ideas) propose new ideas from where this conversation went.\n  /reframe — (world ideas) rewrite the question these ideas answer.\n  /help — this list.\n\nOtherwise just type — I\'ll answer from the subject context + live project data.',
      };
    }
    if (slash === 'compare') return runCompareTurn(convoId);
    if (slash === 'fold') return runFoldTurn(convoId);
    if (slash === 'more') return runMoreIdeasTurn(convoId);
    if (slash === 'reframe') return runReframeTurn(convoId);
    if (slash === 'grill-me') {
      // interrogation mode: a single turn where the model asks questions only
      const ctx = await buildSubjectContext(db, convo.subject_type, convo.subject_id, convo.subject_hint);
      if (ctx.error) return { error: ctx.error };
      const result = await runRoutedTurn({
        convo, ctx, model: CONVO_CHAT_MODEL, maxTokens: 700,
        feature: 'studio', label: 'conversations:grill', includeDigest: false,
        instruction: 'GRILL MODE. Ask the owner the sharpest clarifying questions you can, ONE at a time, in order of importance. Do not propose solutions yet. End with a question mark. Keep it short.',
      });
      if (result.error) return result;
      saveAssistantTurn(convoId, result.text);
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
