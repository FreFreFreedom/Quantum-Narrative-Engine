// Postgres schema for FMCNS work queue — converted from SQLite
// Run via: npm run db:schema (applies to DATABASE_URL)

import { Pool } from 'pg';

export async function applySchema(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // ─── Core: users ─────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE,
        avatar_url TEXT,
        provider TEXT,          -- 'password', 'google', 'github'
        provider_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_users_provider ON users(provider, provider_id)`);
    
    // Seed default user
    await client.query(`
      INSERT INTO users (id, name, provider) VALUES ('antoine', 'Antoine', 'password')
      ON CONFLICT (id) DO NOTHING
    `);

    // ─── Core: work_prompts (task queue) ────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS work_prompts (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        raw_prompt TEXT,
        status TEXT NOT NULL DEFAULT 'queued'
          CHECK (status IN ('queued','running','done','blocked','paused','cancelled')),
        position REAL NOT NULL DEFAULT 0,
        same_context BOOLEAN NOT NULL DEFAULT FALSE,
        mode TEXT NOT NULL DEFAULT 'implement' CHECK (mode IN ('implement','question')),
        preset TEXT NOT NULL DEFAULT 'deep',
        agent_task_id TEXT,
        session_id TEXT,
        opencode_session_id TEXT,
        suggestion_id TEXT,
        created_by TEXT REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        deleted_at TIMESTAMPTZ,
        title_auto BOOLEAN NOT NULL DEFAULT FALSE,
        pending_question JSONB,
        stop_after BOOLEAN NOT NULL DEFAULT FALSE,
        space TEXT NOT NULL DEFAULT 'fmcns',
        component_id TEXT,
        context_turns INTEGER NOT NULL DEFAULT 0,
        resolved_preset TEXT,
        cost_usd REAL,
        tokens_in INTEGER,
        tokens_out INTEGER,
        run_model TEXT,
        provider TEXT NOT NULL DEFAULT 'claude-code',
        provider_model TEXT,
        agent_key TEXT REFERENCES agents(key),
        parent_prompt_id TEXT REFERENCES work_prompts(id),
        plan_source TEXT DEFAULT 'auto',
        plan_pending BOOLEAN NOT NULL DEFAULT FALSE,
        convo_id TEXT,
        seen_at TIMESTAMPTZ,
        summary TEXT,
        inspire_state TEXT NOT NULL DEFAULT 'off',
        inspire_report_id TEXT,
        inspire_picks_json JSONB NOT NULL DEFAULT '[]',
        inspire_error TEXT,
        inspire_review_json JSONB,
        retry_worktree_path TEXT,
        retry_branch TEXT,
        task_tier TEXT NOT NULL DEFAULT 'standard'
          CHECK (task_tier IN ('mini','standard','deep')),
        strategy TEXT DEFAULT 'single',
        strategy_state TEXT DEFAULT 'idle',
        resume_after TIMESTAMPTZ,
        thought_id TEXT
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_work_prompts_status ON work_prompts(status, position)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_work_prompts_space ON work_prompts(space)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_work_prompts_created_by ON work_prompts(created_by)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_work_prompts_strategy ON work_prompts(strategy, strategy_state)`);

    // ─── Core: work_prompt_messages ─────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS work_prompt_messages (
        id TEXT PRIMARY KEY,
        prompt_id TEXT NOT NULL REFERENCES work_prompts(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user','agent')),
        text TEXT NOT NULL,
        agent_task_id TEXT,
        author TEXT REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_work_prompt_msgs ON work_prompt_messages(prompt_id, created_at)`);

    // ─── Core: work_suggestions ──────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS work_suggestions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        rationale TEXT,
        prompt TEXT NOT NULL,
        area TEXT,
        kind TEXT NOT NULL DEFAULT 'chantier',
        status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','accepted','dismissed')),
        fingerprint TEXT NOT NULL,
        work_prompt_id TEXT,
        dismissed_reason TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        deleted_at TIMESTAMPTZ
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_work_suggestions_fp ON work_suggestions(fingerprint)`);

    // ─── Core: work_ideas ────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS work_ideas (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        notes TEXT,
        tag TEXT,
        position REAL NOT NULL DEFAULT 0,
        work_prompt_id TEXT,
        arch_node_id TEXT REFERENCES architecture_nodes(id),
        created_by TEXT REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        deleted_at TIMESTAMPTZ
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_work_ideas_pos ON work_ideas(position)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_work_ideas_node ON work_ideas(arch_node_id)`);

    // ─── Core: agent_tasks ───────────────────────────────────────────────────────
    await client.query(`
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
        pending_question JSONB,
        missed_user_message TEXT,
        work_prompt_id TEXT,
        resume_session_id TEXT,
        session_id TEXT,
        worktree_path TEXT,
        branch TEXT,
        base_sha TEXT,
        stop_requested BOOLEAN NOT NULL DEFAULT FALSE,
        cost_usd REAL,
        tokens_in INTEGER,
        tokens_out INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        heartbeat_at TIMESTAMPTZ,
        claimed_by TEXT,
        claimed_at TIMESTAMPTZ
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_agent_tasks_queue ON agent_tasks(status, kind, priority, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_agent_tasks_prompt ON agent_tasks(work_prompt_id)`);

    // ─── Core: agents ────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS agents (
        key TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        emoji TEXT,
        role TEXT NOT NULL DEFAULT 'dev'
          CHECK (role IN ('research','dev','design','test','reviewer','integrator')),
        persona TEXT NOT NULL DEFAULT '',
        brief_file TEXT,
        provider TEXT NOT NULL DEFAULT 'claude-code',
        provider_model TEXT,
        preset TEXT NOT NULL DEFAULT 'standard',
        tools TEXT NOT NULL DEFAULT 'Bash,Read,Write,Edit,Glob,Grep',
        path_allow TEXT NOT NULL DEFAULT '["**"]',
        path_deny TEXT NOT NULL DEFAULT '[]',
        max_parallel INTEGER NOT NULL DEFAULT 1,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        paused BOOLEAN NOT NULL DEFAULT FALSE,
        sort_order REAL NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Seed default agents
    await client.query(`
      INSERT INTO agents (key, label, emoji, role, persona, brief_file, provider, provider_model, preset, tools, path_allow, path_deny, max_parallel, enabled, paused, sort_order)
      VALUES
        ('dev1', 'Developer 1', '👨‍💻', 'dev', 'Generalist implementer — the default agent for new tasks.', '.agents/roles/dev.md', 'opencode', NULL, 'standard', 'Bash,Read,Write,Edit,Glob,Grep', '["**"]', '[]', 1, TRUE, FALSE, 1),
        ('dev2', 'Developer 2', '👩‍💻', 'dev', 'Second implementer — runs in parallel with Developer 1 on its own worktree.', '.agents/roles/dev.md', 'opencode', NULL, 'standard', 'Bash,Read,Write,Edit,Glob,Grep', '["**"]', '[]', 1, TRUE, FALSE, 2),
        ('dev3', 'Developer 3', '🧑‍💻', 'dev', 'Third implementer — another parallel writer on the OpenCode lane, own worktree.', '.agents/roles/dev.md', 'opencode', NULL, 'standard', 'Bash,Read,Write,Edit,Glob,Grep', '["**"]', '[]', 1, TRUE, FALSE, 3)
      ON CONFLICT (key) DO UPDATE SET
        provider = EXCLUDED.provider,
        updated_at = NOW()
    `);

    // ─── Core: reviews ───────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY,
        prompt_id TEXT NOT NULL REFERENCES work_prompts(id),
        task_id TEXT REFERENCES agent_tasks(id),
        agent_key TEXT,
        branch TEXT NOT NULL,
        base_sha TEXT,
        head_sha TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','approved','changes_requested','rejected','merged','reverted')),
        verdict TEXT,
        plain_summary TEXT,
        concerns JSONB,
        checks JSONB,
        files_changed TEXT,
        insertions INTEGER,
        deletions INTEGER,
        conflicts_with JSONB,
        reviewer_task_id TEXT,
        merge_commit TEXT,
        merged_at TIMESTAMPTZ,
        reverted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_reviews_prompt ON reviews(prompt_id)`);

    // ─── Core: task_stages ───────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS task_stages (
        id TEXT PRIMARY KEY,
        prompt_id TEXT NOT NULL REFERENCES work_prompts(id),
        stage TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        variant TEXT,
        agent_key TEXT REFERENCES agents(key),
        agent_task_id TEXT,
        branch TEXT,
        worktree_path TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','running','done','blocked','skipped','lost','won')),
        input_json JSONB,
        output_text TEXT,
        verdict_json JSONB,
        cost_usd REAL,
        created_at TIMESTAMPTZ,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_task_stages ON task_stages(prompt_id, ordinal)`);

    // ─── Core: ai_settings ───────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_settings (
        id TEXT PRIMARY KEY DEFAULT 'global',
        defaults_json JSONB NOT NULL DEFAULT '{}',
        health_json JSONB NOT NULL DEFAULT '{}',
        quota_policy TEXT NOT NULL DEFAULT 'auto_free',
        cooldown_json JSONB NOT NULL DEFAULT '{}',
        queue_go_budget_usd REAL NOT NULL DEFAULT 0,
        intel_json JSONB NOT NULL DEFAULT '{}',
        queue_auto_ship BOOLEAN NOT NULL DEFAULT TRUE,
        queue_cost_cap_usd REAL NOT NULL DEFAULT 0.1,
        side_call_budget INTEGER NOT NULL DEFAULT 30,
        suggestions_relang_done BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      INSERT INTO ai_settings (id) VALUES ('global')
      ON CONFLICT (id) DO NOTHING
    `);

    // ─── Core: side_call_ledger ──────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS side_call_ledger (
        day TEXT PRIMARY KEY,
        calls INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ─── Core: provider_quota_ledger ─────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS provider_quota_ledger (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        model TEXT,
        scope TEXT NOT NULL DEFAULT 'provider' CHECK (scope IN ('provider','model','key')),
        exhausted_at TIMESTAMPTZ NOT NULL,
        resets_at TIMESTAMPTZ,
        resets_known BOOLEAN NOT NULL DEFAULT FALSE,
        reason TEXT,
        detected_by TEXT,
        evidence TEXT,
        cleared_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_quota_ledger_provider_resets ON provider_quota_ledger(provider_id, resets_at)`);

    // ─── Core: provider_quota_state ──────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS provider_quota_state (
        provider_id TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        exhausted BOOLEAN NOT NULL DEFAULT FALSE,
        resets_at TIMESTAMPTZ,
        resets_known BOOLEAN NOT NULL DEFAULT FALSE,
        last_event_id TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (provider_id, model)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_quota_state_enabled ON provider_quota_state(exhausted, resets_at)`);

    // ─── Core: intel_thoughts ────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS intel_thoughts (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'mechanical' CHECK (kind IN ('mechanical','deliberative')),
        scope TEXT NOT NULL DEFAULT 'node' CHECK (scope IN ('node','graph','content')),
        target_id TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        prompt_draft TEXT,
        state_hash TEXT,
        priority INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','accepted','dismissed','adopted')),
        work_prompt_id TEXT,
        dismissed_reason TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        deleted_at TIMESTAMPTZ
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_intel_thoughts_dedup ON intel_thoughts(scope, target_id, kind, state_hash) WHERE deleted_at IS NULL AND state_hash IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_intel_thoughts_feed ON intel_thoughts(status, created_at)`);

    // ─── Core: intel_signal_acknowledgements ─────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS intel_signal_acknowledgements (
        id TEXT PRIMARY KEY,
        signal_type TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'node',
        target_id TEXT NOT NULL DEFAULT '',
        reason TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_intel_acks ON intel_signal_acknowledgements(signal_type, scope, target_id)`);

    // ─── Core: intel_health_snapshots ────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS intel_health_snapshots (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL DEFAULT 'node',
        target_id TEXT NOT NULL DEFAULT '',
        score INTEGER NOT NULL,
        signals_json JSONB NOT NULL DEFAULT '[]',
        day TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_intel_snapshots ON intel_health_snapshots(scope, target_id, day)`);

    // ─── Core: intel_task_lessons ────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS intel_task_lessons (
        id TEXT PRIMARY KEY,
        work_prompt_id TEXT,
        title TEXT NOT NULL,
        lesson TEXT NOT NULL DEFAULT '',
        outcome TEXT NOT NULL DEFAULT '',
        fingerprint TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_intel_lessons_fp ON intel_task_lessons(fingerprint) WHERE fingerprint IS NOT NULL`);

    await client.query('COMMIT');
    console.log('✓ Core schema applied');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}