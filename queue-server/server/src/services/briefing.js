// services/briefing.js — the "cheap shared knowledge" file set (plan Part 6).
// No embeddings, no RAG — instead a small curated, committed file set the CLI
// fetches on demand:
//   AGENTS.md                   — the communication policy + repo essentials
//   .agents/roles/<role>.md     — per-role briefs (persona + conventions)
//   .agents/current-state.md    — GENERATED here, ~3 KB, from data that already
//                                 exists (architecture components, agent roster,
//                                 open branches, plan backlog).
//
// regenerateBriefing() runs at boot after bootstrapData and after every merge;
// the merge step commits it, so agents branching from origin/main always get a
// fresh copy. Pure SQLite reads + one file write — zero tokens, zero API spend.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { mainRepo, listAgentBranches } from './gitOps.js';
import { getComponents } from './architecture.js';

let db = null;
export function bindBriefingDb(database) { db = database; }

const ROLES = [
  { key: 'dev', brief: '.agents/roles/dev.md' },
  { key: 'uiux', brief: '.agents/roles/uiux.md' },
  { key: 'immersive', brief: '.agents/roles/immersive.md' },
  { key: 'reviewer', brief: '.agents/roles/reviewer.md' },
];

// The prompt template's {{roleBrief}} variable — rendered from agents.persona
// plus a pointer to the agent's brief_file (plan Part 6: one Read call, a few
// hundred tokens, instead of pre-feeding every brief to every agent on every
// task). Falls back to the role's canonical brief when the row has none.
export function roleBriefFor(agent) {
  if (!agent) return '';
  const fallback = ROLES.find((r) => r.key === agent.role);
  const briefFile = agent.brief_file || (fallback ? fallback.brief : null);
  const parts = [];
  if (agent.persona) parts.push(`Your role: ${agent.persona}`);
  if (briefFile) parts.push(`First read your role brief: \`${briefFile}\``);
  return parts.join('\n');
}

// Next step for a component: the ladder entry right after the one marked
// "(current..." (some entries append e.g. "(current — 2 of 12 clusters)");
// if none is marked current, the first entry.
function nextStepFor(evolution) {
  if (!Array.isArray(evolution) || !evolution.length) return null;
  const idx = evolution.findIndex(([, text]) => String(text).includes('(current'));
  const next = idx >= 0 ? evolution[idx + 1] : evolution[0];
  return next ? String(next[1]) : null;
}

function planBacklog(main) {
  try {
    const readme = readFileSync(join(main, 'plans', 'README.md'), 'utf8');
    const rows = [];
    for (const line of readme.split('\n')) {
      const m = line.match(/^\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|[^|]*\|\s*([^|]+?)\s*\|$/);
      if (m) rows.push(`- ${m[1].replace(/\.md$/, '')} — ${m[3]}`);
    }
    return rows.length ? rows.join('\n') : '';
  } catch { return ''; }
}

// Regenerate .agents/current-state.md in the main repo. Best-effort: if there
// is no git repo (e.g. Railway), no plans/, or no components, it still writes
// the sections it can. Returns true when the file was (re)written.
export function regenerateBriefing() {
  const main = mainRepo();
  if (!main || !db) return false;
  try {
    const now = new Date().toISOString();
    const lines = [];
    lines.push('# FMCNS — current state (auto-generated, do not edit)', '');
    lines.push(`Generated: ${now}`, '');

    // Per-component live NOW / status / next step (architecture.js#getComponents).
    const components = getComponents(db);
    if (components.length) {
      lines.push('## Components', '');
      for (const c of components) {
        const next = nextStepFor(c.evolution);
        lines.push(`- ${c.id} · ${c.status || '—'} · next: ${next ? next.slice(0, 140) : '—'}`);
      }
      lines.push('');
    }

    // The agent roster (agents table — same source the Queue UI shows).
    const roster = db.prepare(`SELECT key, label, role, provider, enabled FROM agents ORDER BY sort_order, key`).all();
    if (roster.length) {
      lines.push('## Agent roster', '');
      for (const a of roster) {
        lines.push(`- ${a.key} · ${a.label} · ${a.role} · ${a.provider} · ${a.enabled ? 'enabled' : 'disabled'}`);
      }
      lines.push('');
    }

    // Open agent branches (read-only git query).
    const branches = listAgentBranches();
    if (branches.length) {
      lines.push('## Open agent branches', '');
      for (const b of branches) lines.push(`- ${b}`);
      lines.push('');
    }

    // Plan backlog table from plans/README.md.
    const backlog = planBacklog(main);
    if (backlog) {
      lines.push('## Plan backlog', '');
      lines.push(backlog);
      lines.push('');
    }

    const dir = join(main, '.agents');
    mkdirSync(dir, { recursive: true });
    const target = join(dir, 'current-state.md');
    const body = lines.join('\n');
    writeFileSync(target, body, 'utf8');
    console.log(`[briefing] wrote ${target} (${body.length} bytes)`);
    return true;
  } catch (e) {
    console.error('[briefing] regenerate failed:', e.message);
    return false;
  }
}
