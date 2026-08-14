import express from 'express';
import cors from 'cors';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DB_PATH } from './db/schema.js';
import { requireAuth, issueToken } from './auth.js';
import { attachRealtime } from './realtime.js';
import { queueRoutes } from './routes/queue.js';
import { agentsRoutes } from './routes/agents.js';
import { ontologyRoutes } from './routes/ontology.js';
import { chatRoutes } from './routes/chat.js';
import { bindDb, initPromptQueue } from './services/promptQueue.js';
import { bindAgentsDb } from './services/agents.js';
import { migrateOntology, seedKnowledge, seedArchitectureHistory } from './services/bootstrapData.js';
import { initTaskRunner, bindTaskDb, DATA_DIR } from './services/taskRunner.js';
import { architectureRoutes } from './routes/architecture.js';
import { discoveryRoutes } from './routes/discovery.js';
import { warmCaches } from './services/warmup.js';
import { makeBooksHandler } from './services/books.js';
import { makeTagLensHandler } from './services/tagLens.js';
import { travauxRoutes } from './routes/travaux.js';
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

process.on('unhandledRejection', (e) => console.error('Unhandled rejection (server stayed up):', e));
process.on('uncaughtException', (e) => console.error('Uncaught exception (server stayed up):', e));

const PORT = process.env.PORT || 8080;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const volumeMount = process.env.RAILWAY_VOLUME_MOUNT_PATH;
const onVolume = (p) => !!volumeMount && p.startsWith(volumeMount);
console.log('Storage paths:', JSON.stringify({
  DB_PATH, DATA_DIR, RAILWAY_VOLUME_MOUNT_PATH: volumeMount || null,
  dbOnVolume: onVolume(DB_PATH), dataDirOnVolume: onVolume(DATA_DIR),
}));

const db = openDb();
bindDb(db);
bindTaskDb(db);
bindAgentsDb(db);
bindWorkSuggestionsDb(db);
bindWorkIdeasDb(db);
bindReviewsDb(db);
bindBriefingDb(db);
bindAiTextDb(db);
bindRouterDb(db);
bindQuotaSchedulerDb(db);
bindConversationsDb(db);

// Free-first platform policy (plan self-aware-platform.md Part 1): one-time
// migration of per-feature defaults away from the Claude subscription. Idempotent.
try {
  const migrated = migrateFreeFirstDefaults();
  if (migrated.changed) console.log(`Free-first policy: flipped ${migrated.changed} feature default(s) off Claude.`);
} catch (e) { console.error('Free-first defaults migration failed:', e.message); }

// Repopulate ontology + knowledge data on every boot — Railway's free tier resets
// the DB on each deploy, so this has to be automatic, not a one-off manual step.
try {
  const ontologyResult = migrateOntology(db);
  const knowledgeResult = seedKnowledge(db);
  const architectureHistoryResult = seedArchitectureHistory(db);
  console.log('Bootstrap:', JSON.stringify({ ontologyResult, knowledgeResult, architectureHistoryResult }));
} catch (e) {
  console.error('Bootstrap data load failed:', e.message);
}

// Regenerate the shared-knowledge briefing (.agents/current-state.md) at boot
// (plan Part 6). Best-effort — it needs a git repo; on Railway there is none.
try { regenerateBriefing(); } catch (e) { console.error('Briefing regenerate failed:', e.message); }

// Fire-and-forget: pre-generate book suggestions + first-tag lens for every
// character/country so they're already cached (instant) by the time a user
// clicks, instead of everyone eating live Claude-API latency after each redeploy.
// WARMUP_DISABLED=1 is used by the review runner's ephemeral boot check — a
// throwaway server that must not spend any API credits.
if (process.env.WARMUP_DISABLED !== '1') {
  warmCaches(db, { getBooks: makeBooksHandler(db), getTagLens: makeTagLensHandler(db) })
    .catch((e) => console.error('Cache warm-up failed:', e.message));
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' })); // PDFs come through as base64 in the chat payload

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'fmcns-queue-server', time: new Date().toISOString() });
});

app.post('/api/auth/login', (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(500).json({ error: 'server_not_configured', detail: 'ADMIN_PASSWORD is not set' });
  const { password } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'invalid_password' });
  res.json({ token: issueToken() });
});

app.use('/api/travaux', requireAuth, queueRoutes());
app.use('/api/travaux', requireAuth, agentsRoutes());
app.use('/api/travaux', requireAuth, travauxRoutes());
app.use('/api/travaux', requireAuth, reviewsRoutes());

app.get('/api/agent/usage', requireAuth, async (req, res) => {
  try {
    const usage = await getClaudeUsage();
    res.json({ ...usage, schedulerLimitResetAt: earliestResetAt() });
  } catch (err) {
    res.status(500).json({ error: 'usage_failed', message: err.message });
  }
});
app.use('/api/travaux', requireAuth, providersRoutes());
app.use('/api/ontology', requireAuth, ontologyRoutes(db));
app.use('/api/chat', requireAuth, chatRoutes(db));
app.use('/api/architecture', requireAuth, architectureRoutes(db));
app.use('/api/discovery', requireAuth, discoveryRoutes(db));
app.use('/api/convos', requireAuth, conversationsRoutes());

// Serve the single-file frontend app (fmcns_navigator.html, copied to
// public/index.html) at the root address, so the whole app lives at one URL.
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
app.use(express.static(PUBLIC_DIR));

const server = http.createServer(app);
attachRealtime(server);

// §12 step 1-3 foundation: DB + auth + realtime + the real queue engine. The task
// runner will only be able to actually execute work once CLAUDE_BIN points at an
// installed, authenticated Claude Code CLI — see README for that unresolved
// prerequisite. Until then, tasks enqueue and sit at 'approved'/'in_progress'
// without a real process backing them (or, in local dev, whatever CLAUDE_BIN
// mock script is configured).
initTaskRunner();
initPromptQueue();
startQuotaScheduler();

// One-off, env-gated: queues a single trivial real task on boot to verify the real
// Claude Code execution path end to end. Only fires when RUN_QUEUE_SELFTEST=1 is set;
// meant to be unset again right after the one test run.
if (process.env.RUN_QUEUE_SELFTEST === '1') {
  import('./services/promptQueue.js').then(async (pq) => {
    const row = await pq.createPrompt({
      title: 'Queue self-test',
      prompt: 'This is a one-off connectivity test of a real automated task queue. Reply with only the single word OK, and do not read, write, or modify any files.',
      mode: 'implement', preset: 'fast',
    });
    console.log('[selftest] queued prompt id=' + row.id);
    pq.advanceQueue();
  }).catch((e) => console.error('[selftest] failed to queue —', e.message));
}

server.listen(PORT, () => {
  console.log(`fmcns-queue-server listening on :${PORT}`);
});
