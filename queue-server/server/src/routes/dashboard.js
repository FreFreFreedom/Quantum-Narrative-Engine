// Routes for the Command Center (plan "command-center-dashboard").
// Thin router behind requireAuth, same shape as every other route file: it holds no
// logic, it calls services/dashboard.js.
import { Router } from 'express';
import { dashboard } from '../services/dashboard.js';

export function dashboardRoutes() {
  const router = Router();

  // GET /api/dashboard — one request for the whole screen rather than five, so the
  // landing view has no waterfall. The ranked "what to build next" is NOT here and
  // is fetched separately by the browser: nextSteps() needs the component catalogue
  // and that lives in the frontend file, which is also why /api/architecture/next is
  // a POST. See the service's header.
  router.get('/', (req, res) => {
    const out = dashboard();
    if (out.error) return res.status(503).json(out);
    res.json(out);
  });

  return router;
}
