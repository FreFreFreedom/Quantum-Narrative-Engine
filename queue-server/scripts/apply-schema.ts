// Apply Postgres schema to DATABASE_URL
// Run with: npm run db:schema

import { pool } from '../server/src/db/pool.js';
import { applyAllSchemas } from '../server/src/db/schema.js';

async function waitForDb(maxRetries = 10, delayMs = 2000) {
  const { checkConnection } = await import('../server/src/db/pool.js');
  
  for (let i = 1; i <= maxRetries; i++) {
    try {
      const connected = await checkConnection();
      if (connected) {
        console.log(`  ✓ Database connected (attempt ${i})`);
        return true;
      }
    } catch (e) {
      console.log(`  Attempt ${i}/${maxRetries} failed: ${(e as Error).message}`);
    }
    if (i < maxRetries) {
      console.log(`  Waiting ${delayMs}ms before retry...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return false;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Applying Postgres Schema');
  console.log('═══════════════════════════════════════════════════════════');
  
  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL not set.');
    process.exit(1);
  }

  // Test connection with retries
  console.log('\n[1/2] Testing connection...');
  const connected = await waitForDb(15, 3000);
  if (!connected) {
    console.error('❌ Cannot connect to Postgres after retries.');
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