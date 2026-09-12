// Read endpoints for the frontend "Providers & quota" panel — the catalogue of
// free providers (with key-present flags, never the keys themselves) plus live
// exhaustion state from the ledger.
import { Router } from 'express';
import { listProviders } from '../services/ai/catalog.js';
import { getQuotaState, earliestResetAt, getLaneUsage, getLastRefusals } from '../services/ai/router.js';

export function providersRoutes() {
  const router = Router();

  // Distinct from queue.js's GET /providers (Claude/OpenCode liveness for the
  // New-prompt form) — this is the free-provider catalogue + quota-ledger state
  // for the AI Settings "Providers & quota" panel.
  router.get('/free-providers', (req, res) => {
    const providers = listProviders().map((p) => ({
      id: p.id, label: p.label, limits: p.limits,
      keyPresent: !!process.env[p.apiKeyEnv],
      // Surfaced so the panel can mark the one paid lane as paid rather than
      // letting it sit unlabelled among the free ones.
      metered: !!p.metered,
      // A model's own allowance where it has one: Google's two flash models differ
      // by a factor of twenty-five, so the provider's single number cannot speak
      // for both.
      models: p.models.map((m) => ({ id: m.id, codingRank: m.codingRank, contextTokens: m.contextTokens, limits: m.limits || null })).sort((a, b) => b.codingRank - a.codingRank),
    }));
    const state = getQuotaState();
    // Today's counts and the last refusal each lane gave, so the panel can say what
    // a lane has actually done today instead of only whether it is benched now.
    const usage = getLaneUsage();
    res.json({
      providers, state, earliestResetAt: earliestResetAt(),
      day: usage.day, usage: usage.lanes, refusals: getLastRefusals(),
    });
  });

  return router;
}
