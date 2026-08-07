// WebSocket broadcast (§2, §10.7). promptQueue.js / taskRunner.js call broadcastAll(type, payload)
// without knowing who's listening; every connected client gets it as
// `{ type, payload }` and re-dispatches it as a window event on the client side (see spec §8's
// realtime.js). No per-client targeting needed — this is a single-user app.

import { WebSocketServer } from 'ws';

let wss = null;

export function attachRealtime(httpServer) {
  wss = new WebSocketServer({ server: httpServer, path: '/ws' });
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
