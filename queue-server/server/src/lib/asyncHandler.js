// Wraps an async Express route handler so a rejected promise reaches next(err)
// instead of hanging the request forever. Before this, a route with no try/catch
// whose service call threw just left the client waiting until it timed out — the
// only visible trace was the process-level unhandledRejection logger in index.js.
// Pair with errorHandler (same directory) registered last in the middleware chain.
export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// Attach { status, expose: true } to a thrown Error to control the response the
// global error handler sends — e.g. `const e = new Error('not_found'); e.status = 404;
// e.expose = true; throw e;`. Anything not marked expose:true is reported to the
// client as a bare 500 with no message, so an unexpected internal error can never
// leak implementation detail (or an env var accidentally folded into an Error's
// message) to the response.
export function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  console.error(`[${req.method} ${req.originalUrl}] unhandled error:`, err);
  if (res.headersSent) return next(err);
  const status = Number.isInteger(err?.status) ? err.status : 500;
  const error = err?.expose ? (err.message || 'error') : 'internal_error';
  res.status(status).json({ error });
}
