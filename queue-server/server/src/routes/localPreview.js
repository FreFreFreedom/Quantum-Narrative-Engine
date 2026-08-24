// routes/localPreview.js — the Deploy / Discard bar's backend, for a local preview
// server ONLY (`oc preview <task-id>`, see ~/bin/oc). Never mounted on a normal boot
// — index.js only calls localPreviewRoutes() when PREVIEW_TASK_ID is set, which is
// exactly the env var the preview server is started with.
//
// Deploy does exactly what `oc ship` already does (push the branch, hand off to
// production's manual-complete), then exits this process — that IS "stopping the
// local preview server"; there is no separate shutdown endpoint. Discard throws the
// preview away and exits with nothing pushed, nothing called.
//
// Why this reads the production password straight out of queue-server/.env instead
// of process.env.ADMIN_PASSWORD: the preview server's OWN login is deliberately a
// throwaway ('dev' by default, see `oc preview` in ~/bin/oc) so a preview never needs
// the real password just to open the page locally. That throwaway value is a real
// env var, so loadEnvFile.js's "a real env var beats the file" rule would otherwise
// shadow the actual production password sitting in the same .env file. Logging in to
// PRODUCTION always needs the real one, so this reads the file directly rather than
// trusting whatever happens to be in process.env here.

import { Router } from 'express';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asyncHandler } from '../lib/asyncHandler.js';

// server/src/routes/localPreview.js -> routes -> src -> server -> queue-server -> repo root
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const PRODUCTION_URL = 'https://quantum-narrative-engine-production.up.railway.app';

export function productionPassword() {
  const envFile = join(REPO_ROOT, 'queue-server', '.env');
  if (!existsSync(envFile)) return null;
  const m = readFileSync(envFile, 'utf8').match(/^ADMIN_PASSWORD=(.*)$/m);
  if (!m) return null;
  return m[1].trim().replace(/^["']|["']$/g, '') || null;
}

async function productionLogin(password) {
  const r = await fetch(`${PRODUCTION_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!r.ok) throw new Error(`production login failed (${r.status})`);
  const { token } = await r.json();
  return token;
}

function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// Best-effort, used only to show the task's real title in the bar — the local
// preview DB has no row for it (it lives in production's DB). Never blocks boot.
export async function fetchPreviewTaskTitle(taskId) {
  try {
    const password = productionPassword();
    if (!password) return null;
    const token = await productionLogin(password);
    const r = await fetch(`${PRODUCTION_URL}/api/travaux/prompts?space=fmcns`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const { prompts = [] } = await r.json();
    const match = prompts.find((p) => p.id === taskId);
    return match?.title || null;
  } catch (e) {
    console.error('[preview] could not fetch task title from production:', e.message);
    return null;
  }
}

export function localPreviewRoutes({ taskId, branch }) {
  const router = Router();

  router.post('/deploy-preview', asyncHandler(async (req, res) => {
    if (!branch) return res.json({ ok: false, error: 'No branch known for this preview — cannot deploy.' });

    try {
      git(['push', 'origin', branch]);
    } catch (e) {
      return res.json({ ok: false, error: `Push failed: ${e.message}` });
    }

    let headSha;
    try {
      headSha = git(['rev-parse', 'HEAD']);
    } catch (e) {
      return res.json({ ok: false, error: `Could not read the branch's head commit: ${e.message}` });
    }

    const password = productionPassword();
    if (!password) return res.json({ ok: false, error: 'No production password found in queue-server/.env — cannot ship.' });

    let token;
    try {
      token = await productionLogin(password);
    } catch (e) {
      return res.json({ ok: false, error: e.message });
    }

    try {
      const r = await fetch(`${PRODUCTION_URL}/api/travaux/prompts/${taskId}/manual-complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ branch, head_sha: headSha }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok || !json.ok) {
        return res.json({ ok: false, error: json.error || `Production refused it (${r.status}).` });
      }
    } catch (e) {
      return res.json({ ok: false, error: `Could not reach production: ${e.message}` });
    }

    res.json({ ok: true });
    // The push and the ship both already happened — stopping the process now is what
    // "Deploy" means for a preview server. Give the response a moment to flush first.
    setTimeout(() => process.exit(0), 200);
  }));

  router.post('/discard-preview', (req, res) => {
    try {
      if (process.env.DB_PATH && existsSync(process.env.DB_PATH)) unlinkSync(process.env.DB_PATH);
    } catch (e) {
      console.error('[preview] could not remove the throwaway preview DB:', e.message);
    }
    res.json({ ok: true });
    setTimeout(() => process.exit(0), 200);
  });

  return router;
}
