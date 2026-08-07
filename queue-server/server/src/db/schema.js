// Database schema for the FMCNS work queue (ported from the Orisha "Travaux" spec, §4/§10).
// Additive + idempotent: CREATE TABLE IF NOT EXISTS, ALTER TABLE wrapped in try/catch, run on
// every boot. Safe to call repeatedly.
//
// Uses Node's built-in `node:sqlite` (stable-ish since Node 22.5, still flagged experimental)
// instead of better-sqlite3 — same synchronous API shape, but no native addon to compile, which
// makes both this sandbox and Railway's build step far more reliable. Swap to Postgres later if
// FMCNS ever needs multi-instance or a Railway volume turns out to be a hassle (see README).
//
// Seam vs. the original spec: DB_PATH is env-configurable (§10.1) instead of a hard-coded path.

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'queue.db');

export function openDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  initSchema(db);
  initOntologySchema(db);
  initChatSchema(db);
  initKnowledgeSchema(db);
  return db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
  db.prepare(`INSERT OR IGNORE INTO users (id, name) VALUES ('antoine', 'Antoine')`).run();

  db.exec(`
    CREATE TABLE IF NOT EXISTS work_prompts (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK(status IN ('queued','running','done','blocked','paused','cancelled')),
      position REAL NOT NULL DEFAULT 0,
      same_context INTEGER NOT NULL DEFAULT 0,
      mode TEXT NOT NULL DEFAULT 'implement' CHECK(mode IN ('implement','question')),
      preset TEXT NOT NULL DEFAULT 'deep',
      agent_task_id TEXT,
      session_id TEXT,
      suggestion_id TEXT,
      created_by TEXT REFERENCES users(id),
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      started_at TEXT,
      completed_at TEXT,
      deleted_at TEXT
    )
  `);
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_work_prompts_status ON work_prompts(status, position)`); } catch {}
  try { db.exec(`ALTER TABLE work_prompts ADD COLUMN title_auto INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { db.exec(`ALTER TABLE work_prompts ADD COLUMN pending_question TEXT`); } catch {}
  try { db.exec(`ALTER TABLE work_prompts ADD COLUMN stop_after INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { db.exec(`ALTER TABLE work_prompts ADD COLUMN space TEXT NOT NULL DEFAULT 'fmcns'`); } catch {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS work_prompt_messages (
      id TEXT PRIMARY KEY,
      prompt_id TEXT NOT NULL REFERENCES work_prompts(id),
      role TEXT NOT NULL CHECK(role IN ('user','agent')),
      text TEXT NOT NULL,
      agent_task_id TEXT,
      author TEXT REFERENCES users(id),
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_work_prompt_msgs ON work_prompt_messages(prompt_id, created_at)`); } catch {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS work_suggestions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      rationale TEXT,
      prompt TEXT NOT NULL,
      area TEXT,
      kind TEXT NOT NULL DEFAULT 'chantier',
      status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','accepted','dismissed')),
      fingerprint TEXT NOT NULL,
      work_prompt_id TEXT,
      dismissed_reason TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `);
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_work_suggestions_fp ON work_suggestions(fingerprint)`); } catch {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS work_ideas (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      notes TEXT,
      tag TEXT,
      position REAL NOT NULL DEFAULT 0,
      work_prompt_id TEXT,
      created_by TEXT REFERENCES users(id),
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `);
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_work_ideas_pos ON work_ideas(position)`); } catch {}
}

// ─── FMCNS ontology tables (shared with the task queue's DB, per user decision) ──
// One generic `entities` table for characters, films, and countries alike — this is
// the first real step toward the "character as universal ontological unit" reframe
// from BUILD_STATUS.md's open threads: everything (individual, film-container,
// nation) is a row here, differentiated by `type` and `scale`, not a separate table
// per domain. Tags and continuum scores are separate tables so an entity can carry
// any number of either without schema changes.
export function initOntologySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('character','film','country')),
      name TEXT NOT NULL,
      scale TEXT NOT NULL DEFAULT 'individual',
      container_id TEXT REFERENCES entities(id),
      clusters TEXT,
      grounded INTEGER NOT NULL DEFAULT 0,
      meta TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type)`); } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_container ON entities(container_id)`); } catch {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_tags (
      entity_id TEXT NOT NULL REFERENCES entities(id),
      tag TEXT NOT NULL,
      PRIMARY KEY (entity_id, tag)
    )
  `);
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_entity_tags_tag ON entity_tags(tag)`); } catch {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS continuum_axes (
      key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      low TEXT,
      high TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_continuum (
      entity_id TEXT NOT NULL REFERENCES entities(id),
      axis_key TEXT NOT NULL REFERENCES continuum_axes(key),
      value REAL NOT NULL,
      PRIMARY KEY (entity_id, axis_key)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS clusters (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      grounding_status TEXT
    )
  `);
}

// ─── Embedded assistant: chat memory + attachments ─────────────────────────────
// Persistent so each new app session can pull in past context instead of the user
// re-explaining things. Retrieval logic (what counts as "relevant") can get
// smarter later — this just makes sure everything is captured now so nothing is
// lost while that logic is still simple.
export function initChatSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      -- Rolling summary of the session, regenerated periodically. Simple/placeholder
      -- for now (see chat.js) — the schema is ready for a smarter summarizer later.
      summary TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated ON chat_sessions(updated_at)`); } catch {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES chat_sessions(id),
      role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      text TEXT NOT NULL DEFAULT '',
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, created_at)`); } catch {}

  // PDFs uploaded alongside a message. Stored as base64 directly in the DB (small
  // personal-scale use, and simpler than wiring up separate file storage on
  // Railway's ephemeral filesystem) — revisit if volume ever gets large.
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_attachments (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES chat_sessions(id),
      message_id TEXT REFERENCES chat_messages(id),
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'application/pdf',
      data_base64 TEXT NOT NULL,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_attachments_session ON chat_attachments(session_id)`); } catch {}
}

// ─── Knowledge base: full reference documents for the embedded assistant ───────
// The chat's system prompt is a CONDENSED summary of the project (kept short so
// every turn doesn't pay for it). The full source documents live here instead, and
// the assistant pulls them on demand via a tool (see chat.js) — this is the
// difference between "knows the paradigm" (system prompt) and "can go read the
// primary source when it matters" (this table).
export function initKnowledgeSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_docs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL UNIQUE,
      description TEXT,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
}
