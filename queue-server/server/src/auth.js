// Minimal single-user JWT auth (§10.7: requireAuth is one of only two infra dependencies
// promptQueue.js needs). FMCNS is single-user, so there's no user table/password hashing —
// just one shared secret (ADMIN_PASSWORD) that exchanges for a signed JWT.

import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET env var is required.');
  process.exit(1);
}

export function issueToken() {
  return jwt.sign({ sub: 'antoine' }, JWT_SECRET, { expiresIn: '30d' });
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing_token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'invalid_token' });
  }
}
