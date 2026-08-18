// Postgres schema for FMCNS — ontology, chat, knowledge, books, tags, architecture, discovery, conversations, film
// Part 2 of the schema

import { Pool } from 'pg';

export async function applyOntologySchema(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ─── Ontology: entities ─────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        scale TEXT NOT NULL DEFAULT 'individual',
        container_id TEXT REFERENCES entities(id),
        clusters TEXT,
        grounded BOOLEAN NOT NULL DEFAULT FALSE,
        source TEXT NOT NULL DEFAULT 'archive',
        meta JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_entities_source ON entities(source)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_entities_container ON entities(container_id)`);

    // ─── Ontology: entity_tags ──────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS entity_tags (
        entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        PRIMARY KEY (entity_id, tag)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_entity_tags_tag ON entity_tags(tag)`);

    // ─── Ontology: continuum_axes ───────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS continuum_axes (
        key TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        low TEXT,
        high TEXT
      )
    `);

    // ─── Ontology: entity_continuum ─────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS entity_continuum (
        entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        axis_key TEXT NOT NULL REFERENCES continuum_axes(key),
        value REAL NOT NULL,
        PRIMARY KEY (entity_id, axis_key)
      )
    `);

    // ─── Ontology: clusters ─────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS clusters (
        code TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        grounding_status TEXT
      )
    `);

    // ─── Chat: chat_sessions ────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        title TEXT,
        summary TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated ON chat_sessions(updated_at)`);

    // ─── Chat: chat_messages ────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user','assistant')),
        text TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, created_at)`);

    // ─── Chat: chat_attachments ─────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS chat_attachments (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        message_id TEXT REFERENCES chat_messages(id),
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL DEFAULT 'application/pdf',
        data_base64 TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_chat_attachments_session ON chat_attachments(session_id)`);

    // ─── Knowledge: knowledge_docs ──────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS knowledge_docs (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL UNIQUE,
        description TEXT,
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ─── Books: entity_book_suggestions ─────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS entity_book_suggestions (
        entity_id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
        suggestions TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ─── Books: entity_book_details ─────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS entity_book_details (
        entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        book_title TEXT NOT NULL,
        detail_text TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (entity_id, book_title)
      )
    `);

    // ─── Tags: entity_tag_lenses ────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS entity_tag_lenses (
        entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        lens_text TEXT NOT NULL,
        salient_json JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (entity_id, tag)
      )
    `);

    // ─── Tags: tag_pattern_explanations ─────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS tag_pattern_explanations (
        tag TEXT PRIMARY KEY,
        explanation TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Cleanup long explanations (one-time)
    await client.query(`DELETE FROM tag_pattern_explanations WHERE length(explanation) > 300`);

    await client.query('COMMIT');
    console.log('✓ Ontology/chat/knowledge/books/tags schema applied');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function applyArchitectureSchema(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ─── Architecture: architecture_components ──────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS architecture_components (
        id TEXT PRIMARY KEY,
        now_text TEXT,
        status TEXT,
        last_verified_at TIMESTAMPTZ,
        evolution_json JSONB,
        suggestions_json JSONB,
        suggestions_generated_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ─── Architecture: component_commits ────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS component_commits (
        id TEXT PRIMARY KEY,
        component_id TEXT NOT NULL,
        sha TEXT NOT NULL,
        message TEXT NOT NULL,
        committed_at TIMESTAMPTZ NOT NULL
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_component_commits ON component_commits(component_id, committed_at)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_component_commits_sha ON component_commits(component_id, sha)`);

    // ─── Architecture: architecture_nodes ───────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS architecture_nodes (
        id TEXT PRIMARY KEY,
        territory TEXT NOT NULL,
        name TEXT NOT NULL,
        what TEXT,
        why TEXT,
        next TEXT,
        depends_json JSONB NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'Concept',
        provenance TEXT NOT NULL DEFAULT 'canon' CHECK (provenance IN ('canon','speculative')),
        parent_node_id TEXT REFERENCES architecture_nodes(id),
        fingerprint TEXT,
        sync_source TEXT,
        sync_prompt_id TEXT,
        sync_sha TEXT,
        proposed BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        deleted_at TIMESTAMPTZ
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_arch_nodes_parent ON architecture_nodes(parent_node_id)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_arch_nodes_fp ON architecture_nodes(parent_node_id, fingerprint)`);

    // ─── Architecture: tree_sync_state ──────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS tree_sync_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_sha TEXT,
        last_run_at TIMESTAMPTZ,
        last_error TEXT
      )
    `);
    await client.query(`
      INSERT INTO tree_sync_state (id) VALUES (1)
      ON CONFLICT (id) DO NOTHING
    `);

    await client.query('COMMIT');
    console.log('✓ Architecture schema applied');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function applyDiscoverySchema(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ─── Discovery: github_discovery_cache ──────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS github_discovery_cache (
        query_id TEXT NOT NULL,
        repo_full_name TEXT NOT NULL,
        stars INTEGER NOT NULL DEFAULT 0,
        description TEXT,
        html_url TEXT,
        topics_json JSONB NOT NULL DEFAULT '[]',
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        rank_boost INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (query_id, repo_full_name)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_gh_cache_query ON github_discovery_cache(query_id)`);

    // ─── Discovery: github_discovery_feedback ───────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS github_discovery_feedback (
        id TEXT PRIMARY KEY,
        repo_full_name TEXT NOT NULL,
        verdict TEXT NOT NULL CHECK (verdict IN ('useful','not_useful')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_gh_feedback_repo ON github_discovery_feedback(repo_full_name)`);

    // ─── Discovery: discovery_reports ───────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS discovery_reports (
        id TEXT PRIMARY KEY,
        idea_text TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'idea_box',
        source_id TEXT,
        queries_json JSONB NOT NULL DEFAULT '[]',
        picks_json JSONB NOT NULL DEFAULT '[]',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        rerun_count INTEGER NOT NULL DEFAULT 0,
        project_name TEXT,
        project_territory TEXT,
        parts_json JSONB,
        review_json JSONB
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_discovery_reports_created ON discovery_reports(created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_discovery_reports_source ON discovery_reports(source, source_id)`);

    // ─── Discovery: architecture_node_evidence ──────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS architecture_node_evidence (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL REFERENCES architecture_nodes(id) ON DELETE CASCADE,
        repo_full_name TEXT NOT NULL,
        stars INTEGER NOT NULL DEFAULT 0,
        why TEXT,
        report_id TEXT REFERENCES discovery_reports(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        accepted BOOLEAN NOT NULL DEFAULT FALSE
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_arch_node_evidence_node ON architecture_node_evidence(node_id)`);

    // ─── Discovery: discovery_pick_plants ───────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS discovery_pick_plants (
        report_id TEXT NOT NULL REFERENCES discovery_reports(id),
        part_index INTEGER NOT NULL,
        pick_index INTEGER NOT NULL,
        node_id TEXT NOT NULL REFERENCES architecture_nodes(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (report_id, part_index, pick_index)
      )
    `);

    await client.query('COMMIT');
    console.log('✓ Discovery schema applied');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function applyConversationsSchema(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ─── Conversations: convos ──────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS convos (
        id TEXT PRIMARY KEY,
        subject_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        title TEXT,
        subject_hint TEXT,
        recap TEXT,
        turns INTEGER NOT NULL DEFAULT 0,
        work_prompt_id TEXT,
        handed_off_at TIMESTAMPTZ,
        created_by TEXT REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        deleted_at TIMESTAMPTZ
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_convos_subject ON convos(subject_type, subject_id) WHERE deleted_at IS NULL`);

    // ─── Conversations: convo_messages ──────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS convo_messages (
        id TEXT PRIMARY KEY,
        convo_id TEXT NOT NULL REFERENCES convos(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user','assistant')),
        kind TEXT NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat','plan')),
        text TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_convo_messages ON convo_messages(convo_id, created_at)`);

    await client.query('COMMIT');
    console.log('✓ Conversations schema applied');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function applyFilmEnrichmentSchema(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ─── Film: tmdb_enrichments ─────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS tmdb_enrichments (
        entity_id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'error',
        tmdb_id INTEGER,
        match_confidence INTEGER NOT NULL DEFAULT 0,
        title TEXT,
        title_en TEXT,
        original_language TEXT,
        year INTEGER,
        release_date TEXT,
        synopsis_en TEXT DEFAULT '',
        genres_json JSONB NOT NULL DEFAULT '[]',
        keywords_json JSONB NOT NULL DEFAULT '[]',
        countries_json JSONB NOT NULL DEFAULT '[]',
        cast_json JSONB NOT NULL DEFAULT '[]',
        director TEXT,
        poster_path TEXT,
        fetched_at TIMESTAMPTZ,
        attempted_at TIMESTAMPTZ
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tmdb_enrich_status ON tmdb_enrichments(status)`);

    // ─── Film: tmdb_cache ───────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS tmdb_cache (
        request_key TEXT PRIMARY KEY,
        payload JSONB NOT NULL,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query('COMMIT');
    console.log('✓ Film enrichment schema applied');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Main entry point - applies all schemas in order
export async function applyAllSchemas(pool: Pool) {
  const { applySchema } = await import('./schema-core.js');
  await applySchema(pool);
  await applyOntologySchema(pool);
  await applyArchitectureSchema(pool);
  await applyDiscoverySchema(pool);
  await applyConversationsSchema(pool);
  await applyFilmEnrichmentSchema(pool);
  console.log('✓ All schemas applied successfully');
}