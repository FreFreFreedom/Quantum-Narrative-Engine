// Routes for the architecture intelligence surface — the platform watching
// itself (plan self-aware-platform.md, Parts 3–6). All under
// /api/architecture/intel/. The service layer (architectureIntelligence.js)
// owns every rule: this file only maps HTTP to it.
import { Router } from 'express';
import { intelApi, SIGNAL_META } from '../services/architectureIntelligence.js';
import { asyncHandler } from '../lib/asyncHandler.js';

export function intelRoutes(db) {
  const router = Router();

  // The pulse (Part 3 + 6.1/6.2/6.5): deterministic signals + health scores +
  // adoption meter, all cached ~20 s, zero model calls. Also fires the bounded
  // background pass (retrospectives → lessons) but never awaits it. The visible
  // catalog (what the user sees on the graph) travels as JSON. POST with a body
  // is the primary path — the tree grew too large for ?catalog= URLs (Node's
  // header cap rejects them with 431). GET ?catalog= stays for small callers.
  router.get('/signals', (req, res) => {
    let catalog = [];
    const raw = req.query.catalog;
    if (typeof raw === 'string') {
      try { const v = JSON.parse(raw); if (Array.isArray(v)) catalog = v; } catch { /* malformed — signals over DB-only rows */ }
    }
    const out = intelApi.signalsFor(db, catalog);
    intelApi.scheduleBackgroundIntel(db);
    res.json({ ...out, meta: SIGNAL_META });
  });

  router.post('/signals', (req, res) => {
    const catalog = Array.isArray(req.body?.catalog) ? req.body.catalog : [];
    const out = intelApi.signalsFor(db, catalog);
    intelApi.scheduleBackgroundIntel(db);
    res.json({ ...out, meta: SIGNAL_META });
  });

  // One-off migration: rewrite stored user-facing texts (mind thought titles and
  // bodies, suggestion titles and rationales) into plain everyday language —
  // the same rule new generations are born with. Idempotent.
  router.post('/vulgarize-existing', asyncHandler(async (req, res) => {
    const out = await intelApi.vulgarizeExistingTexts(db);
    res.json(out);
  }));

  // "Intentional, not a problem" (6.2): acknowledging a (type, scope, target)
  // combination silences that signal forever.
  router.post('/signals/ack', (req, res) => {
    const out = intelApi.acknowledgeSignal(db, req.body || {});
    if (out.error) return res.status(400).json(out);
    res.json(out);
  });

  // The Mind feed (Part 4): durable thoughts, newest first.
  router.get('/thoughts', (req, res) => {
    res.json({
      thoughts: intelApi.listThoughts(db, {
        status: req.query.status || null,
        scope: req.query.scope || null,
      }),
    });
  });

  router.get('/thoughts/:id', (req, res) => {
    const t = intelApi.getThought(db, req.params.id);
    if (!t) return res.status(404).json({ error: 'not_found' });
    res.json({ thought: t });
  });

  router.post('/thoughts', (req, res) => {
    const out = intelApi.createThought(db, req.body || {});
    if (out.error) return res.status(out.error === 'duplicate' ? 409 : 400).json(out);
    res.status(201).json(out);
  });

  // Accept → paused Flow task (the human gate). Edited title/prompt may be
  // passed for the rare case where the draft needs re-wording while accepting.
  router.post('/thoughts/:id/accept', asyncHandler(async (req, res) => {
    const out = await intelApi.acceptThought(db, req.params.id, {
      editedTitle: req.body?.editedTitle ?? null,
      editedPrompt: req.body?.editedPrompt ?? null,
    });
    if (out.error === 'not_found') return res.status(404).json(out);
    if (out.error === 'no_prompt') return res.status(400).json(out);
    res.json(out);
  }));

  router.post('/thoughts/:id/dismiss', (req, res) => {
    const out = intelApi.dismissThought(db, req.params.id, { reason: req.body?.reason });
    if (out.error) return res.status(404).json(out);
    res.json(out);
  });

  // Explicit clicks — never capped. Deepen: thoughts about one node; Pulse:
  // thoughts about the whole graph (focus 'growth' for 6.4 feature radar).
  router.post('/deepen', asyncHandler(async (req, res) => {
    const out = await intelApi.deepenNode(db, {
      catalog: req.body?.catalog || [],
      targetId: req.body?.targetId || '',
    });
    if (out.error === 'not_found') return res.status(404).json(out);
    if (out.error === 'all_duplicates') return res.status(409).json(out);
    if (out.error) return res.status(502).json(out);
    res.status(201).json(out);
  }));

  router.post('/pulse', asyncHandler(async (req, res) => {
    const out = await intelApi.pulseGraph(db, {
      catalog: req.body?.catalog || [],
      focus: req.body?.focus || 'pulse',
      force: true, // deliberate click: the cap applies to automatic passes only
    });
    if (out.error === 'cap') return res.status(429).json(out);
    if (out.error) return res.status(502).json(out);
    res.status(201).json(out);
  }));

  // Part 5: the Content graph wakes up — the same Mind, turned on the corpus
  // itself (focus 'themes' | 'bridges'). Explicit clicks, never capped.
  router.post('/content-pulse', asyncHandler(async (req, res) => {
    const out = await intelApi.contentPulse(db, {
      focus: req.body?.focus || 'themes',
      force: true,
    });
    if (out.error === 'cap') return res.status(429).json(out);
    if (out.error) return res.status(502).json(out);
    res.status(201).json(out);
  }));

  // The loop watching itself (6.5).
  router.get('/meter', (req, res) => {
    res.json(intelApi.adoptionMeter(db));
  });

  // Learned lessons (6.3) and the ranked drain for the overnight agent (6.6).
  router.get('/lessons', (req, res) => {
    res.json({ lessons: intelApi.listLessons(db, Math.min(Number(req.query.limit) || 8, 50)) });
  });

  router.get('/drain', (req, res) => {
    res.json({ thoughts: intelApi.drainList(db, { limit: Math.min(Number(req.query.limit) || 10, 50) }) });
  });

  return router;
}