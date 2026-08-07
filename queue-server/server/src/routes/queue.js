// Minimal CRUD over work_prompts to prove the DB + auth + broadcast foundation end-to-end
// (§12 step 1). This is deliberately NOT promptQueue.js/taskRunner.js yet (§12 steps 2-3) —
// no ordering/status-machine/agent-spawning logic here, just enough to create/list/soft-delete
// a queue item and see it round-trip through Railway + Postgres-or-SQLite + a browser.

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { broadcastAll } from '../realtime.js';

export function queueRoutes(db) {
  const router = Router();

  router.get('/prompts', (req, res) => {
    const space = req.query.space || 'fmcns';
    const rows = db.prepare(
      `SELECT * FROM work_prompts WHERE space = ? AND deleted_at IS NULL ORDER BY position ASC, created_at ASC`
    ).all(space);
    res.json({ prompts: rows });
  });

  router.post('/prompts', (req, res) => {
    const { prompt, title, mode, preset, same_context, space } = req.body || {};
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'prompt_required' });
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const derivedTitle = title || prompt.split('\n')[0].slice(0, 80);
    db.prepare(`
      INSERT INTO work_prompts (id, title, prompt, mode, preset, same_context, space, title_auto, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'antoine', ?, ?)
    `).run(
      id, derivedTitle, prompt,
      mode === 'question' ? 'question' : 'implement',
      preset || 'deep',
      same_context ? 1 : 0,
      space || 'fmcns',
      title ? 0 : 1,
      now, now
    );
    const row = db.prepare(`SELECT * FROM work_prompts WHERE id = ?`).get(id);
    broadcastAll('travaux:prompts:updated', { id });
    res.status(201).json(row);
  });

  router.delete('/prompts/:id', (req, res) => {
    const now = new Date().toISOString();
    const result = db.prepare(`UPDATE work_prompts SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`)
      .run(now, now, req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'not_found' });
    broadcastAll('travaux:prompts:updated', { id: req.params.id, deleted: true });
    res.json({ ok: true });
  });

  return router;
}
