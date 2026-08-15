// Registry of in-flight toolless text-generation subprocesses (ai/text.js →
// provider runToolless). Two purposes:
//   1. A boot-time sweep (taskRunner.sweepOrphans) reads the pid files to kill
//      children left behind by a crashed server — the 38h zombie `opencode run
//      ... --agent fmcns-text` was exactly this: the parent died, the 4-min
//      timeout timer died with it, and the CLI ran on, reparented to init.
//   2. A graceful-shutdown handler (index.js SIGTERM/SIGINT) kills the server's
//      own in-flight text children instead of orphaning them on restart.
// Exec tasks are NOT tracked here: they are detached by design (the wrapper
// writes .agent-pid-<taskId> itself) and must survive server restarts.
// This module imports nothing from the rest of the codebase, so providers can
// import it without any circular-dependency risk.

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFileSync, unlinkSync } from 'node:fs';

export const TEXT_PID_PREFIX = '.agent-text-';

let DATA_DIR = null;
export function bindTextCallDir(dir) {
  DATA_DIR = dir || null;
}

const pidFileFor = (id) => (DATA_DIR ? join(DATA_DIR, `${TEXT_PID_PREFIX}${id}.pid`) : null);

// id → { pid, label }. Kept in memory so a live server knows its own children
// (the sweep only kills pids that are NOT in here — see taskRunner.js).
const active = new Map();

export function registerTextCall(pid, { label = 'text' } = {}) {
  const id = randomUUID();
  active.set(id, { pid, label });
  const f = pidFileFor(id);
  if (f) {
    try { writeFileSync(f, `${pid}\n`, 'utf8'); } catch { /* best-effort */ }
  }
  return id;
}

export function unregisterTextCall(id) {
  if (!id) return;
  active.delete(id);
  const f = pidFileFor(id);
  if (f) {
    try { unlinkSync(f); } catch { /* already gone */ }
  }
}

// Kill every text child this server currently has in flight (graceful shutdown).
// Returns the number of signals sent. Group-kill first (detached children), then
// a plain pid kill as fallback.
export function killTextCalls() {
  let n = 0;
  for (const { pid } of active.values()) {
    try { process.kill(-pid, 'SIGKILL'); n++; continue; } catch {}
    try { process.kill(pid, 'SIGKILL'); n++; } catch {}
  }
  active.clear();
  return n;
}

export function activeTextCallCount() { return active.size; }
