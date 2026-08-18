// Main schema entry point - combines all schema modules

import { Pool } from 'pg';
import { applySchema as applyCoreSchema } from './schema-core.js';
import { 
  applyOntologySchema, 
  applyArchitectureSchema, 
  applyDiscoverySchema, 
  applyConversationsSchema, 
  applyFilmEnrichmentSchema 
} from './schema-ontology.js';

export async function applySchema(pool: Pool) {
  await applyCoreSchema(pool);
}

export async function applyAllSchemas(pool: Pool) {
  await applyCoreSchema(pool);
  await applyOntologySchema(pool);
  await applyArchitectureSchema(pool);
  await applyDiscoverySchema(pool);
  await applyConversationsSchema(pool);
  await applyFilmEnrichmentSchema(pool);
  console.log('✓ All schemas applied successfully');
}

// Re-export individual schema functions
export { 
  applyOntologySchema, 
  applyArchitectureSchema, 
  applyDiscoverySchema, 
  applyConversationsSchema, 
  applyFilmEnrichmentSchema 
} from './schema-ontology.js';