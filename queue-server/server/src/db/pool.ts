// Postgres connection pool — replaces node:sqlite DatabaseSync
// Uses node-postgres (pg) with connection pooling for production readiness

import { Pool, PoolConfig } from 'pg';

// Parse DATABASE_URL or build config from individual env vars
function buildPoolConfig(): PoolConfig {
  const databaseUrl = process.env.DATABASE_URL;
  
  if (databaseUrl) {
    // Full connection string provided (Neon, Railway, etc.)
    return {
      connectionString: databaseUrl,
      max: 20,                    // Max connections in pool
      idleTimeoutMillis: 30000,   // Close idle connections after 30s
      connectionTimeoutMillis: 5000, // Wait max 5s for connection
      ssl: databaseUrl.includes('neon.tech') ? { rejectUnauthorized: false } : false,
    };
  }

  // Fallback: individual env vars (for local dev)
  return {
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432'),
    database: process.env.PGDATABASE || 'fmcns',
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
  };
}

// Create the pool (singleton)
export const pool = new Pool(buildPoolConfig());

// Error handling for idle clients
pool.on('error', (err) => {
  console.error('[pg] Unexpected error on idle client', err);
  process.exit(-1);
});

// Helper: run a query with automatic client release
export async function query<T = any>(text: string, params?: any[]): Promise<{ rows: T[]; rowCount: number }> {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  if (process.env.NODE_ENV === 'development') {
    console.log('[pg] Query:', { text: text.slice(0, 100), duration, rows: res.rowCount });
  }
  return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
}

// Helper: get a client for transactions
export async function getClient() {
  return pool.connect();
}

// Helper: run in a transaction
export async function transaction<T>(fn: (client: any) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Graceful shutdown
export async function closePool(): Promise<void> {
  await pool.end();
}

// Health check
export async function checkConnection(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}