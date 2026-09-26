// The analogy engine beside the Room (plans "the analogy engine in the Room" and
// "natural requests and lasting context for Room analogies").
//
// World Ideas asks what could be BUILT out of a conversation. This asks a
// different question: where is the relation being discussed already living, under
// other names, in another domain or at another scale. The value of an arrival is
// the new question it makes possible — not a match score, which is why none is
// ever computed or shown.
//
// Antoine's corrections (2026-09-13):
//   1. The search space is the MODEL'S WORLD, not our 492 entities.
//   2. Any request in ordinary language must work — no fixed move/domain/reach
//      buttons. He can just say what he wants: "twelve vertical", "only biology",
//      "another ten, more like the second one".
//   3. The engine must stay aware of what the whole Room conversation is about,
//      not just the last six messages.
//
// Storage rides what already exists. The side thread is a convo with
// subject_type 'analogy' and subject_id = the Room convo's id. Each arrival is
// one assistant message whose `meta` column holds the card; each of his asks is
// one user message whose `meta` holds a durable request record (kind
// 'analogy_request') that a background loop fills in over several batches. No
// new table, and no new convo_messages.kind value — that column has a SQLite
// CHECK limited to ('chat','plan').

import { randomUUID } from 'node:crypto';
import { broadcastAll } from '../realtime.js';
import { generateText as _generateText } from './ai/text.js';
import { getConvo, listMessages } from './conversations.js';
import { whoHeIsBlock } from './ai/voice.js';
import { subjectsLine } from './mind.js';

let db = null;
export function bindRoomAnalogiesDb(database) { db = database; }

// A single injectable seam so the integration self-test can run every branch of
// the batching/pause/resume/dedup logic against canned replies — no model, no
// network, no credits. Production code never calls this.
let generateText = _generateText;
export function __setGenerateTextForTest(fn) { generateText = fn || _generateText; }

// ─── Steering ────────────────────────────────────────────────────────────────
// One knob left: whether an arrival may show up unasked. Everything that used to
// be a move/domain/reach button is now just words in the ask box.

export const WHENS = ['pause', 'asked'];
export const STEER_DEFAULT = Object.freeze({ when: 'pause' }); // 'pause' = as you talk

export function normalizeSteer(raw) {
  const s = (raw && typeof raw === 'object') ? raw : {};
  let when = s.when === 'every' ? 'pause' : s.when; // legacy value, same meaning
  return { when: WHENS.includes(when) ? when : STEER_DEFAULT.when };
}

export function getSteer(convoId) {
  const row = db?.prepare(`SELECT analogy_steer FROM convos WHERE id=?`).get(convoId);
  if (!row?.analogy_steer) return { ...STEER_DEFAULT };
  try { return normalizeSteer(JSON.parse(row.analogy_steer)); } catch { return { ...STEER_DEFAULT }; }
}

export function setSteer(convoId, patch) {
  if (!db) return { error: 'no_db' };
  if (!getConvo(convoId)) return { error: 'not_found' };
  const next = normalizeSteer({ ...getSteer(convoId), ...(patch || {}) });
  db.prepare(`UPDATE convos SET analogy_steer=? WHERE id=?`).run(JSON.stringify(next), convoId);
  return next;
}

// ─── The side thread ─────────────────────────────────────────────────────────

export function sideThread(convoId, { create = false } = {}) {
  if (!db) return null;
  const found = db.prepare(
    `SELECT * FROM convos WHERE subject_type='analogy' AND subject_id=? AND deleted_at IS NULL`,
  ).get(convoId);
  if (found || !create) return found || null;
  const id = randomUUID();
  db.prepare(`INSERT INTO convos (id, subject_type, subject_id, title, created_by) VALUES (?,?,?,?,?)`)
    .run(id, 'analogy', convoId, 'Analogies', 'antoine');
  return db.prepare(`SELECT * FROM convos WHERE id=?`).get(id);
}

function parseMeta(raw) { try { return raw ? JSON.parse(raw) : null; } catch { return null; } }
function getMessage(msgId) { return db.prepare(`SELECT * FROM convo_messages WHERE id=?`).get(msgId); }
function updateMessageMeta(msgId, meta) {
  db.prepare(`UPDATE convo_messages SET meta=? WHERE id=?`).run(JSON.stringify(meta), msgId);
}

// Every message of the side thread, newest last, with its card or request parsed
// out. His own asks come back as {role:'user'} rows carrying `request`.
export function isLooking(convoId) { return _inFlight.has(convoId); }

export function listAnalogies(convoId) {
  const side = sideThread(convoId);
  if (!side) return { steer: getSteer(convoId), items: [], running: isLooking(convoId) };
  resumeStrayRequests(convoId, side.id); // a server restart can leave one stranded mid-batch
  const items = listMessages(side.id).map((m) => {
    const meta = parseMeta(m.meta);
    return {
      id: m.id, role: m.role, text: m.text, created_at: m.created_at,
      card: meta?.kind === 'arrival' ? meta : null,
      request: meta?.kind === 'analogy_request' ? toRequestView(meta) : null,
    };
  });
  return { steer: getSteer(convoId), items, running: isLooking(convoId) };
}

function addSideMessage(sideId, role, text, meta = null) {
  const id = randomUUID();
  db.prepare(`INSERT INTO convo_messages (id, convo_id, role, kind, text, meta) VALUES (?,?,?,'chat',?,?)`)
    .run(id, sideId, role, String(text || ''), meta ? JSON.stringify(meta) : null);
  db.prepare(`UPDATE convos SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(sideId);
  return id;
}

// ─── The living subject ──────────────────────────────────────────────────────
// What the Room conversation is actually about, refreshed after every completed
// exchange (whether or not unasked cards are allowed to show) so a manual ask
// twenty turns later still lands in the right place. The stored frame carries
// positions and relations but never the real names — that is what keeps a match
// structural instead of a name lookup (fractal_operational_core.md).

function parseContext(raw) { try { return raw ? JSON.parse(raw) : null; } catch { return null; } }

export function getContext(convoId) {
  const row = db?.prepare(`SELECT analogy_context FROM convos WHERE id=?`).get(convoId);
  return parseContext(row?.analogy_context);
}

const S = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

function normalizeContext(parsed, prior) {
  const p = parsed || {};
  return {
    subject: S(p.subject, 80) || prior?.subject || '',
    central_relation: S(p.central_relation, 300) || prior?.central_relation || '',
    focus: S(p.focus, 300) || prior?.focus || '',
    background_threads: Array.isArray(p.background_threads)
      ? p.background_threads.map((t) => S(t, 200)).filter(Boolean).slice(0, 8)
      : (prior?.background_threads || []),
    open_question: S(p.open_question, 300),
    frame: {
      positions: Array.isArray(p?.frame?.positions) ? p.frame.positions.map((t) => S(t, 80)).filter(Boolean).slice(0, 8) : [],
      relations: Array.isArray(p?.frame?.relations) ? p.frame.relations.map((t) => S(t, 200)).filter(Boolean).slice(0, 8) : [],
    },
    updated_at: new Date().toISOString(),
  };
}

function transcriptFor(convoId, limit = 6, charCap = 900) {
  const msgs = listMessages(convoId).filter((m) => m.kind === 'chat').slice(-limit);
  return msgs.map((m) => `${m.role === 'user' ? 'OWNER' : 'QNE'}: ${String(m.text || '').slice(0, charCap)}`).join('\n\n');
}

function buildContextPrompt({ prior, recap, transcript }) {
  return `You track the STANDING SUBJECT of a long conversation for an analogy-finding tool that runs beside it. Update it — don't restate the whole conversation.

${prior ? `The subject as last understood:\n${JSON.stringify(prior)}\n` : 'No subject recorded yet.\n'}
${recap ? `Earlier context, already folded:\n${recap}\n` : ''}
Recent conversation:
---
${transcript}
---

Respond with ONLY this JSON:
{"subject":"a short display name for what this is now about, a few words","central_relation":"the relation or pattern at the center, one sentence, describing the SHAPE of it — no names of specific people, films, companies or works","focus":"what is being discussed right now, one sentence","background_threads":["earlier threads still alive but not centered right now"],"open_question":"the live unresolved question, or an empty string","frame":{"positions":["role A","role B","..."],"relations":["how the positions relate to each other"]}}

The frame must name POSITIONS and RELATIONS only, never the real people, films, companies or works involved — naming the source would let a later match latch onto names instead of structure.
If the subject has clearly changed, replace central_relation and focus, but keep anything from background_threads that is still alive.`;
}

async function doRefreshContext(convoId) {
  const convo = getConvo(convoId);
  if (!convo) return;
  const prior = getContext(convoId);
  const transcript = transcriptFor(convoId, 24, 400);
  if (!transcript) return;
  const result = await generateText({
    prompt: buildContextPrompt({ prior, recap: convo.recap, transcript }),
    feature: 'analogies', maxTokens: 500, label: 'room:analogy-context',
    maxAttempts: 2, timeoutMs: 20_000,
  });
  if (result?.error) return;
  const parsed = firstJson(result.text);
  if (!parsed) return;
  db.prepare(`UPDATE convos SET analogy_context=? WHERE id=?`).run(JSON.stringify(normalizeContext(parsed, prior)), convoId);
}

function refreshContextIfNeeded(convo) {
  const turns = convo.turns || 0;
  const seen = convo.analogy_context_seen_turns || 0;
  if (turns <= seen) return;
  // Watermark moves before the call, same reasoning as analogy_seen_turns below: a
  // slow or failed refresh must never leave the conversation re-triggering forever.
  db.prepare(`UPDATE convos SET analogy_context_seen_turns=? WHERE id=?`).run(turns, convo.id);
  setImmediate(() => {
    doRefreshContext(convo.id).catch((e) => console.error('[room] analogy context refresh failed:', e?.message || e));
  });
}

function snapshotContext(convoId) { return getContext(convoId) || null; }

function contextLines(ctx) {
  if (!ctx) return '';
  const frameLine = ctx.frame?.relations?.length
    ? `\nThe standing shape of what's being discussed: positions — ${(ctx.frame.positions || []).join(', ') || '(unnamed)'}; how they relate — ${ctx.frame.relations.join('; ')}.`
    : '';
  const subjectLine = ctx.central_relation ? `\nWhat this conversation is actually circling: ${ctx.central_relation}` : '';
  return `${subjectLine}${frameLine}`;
}

// ─── Asking the model ────────────────────────────────────────────────────────
// The rules here are the vision's, not style: an analogy that matches on NAMES is
// worthless (fractal_operational_core.md — naming must never feed the matcher), a
// comparison that cannot say where it breaks is a claim rather than a finding, and
// a pattern that recurs at several scales is NOT evidence of cause travelling
// between them. A similarity percentage would invent precision that does not exist.

const BATCH_CAP = 6; // per model call — the request-level count has no ceiling
const DEFAULT_COUNT = 3;
const MAX_POOL = 12; // ceiling on candidates offered to the critic in one round

// The default search is a SOCIAL one — Antoine's correction (2026-09-13): another
// social arrangement (a person, a family, a group, an institution, a city, a
// nation...) that reveals the same shape of power, belonging, care, dependence,
// exclusion, conflict, memory or repair. Scientific domains stay available, but
// only when he explicitly asks for them — they no longer default in.
const SOCIAL_FIRST_RULES = `Precedence, in order:
1. If he named a domain, a form, or a count, follow it exactly — a request always wins.
2. Otherwise default to SOCIAL structure: personal relations, families, households, peer
   groups, neighbourhoods, workplaces, organizations, markets, care systems, courts,
   cities, states, movements, rituals, historical societies. Films, books, myths and
   imagined societies count too, as long as they hold a clear social arrangement.
3. Prefer the closest structural match over a stranger, weaker one. Scale difference
   (a person vs. a nation, say) is a tie-breaker between equally strong matches, never
   a goal by itself — do not force one candidate per scale.
4. Do not default to scientific, biological, ecological or engineering material unless
   he asked for that domain by name.`;

const HARD_RULES = `Hard rules:
- Match on the RELATION — who holds authority, who depends on whom, who carries the
  cost, how membership is granted or denied, what tension is being contained, what
  relation reproduces the arrangement. Never match on shared words or shared subject
  matter; if two things line up only because they share nouns, it is not an analogy.
- Offer it only if you could say where it breaks. Do not write that down.
- Never give a similarity score, percentage or star rating.
- A pattern repeating at several scales is not evidence that anything travels between
  them. Never imply cause.
- What you offer is PROPOSED, never established.`;

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

function normalizeCandidate(a) {
  const c = {
    left: S(a?.left, 60), right: S(a?.right, 60),
    title: S(a?.title, 120), reading: S(a?.reading, 600),
    question: S(a?.question, 400),
    left_scale: S(a?.left_scale, 40), right_scale: S(a?.right_scale, 40),
    structural_frame: {
      positions: Array.isArray(a?.structural_frame?.positions) ? a.structural_frame.positions.map((t) => S(t, 60)).filter(Boolean).slice(0, 6) : [],
      relations: Array.isArray(a?.structural_frame?.relations) ? a.structural_frame.relations.map((t) => S(t, 160)).filter(Boolean).slice(0, 6) : [],
    },
  };
  return c;
}

export function parseCandidates(text) {
  const parsed = firstJson(text);
  const list = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
  return list.map(normalizeCandidate).filter((a) => a.title && a.left && a.right);
}

// Turn an accepted candidate into what actually gets stored as a card.
function toArrivalCard(candidate, { anchorMessageId = null, asked = false } = {}) {
  return { kind: 'arrival', ...candidate, anchor_message_id: anchorMessageId, asked };
}

function avoidLines(cards) {
  return (cards || []).map((c) => `- ${c.left} ↔ ${c.right}: ${c.title}`).join('\n');
}

// ─── The generator ───────────────────────────────────────────────────────────
// Proposes candidates broadly. Never judges its own work — that is the critic's
// job, in a separate call, below.

function buildCandidatesPrompt({ transcript, ctx, instruction, poolSize, avoid, askCount }) {
  const avoided = avoidLines(avoid);
  return `ANALOGY GENERATOR: you are the analogical instrument beside a conversation. You are NOT summarising it and NOT proposing work to build.

Your one job: find where the RELATION being discussed is already living under other names — anywhere in the real world (or in fiction, myth or an imagined society), at any scale.

${SOCIAL_FIRST_RULES}

${transcript ? `The conversation so far:\n---\n${transcript}\n---\n` : ''}${contextLines(ctx)}
${subjectsLine(4)}
${instruction ? `He directly asked: "${instruction}" — honor exactly what this names (domain, form, or count).` : 'No direct request was made this time — use the precedence above on your own.'}
${avoided ? `Do not repeat any of these, in any form:\n${avoided}\n` : ''}
${HARD_RULES}
- Plain, short words. No jargon.

Propose ${poolSize} candidates — cast a wide net, the strongest ones will be picked from these.${askCount ? ' Also work out how many he actually wants: a bare number ("twelve", "17") IS a count; a number that is part of a name or established structure (e.g. "five-act structure", "the seven deadly sins") is NOT a request for that many — it is part of the subject. If no count is stated, the default is ' + DEFAULT_COUNT + '.' : ''}

Write in English.
${whoHeIsBlock()}

Respond with ONLY this JSON and nothing else:
{${askCount ? '"requested_count": <integer or null>, ' : ''}"candidates":[{"left":"the first side, 1-3 words","right":"the other side, 1-3 words","title":"the relation itself, under 7 words","reading":"one or two short sentences saying what holds","question":"the new question this makes possible, one sentence","left_scale":"e.g. person, family, institution, city, nation","right_scale":"same idea for the other side","structural_frame":{"positions":["the roles involved, no real names"],"relations":["how those roles relate to each other"]}}]}`;
}

// ─── The critic ──────────────────────────────────────────────────────────────
// Sees the same nameless frame, the same request, the proposed candidates, and a
// compact inventory of what has already been accepted — but never the generator's
// own reasoning. It selects and ranks; it never rewrites or embellishes.

function buildCriticPrompt({ candidates, instruction, ctx, priorAccepted, cap }) {
  const list = candidates
    .map((c, i) => `${i}. [${c.left_scale || '?'} ↔ ${c.right_scale || '?'}] ${c.left} / ${c.right} — ${c.title}. ${c.reading}`)
    .join('\n');
  const already = avoidLines(priorAccepted) || '(none yet)';
  return `ANALOGY CRITIC: judge candidate analogies for the same nameless-conversation instrument. You did not propose these — you only select and rank. Never rewrite, soften or add a fact to a candidate.

${contextLines(ctx)}
${instruction ? `The request was: "${instruction}". Reject anything that does not honor exactly what was named.` : 'No direct request was made — default to social/structural candidates; reject a scientific, biological, ecological or engineering one outright unless nothing else is offered.'}

Already accepted so far in this delivery (reject any near-duplicate — same pair of sides, or the same relation restated):
${already}

Candidates:
${list}

Reject a candidate if:
- it rests on shared vocabulary or a shared subject rather than the relation itself
- it is a generic social trope with nothing specific holding it up
- it reverses power, authority or dependence
- it invents a factual detail that was not given
- it uses jargon
- it is a near-duplicate of another candidate, or of one already accepted (exact match or same relation restated)
- it opens no new question
- (with no domain requested) it is scientific rather than social

Respond with ONLY this JSON and nothing else:
{"accepted":[<indices into the candidates array above, strongest first, rank order, at most ${cap}>]}`;
}

function parseAcceptedIndices(text, len) {
  const parsed = firstJson(text);
  const raw = Array.isArray(parsed?.accepted) ? parsed.accepted : [];
  const seen = new Set();
  const out = [];
  for (const v of raw) {
    const i = Number(v);
    if (Number.isInteger(i) && i >= 0 && i < len && !seen.has(i)) { seen.add(i); out.push(i); }
  }
  return out;
}

// Generate a pool, then have an independent call judge it — the two-pass shape
// every arrival goes through, whether it showed up on its own, was asked for, or
// is replacing a card in place.
async function runGenerateAndCritic({ transcript = null, ctx, instruction = null, need, avoid = [], priorAccepted = [], askCount = false }) {
  const poolSize = instruction ? Math.min(MAX_POOL, Math.max(need * 2, need)) : Math.max(4, need);
  const genResult = await generateText({
    prompt: buildCandidatesPrompt({ transcript, ctx, instruction, poolSize, avoid: [...avoid, ...priorAccepted], askCount }),
    feature: 'analogies', maxTokens: 1800, label: 'room:analogies:generate', maxAttempts: 2, timeoutMs: 25_000,
  });
  if (genResult?.error) return { error: genResult.error };
  const parsedGen = askCount ? firstJson(genResult.text) : null;
  const requestedCount = askCount
    ? (Number.isInteger(parsedGen?.requested_count) && parsedGen.requested_count > 0 ? parsedGen.requested_count : DEFAULT_COUNT)
    : null;

  let candidates = parseCandidates(genResult.text);
  const avoidSigs = new Set([...avoid, ...priorAccepted].map(signatureOf));
  candidates = candidates.filter((c) => !avoidSigs.has(signatureOf(c)));
  if (!candidates.length) return { requestedCount, arrivals: [] };

  const criticResult = await generateText({
    prompt: buildCriticPrompt({ candidates, instruction, ctx, priorAccepted, cap: need }),
    feature: 'analogies', maxTokens: 600, label: 'room:analogies:critic', maxAttempts: 2, timeoutMs: 20_000,
  });
  if (criticResult?.error) return { error: criticResult.error };

  const accepted = parseAcceptedIndices(criticResult.text, candidates.length).slice(0, need).map((i) => candidates[i]);
  return { requestedCount, arrivals: accepted };
}

// The last thing HE said — the line an unasked arrival is pinned to in the
// transcript. Falls back to nothing rather than guessing at an assistant turn.
function lastUserMessageId(convoId) {
  const msgs = listMessages(convoId).filter((m) => m.kind === 'chat' && m.role === 'user');
  return msgs.length ? msgs[msgs.length - 1].id : null;
}

async function runUnaskedLook(convoId) {
  const convo = getConvo(convoId);
  if (!convo) return { error: 'not_found' };
  const transcript = transcriptFor(convoId, 6, 900);
  if (!transcript) return { arrivals: [] };
  const ctx = getContext(convoId);

  const result = await runGenerateAndCritic({ transcript, ctx, need: 1 });
  if (result?.error) return { error: result.error };
  if (!result.arrivals.length) return { arrivals: [] };

  const arrivals = result.arrivals.map((c) => toArrivalCard(c, { anchorMessageId: lastUserMessageId(convoId), asked: false }));
  const side = sideThread(convoId, { create: true });
  for (const card of arrivals) addSideMessage(side.id, 'assistant', card.title, card);
  broadcastAll('analogies:updated', { convoId, count: arrivals.length });
  return { arrivals };
}

// ─── The unasked pass ────────────────────────────────────────────────────────
// Fire-and-forget, one look per new turn, and the watermark is advanced as the
// pass is KICKED OFF rather than when it finishes, so a slow or failed look never
// leaves the conversation re-triggering forever. Now offers at most ONE arrival
// (the plan reserves "any number" for a direct ask) and never blocks the living
// subject from updating even when unasked arrivals are switched off.

const _inFlight = new Set();

export function analogyLook(convoId) {
  if (!convoId) return;
  const convo = getConvo(convoId);
  // A side talk is itself the small conversation beside the Room — it does not
  // get a second one of its own beside IT.
  if (!convo || convo.subject_type === 'side') return;

  refreshContextIfNeeded(convo);

  if (_inFlight.has(convoId)) return;
  const steer = getSteer(convoId);
  if (steer.when === 'asked') return; // he turned the unasked pass off
  const seen = convo.analogy_seen_turns || 0;
  const turns = convo.turns || 0;
  if (turns <= seen) return;

  _inFlight.add(convoId);
  db.prepare(`UPDATE convos SET analogy_seen_turns=? WHERE id=?`).run(turns, convoId);
  // Say it is looking before the call, not after: a pane that sits still for two
  // seconds and then jumps reads as broken, and the whole point of this one is
  // that it arrives on its own.
  broadcastAll('analogies:updated', { convoId, running: true });
  setImmediate(async () => {
    try { await runUnaskedLook(convoId); }
    catch (e) { console.error('[room] analogy look failed:', e?.message || e); }
    finally { _inFlight.delete(convoId); broadcastAll('analogies:updated', { convoId }); }
  });
}

// ─── Manual requests — any number, delivered progressively ──────────────────
// His own ask becomes a durable record (a user message in the side thread) that
// a background loop fills in, at most BATCH_CAP arrivals per model call, until
// the exact requested count is stored or the request is stopped/paused. Only one
// request generates at a time per Room conversation; others wait as 'queued'.

function toRequestView(meta) {
  return {
    id: meta.request_id, status: meta.status,
    requested_count: meta.requested_count ?? null,
    delivered_count: meta.delivered_count || 0,
    last_error: meta.last_error || null,
  };
}

function signatureOf(card) { return `${card.left}|${card.right}|${card.title}`.toLowerCase(); }

function inventoryFor(sideId, requestId) {
  const set = new Set();
  listMessages(sideId).forEach((m) => {
    const meta = parseMeta(m.meta);
    if (meta?.kind === 'arrival' && meta.request_id === requestId) set.add(signatureOf(meta));
  });
  return set;
}

// The same inventory, as compact cards the generator/critic can be shown so
// "never repeat this" has something to point at, not just a signature string.
function inventoryCardsFor(sideId, requestId) {
  return listMessages(sideId)
    .map((m) => parseMeta(m.meta))
    .filter((meta) => meta?.kind === 'arrival' && meta.request_id === requestId)
    .map((meta) => ({ left: meta.left, right: meta.right, title: meta.title }));
}

function storeArrivals(sideId, arrivals, meta, startOrdinal) {
  return arrivals.map((card, i) => {
    const full = { ...card, request_id: meta.request_id, ordinal: startOrdinal + i + 1, requested_count: meta.requested_count };
    addSideMessage(sideId, 'assistant', card.title, full);
    return full;
  });
}

// The first call for a fresh request: work out how many he wants (or the
// default), propose a pool, and have the critic pick the first batch — up to
// BATCH_CAP, fewer if the requested count is smaller.
async function interpretAndFirstBatch(meta) {
  const ctx = meta.context_snapshot;
  const result = await runGenerateAndCritic({ ctx, instruction: meta.instruction, need: BATCH_CAP, askCount: true });
  if (result?.error) return { error: result.error };
  const requestedCount = result.requestedCount ?? DEFAULT_COUNT;
  const need = Math.min(BATCH_CAP, requestedCount);
  const arrivals = result.arrivals.slice(0, need).map((c) => toArrivalCard(c, { asked: true }));
  return { requestedCount, arrivals };
}

// A continuation of a request already under way — same instruction, standing
// direction unchanged, and a compact inventory of what has already landed so
// the generator and the critic both avoid repeating it.
async function nextBatch(meta, need, priorInventoryCards) {
  const result = await runGenerateAndCritic({ ctx: meta.context_snapshot, instruction: meta.instruction, need, priorAccepted: priorInventoryCards });
  if (result?.error) return { error: result.error };
  return { arrivals: result.arrivals.map((c) => toArrivalCard(c, { asked: true })) };
}

const _reqInFlight = new Map(); // convoId -> requestMsgId currently generating
function requestBusy(convoId) { return _reqInFlight.has(convoId); }

function findRequestMessage(sideId, requestId) {
  return listMessages(sideId).find((m) => {
    const meta = parseMeta(m.meta);
    return meta?.kind === 'analogy_request' && meta.request_id === requestId;
  }) || null;
}

function nextQueuedRequest(sideId) {
  const msgs = listMessages(sideId).filter((m) => m.role === 'user');
  for (const m of msgs) {
    const meta = parseMeta(m.meta);
    if (meta?.kind === 'analogy_request' && meta.status === 'queued') return m;
  }
  return null;
}

function startNextQueued(convoId, sideId) {
  if (requestBusy(convoId)) return;
  const next = nextQueuedRequest(sideId);
  if (next) runRequest(convoId, sideId, next.id);
}

// A server restart can leave a request stuck at 'running' with nothing actually
// working on it — resumed the moment the pane is opened again (GET /analogies)
// or the server boots (resumeAllStrayRequests below).
function resumeStrayRequests(convoId, sideId) {
  if (requestBusy(convoId)) return;
  const msgs = listMessages(sideId).filter((m) => m.role === 'user');
  const stray = msgs.find((m) => {
    const meta = parseMeta(m.meta);
    return meta?.kind === 'analogy_request' && (meta.status === 'running' || meta.status === 'queued');
  });
  if (stray) runRequest(convoId, sideId, stray.id);
}

// Called once at boot (server/src/index.js) so a request left running when the
// process died last time picks back up without waiting for the pane to reopen.
export function resumeAllStrayRequests() {
  if (!db) return;
  const rows = db.prepare(
    `SELECT DISTINCT convo_id FROM convo_messages WHERE role='user' AND meta LIKE '%analogy_request%'`,
  ).all();
  for (const { convo_id: sideId } of rows) {
    const side = db.prepare(`SELECT subject_id FROM convos WHERE id=? AND subject_type='analogy'`).get(sideId);
    if (side) resumeStrayRequests(side.subject_id, sideId);
  }
}

const MAX_BATCHES_PER_REQUEST = 200; // a runaway guard against a request that never converges, not a product cap

async function runRequest(convoId, sideId, requestMsgId) {
  if (requestBusy(convoId)) return;
  _reqInFlight.set(convoId, requestMsgId);
  try {
    let row = getMessage(requestMsgId);
    if (!row) return;
    let meta = parseMeta(row.meta);
    if (!meta || meta.status === 'cancelled' || meta.status === 'complete') return;

    meta.status = 'running';
    updateMessageMeta(requestMsgId, meta);
    broadcastAll('analogies:updated', { convoId, requestId: meta.request_id, status: 'running', delivered_count: meta.delivered_count, requested_count: meta.requested_count });

    if (meta.requested_count == null) {
      const first = await interpretAndFirstBatch(meta);
      row = getMessage(requestMsgId);
      if (!row) return; // the pane was cleared mid-flight
      meta = parseMeta(row.meta);
      if (meta.status === 'cancelled') return;
      if (first.error) {
        meta.status = 'paused'; meta.last_error = first.error;
        updateMessageMeta(requestMsgId, meta);
        broadcastAll('analogies:updated', { convoId, requestId: meta.request_id, status: 'paused', delivered_count: meta.delivered_count, requested_count: meta.requested_count });
        return;
      }
      meta.requested_count = first.requestedCount;
      const stored = storeArrivals(sideId, first.arrivals, meta, meta.delivered_count);
      meta.delivered_count += stored.length;
      updateMessageMeta(requestMsgId, meta);
      broadcastAll('analogies:updated', { convoId, requestId: meta.request_id, status: 'running', delivered_count: meta.delivered_count, requested_count: meta.requested_count });
    }

    let batches = 0;
    while (meta.delivered_count < meta.requested_count && batches < MAX_BATCHES_PER_REQUEST) {
      batches++;
      row = getMessage(requestMsgId);
      if (!row) return;
      meta = parseMeta(row.meta);
      if (meta.status === 'cancelled') return;

      const need = Math.min(BATCH_CAP, meta.requested_count - meta.delivered_count);
      const inventory = inventoryFor(sideId, meta.request_id);
      const inventoryCards = inventoryCardsFor(sideId, meta.request_id);
      const batch = await nextBatch(meta, need, inventoryCards);

      row = getMessage(requestMsgId);
      if (!row) return;
      meta = parseMeta(row.meta);
      if (meta.status === 'cancelled') return;

      if (batch.error) {
        meta.status = 'paused'; meta.last_error = batch.error;
        updateMessageMeta(requestMsgId, meta);
        broadcastAll('analogies:updated', { convoId, requestId: meta.request_id, status: 'paused', delivered_count: meta.delivered_count, requested_count: meta.requested_count });
        return;
      }
      const deduped = batch.arrivals.filter((a) => !inventory.has(signatureOf(a)));
      if (!deduped.length) {
        meta.status = 'paused'; meta.last_error = 'no_new_arrivals';
        updateMessageMeta(requestMsgId, meta);
        broadcastAll('analogies:updated', { convoId, requestId: meta.request_id, status: 'paused', delivered_count: meta.delivered_count, requested_count: meta.requested_count });
        return;
      }
      const stored = storeArrivals(sideId, deduped, meta, meta.delivered_count);
      meta.delivered_count += stored.length;
      updateMessageMeta(requestMsgId, meta);
      broadcastAll('analogies:updated', { convoId, requestId: meta.request_id, status: 'running', delivered_count: meta.delivered_count, requested_count: meta.requested_count });
    }

    meta.status = meta.delivered_count >= meta.requested_count ? 'complete' : 'paused';
    if (meta.status === 'paused' && !meta.last_error) meta.last_error = 'gave_up';
    updateMessageMeta(requestMsgId, meta);
    broadcastAll('analogies:updated', { convoId, requestId: meta.request_id, status: meta.status, delivered_count: meta.delivered_count, requested_count: meta.requested_count });
  } finally {
    _reqInFlight.delete(convoId);
    startNextQueued(convoId, sideId);
  }
}

// His own question into the side pane. Saved and answered with 202 straight
// away — a request is generated in the background, never inline, so the input
// stays usable and "another twelve" doesn't block on the first one finishing.
export function askAnalogies(convoId, text) {
  if (!db) return { error: 'no_db' };
  if (!getConvo(convoId)) return { error: 'not_found' };
  // 1000 characters cut a real ask in half — he pasted a six-point description of
  // a loop and the pane answered the first half of it (2026-09-13). An ask is the
  // thing being reasoned about, so it gets room.
  const instruction = String(text || '').trim().slice(0, 6000);
  if (!instruction) return { error: 'empty' };

  const side = sideThread(convoId, { create: true });
  const meta = {
    kind: 'analogy_request',
    request_id: randomUUID(),
    requested_count: null,
    delivered_count: 0,
    status: 'queued',
    context_snapshot: snapshotContext(convoId),
    instruction,
    last_error: null,
  };
  addSideMessage(side.id, 'user', instruction, meta);
  broadcastAll('analogies:updated', { convoId, requestId: meta.request_id, status: 'queued', delivered_count: 0, requested_count: null });
  startNextQueued(convoId, side.id);
  return { request: toRequestView(meta) };
}

export function resumeRequest(convoId, requestId) {
  const side = sideThread(convoId);
  const msg = side && findRequestMessage(side.id, requestId);
  if (!msg) return { error: 'not_found' };
  const meta = parseMeta(msg.meta);
  if (meta.status === 'queued' || meta.status === 'running') return { request: toRequestView(meta) }; // idempotent
  if (meta.status === 'paused') {
    meta.status = 'queued'; meta.last_error = null;
    updateMessageMeta(msg.id, meta);
    broadcastAll('analogies:updated', { convoId, requestId, status: 'queued', delivered_count: meta.delivered_count, requested_count: meta.requested_count });
    startNextQueued(convoId, side.id);
  }
  return { request: toRequestView(meta) };
}

export function cancelRequest(convoId, requestId) {
  const side = sideThread(convoId);
  const msg = side && findRequestMessage(side.id, requestId);
  if (!msg) return { error: 'not_found' };
  const meta = parseMeta(msg.meta);
  if (meta.status !== 'complete' && meta.status !== 'cancelled') {
    meta.status = 'cancelled';
    updateMessageMeta(msg.id, meta);
    broadcastAll('analogies:updated', { convoId, requestId, status: 'cancelled', delivered_count: meta.delivered_count, requested_count: meta.requested_count });
  }
  return { request: toRequestView(meta) };
}

// One card off the pane, rather than the whole pane. Analogies are messages in
// the side thread, so removing one is removing its row — and an ask is removed
// with the arrivals it produced, since an ask left alone shows as a question
// nothing answered.
export function forgetAnalogy(convoId, messageId) {
  const side = sideThread(convoId);
  if (!side) return { error: 'not_found' };
  const rows = listMessages(side.id);
  const at = rows.findIndex((m) => m.id === messageId);
  if (at < 0) return { error: 'not_found' };
  const ids = [rows[at].id];
  if (rows[at].role === 'user') {
    for (let i = at + 1; i < rows.length && rows[i].role !== 'user'; i++) ids.push(rows[i].id);
  }
  const marks = ids.map(() => '?').join(',');
  const n = db.prepare(`DELETE FROM convo_messages WHERE convo_id=? AND id IN (${marks})`).run(side.id, ...ids)?.changes || 0;
  broadcastAll('analogies:updated', { convoId });
  return { ok: true, removed: n };
}

function findRequestInstruction(sideId, requestId) {
  if (!requestId) return null;
  const msg = findRequestMessage(sideId, requestId);
  const meta = msg ? parseMeta(msg.meta) : null;
  return meta?.instruction || null;
}

// Swap one card for a fresh one in the same slot — same row, same position,
// same anchor. Runs through the same generator-then-critic pass as every other
// arrival, telling the generator not to repeat what is being replaced.
export async function regenerateAnalogy(convoId, messageId) {
  if (!db) return { error: 'no_db' };
  const side = sideThread(convoId);
  if (!side) return { error: 'not_found' };
  const row = db.prepare(`SELECT * FROM convo_messages WHERE id=? AND convo_id=?`).get(messageId, side.id);
  const oldCard = row ? parseMeta(row.meta) : null;
  if (!row || oldCard?.kind !== 'arrival') return { error: 'not_found' };

  const transcript = transcriptFor(convoId);
  if (!transcript) return { error: 'empty' };
  const ctx = getContext(convoId);
  const instruction = oldCard.asked ? findRequestInstruction(side.id, oldCard.request_id) : null;

  const result = await runGenerateAndCritic({ transcript, ctx, instruction, need: 1, avoid: [oldCard] });
  if (result?.error) return { error: result.error };
  const next = result.arrivals[0];
  if (!next) return { error: 'empty' };

  const full = {
    ...toArrivalCard(next, { anchorMessageId: oldCard.anchor_message_id, asked: oldCard.asked }),
    request_id: oldCard.request_id, ordinal: oldCard.ordinal, requested_count: oldCard.requested_count,
  };
  db.prepare(`UPDATE convo_messages SET text=?, meta=? WHERE id=?`).run(full.title, JSON.stringify(full), messageId);
  broadcastAll('analogies:updated', { convoId });
  return { ok: true, card: full };
}

export function clearAnalogies(convoId) {
  const side = sideThread(convoId);
  if (!side) return { cleared: 0 };
  listMessages(side.id).filter((m) => m.role === 'user').forEach((m) => {
    const meta = parseMeta(m.meta);
    if (meta?.kind === 'analogy_request' && (meta.status === 'queued' || meta.status === 'running')) {
      meta.status = 'cancelled';
      updateMessageMeta(m.id, meta);
    }
  });
  const n = db.prepare(`DELETE FROM convo_messages WHERE convo_id=?`).run(side.id)?.changes || 0;
  broadcastAll('analogies:updated', { convoId });
  return { cleared: n };
}
