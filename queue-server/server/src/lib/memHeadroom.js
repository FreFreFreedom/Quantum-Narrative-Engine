// Container memory headroom — how much RAM the server may still use before the
// platform's limit kills a process (Railway OOM = SIGKILL = exit code 137).
//
// On Linux, os.freemem() reads the HOST's /proc/meminfo, not the container's
// cgroup limit — useless for deciding whether a spawned agent would survive.
// This reads the cgroup accounting directly (v2 first, v1 fallback) so the
// queue's dispatch guard sees the number that actually matters. On macOS there
// are no cgroups; freemem() is the best available signal.

import { readFileSync, existsSync } from 'node:fs';
import { freemem } from 'node:os';

export function containerFreeBytes() {
  // cgroup v2: memory.max / memory.current
  try {
    const maxPath = '/sys/fs/cgroup/memory.max';
    if (existsSync(maxPath)) {
      const max = readFileSync(maxPath, 'utf8').trim();
      if (max !== 'max') {
        const limit = parseInt(max, 10);
        const used = parseInt(readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim(), 10);
        if (Number.isFinite(limit) && Number.isFinite(used)) return Math.max(0, limit - used);
      }
    }
  } catch {}
  // cgroup v1: memory.limit_in_bytes / memory.usage_in_bytes (a huge limit
  // means "no container limit" — treat as unknown, not as a 1TB free-for-all)
  try {
    const limitPath = '/sys/fs/cgroup/memory/memory.limit_in_bytes';
    if (existsSync(limitPath)) {
      const limit = parseInt(readFileSync(limitPath, 'utf8').trim(), 10);
      if (Number.isFinite(limit) && limit < 1e15) {
        const used = parseInt(readFileSync('/sys/fs/cgroup/memory/memory.usage_in_bytes', 'utf8').trim(), 10);
        if (Number.isFinite(used)) return Math.max(0, limit - used);
      }
    }
  } catch {}
  try { return freemem(); } catch { return null; }
}
