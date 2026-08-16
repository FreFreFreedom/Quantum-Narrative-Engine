// WebSocket broadcast (§2, §10.7). promptQueue.js / taskRunner.js call broadcastAll(type, payload)
// without knowing who's listening; every connected client gets it as
// `{ type, payload }` and re-dispatches it as a window event on the client side (see spec §8's
// realtime.js). No per-client targeting needed — this is a single-user app.

import { WebSocketServer } from 'ws';
import { verifyToken } from './auth.js';

let wss = null;

// Every HTTP route is behind requireAuth — this channel was the one open door,
// broadcasting task/queue content (titles, prompts, results) to anyone who found
// /ws. A browser's WebSocket API can't set an Authorization header on the
// handshake, so the token travels as a query param instead.
export function attachRealtime(httpServer) {
  wss = new WebSocketServer({ server: httpServer, path: '/ws', verifyClient: ({ req }, done) => {
    try {
      const url = new URL(req.url, 'http://internal');
      const token = url.searchParams.get('token');
      if (!token) return done(false, 401, 'missing_token');
      verifyToken(token);
      done(true);
    } catch {
      done(false, 401, 'invalid_token');
    }
  } });
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'connected', payload: { at: new Date().toISOString() } }));
    ws.on('error', () => {});
  });
  return wss;
}

export function broadcastAll(type, payload) {
  if (!wss) return;
  const msg = JSON.stringify({ type, payload });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(msg);
  });
}
