// services/agents.js — the agent roster, as data (plan Part 1, step 3 subset).
// The agents table is seeded with dev1 + dev2 on every boot (INSERT OR IGNORE in
// schema.js, so a UI edit is never clobbered); this service is the read/write seam
// for the roster, following the repo's routes→services pattern.

let db = null;
export function bindAgentsDb(database) { db = database; }

export function listAgents() {
  if (!db) return [];
  return db.prepare(`SELECT * FROM agents ORDER BY sort_order, key`).all();
}

export function getAgent(key) {
  if (!db || !key) return null;
  return db.prepare(`SELECT * FROM agents WHERE key=?`).get(key) || null;
}

// Whitelisted editable columns — a UI/API edit can never touch created_at or key.
const EDITABLE = [
  'label', 'emoji', 'role', 'persona', 'brief_file',
  'provider', 'provider_model', 'preset', 'tools',
  'path_allow', 'path_deny', 'max_parallel', 'enabled', 'paused', 'sort_order',
];

const ROLES = ['research', 'dev', 'design', 'test', 'reviewer', 'integrator'];
const PROVIDERS = ['claude-code', 'opencode'];

// POST — create a new agent. `key` is required (the roster is keyed on it; adding
// a sixth agent is one INSERT from the UI — "config, not migration").
export function createAgent(fields = {}) {
  if (!db) throw new Error('agents db not bound');
  const key = String(fields.key || '').trim();
  if (!/^[a-z0-9_-]{1,32}$/.test(key)) throw new Error('agent key must be 1–32 chars of a-z0-9_-');
  if (getAgent(key)) throw new Error(`agent '${key}' already exists`);
  const label = String(fields.label || '').trim() || key;
  const role = ROLES.includes(fields.role) ? fields.role : 'dev';
  const provider = PROVIDERS.includes(fields.provider) ? fields.provider : 'claude-code';
  const maxParallel = Math.max(1, Math.min(4, parseInt(fields.max_parallel, 10) || 1));
  db.prepare(`
    INSERT INTO agents (key, label, emoji, role, persona, brief_file, provider, provider_model,
      preset, tools, path_allow, path_deny, max_parallel, enabled, paused, sort_order)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    key, label, fields.emoji || null, role, String(fields.persona || ''),
    fields.brief_file || null, provider, fields.provider_model || null,
    ['fast', 'standard', 'deep', 'auto'].includes(fields.preset) ? fields.preset : 'standard',
    String(fields.tools || 'Bash,Read,Write,Edit,Glob,Grep'),
    String(fields.path_allow || '["**"]'), String(fields.path_deny || '[]'),
    maxParallel, fields.enabled === false ? 0 : 1, fields.paused ? 1 : 0,
    Number.isFinite(Number(fields.sort_order)) ? Number(fields.sort_order) : 0
  );
  return getAgent(key);
}

// PATCH — update whitelisted fields of an existing agent.
export function updateAgent(key, patch = {}) {
  if (!db) return null;
  if (!getAgent(key)) return null;
  const sets = [];
  const vals = [];
  for (const k of Object.keys(patch || {})) {
    if (!EDITABLE.includes(k)) continue;
    let v = patch[k];
    if (k === 'enabled' || k === 'paused') v = v ? 1 : 0;
    if (k === 'max_parallel') v = Math.max(1, Math.min(4, parseInt(v, 10) || 1));
    if (k === 'provider' && !PROVIDERS.includes(v)) continue;
    if (k === 'role' && !ROLES.includes(v)) continue;
    if (k === 'preset' && !['fast', 'standard', 'deep', 'auto'].includes(v)) continue;
    sets.push(`${k}=?`);
    vals.push(v);
  }
  if (!sets.length) return getAgent(key);
  sets.push(`updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
  db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE key=?`).run(...vals, key);
  return getAgent(key);
}

export function deleteAgent(key) {
  if (!db || !key || key === 'dev1' || key === 'dev2') return false;
  const del = db.prepare(`DELETE FROM agents WHERE key=?`).run(key);
  return del.changes > 0;
}
