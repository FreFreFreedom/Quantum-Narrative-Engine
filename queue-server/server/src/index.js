import express from 'express';
import cors from 'cors';
import http from 'node:http';
import { openDb } from './db/schema.js';
import { requireAuth, issueToken } from './auth.js';
import { attachRealtime } from './realtime.js';
import { queueRoutes } from './routes/queue.js';

const PORT = process.env.PORT || 8080;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const db = openDb();

const app = express();
app.use(cors());
app.use(express.json());

// Unauthenticated health check — Railway (and you) can hit this to confirm the box is alive
// and the DB opened cleanly, without needing a token.
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'fmcns-queue-server', time: new Date().toISOString() });
});

app.post('/api/auth/login', (req, res) => {
  if (!ADMIN_PASSWORD) {
    return res.status(500).json({ error: 'server_not_configured', detail: 'ADMIN_PASSWORD is not set' });
  }
  const { password } = req.body || {};
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'invalid_password' });
  }
  res.json({ token: issueToken() });
});

app.use('/api/travaux', requireAuth, queueRoutes(db));

const server = http.createServer(app);
attachRealtime(server);

server.listen(PORT, () => {
  console.log(`fmcns-queue-server listening on :${PORT}`);
});
