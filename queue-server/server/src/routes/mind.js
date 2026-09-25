// Routes for the Room's shared memory (plan "room-shared-memory").
// Thin router behind requireAuth, same shape as every other route file.
import { Router } from 'express';
import * as mind from '../services/mind.js';
import { KINDS } from '../services/mind.js';
import { asyncHandler } from '../lib/asyncHandler.js';

// KINDS is imported, never re-declared. This file used to keep its own copy of the
// list, and it drifted the moment `vision` was added to mind.js: the service
// accepted the new kind and this router rejected it as `bad_kind`, so the Mind
// panel could not file the paradigm by hand and a probe against the deployed API
// read as "the deploy never landed".

export function mindRoutes() {
  const router = Router();

  router.get('/', (req, res) => {
    res.json({ facts: mind.listFacts({ activeOnly: true }) });
  });

  router.post('/', (req, res) => {
    const b = req.body || {};
    if (!b.text || !String(b.text).trim()) return res.status(400).json({ error: 'text_required' });
    if (b.kind && !KINDS.includes(b.kind)) return res.status(400).json({ error: 'bad_kind' });
    const saved = mind.saveFact({
      kind: b.kind || 'about', text: b.text, detail: b.detail || null, sourceNote: 'manual',
      ownerNote: b.ownerNote || null, central: !!b.central,
    });
    if (saved.error === 'duplicate') return res.status(409).json({ error: 'duplicate', id: saved.id });
    if (saved.error) return res.status(400).json(saved);
    res.json({ fact: saved });
  });

  // POST /api/mind/remember — the direct-text remember entrance (the Room Mind
  // pane's typed input has no conversation to read around it, unlike a selected
  // passage — see /api/convos/:id/remember for that one). Body:
  // { text, ownerNote?, central?, destination: 'memory'|'core' }.
  // One call: proposes the memory from his source + note, then saves it — Core
  // paradigm is his direct instruction to publish, no second approval screen.
  router.post('/remember', asyncHandler(async (req, res) => {
    const b = req.body || {};
    const text = String(b.text || '').trim();
    if (!text) return res.status(400).json({ error: 'empty' });
    const destination = b.destination === 'core' ? 'core' : 'memory';
    const proposed = await mind.proposeRemember({
      sourceType: 'direct', text, ownerNote: b.ownerNote || null, central: !!b.central, destination,
    });
    if (proposed.error) return res.status(proposed.error === 'empty' ? 400 : 500).json(proposed);
    const out = mind.saveRemembered({
      sourceType: 'direct', sourceText: text, ownerNote: b.ownerNote || null, central: !!b.central,
      destination, kind: proposed.kind, text: proposed.text, detail: proposed.detail,
    });
    if (out.error) return res.status(out.error === 'duplicate' ? 409 : 400).json(out);
    res.json(out);
  }));

  // Runner-only surface for the Core-paradigm append (queue-runner.js#publishCoreAdditions).
  // Never exposes a write path for the browser to invent a publication with — only
  // to list what saveRemembered() already queued, and acknowledge it after push.
  router.get('/core-publications/pending', (req, res) => {
    res.json({ publications: mind.listPendingCorePublications() });
  });

  // Lets the Room poll a pending Core save's status after a reload, so
  // "Publishing to core…" can turn into "In core" without staying in memory.
  router.get('/core-publications/:id', (req, res) => {
    const status = mind.corePublicationStatus(req.params.id);
    if (!status) return res.status(404).json({ error: 'not_found' });
    res.json(status);
  });

  router.post('/core-publications/:id/ack', (req, res) => {
    const out = mind.acknowledgeCorePublication(req.params.id, req.body?.commitSha || null);
    if (out.error) return res.status(400).json(out);
    res.json(out);
  });

  // Like — a passage of a Room answer answered the way he loves. Teaches the Mind.
  router.get('/likes', (req, res) => { res.json({ likes: mind.listLikes() }); });
  router.post('/likes', (req, res) => {
    const out = mind.likeLine({ text: req.body?.text, convoId: req.body?.convoId, messageId: req.body?.messageId, note: req.body?.note });
    if (out.error) return res.status(400).json(out);
    res.json(out);
  });
  router.patch('/likes/:id', (req, res) => {
    const out = mind.noteLike(req.params.id, req.body?.note);
    if (out.error) return res.status(404).json(out);
    res.json(out);
  });
  router.delete('/likes/:id', (req, res) => {
    const out = mind.unlikeLine(req.params.id);
    if (out.error) return res.status(404).json(out);
    res.json(out);
  });

  router.patch('/:id', (req, res) => {
    const b = req.body || {};
    if (b.kind && !KINDS.includes(b.kind)) return res.status(400).json({ error: 'bad_kind' });
    const out = mind.reviseFact(req.params.id, { text: b.text, detail: b.detail, kind: b.kind });
    if (out.error) return res.status(out.error === 'not_found' ? 404 : 400).json(out);
    res.json({ fact: out });
  });

  router.delete('/:id', (req, res) => {
    const out = mind.forgetFact(req.params.id);
    if (out.error) return res.status(out.error === 'not_found' ? 404 : 400).json(out);
    res.json({ ok: true });
  });

  // Manual trigger for the harvest job (useful for testing without waiting for the
  // turn watermark).
  //
  // `rescan: true` also rewinds the watermark, so the whole thread is read again
  // from its first message. Needed whenever what the harvest LOOKS FOR changes —
  // adding the `vision` kind meant every conversation already past the watermark
  // held paradigm material that would never be extracted otherwise. Safe to repeat:
  // saveFact() dedups on the normalised text, so a re-read of ground already
  // covered writes nothing.
  router.post('/harvest', asyncHandler(async (req, res) => {
    const b = req.body || {};
    if (!b.convoId) return res.status(400).json({ error: 'convoId_required' });
    if (b.rescan) mind.rewindHarvest(b.convoId);
    await mind.harvest(b.convoId, { force: true });
    res.json({ ok: true });
  }));

  // The library pass — read what he has KEPT (passages, shelf) rather than what he
  // said. Runs on its own after any conversation harvest; this is the "look now"
  // entrance, which also ignores the "enough new things yet?" threshold.
  router.post('/harvest-library', (req, res) => {
    res.json(mind.harvestLibrary({ force: true }));
  });

  // Fold entries that are one idea into one. Automatic once a day on the most
  // crowded kind; this asks for it now.
  router.post('/thicken', (req, res) => {
    res.json(mind.thickenMemory({ force: true }));
  });

  return router;
}
