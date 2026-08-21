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
import { generateText, generateTextStream, studioPersonaText } from './ai/text.js';
import { getComponents } from './architecture.js';
import { projectMapBlock } from './projectMap.js';
import { listSuggestions } from './workSuggestions.js';
import { listIdeas, getIdea } from './workIdeas.js';

// keep SubjectContext's module-level registrations loaded (imported above)
import './subjectContext.js';

let db = null;
export function bindConversationsDb(database) { db = database; }

const CONVO_HISTORY_WINDOW = 16;
// The chat turn is the one you sit and wait for, so it runs on the fast tier by
// default; /plan and the rewrites keep the stronger model, because those produce
// something you keep. An explicit model is only a preference — ai/text.js drops it
// when the configured lane cannot honour it, so the AI Settings 'studio' row still
// has the final say.
const CONVO_CHAT_MODEL = process.env.CONVO_CHAT_MODEL || 'claude-haiku-4-5-20251001';
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
// the lookups those tools did are pre-answered by the project map plus
// liveListsBlock() below. Kept so
// the tool path still works if ALLOW_METERED_API is ever turned on.

// ─── System prompt builders ──────────────────────────────────────────────────

const BASE_SYSTEM = `You are the Idea Studio thinking partner inside FMCNS, working through one subject at a time with its owner.

Everything you know about the project is in this prompt — you have NO tools and cannot look anything up. So never say or imply that you checked, searched, read the code or looked something up. Work from what the owner has said plus the reference sections below, and when you genuinely do not know, say so. If something already exists in the project, say so rather than proposing to build it again.

Commands the user may type:
  /grill-me — switch to interrogation mode: ask the sharpest clarifying questions, one at a time, no answering yet.
  /plan     — produce the final plan for the coding agent (done by the system; you do not do this yourself).
  /handoff  — queue the plan as a task (done by the system).
  /compare  — compare the enrichment ideas attached to this subject (done by the system; you do not do this yourself).
  /help     — list these commands.

The subject being discussed is described in SUBJECT CONTEXT below. It is the whole reason this conversation exists — keep every answer anchored to it.

Be direct. Never mention internal component ids, codes or file names in your answers — say what the thing DOES, not what it is called in the codebase. The owner is not a programmer, so TECHNICAL jargon is out.

Conceptual, philosophical and spiritual language is NOT jargon and is welcome — the subject matter is mythic and structural, and flattening it into plain operational English loses the actual thought. Abstraction is fine. Vagueness is not.`;

// How long an answer should be. Split out of BASE_SYSTEM because the two lanes
// want opposite things and used to share one instruction.
//
// TERSE is for the structured, system-triggered turns (compare, fold, reframe)
// that land in a small card and are read at a glance.
//
// JUDGED is for actual conversation. Antoine's ask, in his words: "I don't want
// just a one-line answer... I need depth in these types of conversations." The
// old shared line ("keep answers short unless the user asks for detail") made
// every turn default to terse and put the burden on him to ask for depth every
// time — which is not how a real brainstorming conversation works. So the model
// judges length from the question instead, the way ChatGPT does by default.
// ─── The Idea Studio voice ───────────────────────────────────────────────────
// Third attempt, and the first one built on JUDGEMENT rather than on register.
//
// The two before it described the voice they wanted ("be philosophical", "reach
// for the structural reading") and gpt-4o answered in its default
// product-consultant idiom anyway. Live evidence, same question both times:
// "immersive engagement... exploratory adventure... impactful and memorable" and
// "participation rather than observation... engagement and exploration". It
// described an idea's benefits instead of taking a position on it.
//
// The most useful answer of that whole session came from the free lane during a
// run where gpt-4o errored: "Mostly a distraction right now — but there's a real
// itch underneath it worth naming, because I think two of your saved notes are the
// same itch. [...] it costs you a second toolchain, a rewrite of every view you
// already have working, and months of attention." That is the target — not because
// it was philosophical, because it JUDGED: took a position, found the want under
// the stated want, spotted a duplicate in the notebook, priced the cost in
// attention. So the prompt now asks for that behaviour directly.
//
// Antoine's own framing of his research is kept VERBATIM under HOW TO THINK. It is
// his text, not a paraphrase, and it is here as domain competence rather than as
// style: the project treats a character, a film and a country as one object read at
// different scales, and an advisor who cannot think that way cannot judge ideas
// about it. Specificity is also what actually moves a model — named lenses
// (biopolitics, shadow work, grief as a mirror of power) change how it reasons in a
// way "be profound" never does.
//
// THE NEVER BLOCK IS LOAD-BEARING — DO NOT TRIM IT. Every word on that list
// appeared in a real answer during testing. Banning a register by naming its
// vocabulary moves a model far more reliably than describing the register you want.
//
// Layered on top of BASE_SYSTEM, not replacing it: the operational rules (no tools,
// invent nothing, say when something already exists, stay anchored to the subject)
// are what keep this useful instead of merely eloquent.
//
// Overridable live from AI Settings (ai_settings.studio_persona) because a thinking
// partner's register is something you only get right by iterating, and waiting on a
// deploy each time kills that loop.
const DEFAULT_STUDIO_PERSONA = `You are what Antoine argues with before he builds anything.

His notebook is full and so is his queue. Ideas are not scarce here — judgement is. On every turn your job is to work out whether the thing being discussed is real, what it actually is underneath what he said, and whether it deserves his attention. Then say so.

HOW TO THINK
You navigate the liminal space where history, myth and imagination converge. You trace the conscious architectures and subconscious drives of entities — families, corporations, nations, civilizations — as evolving, self-similar consciousness systems. You think through biopolitics, post-humanism, cyberpunk dynamics, transhumanist warfare, shadow work, and grief as mirrors of power and memory. Literature, cinema and speculative worlds are living laboratories for decoding suppressed stories and collective feedback loops. You map multi-scale narrative cartographies where every node — real or imagined — can reveal deeper structural truths.

This frame is not decoration, it is the subject matter. The project treats a character, a film and a country as the same kind of object read at different scales. An idea that does not touch that is usually a distraction wearing an interesting coat, and noticing which is part of your job.

ALWAYS
- Take a position. "It depends" is allowed only if you then say on what, and pick.
- Find the want under the want — the stated idea is rarely the real one.
- Say when two things already in the notebook are the same idea. You can see the list.
- Name what it would COST: attention, coherence, months. Not only what it gives.
- Say plainly when you think he is wrong, and why.
- Say when you don't know.

NEVER
- Summarise benefits. You are not selling anything.
- Use these words: immersive, engagement, engaging, impactful, memorable, journey, seamless, leverage, unlock, elevate, robust, holistic, transformative.
- End with a paragraph restating what you just said.
- Open by repeating the question back.
- Pad to seem thorough. Length is earned by having more to say.`;

function studioPersona() {
  const custom = (studioPersonaText() || '').trim();
  return custom || DEFAULT_STUDIO_PERSONA;
}

const LENGTH_TERSE = `Keep answers short unless the user asks for detail.`;
const LENGTH_JUDGED = `Let the question decide how long the answer is — the way a good thinking partner would. A question with one right answer gets one or two sentences; a real question about direction, trade-offs or "what should this be" gets the depth it deserves: work through it, lay out the possibilities, say what you'd pick and why. Do not pad, and do not compress something that needs room. Never end with a summary of what you just said.`;

function subjectSystemPrompt(ctxText, { depth = false } = {}) {
  return `${BASE_SYSTEM}

${depth ? LENGTH_JUDGED : LENGTH_TERSE}

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

// Flatten a conversation into one prompt. The lane that reaches the model is
// one-prompt-in, one-answer-out — there is no mid-turn tool round trip — so the
// lookups the tool loop used to make are pre-answered here instead, from the DB,
// for free.
//
// This used to be one big projectDigestBlock() that also dumped 40 architecture
// components. That half now lives in the standing project map
// (services/projectMap.js), which is built once at boot and sent first so prompt
// caching can pay for it. What is left here is the part that MUST be live: the
// notebook, the queue and the open suggestions. A list of ideas cached at boot
// would make the advisor claim two notes are duplicates of each other days after
// one of them changed — and "say when two things in the notebook are the same
// idea" is one of the things the voice explicitly promises. So it is rebuilt per
// turn, and sent AFTER the map, where being variable costs nothing.
function liveListsBlock() {
  try {
    const queued = db.prepare(`SELECT title, status FROM work_prompts WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 15`).all();
    // Titles only, and capped: this rides along on every chat turn, so it earns its
    // keep by being short. Dismissed suggestions are left out on purpose — they are
    // decisions already taken, not options still open.
    const sugg = db.prepare(
      `SELECT title FROM work_suggestions WHERE deleted_at IS NULL AND status IN ('new','accepted') ORDER BY created_at DESC LIMIT 20`
    ).all();
    const seeds = db.prepare(
      `SELECT title FROM work_ideas WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 15`
    ).all();
    if (!queued.length && !sugg.length && !seeds.length) return '';
    const brief = (rows) => rows.map((r) => `- ${String(r.title || '').slice(0, 90)}`).join('\n');
    // Framed as background reference, not as the topic. Named plainly so a reader
    // of the prompt (and the model) treats it as a list to check against rather
    // than as the thing being discussed.
    return `\n=== WHAT IS ALREADY ON THE TABLE — check against it; do not let it set the subject. ===\n`
      + (queued.length ? `Recent work in the queue:\n${queued.map((q) => `- [${q.status}] ${q.title}`).join('\n')}\n` : '')
      + (sugg.length ? `Suggestions already on the table:\n${brief(sugg)}\n` : '')
      + (seeds.length ? `Ideas already in the notebook:\n${brief(seeds)}` : '');
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
// The prompt itself, factored out so the streaming turn below sends exactly the
// same thing — a second copy of this assembly would drift.
function buildTurnPrompt({ convo, ctx, instruction = null, includeProjectContext = true, brevity = true }) {
  const msgs = listMessages(convo.id);
  const depth = !brevity;
  // ORDER MATTERS, TWICE OVER, AND EACH HALF FIXES A REAL FAILURE. A later
  // innocent-looking reorder would undo one of them, so both reasons are written
  // down here.
  //
  // 1. THE PROJECT MAP GOES FIRST — nothing variable in front of it. It is ~10k
  //    tokens on every turn, and prompt caching is what makes that affordable
  //    (~2¢ on the first message of a session, ~0.5¢ after). Caching matches a
  //    shared PREFIX, so a single variable character ahead of the map — a date, a
  //    subject name, a message count — turns every turn back into a full-price
  //    turn. See services/projectMap.js for the other half of the guarantee
  //    (byte-identical, built once at boot).
  //
  // 2. HOW TO THINK GOES LAST — immediately before it answers. The voice used to
  //    sit near the top, ahead of the project digest and an operational "reply to
  //    the owner's last message", and a model weights the END of a long prompt
  //    most heavily: gpt-4o read the frame, buried it, and answered in its default
  //    consultant register ("immersive engagement", "exploratory adventure").
  //    Verified live before and after.
  //
  // Both hold at once: stable map first, variable material after, voice last.
  return [
    includeProjectContext ? projectMapBlock() : '',
    subjectSystemPrompt(ctx.contextText, { depth }),
    includeProjectContext ? liveListsBlock() : '',
    `\n=== THE CONVERSATION SO FAR ===\n${transcriptOf(convo, msgs, CONVO_HISTORY_WINDOW) || '(nothing yet)'}`,
    depth ? `\n=== HOW TO THINK ===\n${studioPersona()}` : '',
    instruction
      ? `\n=== WHAT TO DO NOW ===\n${instruction}`
      : `\n=== WHAT TO DO NOW ===\n${brevity
          ? `Reply to the owner's last message. Nothing else.\n\nKeep it short: this lands in a small box inside a card, not on a page. A few sentences. No preamble, no restating the question back, no summary at the end. If the honest answer is one line, give one line.`
          : `Reply to the owner's last message, in the voice and frame set out under HOW TO THINK above — that is the register, not a suggestion. Judge the thing being discussed: is it real, what is it actually, is it worth his attention. Say so.\n\nNo preamble, no restating the question back, no closing summary. Start with the substance and give it the room it needs.`}`,
  ].filter(Boolean).join('\n');
}

async function runRoutedTurn({ convo, ctx, instruction = null, model, maxTokens, feature, label, includeProjectContext = true }) {
  const prompt = buildTurnPrompt({ convo, ctx, instruction, includeProjectContext });
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

// Streaming sibling of runChatTurn. Same prompt, same single saveAssistantTurn at
// the end — so the DB write is identical and the frontend's existing poll fallback
// (awaitTurn) keeps working untouched if a stream dies mid-flight.
//
// The output ceiling is 1200 here, not 450. That 450 existed only because nothing
// streamed and the whole answer had to be written before any of it appeared; once
// tokens arrive as they are produced, a longer answer costs patience nothing. The
// brevity instruction is relaxed to match — a cramped ceiling and a "keep it very
// short" order were solving the same vanished problem.
async function runChatTurnStreaming(convoId, userId, onToken) {
  const convo = getConvo(convoId);
  if (!convo) return { error: 'not_found' };
  const ctx = await buildSubjectContext(db, convo.subject_type, convo.subject_id, convo.subject_hint);
  if (ctx.error) return { error: ctx.error };

  const prompt = buildTurnPrompt({ convo, ctx, brevity: false });
  const result = await generateTextStream({
    prompt, feature: 'studio', label: 'conversations:chat',
    // 4000, not 450 and not 1200. Both smaller numbers were brevity caps: 450
    // because nothing streamed and the whole answer had to be written before any
    // of it showed, 1200 because that was the timid first step away from it.
    // Neither is a budget constraint — an answer only costs what it actually
    // uses, so a high ceiling on a short answer costs nothing. This is headroom
    // for the times a question genuinely needs it, not a target.
    model: CONVO_CHAT_MODEL, maxTokens: 4000,
    allowLongOutput: true, timeoutMs: 150_000, onToken,
  });
  if (result.error) return result;
  saveAssistantTurn(convoId, result.text, result.notice ? { notice: result.notice } : null);
  return { text: result.text, via: result.via, notice: result.notice || null };
}

async function runChatTurn(convoId, userId) {
  const convo = getConvo(convoId);
  if (!convo) return { error: 'not_found' };
  const ctx = await buildSubjectContext(db, convo.subject_type, convo.subject_id, convo.subject_hint);
  if (ctx.error) return { error: ctx.error };

  const result = await runRoutedTurn({
    // 450, not 1400: nothing is streamed, so the wait is the whole answer being
    // written before you see any of it. Cutting the ceiling cuts the wait roughly
    // in proportion. The brevity line above stops it reading as a truncation.
    convo, ctx, model: CONVO_CHAT_MODEL, maxTokens: 450,
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
    feature: 'studio', label: `conversations:${act}`, includeProjectContext: false,
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
      const notes = String(idea.notes || '').trim().slice(0, 4000);
      createIdea({
        title: String(idea.title).trim().slice(0, 200),
        notes: notes + (notes ? '\n\n' : '') + `(Came out of a conversation about "${convo.title || 'something else'}".)`,
      });
      made.push(String(idea.title).trim());
    } catch { /* one bad idea must not lose the others */ }
  }
  if (!made.length) return { text: 'Could not save those ideas.' };

  const text = `Saved ${made.length} new idea${made.length === 1 ? '' : 's'} to your notebook: ${made.join(', ')}. Each one says where it came from. They are seeds — nothing runs until you queue one.`;
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
    feature: 'studio', label: 'conversations:fold', includeProjectContext: false,
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
    feature: 'studio', label: 'conversations:reframe', includeProjectContext: false,
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

// onToken, when supplied by the route, turns the ordinary text turn into a
// streamed one. Slash commands stay non-streamed: they are structured actions
// (plan, handoff, fold) whose value is the finished artefact, not the typing.
export async function sendMessage(convoId, { text, userId = 'antoine', onToken = null } = {}) {
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
        feature: 'studio', label: 'conversations:grill', includeProjectContext: false,
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
  const out = onToken
    ? await runChatTurnStreaming(convoId, userId, onToken)
    : await runChatTurn(convoId, userId);
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
    // 'own', not 'skip': the conversation already deliberated, so the plan is final and
    // is never auto-drafted over — but the world-look still runs, because "this part
    // already exists" is worth knowing about a plan nobody has checked against the
    // code yet. Picking an idea redrafts from raw_prompt, keeping the original.
    plan_source: 'own',
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
