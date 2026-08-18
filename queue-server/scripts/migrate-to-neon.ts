// Migration script: SQLite → Neon Postgres
// Run with: npm run db:migrate (requires DATABASE_URL env var)

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { pool, query, transaction } from '../server/src/db/pool.js';

// Tables to migrate in dependency order
const TABLES = [
  'users',
  'work_prompts',
  'work_prompt_messages',
  'work_suggestions',
  'work_ideas',
  'agent_tasks',
  'agents',
  'reviews',
  'task_stages',
  'ai_settings',
  'side_call_ledger',
  'provider_quota_ledger',
  'provider_quota_state',
  'intel_thoughts',
  'intel_signal_acknowledgements',
  'intel_health_snapshots',
  'intel_task_lessons',
  'entities',
  'entity_tags',
  'continuum_axes',
  'entity_continuum',
  'clusters',
  'chat_sessions',
  'chat_messages',
  'chat_attachments',
  'knowledge_docs',
  'entity_book_suggestions',
  'entity_book_details',
  'entity_tag_lenses',
  'tag_pattern_explanations',
  'architecture_components',
  'component_commits',
  'architecture_nodes',
  'tree_sync_state',
  'github_discovery_cache',
  'github_discovery_feedback',
  'discovery_reports',
  'architecture_node_evidence',
  'discovery_pick_plants',
  'convos',
  'convo_messages',
  'tmdb_enrichments',
  'tmdb_cache',
];

// Column type conversions for known problematic columns
const COLUMN_TRANSFORMS: Record<string, (val: any) => any> = {
  // Boolean columns stored as 0/1 in SQLite
  same_context: (v) => v === 1 || v === '1',
  stop_after: (v) => v === 1 || v === '1',
  title_auto: (v) => v === 1 || v === '1',
  plan_pending: (v) => v === 1 || v === '1',
  grounded: (v) => v === 1 || v === '1',
  enabled: (v) => v === 1 || v === '1',
  paused: (v) => v === 1 || v === '1',
  stop_requested: (v) => v === 1 || v === '1',
  resets_known: (v) => v === 1 || v === '1',
  exhausted: (v) => v === 1 || v === '1',
  proposed: (v) => v === 1 || v === '1',
  accepted: (v) => v === 1 || v === '1',
  queue_auto_ship: (v) => v === 1 || v === '1',
  suggestions_relang_done: (v) => v === 1 || v === '1',
  
  // JSON columns that might be strings
  pending_question: (v) => v ? JSON.parse(v) : null,
  inspire_picks_json: (v) => v ? JSON.parse(v) : [],
  inspire_review_json: (v) => v ? JSON.parse(v) : null,
  tried_models: (v) => v ? JSON.parse(v) : [],
  depends_json: (v) => v ? JSON.parse(v) : [],
  defaults_json: (v) => v ? JSON.parse(v) : {},
  health_json: (v) => v ? JSON.parse(v) : {},
  cooldown_json: (v) => v ? JSON.parse(v) : {},
  intel_json: (v) => v ? JSON.parse(v) : {},
  concerns: (v) => v ? JSON.parse(v) : [],
  checks: (v) => v ? JSON.parse(v) : {},
  conflicts_with: (v) => v ? JSON.parse(v) : [],
  input_json: (v) => v ? JSON.parse(v) : null,
  verdict_json: (v) => v ? JSON.parse(v) : null,
  queries_json: (v) => v ? JSON.parse(v) : [],
  picks_json: (v) => v ? JSON.parse(v) : [],
  parts_json: (v) => v ? JSON.parse(v) : null,
  review_json: (v) => v ? JSON.parse(v) : null,
  topics_json: (v) => v ? JSON.parse(v) : [],
  genres_json: (v) => v ? JSON.parse(v) : [],
  keywords_json: (v) => v ? JSON.parse(v) : [],
  countries_json: (v) => v ? JSON.parse(v) : [],
  cast_json: (v) => v ? JSON.parse(v) : [],
  meta: (v) => v ? JSON.parse(v) : null,
  salient_json: (v) => v ? JSON.parse(v) : null,
  evolution_json: (v) => v ? JSON.parse(v) : null,
  suggestions_json: (v) => v ? JSON.parse(v) : null,
  signals_json: (v) => v ? JSON.parse(v) : [],
  payload: (v) => v ? JSON.parse(v) : null,
  
  // Timestamps: SQLite stores as TEXT, Postgres expects TIMESTAMPTZ
  // These are handled generically below
};

async function migrateTable(sqliteDb: DatabaseSync, tableName: string) {
  console.log(`\n[Migrate] ${tableName}...`);
  
  // Get all rows from SQLite
  const rows = sqliteDb.prepare(`SELECT * FROM ${tableName}`).all() as Record<string, any>[];
  
  if (rows.length === 0) {
    console.log(`  → 0 rows (skipped)`);
    return;
  }

  // Build insert query
  const columns = Object.keys(rows[0]);
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  const insertSql = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;

  let inserted = 0;
  let skipped = 0;

  for (const row of rows) {
    const values = columns.map(col => {
      let val = row[col];
      
      // Apply column-specific transforms
      if (COLUMN_TRANSFORMS[col]) {
        val = COLUMN_TRANSFORMS[col](val);
      }
      
      // Handle timestamps: convert SQLite TEXT to Date
      if (val && typeof val === 'string' && 
          (col.endsWith('_at') || col === 'created_at' || col === 'updated_at' || 
           col === 'started_at' || col === 'completed_at' || col === 'heartbeat_at' ||
           col === 'exhausted_at' || col === 'resets_at' || col === 'cleared_at' ||
           col === 'fetched_at' || col === 'attempted_at' || col === 'last_run_at' ||
           col === 'handed_off_at' || col === 'merged_at' || col === 'reverted_at' ||
           col === 'last_verified_at' || col === 'suggestions_generated_at' || col === 'committed_at')) {
        // Ensure it's a valid ISO string
        const parsed = new Date(val);
        if (!isNaN(parsed.getTime())) {
          val = parsed.toISOString();
        }
      }
      
      // Handle INTEGER PRIMARY KEY CHECK (id=1) for tree_sync_state
      if (col === 'id' && tableName === 'tree_sync_state' && val === 1) {
        val = 1;
      }
      
      // Convert SQLite 0/1 to boolean for known boolean columns not in COLUMN_TRANSFORMS
      if (typeof val === 'number' && (val === 0 || val === 1)) {
        const boolCols = ['grounded', 'enabled', 'paused', 'stop_requested', 'resets_known', 
                          'exhausted', 'proposed', 'accepted', 'queue_auto_ship', 
                          'suggestions_relang_done', 'same_context', 'stop_after', 'title_auto',
                          'plan_pending', 'queue_go_budget_usd', 'side_call_budget'];
        if (boolCols.includes(col)) {
          val = val === 1;
        }
      }
      
      return val;
    });

    try {
      await query(insertSql, values);
      inserted++;
    } catch (e: any) {
      // ON CONFLICT DO NOTHING means duplicates are skipped
      if (e.code === '23505') { // unique_violation
        skipped++;
      } else {
        console.error(`  ✗ Error inserting row:`, e.message);
        console.error(`  Columns:`, columns);
        console.error(`  Values:`, values.map((v, i) => `${columns[i]}=${typeof v === 'string' ? v.slice(0, 50) : v}`));
        throw e;
      }
    }
  }

  console.log(`  → ${inserted} inserted, ${skipped} skipped (conflicts)`);
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  SQLite → Neon Postgres Migration');
  console.log('═══════════════════════════════════════════════════════════');
  
  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL not set. Set it to your Neon connection string.');
    process.exit(1);
  }

  // Test connection
  console.log('\n[1/3] Testing Postgres connection...');
  const connected = await checkConnection();
  if (!connected) {
    console.error('❌ Cannot connect to Postgres. Check DATABASE_URL.');
    process.exit(1);
  }
  console.log('  ✓ Connected');

  // Open SQLite
  console.log('\n[2/3] Opening SQLite database...');
  const sqlitePath = process.env.SQLITE_PATH || path.join(
    process.env.RAILWAY_VOLUME_MOUNT_PATH || process.cwd(), 
    'data', 'queue.db'
  );
  
  if (!fs.existsSync(sqlitePath)) {
    console.error(`❌ SQLite file not found: ${sqlitePath}`);
    console.error('Set SQLITE_PATH env var if it\'s in a different location.');
    process.exit(1);
  }
  
  const sqliteDb = new DatabaseSync(sqlitePath, { readOnly: true });
  console.log(`  ✓ Opened: ${sqlitePath}`);

  // Migrate all tables
  console.log('\n[3/3] Migrating tables...');
  let totalTables = 0;
  let totalRows = 0;

  for (const table of TABLES) {
    try {
      const countResult = sqliteDb.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: string | number | bigint } | undefined;
      const count = countResult ? Number(countResult.c) : 0;
      if (count > 0) {
        totalTables++;
        totalRows += count;
      }
      await migrateTable(sqliteDb, table);
    } catch (e: any) {
      if (e.message.includes('no such table')) {
        console.log(`  → ${table}: does not exist in SQLite (skipped)`);
      } else {
        throw e;
      }
    }
  }

  sqliteDb.close();
  await pool.end();

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(`  ✓ Migration complete: ${totalTables} tables, ${totalRows} rows`);
  console.log('═══════════════════════════════════════════════════════════');
}

// Import checkConnection from pool
import { checkConnection } from '../server/src/db/pool.js';

main().catch((e) => {
  console.error('\n❌ Migration failed:', e);
  process.exit(1);
});