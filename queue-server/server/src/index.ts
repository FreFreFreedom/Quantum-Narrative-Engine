// Main entry point — TypeScript + Postgres version
/// <reference path="./global.d.ts" />

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Type-only imports for declaration-less modules
import type { Pool } from 'pg';
import { pool } from './db/pool.js';
import { applyAllSchemas } from './db/schema.js';
import { requireAuth, issueToken } from './services/auth.js';
import { attachRealtime } from './realtime.js';
import { queueRoutes } from './routes/queue.js';
import { agentsRoutes } from './routes/agents.js';
import { ontologyRoutes } from './routes/ontology.js';
import { chatRoutes } from './routes/chat.js';
import { bindDb, initPromptQueue } from './services/promptQueue.js';
import { bindAgentsDb } from './services/agents.js';
import { migrateOntology, seedKnowledge, seedArchitectureHistory, cleanupFrenchSuggestions } from './services/bootstrapData.js';
import { initTaskRunner, bindTaskDb, DATA_DIR } from './services/taskRunner.js';
import { architectureRoutes } from './routes/architecture.js';
import { intelRoutes } from './routes/intel.js';
import { discoveryRoutes } from './routes/discovery.js';
import { warmCaches } from './services/warmup.js';
import { startPreGen } from './services/preGen.js';
import { makeBooksHandler } from './services/books.js';
import { makeTagLensHandler } from './services/tagLens.js';
import { travauxRoutes } from './routes/travaux.js';
import { workerRoutes } from './routes/worker.js';
import { reviewsRoutes } from './routes/reviews.js';
import { bindWorkSuggestionsDb } from './services/workSuggestions.js';
import { bindWorkIdeasDb } from './services/workIdeas.js';
import { bindReviewsDb } from './services/reviewRunner.js';
import { bindBriefingDb, regenerateBriefing } from './services/briefing.js';
import { getClaudeUsage } from './services/claudeUsage.js';
import { bindAiTextDb, migrateFreeFirstDefaults } from './services/ai/text.js';
import { bindRouterDb, earliestResetAt } from './services/ai/router.js';
import { startQuotaScheduler, bindQuotaSchedulerDb } from './services/quotaScheduler.js';
import { providersRoutes } from './routes/providers.js';
import { conversationsRoutes } from './routes/conversations.js';
import { bindConversationsDb } from './services/conversations.js';
import { killTextCalls, activeTextCallCount } from './services/textCallRegistry.js';
import { errorHandler } from './lib/asyncHandler.js';
import authRoutes from './routes/auth.js';

process.on('unhandledRejection', (e) => console.error('Unhandled rejection (server stayed up):', e));
process.on('uncaughtException', (e) => console.error('Uncaught exception (server stayed up):', e));

// Graceful shutdown
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    const n = activeTextCallCount();
    if (n) console.log(`[shutdown] killing ${n} in-flight text call(s)…`);
    killTextCalls();
    process.exit(0);
  });
}

const PORT = process.env.PORT || 8080;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const volumeMount = process.env.RAILWAY_VOLUME_MOUNT_PATH;
const onVolume = (p: string) => !!volumeMount && p.startsWith(volumeMount);
console.log('Storage paths:', JSON.stringify({
  DATA_DIR, RAILWAY_VOLUME_MOUNT_PATH: volumeMount || null,
  dataDirOnVolume: onVolume(DATA_DIR),
}));

// Apply database schema
await applyAllSchemas(pool);

// Bind all services to the pg pool
bindDb(pool);
bindTaskDb(pool);
bindAgentsDb(pool);
bindWorkSuggestionsDb(pool);
bindWorkIdeasDb(pool);
bindReviewsDb(pool);
bindBriefingDb(pool);
bindAiTextDb(pool);
bindRouterDb(pool);
bindQuotaSchedulerDb(pool);
bindConversationsDb(pool);

// Free-first platform policy
try {
  const migrated = migrateFreeFirstDefaults();
  if (migrated.changed) console.log(`Free-first policy: flipped ${migrated.changed} feature default(s) off Claude.`);
} catch (e) { console.error('Free-first defaults migration failed:', (e as Error).message); }

// Bootstrap data
try {
  const ontologyResult = await migrateOntology(pool);
  const knowledgeResult = await seedKnowledge(pool);
  const architectureHistoryResult = await seedArchitectureHistory(pool);
  const suggestionsRelangResult = await cleanupFrenchSuggestions(pool);
  console.log('Bootstrap:', JSON.stringify({ ontologyResult, knowledgeResult, architectureHistoryResult, suggestionsRelangResult }));
} catch (e) {
  console.error('Bootstrap data load failed:', (e as Error).message);
}

// Express app
const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(rateLimit({ windowMs: 60_000, max: 300 }));

// Auth routes (no auth required)
app.use('/api/auth', authRoutes);

// Protected routes
app.use('/api/travaux', requireAuth, travauxRoutes);
app.use('/api/queue', requireAuth, queueRoutes);
app.use('/api/agents', requireAuth, agentsRoutes);
app.use('/api/ontology', requireAuth, ontologyRoutes);
app.use('/api/chat', requireAuth, chatRoutes);
app.use('/api/architecture', requireAuth, architectureRoutes);
app.use('/api/intel', requireAuth, intelRoutes);
app.use('/api/discovery', requireAuth, discoveryRoutes);
app.use('/api/worker', requireAuth, workerRoutes);
app.use('/api/reviews', requireAuth, reviewsRoutes);
app.use('/api/providers', requireAuth, providersRoutes);
app.use('/api/conversations', requireAuth, conversationsRoutes);

// Health check
app.get('/health', async (req, res) => {
  const dbOk = await pool.query('SELECT 1').then(() => true).catch(() => false);
  res.json({ ok: dbOk, time: new Date().toISOString() });
});

// Frontend (served from queue-server/public)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicPath = path.join(__dirname, '..', '..', 'public');
app.use(express.static(publicPath));
app.get('*', (req, res) => {
  res.sendFile(path.join(publicPath, 'index.html'));
});

// Error handler
app.use(errorHandler);

// HTTP server + WebSocket
const server = http.createServer(app);
attachRealtime(server, pool);

server.listen(PORT, () => {
  console.log(`🚀 FMCNS server listening on port ${PORT}`);
  initTaskRunner(pool);
  startPreGen(pool);
  startQuotaScheduler(pool);
  warmCaches(pool);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[shutdown] SIGTERM received');
  killTextCalls();
  await pool.end();
  server.close(() => process.exit(0));
});

process.on('SIGINT', async () => {
  console.log('[shutdown] SIGINT received');
  killTextCalls();
  await pool.end();
  server.close(() => process.exit(0));
});