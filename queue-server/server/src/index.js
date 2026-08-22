// Local .env first, before any module reads process.env at import time. No-op on
// Railway (variables come from the project there, no .env file exists).
import { loadEnvFile } from './lib/loadEnvFile.js';
loadEnvFile(new URL('../../.env', import.meta.url));

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
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
import { migrateOntology, seedKnowledge, seedArchitectureHistory, cleanupFrenchSuggestions, cleanupTestArchNode } from './services/bootstrapData.js';
import { initTaskRunner, bindTaskDb, DATA_DIR, runnerReportedUsage } from './services/taskRunner.js';
import { architectureRoutes } from './routes/architecture.js';
import { intelRoutes } from './routes/intel.js';
import { discoveryRoutes } from './routes/discovery.js';
import { warmCaches } from './services/warmup.js';
import { startPreGen } from './services/preGen.js';
import { makeBooksHandler } from './services/books.js';
import { makeTagLensHandler } from './services/tagLens.js';
import { travauxRoutes } from './routes/travaux.js';
import { cardLinesRoutes } from './routes/cardLines.js';
import { workerRoutes } from './routes/worker.js';
import { reviewsRoutes } from './routes/reviews.js';
import { bindWorkSuggestionsDb, classifyUnplacedSuggestions } from './services/workSuggestions.js';
import { bindWorkIdeasDb } from './services/workIdeas.js';
import { bindCardLinesDb } from './services/cardLines.js';
import { bindReviewsDb } from './services/reviewRunner.js';
import { bindGitJobsDb } from './services/gitJobs.js';
import { bindBriefingDb, regenerateBriefing } from './services/briefing.js';
import { bindProjectMapDb, buildProjectMap } from './services/projectMap.js';
import { bindTagCommunitiesDb, buildTagCommunities } from './services/tagCommunities.js';
import { getClaudeUsage } from './services/claudeUsage.js';
import { logBillingPosture, logOpenAiPosture } from './services/billingGuard.js';
import { bindOpenAiSpendDb, warmSpendCache, capState as openAiCapState } from './services/openaiSpend.js';
import { bindAiTextDb, migrateFreeFirstDefaults } from './services/ai/text.js';
import { bindRouterDb, queueDeferUntil } from './services/ai/router.js';
import { startQuotaScheduler, bindQuotaSchedulerDb } from './services/quotaScheduler.js';
import { providersRoutes } from './routes/providers.js';
import { conversationsRoutes } from './routes/conversations.js';
import { bindConversationsDb } from './services/conversations.js';
import { killTextCalls, activeTextCallCount } from './services/textCallRegistry.js';
import { errorHandler } from './lib/asyncHandler.js';

process.on('unhandledRejection', (e) => console.error('Unhandled rejection (server stayed up):', e));
process.on('uncaughtException', (e) => console.error('Uncaught exception (server stayed up):', e));

// Graceful shutdown: kill this server's own in-flight toolless text children
// (their 4-min timers die with the process — without this they'd orphan and run
// on, exactly the 38h zombie class this fix targets). Exec tasks are detached by
// design and are NOT killed here: they survive restarts and their monitors
// re-attach at boot.
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
bindCardLinesDb(db);
bindReviewsDb(db);
bindGitJobsDb(db);
bindBriefingDb(db);
bindProjectMapDb(db);
bindAiTextDb(db);
bindOpenAiSpendDb(db);
bindRouterDb(db);
bindQuotaSchedulerDb(db);
bindConversationsDb(db);
bindTagCommunitiesDb(db);

// Free-first platform policy (plan self-aware-platform.md Part 1): one-time
// migration of per-feature defaults away from the Claude subscription. Idempotent.
try {
  const migrated = migrateFreeFirstDefaults();
  if (migrated.changed) console.log(`Free-first policy: flipped ${migrated.changed} feature default(s) off Claude.`);
} catch (e) { console.error('Free-first defaults migration failed:', e.message); }

// Repopulate ontology + knowledge data on every boot. Not because the DB is wiped —
// production keeps it on a volume (CLAUDE.md, "Production data IS durable") — but so a
// change to a seed file reaches the app on the next deploy with no manual step. Cheap
// and idempotent; see services/bootstrapData.js.
try {
  const ontologyResult = migrateOntology(db);
  const knowledgeResult = seedKnowledge(db);
  const architectureHistoryResult = seedArchitectureHistory(db);
  const suggestionsRelangResult = cleanupFrenchSuggestions(db);
  const testNodeResult = cleanupTestArchNode(db);
  console.log('Bootstrap:', JSON.stringify({ ontologyResult, knowledgeResult, architectureHistoryResult, suggestionsRelangResult, testNodeResult }));
} catch (e) {
  console.error('Bootstrap data load failed:', e.message);
}

// Theme clusters: regroup the archetypal tags by how often they land on the same
// entity, once, from the live entity_tags table. Deliberately AFTER the bootstrap
// block above — that is what (re)fills entity_tags, and clustering before it would
// read an empty table on the first boot after a deploy. Pure arithmetic, no model
// calls, and it answers an empty index rather than throwing.
buildTagCommunities();

// Regenerate the shared-knowledge briefing (.agents/current-state.md) at boot
// (plan Part 6). Best-effort — it needs a git repo; on Railway there is none.
try { regenerateBriefing(); } catch (e) { console.error('Briefing regenerate failed:', e.message); }

// Build the Idea Studio's standing project map ONCE, here, and hold it in memory
// for the life of the process. It rides on every studio turn (~10k tokens), and
// prompt caching only pays for it if it is byte-identical every time — so it must
// never be rebuilt per turn. Runs after regenerateBriefing() on purpose: the map
// folds in the .agents/current-state.md that call just wrote.
try { buildProjectMap(); } catch (e) { console.error('Project map build failed:', e.message); }

// Background pre-generation: book suggestions + first-tag lens for every
// character/country, plus the suggestion/architecture/world-look sweeps.
//
// OFF BY DEFAULT (opt in with PREGEN_ENABLED=1), because these results are cached in
// the DB on first view anyway (entity_book_suggestions / entity_tag_lenses), so
// generating on demand costs one short wait once per item — for content that may never
// be opened at all. That is the whole reason, and it stands on its own.
//
// CAREFUL IF YOU REVISIT THIS. The original reason given here was different and was
// WRONG: it said Railway's free tier reset the DB every redeploy, so the "already
// cached?" guards always read empty and the full sweep re-ran every deploy at ~369 AI
// calls. Production keeps the DB on a volume (CLAUDE.md, "Production data IS durable"),
// so those guards DO work and the real cost of turning this on is only the
// not-yet-cached items — far less than 369, and near zero once warm. So the honest
// position is: re-enabling this is a legitimate judgment call about whether to pay
// up-front for content nobody may open, NOT something the old comment's arithmetic
// forbids. Decide it deliberately; don't let either version of this comment decide for
// you. Corrected 2026-08-21.
// WARMUP_DISABLED=1 is still honoured — the review runner's ephemeral boot
// check relies on it and must never spend credits.
if (process.env.PREGEN_ENABLED === '1' && process.env.WARMUP_DISABLED !== '1') {
  warmCaches(db, { getBooks: makeBooksHandler(db), getTagLens: makeTagLensHandler(db) })
    .catch((e) => console.error('Cache warm-up failed:', e.message));
  // Background pre-generation (suggestions + architecture "what's next") so those
  // tabs open instantly from the DB instead of waiting on a live generation.
  // Same WARMUP_DISABLED gate: the review runner's ephemeral boot must not spend.
  startPreGen(db);
}

// Sort any suggestions that predate the territory field into their territories, so the
// Flow's filter chips have something to filter on. Deliberately OUTSIDE the
// PREGEN_ENABLED gate above: that gate exists because those sweeps fired hundreds of
// calls on every single deploy. This is one call, made only when unplaced rows
// actually exist — once they are placed the query finds nothing and later boots spend
// nothing at all. WARMUP_DISABLED is still honoured: the review runner's throwaway
// boot must never spend. A failure here (Railway reaches Claude through the Mac
// runner's helper lane, which may be offline) is logged and retried next boot; nothing
// is left half-written, and the "Sort the old ones" button is the manual path.
if (process.env.WARMUP_DISABLED !== '1') {
  classifyUnplacedSuggestions()
    .then((r) => {
      if (r && r.updated) console.log(`[suggestions] placed ${r.updated} of ${r.considered} into territories`);
    })
    .catch((e) => console.error('[suggestions] one-off classify failed:', e.message));
}

const app = express();
// Railway terminates TLS at exactly one proxy in front of this container, so the
// client's real address arrives in X-Forwarded-For. Without this, express-rate-limit
// throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR on every login AND keys its bucket on the
// proxy's address instead of the caller's — meaning the 10-attempts-per-15-minutes
// login limit below is shared by everyone at once. The local runner re-logs in on
// start and on any 401, so that shared bucket can lock the runner out of its own
// queue: the queue then silently stops, which is the exact failure this app can least
// afford. One hop, not `true` — trusting every hop lets a caller spoof the header.
app.set('trust proxy', 1);
// Antoine opens fmcns_navigator.html either from the deployed frontend (same
// origin as this API — no CORS involved) or directly as a local file (Origin:
// null) — see CLAUDE.md. Allow just those, not any website that happens to
// hold a stolen token.
const ALLOWED_ORIGINS = [
  'https://quantum-narrative-engine-production.up.railway.app',
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
];
app.use(cors({
  origin(origin, callback) {
    // No Origin header (server-to-server, curl) or the file:// "null" origin —
    // allow both; a same-origin browser request also sends no Origin at all.
    if (!origin || origin === 'null') return callback(null, true);
    if (ALLOWED_ORIGINS.some((o) => (o instanceof RegExp ? o.test(origin) : o === origin))) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
}));
// CSP off: the frontend is a single file with inline <script>/<style> tags, which a
// default CSP would block outright. Every other helmet header (X-Content-Type-Options,
// X-Frame-Options, HSTS, X-Powered-By removal, etc.) still applies.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '25mb' })); // PDFs come through as base64 in the chat payload

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'fmcns-queue-server', time: new Date().toISOString() });
});

// Unlimited login attempts previously meant the shared password could be brute-forced
// with no throttling at the app layer at all.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_attempts', detail: 'Too many login attempts — try again in 15 minutes.' },
});

app.post('/api/auth/login', loginLimiter, (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(500).json({ error: 'server_not_configured', detail: 'ADMIN_PASSWORD is not set' });
  const { password } = req.body || {};
  if (!timingSafeEqualStrings(String(password || ''), ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'invalid_password' });
  }
  res.json({ token: issueToken() });
});

// crypto.timingSafeEqual throws on unequal-length buffers, so compare a fixed-size
// hash of each string instead of the raw (variable-length) values — that keeps the
// comparison itself constant-time regardless of how the two strings' lengths differ.
function timingSafeEqualStrings(a, b) {
  const ah = crypto.createHash('sha256').update(a).digest();
  const bh = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ah, bh);
}

app.use('/api/travaux', requireAuth, workerRoutes());
app.use('/api/travaux', requireAuth, queueRoutes());
app.use('/api/travaux', requireAuth, agentsRoutes());
app.use('/api/travaux', requireAuth, travauxRoutes());
app.use('/api/cards', requireAuth, cardLinesRoutes());
app.use('/api/travaux', requireAuth, reviewsRoutes());

// Say plainly at boot whether anything here can spend real money (billingGuard.js).
logBillingPosture();
// The one paid lane gets its own line, with the month-to-date figure — warming
// the cache here also means the first conversation turn doesn't wait on OpenAI's
// cost API before it can start.
warmSpendCache().then((cap) => logOpenAiPosture(cap)).catch(() => logOpenAiPosture(null));

app.get('/api/agent/usage', requireAuth, async (req, res) => {
  try {
    const local = await getClaudeUsage();
    // Claude runs on Antoine's Mac now, so the container's own read is usually
    // empty. When the attached runner has reported real subscription numbers,
    // those are the truthful ones — fall back to the local read otherwise.
    const fromRunner = runnerReportedUsage();
    const usage = (!local.subscriptionAvailable && fromRunner?.subscriptionAvailable)
      ? { ...fromRunner, source: 'runner' }
      : { ...local, source: 'server' };
    // The paid OpenAI lane, so the strip can show it beside the build quota. The
    // second Claude account no longer reports a quota at all: Anthropic rate-limits
    // that reading with a ~45-minute back-off, and nothing decides anything from it
    // any more — that account is simply spent to its ceiling, then work moves to the
    // main one (see ai/text.js).
    let openai = null;
    try { openai = await openAiCapState(); } catch {}
    res.json({
      ...usage,
      openai,
      schedulerLimitResetAt: queueDeferUntil(),
    });
  } catch (err) {
    res.status(500).json({ error: 'usage_failed', message: err.message });
  }
});
app.use('/api/travaux', requireAuth, providersRoutes());
app.use('/api/ontology', requireAuth, ontologyRoutes(db));
app.use('/api/chat', requireAuth, chatRoutes(db));
app.use('/api/architecture', requireAuth, architectureRoutes(db));
app.use('/api/architecture/intel', requireAuth, intelRoutes(db));
app.use('/api/discovery', requireAuth, discoveryRoutes(db));
app.use('/api/convos', requireAuth, conversationsRoutes());

// Serve the single-file frontend app (fmcns_navigator.html, copied to
// public/index.html) at the root address, so the whole app lives at one URL.
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
app.use(express.static(PUBLIC_DIR));

// Must be registered after every route: catches anything an asyncHandler-wrapped
// handler (or a synchronous throw) passes to next(err), so a failure always gets a
// response instead of hanging the request until the client times out.
app.use(errorHandler);

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
