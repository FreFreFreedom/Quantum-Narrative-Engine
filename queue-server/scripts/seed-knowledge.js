// Manual/local wrapper around the same logic index.js runs automatically on every
// boot (server/src/services/bootstrapData.js). Useful for local testing.
import { openDb } from '../server/src/db/schema.js';
import { seedKnowledge } from '../server/src/services/bootstrapData.js';
const db = openDb();
console.log(seedKnowledge(db));
