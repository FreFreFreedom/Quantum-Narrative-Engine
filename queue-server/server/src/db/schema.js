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

// Falls back to the Railway volume mount (auto-injected whenever a volume is attached)
// before process.cwd(), so the DB lands on durable storage by default even if DB_PATH is
// never explicitly set — process.cwd() alone sits in the container's ephemeral filesystem
// and gets wiped on every redeploy on Railway's free tier.
export const DB_PATH = process.env.DB_PATH || path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || process.cwd(), 'data', 'queue.db');

export function openDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  initSchema(db);
  initOntologySchema(db);
  initChatSchema(db);
  initKnowledgeSchema(db);
  initBooksSchema(db);
  initArchitectureSchema(db);
  initTagLensSchema(db);
  initTagPatternSchema(db);
  initBookDetailSchema(db);
  initDiscoverySchema(db);
  initConversationsSchema(db);
  initFilmEnrichmentSchema(db);
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
  try { db.exec(`ALTER TABLE work_prompts ADD COLUMN component_id TEXT`); } catch {}
  // Credit-saving: counts how many times this task's session has been continued
  // (reply/steer) without a fresh start. Each continuation both resumed the CLI
  // session (which already carries the full transcript) AND re-sent the whole
  // thread as prompt text, so cost grew with every reply, compounding the longer a
  // conversation went on. Past a threshold the chain auto-resets to a fresh session
  // with a short recap instead of unbounded growth (see promptQueue.js).
  try { db.exec(`ALTER TABLE work_prompts ADD COLUMN context_turns INTEGER NOT NULL DEFAULT 0`); } catch {}
  // Cost policy (modelPolicy.js): when preset='auto', the concrete tier the judge picked,
  // remembered here so replies/retries reuse the decision instead of re-judging every turn.
  try { db.exec(`ALTER TABLE work_prompts ADD COLUMN resolved_preset TEXT`); } catch {}
  // Per-run cost visibility, read out of the CLI's own stream-json result line
  // (taskRunner.js extractUsage()) — nothing computed, just surfaced.
  try { db.exec(`ALTER TABLE work_prompts ADD COLUMN cost_usd REAL`); } catch {}
  try { db.exec(`ALTER TABLE work_prompts ADD COLUMN tokens_in INTEGER`); } catch {}
  try { db.exec(`ALTER TABLE work_prompts ADD COLUMN tokens_out INTEGER`); } catch {}
  try { db.exec(`ALTER TABLE work_prompts ADD COLUMN run_model TEXT`); } catch {}
  // Execution provider ('claude-code' | 'opencode') — which CLI actually runs this
  // prompt. Defaults to claude-code so every pre-existing row keeps behaving exactly
  // as before (a missing value IS claude-code). provider_model is the concrete
  // OpenCode model id (e.g. 'opencode/deepseek-v4-flash-free') the user picked for
  // this task; ignored for claude-code rows.
  try { db.exec(`ALTER TABLE work_prompts ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude-code'`); } catch {}
  try { db.exec(`ALTER TABLE work_prompts ADD COLUMN provider_model TEXT`); } catch {}
  // OpenCode's own session id, for `opencode run --session` continuation. Separate
  // from session_id (Claude's) because the two CLIs have incompatible session
  // stores — a session is only ever resumable by the provider that created it.
  try { db.exec(`ALTER TABLE work_prompts ADD COLUMN opencode_session_id TEXT`); } catch {}
  // Agent roster link (plan Part 1): which agent this prompt is assigned to.
  // NULL → the runner falls back to 'dev1'. ALTER, not in the CREATE, so
  // pre-existing rows get NULL and behave exactly as before. The REFERENCES is
  // validated by node:sqlite (FKs on by default): an unknown agent key is
  // rejected at insert time rather than silently dispatching to dev1.
  try { db.exec(`ALTER TABLE work_prompts ADD COLUMN agent_key TEXT REFERENCES agents(key)`); } catch {}
  // Explicit continuation link (plan 2d): the prompt row this one chains onto
  // ("Continuer : ⟨titre⟩" dropdown). Replaces the positional same_context
  // inference, which breaks under parallelism — with several agents interleaved,
  // "the previous row in this space" is somebody else's task. NULL = fresh
  // session (the backfill value for every existing row).
  try { db.exec(`ALTER TABLE work_prompts ADD COLUMN parent_prompt_id TEXT REFERENCES work_prompts(id)`); } catch {}
  // Plan-first queue (plan "plan-first-queue-and-idea-composition", Part A): every
  // implement-mode task is auto-drafted into an unambiguous brief before it runs.
  // raw_prompt keeps what was actually submitted (for the "Originally submitted"
  // toggle); plan_source lets a future caller that already produced a deliberated
  // plan (e.g. a finished conversation handoff) opt out with 'skip' instead of
  // paying for a redundant second drafting pass. plan_pending is a plain flag, not
  // a new status value — status stays 'queued'/'paused' as set at creation time,
  // and advanceQueue()'s queued-selection queries skip rows still drafting, the
  // same pattern already used for resume_after. This avoids touching the
  // work_prompts.status CHECK constraint, which SQLite cannot ALTER in place.
  try { db.exec(`ALTER TABLE work_prompts ADD COLUMN raw_prompt TEXT`); } catch {}
  try { db.exec(`ALTER TABLE work_prompts ADD COLUMN plan_source TEXT DEFAULT 'auto'`); } catch {}
  try { db.exec(`ALTER TABLE work_prompts ADD COLUMN plan_pending INTEGER NOT NULL DEFAULT 0`); } catch {}
  // Link a Dispatch Queue task back to the conversation that produced it (Idea Studio
  // handoff — see plans/universal-conversations-core-architecture.md §7).
  try { db.exec(`ALTER TABLE work_prompts ADD COLUMN convo_id TEXT`); } catch {}
  try { db.exec(`ALTER TABLE work_prompts ADD COLUMN seen_at TEXT`); } catch {}

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

  // Agent task executions — the runner's own record, previously a JSON file
  // (data/agent-tasks.json). Moved to SQLite because an unlocked whole-file
  // read-modify-write loses writes when two tasks finalize in the same tick;
  // node:sqlite serializes writes for free (see plan 2c).
  // run_state is the PROCESS state (idle|dispatched|working|awaiting_input|stopped)
  // orthogonal to status (approved|in_progress|done|blocked|cancelled) — lets the
  // UI tell a wedged agent from a busy one (plan Part 3, trimmed to 5 states).
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_tasks (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'queue',
      mode TEXT NOT NULL DEFAULT 'implement',
      agent_key TEXT REFERENCES agents(key),
      title TEXT,
      description TEXT,
      author TEXT,
      status TEXT NOT NULL DEFAULT 'approved',
      run_state TEXT NOT NULL DEFAULT 'idle',
      model TEXT,
      effort TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      provider TEXT NOT NULL DEFAULT 'claude-code',
      provider_model TEXT,
      run_model TEXT,
      tried_models TEXT,
      agent_result TEXT,
      user_summary TEXT,
      pending_question TEXT,
      missed_user_message TEXT,
      work_prompt_id TEXT,
      resume_session_id TEXT,
      session_id TEXT,
      worktree_path TEXT,
      branch TEXT,
      base_sha TEXT,
      stop_requested INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL,
      tokens_in INTEGER,
      tokens_out INTEGER,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      started_at TEXT,
      completed_at TEXT,
      heartbeat_at TEXT
    )
  `);
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_tasks_queue ON agent_tasks(status, kind, priority, created_at)`); } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_tasks_prompt ON agent_tasks(work_prompt_id)`); } catch {}

  // The agent roster, as data (plan Part 1). Created here BEFORE agent_tasks
  // because node:sqlite enforces foreign keys by default — the REFERENCES above
  // needs the table to exist. Seeded with the roster rows in step 3
  // (services/agents.js + bootstrapData); an empty roster here changes nothing.
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      key            TEXT PRIMARY KEY,
      label          TEXT NOT NULL,
      emoji          TEXT,
      role           TEXT NOT NULL DEFAULT 'dev'
                     CHECK(role IN ('research','dev','design','test','reviewer','integrator')),
      persona        TEXT NOT NULL DEFAULT '',
      brief_file     TEXT,
      provider       TEXT NOT NULL DEFAULT 'claude-code',
      provider_model TEXT,
      preset         TEXT NOT NULL DEFAULT 'standard',
      tools          TEXT NOT NULL DEFAULT 'Bash,Read,Write,Edit,Glob,Grep',
      path_allow     TEXT NOT NULL DEFAULT '["**"]',
      path_deny      TEXT NOT NULL DEFAULT '[]',
      max_parallel   INTEGER NOT NULL DEFAULT 1,
      enabled        INTEGER NOT NULL DEFAULT 1,
      paused         INTEGER NOT NULL DEFAULT 0,
      sort_order     REAL NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);
  // Seed the two developer agents (step 3 scope — the full roster arrives in a
  // later step). Seeded HERE rather than in bootstrapData.js because agent_tasks
  // rows (legacy import + live queue) carry a REFERENCES agents(key) FK — the rows
  // must exist before the first task is ever inserted, and openDb() runs before
  // the bootstrap pass. INSERT OR IGNORE: a UI edit to an agent is never clobbered.
  db.exec(`
    INSERT OR IGNORE INTO agents (key, label, emoji, role, persona, brief_file, provider, provider_model, preset, tools, path_allow, path_deny, max_parallel, enabled, paused, sort_order)
    VALUES
      ('dev1', 'Developer 1', '👨‍💻', 'dev', 'Generalist implementer — the default agent for new tasks.', '.agents/roles/dev.md', 'claude-code', NULL, 'standard', 'Bash,Read,Write,Edit,Glob,Grep', '["**"]', '[]', 1, 1, 0, 1),
      ('dev2', 'Developer 2', '👩‍💻', 'dev', 'Second implementer — runs in parallel with Developer 1 on its own worktree.', '.agents/roles/dev.md', 'opencode', NULL, 'standard', 'Bash,Read,Write,Edit,Glob,Grep', '["**"]', '[]', 1, 1, 0, 2)
  `);
  // Backfill brief_file on rows seeded before step 6 (INSERT OR IGNORE never
  // clobbers a UI edit — this only fills NULLs for the two default devs).
  try {
    db.prepare(`UPDATE agents SET brief_file='.agents/roles/dev.md' WHERE key IN ('dev1','dev2') AND brief_file IS NULL`).run();
  } catch {}

  // ─── Reviews — the merge gate (plan Part 4, step 5) ───────────────────────────
  // One row per finished dev/design task whose branch reached the review stage.
  // status is the HUMAN-facing lifecycle: pending → approved | changes_requested |
  // rejected | merged | reverted. checks holds the five deterministic check results
  // as JSON; verdict is the machine verdict (safe|risky|unsafe) — the model second
  // opinion is step 9 scope, so for now verdict derives from the checks alone.
  db.exec(`
    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      prompt_id TEXT NOT NULL REFERENCES work_prompts(id),
      task_id TEXT REFERENCES agent_tasks(id),
      agent_key TEXT,
      branch TEXT NOT NULL, base_sha TEXT, head_sha TEXT,
      status TEXT NOT NULL DEFAULT 'pending',   -- pending|approved|changes_requested|rejected|merged|reverted
      verdict TEXT,                             -- safe|risky|unsafe
      plain_summary TEXT,                       -- French, for the human
      concerns TEXT,                            -- JSON array
      checks TEXT,                              -- JSON {syntax,boot,endpoints,html,scope,conflict}
      files_changed TEXT, insertions INTEGER, deletions INTEGER,
      conflicts_with TEXT,                      -- JSON array of branch names
      reviewer_task_id TEXT,
      merge_commit TEXT, merged_at TEXT, reverted_at TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status)`); } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_reviews_prompt ON reviews(prompt_id)`); } catch {}

  // ─── Collaboration strategies: task_stages + work_prompts strategy columns (plan Part 4B, P7) ───────
  // task_stages holds the stage machine for multi-agent flows. Each row is one stage
  // (research|build|test|judge|integrate) within a prompt. Stages at the SAME ordinal
  // run CONCURRENTLY (e.g. two build variants in Competition). A judge stage (ordinal 2)
  // waits for all ordinal-1 stages to complete.
  // Strategy state on work_prompts tracks the overall flow: idle|running|awaiting_choice|done|abandoned.
  try { db.exec(`ALTER TABLE work_prompts ADD COLUMN strategy TEXT DEFAULT 'single'`); } catch {}
  try { db.exec(`ALTER TABLE work_prompts ADD COLUMN strategy_state TEXT DEFAULT 'idle'`); } catch {}

  // Deferral with a known reset time (plan "Always-On Models"): when every model in
  // the fallback chain is exhausted, a prompt is parked here instead of just being
  // requeued and immediately retried — quotaScheduler.js clears it once resume_after
  // passes.
  try { db.exec(`ALTER TABLE work_prompts ADD COLUMN resume_after TEXT`); } catch {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS task_stages (
      id TEXT PRIMARY KEY,
      prompt_id  TEXT NOT NULL REFERENCES work_prompts(id),
      stage      TEXT NOT NULL,        -- 'research'|'build'|'test'|'judge'|'integrate'
      ordinal    INTEGER NOT NULL,     -- execution order; equal ordinals run CONCURRENTLY
      variant    TEXT,                 -- 'A'|'B' in competition, NULL otherwise
      agent_key  TEXT REFERENCES agents(key),
      agent_task_id TEXT,              -- the actual run
      branch     TEXT, worktree_path TEXT,
      status     TEXT NOT NULL DEFAULT 'pending',
                 -- pending|running|done|blocked|skipped|lost|won
      input_json TEXT,                 -- what this stage was handed (e.g. the research brief)
      output_text TEXT,                -- the stage's distilled output, fed forward
      verdict_json TEXT,               -- judge stages only
      cost_usd REAL,
      created_at TEXT, started_at TEXT, completed_at TEXT
    )
  `);
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_task_stages ON task_stages(prompt_id, ordinal)`); } catch {}

  // ─── AI Settings (plan Part 7R) ───────────────────────────────────────────────
  // Single-row table (id='global') holding the platform-wide provider configuration.
  // All feature work-types reference this for defaults; per-task overrides remain in
  // the queue form. Idempotent CREATE + seed with sane free-first defaults.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_settings (
      id TEXT PRIMARY KEY DEFAULT 'global',
      -- Per-work-type default model (feature -> {provider, model, preset})
      defaults_json TEXT NOT NULL DEFAULT '{}',
      -- Provider health cache (updated by /api/travaux/providers polling)
      health_json TEXT NOT NULL DEFAULT '{}',
      -- Global policy when a provider is exhausted: 'auto_free' | 'manual_only'
      quota_policy TEXT NOT NULL DEFAULT 'auto_free',
      -- Per-provider cooldown until timestamp (ISO) when limit was hit
      cooldown_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);
  // Backfill: ensure the single row exists (idempotent, harmless on existing DBs).
  try { db.prepare(`INSERT OR IGNORE INTO ai_settings (id, defaults_json, health_json, quota_policy, cooldown_json) VALUES ('global', '{}', '{}', 'auto_free', '{}')`).run(); } catch {}
  // Self-aware platform (plan self-aware-platform.md):
  // - queue_go_budget_usd: daily cap on the paid OpenCode Go lane for the task
  //   queue. 0 = no guard. Default ≈ 1/30th of the ~10 USD/month plan.
  // - intel_json: intelligence engine budget (e.g. { thoughts_per_hour: 2 }).
  try { db.exec(`ALTER TABLE ai_settings ADD COLUMN queue_go_budget_usd REAL NOT NULL DEFAULT 0.33`); } catch {}
  try { db.exec(`ALTER TABLE ai_settings ADD COLUMN intel_json TEXT NOT NULL DEFAULT '{}'`); } catch {}

  // ─── Quota-exhaustion ledger (plan "Always-On Models") ───────────────────────
  // provider_quota_ledger: append-only history of every exhaustion event, so the
  // router can defer work with a KNOWN reset time instead of discovering
  // exhaustion mid-task. provider_quota_state: denormalised one-row-per
  // provider+model fast lookup, read on every routing decision.
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_quota_ledger (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      model TEXT,
      scope TEXT NOT NULL DEFAULT 'provider',   -- 'provider'|'model'|'key'
      exhausted_at TEXT NOT NULL,
      resets_at TEXT,
      resets_known INTEGER NOT NULL DEFAULT 0,
      reason TEXT,
      detected_by TEXT,                         -- 'text'|'queue'|'chat'
      evidence TEXT,
      cleared_at TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_quota_ledger_provider_resets ON provider_quota_ledger(provider_id, resets_at)`); } catch {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_quota_state (
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      exhausted INTEGER NOT NULL DEFAULT 0,
      resets_at TEXT,
      resets_known INTEGER NOT NULL DEFAULT 0,
      last_event_id TEXT,
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (provider_id, model)
    )
  `);
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_quota_state_enabled ON provider_quota_state(exhausted, resets_at)`); } catch {}

  // ─── Intelligence thoughts (plan self-aware-platform.md, Part 4) ─────────────
  // Durable thought files: what the platform noticed about its own architecture
  // (mechanical signals are computed live and not stored; deliberative thoughts
  // are model-generated and persisted here with a state_hash so the same state
  // is never re-thought). status: new -> accepted (linked to a paused Flow task
  // via work_prompt_id) | dismissed (kept for the record, not re-proposed).
  db.exec(`
    CREATE TABLE IF NOT EXISTS intel_thoughts (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'mechanical' CHECK(kind IN ('mechanical','deliberative')),
      scope TEXT NOT NULL DEFAULT 'node' CHECK(scope IN ('node','graph','content')),
      target_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      prompt_draft TEXT,
      state_hash TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','accepted','dismissed','adopted')),
      work_prompt_id TEXT,
      dismissed_reason TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      deleted_at TEXT
    )
  `);
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_intel_thoughts_dedup ON intel_thoughts(scope, target_id, kind, state_hash) WHERE deleted_at IS NULL AND state_hash IS NOT NULL`); } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_intel_thoughts_feed ON intel_thoughts(status, created_at)`); } catch {}

  // ─── Intelligence round 2 (plan self-aware-platform.md, Parts 3 & 6) ─────────
  // intel_signal_acknowledgements: one-click "intentional, not a problem" — once a
  // signal type is acknowledged for a target it is filtered out forever (6.2).
  db.exec(`
    CREATE TABLE IF NOT EXISTS intel_signal_acknowledgements (
      id TEXT PRIMARY KEY,
      signal_type TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'node',
      target_id TEXT NOT NULL DEFAULT '',
      reason TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_intel_acks ON intel_signal_acknowledgements(signal_type, scope, target_id)`); } catch {}

  // intel_health_snapshots: one deterministic daily snapshot per target (node or
  // graph) so the platform's health has a history and a trend, not just a number
  // (6.1). day = YYYY-MM-DD UTC; upsert per (scope, target, day).
  db.exec(`
    CREATE TABLE IF NOT EXISTS intel_health_snapshots (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL DEFAULT 'node',
      target_id TEXT NOT NULL DEFAULT '',
      score INTEGER NOT NULL,
      signals_json TEXT NOT NULL DEFAULT '[]',
      day TEXT NOT NULL,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_intel_snapshots ON intel_health_snapshots(scope, target_id, day)`); } catch {}

  // intel_task_lessons: post-mortem notes from finished queue tasks (6.3).
  // Separate table on purpose — retrospectives are not "thoughts" the user
  // accepts or dismisses; they are durable learned context, deduped by a
  // fingerprint of the lesson so the same lesson is never re-learned.

  // Delay the ALTER until the table exists.
  try { db.exec(`CREATE TABLE IF NOT EXISTS intel_task_lessons (
      id TEXT PRIMARY KEY,
      work_prompt_id TEXT,
      title TEXT NOT NULL,
      lesson TEXT NOT NULL DEFAULT '',
      outcome TEXT NOT NULL DEFAULT '',
      fingerprint TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`); } catch {}
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_intel_lessons_fp ON intel_task_lessons(fingerprint) WHERE fingerprint IS NOT NULL`); } catch {}

  // Link from a queue task back to the Mind thought that produced it (Accept →
  // paused Flow task, Part 4), mirroring suggestion_id.
  try { db.exec(`ALTER TABLE work_prompts ADD COLUMN thought_id TEXT`); } catch {}
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
      -- Deliberately NO CHECK constraint on type. The original schema pinned it to
      -- ('character','film','country'), which meant any new kind of pattern-instance
      -- (Reddit-derived accounts of real situations, institutions, etc.) could not be
      -- inserted at all without a table rebuild — exactly the "bolted on the side"
      -- outcome the ontology is meant to avoid ("character as universal ontological
      -- unit" means the unit is the schema, not the three seeded types).
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      scale TEXT NOT NULL DEFAULT 'individual',
      container_id TEXT REFERENCES entities(id),
      clusters TEXT,
      grounded INTEGER NOT NULL DEFAULT 0,
      -- Provenance, independent of type: where this instance came from (archive,
      -- reddit, …). Type says WHAT it is, source says WHERE IT CAME FROM — keeping
      -- them separate is what lets a Reddit-derived instance be a first-class
      -- character rather than its own parallel mode.
      source TEXT NOT NULL DEFAULT 'archive',
      meta TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
  // Existing databases (the volume now persists them across deploys) still carry the
  // old CHECK constraint, which ALTER TABLE cannot drop in SQLite. Rebuild the table
  // once, only if the constraint is actually still there — idempotent by inspection,
  // not by a migration-version counter.
  try {
    const ddl = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='entities'`).get();
    if (ddl && ddl.sql && ddl.sql.includes('CHECK(type IN')) {
      console.log('[schema] Rebuilding entities table to drop the hardcoded type CHECK constraint…');
      db.exec('PRAGMA foreign_keys=OFF');
      db.exec(`
        CREATE TABLE entities_new (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          name TEXT NOT NULL,
          scale TEXT NOT NULL DEFAULT 'individual',
          container_id TEXT REFERENCES entities(id),
          clusters TEXT,
          grounded INTEGER NOT NULL DEFAULT 0,
          source TEXT NOT NULL DEFAULT 'archive',
          meta TEXT,
          created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        )
      `);
      db.exec(`
        INSERT INTO entities_new (id, type, name, scale, container_id, clusters, grounded, source, meta, created_at, updated_at)
        SELECT id, type, name, scale, container_id, clusters, grounded, 'archive', meta, created_at, updated_at FROM entities
      `);
      db.exec('DROP TABLE entities');
      db.exec('ALTER TABLE entities_new RENAME TO entities');
      db.exec('PRAGMA foreign_keys=ON');
      console.log('[schema] entities table rebuilt — type is now open-ended.');
    }
  } catch (e) { console.error('[schema] entities rebuild failed (continuing with existing table):', e.message); }
  try { db.exec(`ALTER TABLE entities ADD COLUMN source TEXT NOT NULL DEFAULT 'archive'`); } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type)`); } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_source ON entities(source)`); } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_container ON entities(container_id)`); } catch {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_tags (
      entity_id TEXT NOT NULL REFERENCES entities(id),
      tag TEXT NOT NULL,
      PRIMARY KEY (entity_id, tag)
    )
  `);
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_entity_tags_tag ON entity_tags(tag)`); } catch {}

  // Salient facts: which verified TMDb facts a tag/cluster lens foregrounds. The
  // lens call returns prose + a short JSON list of salient facts; stored here so
  // the client can highlight/dim the entity's fact sheet through the active lens.
  try { db.exec(`ALTER TABLE entity_tag_lenses ADD COLUMN salient_json TEXT`); } catch {}

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

// ─── Book recommendations, cached per entity ────────────────────────────────────
// Generated once per entity via the Claude API (see services/books.js) and cached
// here so re-clicking the same entity doesn't cost another API call.
export function initBooksSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_book_suggestions (
      entity_id TEXT PRIMARY KEY REFERENCES entities(id),
      suggestions TEXT NOT NULL,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
}

// ─── Book detail: a deeper, on-demand read of how ONE recommended book specifically
// exhibits an entity's pattern — separate from the one-line "why" shown in the list,
// generated only when the user clicks into a book. Cached per (entity, book title). ───
export function initBookDetailSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_book_details (
      entity_id TEXT NOT NULL REFERENCES entities(id),
      book_title TEXT NOT NULL,
      detail_text TEXT NOT NULL,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (entity_id, book_title)
    )
  `);
}

// ─── Tag lenses: an entity examined through one of its own tags ─────────────────
// Generated once per (entity, tag) pair via the Claude API and cached — clicking a
// tag on an already-viewed entity is then free.
export function initTagLensSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_tag_lenses (
      entity_id TEXT NOT NULL REFERENCES entities(id),
      tag TEXT NOT NULL,
      lens_text TEXT NOT NULL,
      salient_json TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (entity_id, tag)
    )
  `);
  // Existing DBs created before salient_json shipped: patch the table in place.
  // (The parallel ALTER in initSchema can't cover fresh DBs — the table didn't
  // exist yet when it ran.)
  try { db.exec(`ALTER TABLE entity_tag_lenses ADD COLUMN salient_json TEXT`); } catch {}
}

// ─── Tag PATTERN explanations: what a tag means as a general pattern, not tied to
// any one entity — this is what an edge's connection panel shows before you drill
// into how a specific entity expresses it (that's entity_tag_lenses instead). ───
export function initTagPatternSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tag_pattern_explanations (
      tag TEXT PRIMARY KEY,
      explanation TEXT NOT NULL,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
  // One-time-per-boot cleanup: explanations generated under the old, longer
  // prompt (2-4 sentences / ~350 tokens) are stale now that the prompt is capped
  // to 2 sentences / 40-55 words. Purge anything still long so it lazily
  // regenerates (short, cheap) next time that tag's edge is clicked. Idempotent —
  // deletes zero rows once everything's already short.
  db.exec(`DELETE FROM tag_pattern_explanations WHERE length(explanation) > 300`);
}

// ─── Architecture Navigator: live component state, evolution ladders, generated
// "what's next" suggestions, and a build-history trail ──────────────────────────
// now_text/status/last_verified_at are recomputed from live data on every read
// (see services/architecture.js) — this table caches the result rather than
// recomputing on every request, and is what actually gets served. evolution_json
// is authored content (like BUILD_STATUS.md), seeded once and editable later.
// suggestions are Claude-generated on demand (cost-controlled — regeneration is a
// manual action, not automatic) and cached until the next regenerate call.
export function initArchitectureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS architecture_components (
      id TEXT PRIMARY KEY,
      now_text TEXT,
      status TEXT,
      last_verified_at TEXT,
      evolution_json TEXT,
      suggestions_json TEXT,
      suggestions_generated_at TEXT,
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);

  // Manually-maintained mapping of commits to the component(s) they touched — the
  // deployed container has no .git access, so this can't be computed live. Going
  // forward only: seeded by hand alongside each relevant commit from now on.
  db.exec(`
    CREATE TABLE IF NOT EXISTS component_commits (
      id TEXT PRIMARY KEY,
      component_id TEXT NOT NULL,
      sha TEXT NOT NULL,
      message TEXT NOT NULL,
      committed_at TEXT NOT NULL
    )
  `);
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_component_commits ON component_commits(component_id, committed_at)`); } catch {}
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_component_commits_sha ON component_commits(component_id, sha)`); } catch {}

  // Nodes the tech tree grows beyond the hardcoded ARCH_DATA trunk in the frontend.
  // Two provenances share the table because they are the same kind of object at
  // different confidence: 'canon' is authored by hand (or a promoted speculation),
  // 'speculative' is Claude-proposed and renders dashed until accepted. Accepting
  // is therefore an UPDATE of provenance, not a copy between tables.
  //
  // Unlike everything else in this DB, these rows are NOT regenerable from source
  // docs on boot — they are the only user-authored content here, which is why the
  // Railway volume mount matters for this table specifically.
  //
  // `fingerprint` is a sha1 of the parent + normalised name, unique per parent, so
  // re-running speculation on the same node can't pile up near-duplicate branches
  // (same dedup approach as work_suggestions).
  db.exec(`
    CREATE TABLE IF NOT EXISTS architecture_nodes (
      id TEXT PRIMARY KEY,
      territory TEXT NOT NULL,
      name TEXT NOT NULL,
      what TEXT,
      why TEXT,
      next TEXT,
      depends_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'Concept',
      provenance TEXT NOT NULL DEFAULT 'canon',
      parent_node_id TEXT,
      fingerprint TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `);
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_arch_nodes_parent ON architecture_nodes(parent_node_id)`); } catch {}
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_arch_nodes_fp ON architecture_nodes(parent_node_id, fingerprint)`); } catch {}

  // Phase 4: a Seed can be planted directly into the tree, making Idées the list
  // rendering of the same objects the tree renders spatially. Additive ALTER in a
  // try/catch per this file's convention — it throws harmlessly once applied.
  try { db.exec(`ALTER TABLE work_ideas ADD COLUMN arch_node_id TEXT`); } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_work_ideas_node ON work_ideas(arch_node_id)`); } catch {}
}

// ─── Building blocks: evidence-backed discovery (GitHub search + AI-imagined
// proposals for FMCNS's own tech tree) ───────────────────────────────────────────
// Two independent flows share these tables: the curated "Discover" catalog (pure
// GitHub search results, re-ranked by feedback) and the free-text "Idea box"
// (a 2-pass AI call that returns both real repos and pure-imagined proposals).
// No cascade FKs anywhere in this schema (see architecture_nodes) and tree nodes
// are soft-deleted, so architecture_node_evidence rows are left as harmless
// orphans on node delete rather than cleaned up explicitly.
export function initDiscoverySchema(db) {
  // One row per (query_id, repo) — refreshed on a 24h TTL (see codeDiscovery.js).
  db.exec(`
    CREATE TABLE IF NOT EXISTS github_discovery_cache (
      query_id TEXT NOT NULL,
      repo_full_name TEXT NOT NULL,
      stars INTEGER NOT NULL DEFAULT 0,
      description TEXT,
      html_url TEXT,
      topics_json TEXT NOT NULL DEFAULT '[]',
      fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      rank_boost INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (query_id, repo_full_name)
    )
  `);
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_gh_cache_query ON github_discovery_cache(query_id)`); } catch {}

  // "Useful"/"Not useful" clicks. rank_boost above is a derived, denormalised copy
  // updated whenever a feedback row is written, so results can sort with a single
  // column read instead of a join on every list.
  db.exec(`
    CREATE TABLE IF NOT EXISTS github_discovery_feedback (
      id TEXT PRIMARY KEY,
      repo_full_name TEXT NOT NULL,
      verdict TEXT NOT NULL CHECK(verdict IN ('useful','not_useful')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_gh_feedback_repo ON github_discovery_feedback(repo_full_name)`); } catch {}

  // One row per Idea box run — saved even though the MVP has no History view yet,
  // so Phase 2 can list/rerun them without a data migration.
  db.exec(`
    CREATE TABLE IF NOT EXISTS discovery_reports (
      id TEXT PRIMARY KEY,
      idea_text TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'idea_box',
      source_id TEXT,
      queries_json TEXT NOT NULL DEFAULT '[]',
      picks_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      rerun_count INTEGER NOT NULL DEFAULT 0
    )
  `);
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_discovery_reports_created ON discovery_reports(created_at)`); } catch {}
  // Multi-part reports (idea decomposed into sub-parts, each with its own picks) —
  // new reports write here; picks_json stays for pre-existing single-part rows.
  try { db.exec(`ALTER TABLE discovery_reports ADD COLUMN project_name TEXT`); } catch {}
  try { db.exec(`ALTER TABLE discovery_reports ADD COLUMN project_territory TEXT`); } catch {}
  try { db.exec(`ALTER TABLE discovery_reports ADD COLUMN parts_json TEXT`); } catch {}

  // Written when a discovery pick (proven kind only) is planted into the tech tree —
  // links the new architecture_node back to the repo evidence that justified it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS architecture_node_evidence (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL REFERENCES architecture_nodes(id),
      repo_full_name TEXT NOT NULL,
      stars INTEGER NOT NULL DEFAULT 0,
      why TEXT,
      report_id TEXT REFERENCES discovery_reports(id),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      accepted INTEGER NOT NULL DEFAULT 0
    )
  `);
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_arch_node_evidence_node ON architecture_node_evidence(node_id)`); } catch {}
}

// ─── Idea Studio conversations (plan "universal-conversations-core-architecture") ──
// One conversation per subject (architecture component / tech-tree node / seed /
// suggestion). Messages accumulate as turns; the model is called per-turn (not per
// message), and the conversation history is windowed + recap'd for cost control.
export function initConversationsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS convos (
      id TEXT PRIMARY KEY,
      subject_type TEXT NOT NULL,
      subject_id   TEXT NOT NULL,
      title TEXT,
      subject_hint TEXT,
      recap TEXT,
      turns INTEGER NOT NULL DEFAULT 0,
      work_prompt_id TEXT,
      handed_off_at TEXT,
      created_by TEXT REFERENCES users(id),
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      deleted_at TEXT
    )
  `);
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_convos_subject ON convos(subject_type, subject_id) WHERE deleted_at IS NULL`); } catch {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS convo_messages (
      id TEXT PRIMARY KEY,
      convo_id TEXT NOT NULL REFERENCES convos(id),
      role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      kind TEXT NOT NULL DEFAULT 'chat' CHECK(kind IN ('chat','plan')),
      text TEXT NOT NULL DEFAULT '',
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_convo_messages ON convo_messages(convo_id, created_at)`); } catch {}
}

// ─── Film enrichment: TMDb metadata (synopsis, genres, keywords, cast) ────────
// Two tables, both keyed off TMDb, following the generate-once-and-cache pattern
// (see books.js / codeDiscovery.js's github_discovery_cache):
// - tmdb_enrichments: the RESULT, one row per film entity. Deliberately keyed by
//   entity_id and NOT written into entities.meta, because migrateOntology()
//   re-seeds/overwrites every entity's meta on every boot (ON CONFLICT DO UPDATE)
//   — data written into meta would be erased at the next deploy. This table
//   survives reseeds and is merged client-side at boot.
// - tmdb_cache: raw API responses keyed by request hash (search/detail), so a
//   batch re-run reuses earlier answers. 30-day TTL enforced in the service
//   (filmEnrichment.js). Negative results ("movie not found") are cached too —
//   otherwise every boot would re-query the same missing titles.
export function initFilmEnrichmentSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tmdb_enrichments (
      entity_id TEXT PRIMARY KEY REFERENCES entities(id),
      -- matched | not_found | ambiguous | error — see filmEnrichment.js for the
      -- matching rules (year-scoped search + director validation vs. meta.auteurs).
      status TEXT NOT NULL DEFAULT 'error',
      tmdb_id INTEGER,
      match_confidence INTEGER NOT NULL DEFAULT 0,
      title TEXT,
      title_en TEXT,
      original_language TEXT,
      year INTEGER,
      release_date TEXT,
      -- Overview pulled with language=en-US (the corpus is partly non-English
      -- films; the enrichment block always shows the English synopsis plus the
      -- original-language title).
      synopsis_en TEXT DEFAULT '',
      genres_json TEXT NOT NULL DEFAULT '[]',
      keywords_json TEXT NOT NULL DEFAULT '[]',
      countries_json TEXT NOT NULL DEFAULT '[]',
      cast_json TEXT NOT NULL DEFAULT '[]',
      director TEXT,
      poster_path TEXT,
      fetched_at TEXT,
      attempted_at TEXT
    )
  `);
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_tmdb_enrich_status ON tmdb_enrichments(status)`); } catch {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS tmdb_cache (
      request_key TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);
}
