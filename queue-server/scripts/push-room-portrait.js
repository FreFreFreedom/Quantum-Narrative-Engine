// Sends the body of data-seed/voices/the-room.md (who he is: his words, his story, his
// paradigm) into the AI Settings voice box the live Room reads. Run from queue-server/
// after editing that file. See AGENTS.md "Telling the Room something about him".
import fs from 'node:fs';
import { loadEnvFile } from '../server/src/lib/loadEnvFile.js';

loadEnvFile(new URL('../.env', import.meta.url));
const base = process.env.QUEUE_URL || 'https://quantum-narrative-engine-production.up.railway.app';
const body = fs.readFileSync(new URL('../data-seed/voices/the-room.md', import.meta.url), 'utf8')
  .replace(/^\s*<!--[\s\S]*?-->\s*/, '').trim();
const t = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: process.env.ADMIN_PASSWORD }) }).then((r) => r.json());
const r = await fetch(base + '/api/travaux/ai-settings', { method: 'PUT',
  headers: { Authorization: 'Bearer ' + t.token, 'Content-Type': 'application/json' },
  body: JSON.stringify({ studioPersona: body }) }).then((r) => r.json());
const ok = (r.studioPersona || '') === body;
console.log(ok ? `Room portrait live (${body.length} chars).` : 'Portrait NOT stored — box differs from the file.');
process.exit(ok ? 0 : 1);
