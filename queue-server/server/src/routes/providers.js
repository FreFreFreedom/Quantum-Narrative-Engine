// Read endpoints for the frontend "Providers & quota" panel — the catalogue of
// free providers (with key-present flags, never the keys themselves) plus live
// exhaustion state from the ledger.
import { Router } from 'express';
import { listProviders } from '../services/ai/catalog.js';
import { getQuotaState, earliestResetAt } from '../services/ai/router.js';

export function providersRoutes() {
  const router = Router();

  // Distinct from queue.js's GET /providers (Claude/OpenCode liveness for the
  // New-prompt form) — this is the free-provider catalogue + quota-ledger state
  // for the AI Settings "Providers & quota" panel.
  router.get('/free-providers', (req, res) => {
    const providers = listProviders().map((p) => ({
      id: p.id, label: p.label, limits: p.limits,
      keyPresent: !!process.env[p.apiKeyEnv],
      models: p.models.map((m) => ({ id: m.id, codingRank: m.codingRank, contextTokens: m.contextTokens })).sort((a, b) => b.codingRank - a.codingRank),
    }));
    const state = getQuotaState();
    res.json({ providers, state, earliestResetAt: earliestResetAt() });
  });

  return router;
}
