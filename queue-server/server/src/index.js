import express from 'express';
import cors from 'cors';
import http from 'node:http';
import { openDb } from './db/schema.js';
import { requireAuth, issueToken } from './auth.js';
import { attachRealtime } from './realtime.js';
import { queueRoutes } from './routes/queue.js';
import { ontologyRoutes } from './routes/ontology.js';
import { chatRoutes } from './routes/chat.js';
import { bindDb, initPromptQueue } from './services/promptQueue.js';
import { migrateOntology, seedKnowledge } from './services/bootstrapData.js';
import { initTaskRunner } from './services/taskRunner.js';

process.on('unhandledRejection', (e) => console.error('Unhandled rejection (server stayed up):', e));
process.on('uncaughtException', (e) => console.error('Uncaught exception (server stayed up):', e));

const PORT = process.env.PORT || 8080;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const db = openDb();
bindDb(db);

// Repopulate ontology + knowledge data on every boot — Railway's free tier resets
// the DB on each deploy, so this has to be automatic, not a one-off manual step.
try {
  const ontologyResult = migrateOntology(db);
  const knowledgeResult = seedKnowledge(db);
  console.log('Bootstrap:', JSON.stringify({ ontologyResult, knowledgeResult }));
} catch (e) {
  console.error('Bootstrap data load failed:', e.message);
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
app.use('/api/ontology', requireAuth, ontologyRoutes(db));
app.use('/api/chat', requireAuth, chatRoutes(db));

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

server.listen(PORT, () => {
  console.log(`fmcns-queue-server listening on :${PORT}`);
});
