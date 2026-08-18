// Apply Postgres schema to DATABASE_URL
// Run with: npm run db:schema

import { pool } from '../server/src/db/pool.js';
import { applyAllSchemas } from '../server/src/db/schema.js';

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Applying Postgres Schema');
  console.log('═══════════════════════════════════════════════════════════');
  
  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL not set.');
    process.exit(1);
  }

  // Test connection
  console.log('\n[1/2] Testing connection...');
  const { checkConnection } = await import('../server/src/db/pool.js');
  const connected = await checkConnection();
  if (!connected) {
    console.error('❌ Cannot connect to Postgres.');
    process.exit(1);
  }
  console.log('  ✓ Connected');

  // Apply schema
  console.log('\n[2/2] Applying schema...');
  try {
    await applyAllSchemas(pool);
  } catch (e) {
    console.error('❌ Schema apply failed:', e);
    process.exit(1);
  }

  await pool.end();
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  ✓ Schema applied successfully');
  console.log('═══════════════════════════════════════════════════════════');
}

main();