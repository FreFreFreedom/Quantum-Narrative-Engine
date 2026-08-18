// OAuth routes: Google + GitHub authentication
// Mount at /api/auth

import { Router, Request, Response, NextFunction } from 'express';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { Strategy as GitHubStrategy } from 'passport-github2';
import session from 'express-session';
import { pool } from '../db/pool.js';
import { 
  upsertOAuthUser, 
  issueToken, 
  verifyToken,
  getUserById,
  User,
} from '../services/auth.js';

const router = Router();

// Session middleware (required for Passport)
router.use(session({
  secret: process.env.SESSION_SECRET || process.env.JWT_SECRET || 'dev-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  },
}));

router.use(passport.initialize());
router.use(passport.session());

// Passport serialization - use string ID
passport.serializeUser((user: Express.User, done: (err: Error | null, id?: string) => void) => {
  done(null, user.id);
});

passport.deserializeUser(async (id: string, done: (err: Error | null, user?: Express.User | false) => void) => {
  try {
    const user = await getUserById(id);
    done(null, user || false);
  } catch (e) {
    done(e as Error, false);
  }
});

// Google Strategy
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: `${process.env.APP_URL || 'http://localhost:3000'}/api/auth/google/callback`,
    scope: ['profile', 'email'],
  }, async (accessToken: string, refreshToken: string, profile: any, done: (err: Error | null, user?: Express.User | false) => void) => {
    try {
      const email = profile.emails?.[0]?.value;
      if (!email) return done(new Error('No email from Google'), false);
      
      // Google profile._json doesn't have expires_at, use token expiry instead
      const expiresAt = profile._json?.exp ? new Date(profile._json.exp * 1000) : undefined;
      
      const user = await upsertOAuthUser({
        provider: 'google',
        providerId: profile.id,
        email,
        name: profile.displayName || email,
        avatarUrl: profile.photos?.[0]?.value,
        accessToken,
        refreshToken,
        expiresAt,
      });
      done(null, user);
    } catch (e) {
      done(e as Error, false);
    }
  }));
}

// GitHub Strategy
if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
  passport.use(new GitHubStrategy({
    clientID: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    callbackURL: `${process.env.APP_URL || 'http://localhost:3000'}/api/auth/github/callback`,
    scope: ['user:email'],
  }, async (accessToken: string, refreshToken: string, profile: any, done: (err: Error | null, user?: Express.User | false) => void) => {
    try {
      const email = profile.emails?.[0]?.value || `${profile.username}@github.local`;
      
      const user = await upsertOAuthUser({
        provider: 'github',
        providerId: profile.id,
        email,
        name: profile.displayName || profile.username || email,
        avatarUrl: profile.photos?.[0]?.value,
        accessToken,
        refreshToken,
      });
      done(null, user);
    } catch (e) {
      done(e as Error, false);
    }
  }));
}

// ─── Routes ────────────────────────────────────────────────────────────────────

// Google OAuth
router.get('/google', 
  (req: Request, res: Response, next: NextFunction) => {
    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.status(501).json({ error: 'Google OAuth not configured' });
    }
    next();
  },
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

router.get('/google/callback',
  passport.authenticate('google', { failureRedirect: '/login?error=google', session: false }),
  (req: Request, res: Response) => {
    const user = req.user as Express.User;
    const token = issueToken(user);
    
    // Redirect to frontend with token
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    res.redirect(`${frontendUrl}/?token=${token}&provider=google`);
  }
);

// GitHub OAuth
router.get('/github',
  (req: Request, res: Response, next: NextFunction) => {
    if (!process.env.GITHUB_CLIENT_ID) {
      return res.status(501).json({ error: 'GitHub OAuth not configured' });
    }
    next();
  },
  passport.authenticate('github', { scope: ['user:email'] })
);

router.get('/github/callback',
  passport.authenticate('github', { failureRedirect: '/login?error=github', session: false }),
  (req: Request, res: Response) => {
    const user = req.user as Express.User;
    const token = issueToken(user);
    
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    res.redirect(`${frontendUrl}/?token=${token}&provider=github`);
  }
);

// Get current user (from JWT)
router.get('/me', async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  
  const token = authHeader.slice(7);
  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  
  const user = await getUserById(payload.sub);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  res.json({ user: { id: user.id, name: user.name, email: user.email, avatar_url: user.avatar_url } });
});

// Logout
router.post('/logout', (req: Request, res: Response) => {
  req.logout(() => {});
  req.session.destroy(() => {});
  res.json({ ok: true });
});

// Password login (for backwards compatibility)
router.post('/password', async (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }
  
  const { verifyPasswordLogin } = await import('../services/auth.js');
  const user = await verifyPasswordLogin(email, password);
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  
  const token = issueToken(user);
  res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
});

export default router;