// Embedded FMCNS assistant — a fresh Claude API connection (not the Cowork session
// that built this app) with tool access to the live ontology database, plus
// persistent memory across app sessions and native PDF upload support.
//
// Memory design: every session's messages are stored (chat_messages). When a new
// session starts, it's primed with a short "prior context" block built from recent
// past sessions' summaries (or, if a session has no summary yet, its last few
// messages). Summary generation here is intentionally simple (see summarizeSession)
// — the storage and priming plumbing is the part that had to exist from day one;
// a smarter summarizer can replace summarizeSession() later without touching schema
// or the priming logic that reads it.
//
// PDF uploads: the Anthropic API accepts PDFs as native "document" content blocks.
// Attachments are stored as base64 in chat_attachments and passed through as-is.

import { randomUUID } from 'node:crypto';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CHAT_MODEL = process.env.CHAT_MODEL || 'claude-sonnet-4-5';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const PRIMING_SESSION_LIMIT = 5;

const SYSTEM_PROMPT = `You are the embedded assistant inside FMCNS (Fractal Mythic Consciousness Navigation System), a private research platform mapping archetypal patterns across scales — individual, family, institution, nation, civilization — through film, geography, and myth.

Core framework, condensed:
- Three layers: ONTOLOGICAL (the formal graph — entities, types, edges; what exists and connects), SEMANTIC (meaning/resonance — tags, archetypal charge, interpretive content), ANALOGICAL (cross-scale pattern mappings — which structure at one scale mirrors which structure at another, e.g. "a follower is to a cult leader as a citizen is to a tyrant").
- Integration Continuum: every entity can be scored on named axes (e.g. Guilt-as-Engine: Ascetic Self-Destruction <-> Integrated Accountability; Possession <-> Sovereign Otherness) marking its position between a shadow pole and an integrated pole.
- Scale Echo: the core mechanism — given a pattern active at one scale, find its structural echoes at every other scale, regardless of surface similarity.
- "Character" is the emerging universal unit: individuals, films-as-containers, and nations are all entities in one schema, differentiated by type/scale, not separate systems.
- Entities are tagged "grounded" (derived from real source material the user has provided) vs. reasoned (your own inference) — always say which when it matters, never blur the two.

You have tools to query the live database: search entities, fetch one entity with full detail (tags, continuum scores, container/children), list clusters, list continuum axes, find entities near a given continuum value, and list/read the full reference documents (the complete ontology doc, films master list, and the source archive that grounded the film analysis). Use them for anything specific rather than guessing from this prompt — this prompt gives you the paradigm, the tools give you the current facts and the primary sources.

You may also receive PDF documents the user uploaded directly in this message — read them natively.

Be direct and concise. If something isn't in the data, say so rather than inventing it.`;

const TOOLS = [
  {
    name: 'search_entities',
    description: 'Search/filter entities (characters, films, countries) by type, cluster, tag, name substring, or grounded status.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['character', 'film', 'country'] },
        cluster: { type: 'string', description: 'Cluster code, e.g. "I" or "II"' },
        tag: { type: 'string' },
        name: { type: 'string', description: 'Substring match on entity name' },
        grounded: { type: 'boolean' },
      },
    },
  },
  {
    name: 'get_entity',
    description: "Fetch one entity by id with full detail: tags, continuum scores, container entity (e.g. a character's film), and children (e.g. a film's characters).",
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'list_clusters',
    description: 'List all thematic clusters with their grounding status (grounded vs. reasoned).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_continuum_axes',
    description: 'List all Integration Continuum axes defined so far, with their two poles.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'nearby_on_axis',
    description: 'Find entities whose score on a given continuum axis is closest to a target value — useful for "what else scores like X".',
    input_schema: {
      type: 'object',
      properties: { axis_key: { type: 'string' }, value: { type: 'number' }, limit: { type: 'number' } },
      required: ['axis_key', 'value'],
    },
  },
  {
    name: 'list_knowledge_docs',
    description: 'List the full reference documents available beyond this system prompt (the full ontology doc, films master list, and the source archive that grounded the film analysis). Returns titles and descriptions only, not content.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'read_knowledge_doc',
    description: 'Read a reference document in full or a slice of it by title (from list_knowledge_docs). The source archive is large (~750k tokens) — prefer offset/length to read a portion rather than the whole thing unless truly needed.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        offset: { type: 'number', description: 'Character offset to start from. Default 0.' },
        length: { type: 'number', description: 'Max characters to return. Default 20000.' },
      },
      required: ['title'],
    },
  },
];

// ─── Session storage ────────────────────────────────────────────────────────────
export function createSession(db, { title = null } = {}) {
  const id = randomUUID();
  db.prepare(`INSERT INTO chat_sessions (id, title) VALUES (?, ?)`).run(id, title);
  return getSession(db, id);
}
export function getSession(db, id) {
  return db.prepare(`SELECT * FROM chat_sessions WHERE id=?`).get(id) || null;
}
export function listSessions(db, limit = 50) {
  return db.prepare(`SELECT * FROM chat_sessions ORDER BY updated_at DESC LIMIT ?`).all(limit);
}
export function listMessages(db, sessionId) {
  return db.prepare(`SELECT * FROM chat_messages WHERE session_id=? ORDER BY created_at`).all(sessionId);
}
function addMessage(db, sessionId, role, text) {
  const id = randomUUID();
  db.prepare(`INSERT INTO chat_messages (id, session_id, role, text) VALUES (?,?,?,?)`).run(id, sessionId, role, text);
  db.prepare(`UPDATE chat_sessions SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(sessionId);
  return id;
}
function storeAttachment(db, sessionId, messageId, { filename, mimeType, dataBase64 }) {
  const id = randomUUID();
  db.prepare(`INSERT INTO chat_attachments (id, session_id, message_id, filename, mime_type, data_base64) VALUES (?,?,?,?,?,?)`)
    .run(id, sessionId, messageId, filename, mimeType || 'application/pdf', dataBase64);
  return id;
}

// Simple placeholder summarizer: takes the last handful of messages and truncates.
// Deliberately not an extra API call (keeps this cheap and synchronous) — swap for
// a real toollless-Claude summarization pass later without touching callers.
function summarizeSession(db, sessionId) {
  const messages = listMessages(db, sessionId);
  if (!messages.length) return null;
  const text = messages.slice(-8).map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`).join('\n');
  return text.length > 1500 ? text.slice(-1500) : text;
}
export function touchSessionSummary(db, sessionId) {
  const summary = summarizeSession(db, sessionId);
  if (summary) db.prepare(`UPDATE chat_sessions SET summary=? WHERE id=?`).run(summary, sessionId);
  return summary;
}

// What a NEW session gets primed with: recent past sessions' summaries (or their
// last few messages if no summary exists yet), oldest to newest. This is the
// "don't make me re-explain everything" mechanism.
export function buildPriorContext(db, excludeSessionId = null) {
  const sessions = listSessions(db, PRIMING_SESSION_LIMIT + 1).filter((s) => s.id !== excludeSessionId).slice(0, PRIMING_SESSION_LIMIT);
  if (!sessions.length) return '';
  const blocks = sessions.reverse().map((s) => {
    const summary = s.summary || summarizeSession(db, s.id);
    if (!summary) return null;
    return `--- Session from ${s.created_at}${s.title ? ` ("${s.title}")` : ''} ---\n${summary}`;
  }).filter(Boolean);
  if (!blocks.length) return '';
  return `\n\nPrior context from recent sessions (most recent last), so you don't need to be re-briefed from scratch:\n\n${blocks.join('\n\n')}`;
}

// ─── Knowledge base ─────────────────────────────────────────────────────────────
function listKnowledgeDocs(db) {
  return db.prepare(`SELECT title, description, length(content) AS chars FROM knowledge_docs`).all();
}
function readKnowledgeDoc(db, title, offset, length) {
  const row = db.prepare(`SELECT content FROM knowledge_docs WHERE title=?`).get(title);
  if (!row) return { error: 'not_found', available: db.prepare(`SELECT title FROM knowledge_docs`).all().map((r) => r.title) };
  const content = row.content;
  return {
    title, offset, length: Math.min(length, content.length - offset),
    total_chars: content.length,
    has_more: offset + length < content.length,
    text: content.slice(offset, offset + length),
  };
}

// ─── Chat turn ───────────────────────────────────────────────────────────────────
export function makeChatHandler(db) {
  return async function handleChat({ sessionId, text, attachments = [] }) {
    if (!ANTHROPIC_API_KEY) return { error: 'no_api_key', message: 'ANTHROPIC_API_KEY is not set on the server.' };
    if (!sessionId || !getSession(db, sessionId)) return { error: 'invalid_session' };

    const q = await import('./ontologyQuery.js');
    const dispatch = (name, input) => {
      switch (name) {
        case 'search_entities': return q.searchEntities(db, input || {});
        case 'get_entity': return q.getEntity(db, input.id);
        case 'list_clusters': return q.listClusters(db);
        case 'list_continuum_axes': return q.listContinuumAxes(db);
        case 'nearby_on_axis': return q.nearbyOnAxis(db, input.axis_key, input.value, input.limit || 10);
        case 'list_knowledge_docs': return listKnowledgeDocs(db);
        case 'read_knowledge_doc': return readKnowledgeDoc(db, input.title, input.offset || 0, input.length || 20000);
        default: return { error: `unknown tool: ${name}` };
      }
    };

    const userMessageId = addMessage(db, sessionId, 'user', text);
    for (const att of attachments) storeAttachment(db, sessionId, userMessageId, att);

    // Build the user turn's content: PDFs as native document blocks, then the text.
    const userContent = [
      ...attachments.map((att) => ({
        type: 'document',
        source: { type: 'base64', media_type: att.mimeType || 'application/pdf', data: att.dataBase64 },
      })),
      { type: 'text', text },
    ];

    // Prior turns in THIS session, replayed as plain text (attachments aren't
    // re-sent on later turns — only their content mattered at the time).
    const history = listMessages(db, sessionId).slice(0, -1).map((m) => ({
      role: m.role, content: m.text,
    }));

    const priorContext = buildPriorContext(db, sessionId);
    const system = SYSTEM_PROMPT + priorContext;

    let messages = [...history, { role: 'user', content: userContent }];
    let finalText = '';
    for (let round = 0; round < 6; round++) {
      let resp;
      try {
        resp = await fetch(ANTHROPIC_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: CHAT_MODEL, max_tokens: 1500, system, tools: TOOLS, messages }),
        });
      } catch (e) {
        // Network failure reaching the API — return a clean error instead of letting
        // an unhandled rejection crash the whole server (it did, once, before this).
        return { error: 'network_error', message: `Could not reach the Anthropic API: ${e.message}` };
      }
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        return { error: 'api_error', message: `Anthropic API HTTP ${resp.status}: ${errText.slice(0, 500)}` };
      }
      const data = await resp.json();
      const toolUses = (data.content || []).filter((b) => b.type === 'tool_use');
      if (!toolUses.length) {
        finalText = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        break;
      }
      messages.push({ role: 'assistant', content: data.content });
      const toolResults = toolUses.map((tu) => {
        let result;
        try { result = dispatch(tu.name, tu.input); } catch (e) { result = { error: e.message }; }
        return { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result ?? null).slice(0, 8000) };
      });
      messages.push({ role: 'user', content: toolResults });
    }

    if (!finalText) return { error: 'too_many_tool_rounds' };
    addMessage(db, sessionId, 'assistant', finalText);
    touchSessionSummary(db, sessionId);
    return { text: finalText, sessionId };
  };
}
