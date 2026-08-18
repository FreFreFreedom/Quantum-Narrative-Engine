// Auth service: JWT + Google/GitHub OAuth
// Replaces server/src/auth.js with TypeScript + Postgres

import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { pool } from '../db/pool.js';
import type { Request, Response, NextFunction } from 'express';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'dev';

export interface User {
  id: string;
  name: string;
  email?: string;
  avatar_url?: string;
  provider: 'password' | 'google' | 'github';
  provider_id?: string;
  created_at: Date;
}

export interface JWTPayload {
  sub: string;
  name: string;
  email?: string;
  iat?: number;
  exp?: number;
}

// Password hashing
function hashPassword(password: string): string {
  return createHash('sha256').update(password + JWT_SECRET).digest('hex');
}

function verifyPassword(password: string, hash: string): boolean {
  return hashPassword(password) === hash;
}

// Issue JWT token
export function issueToken(user: User): string {
  return jwt.sign(
    { sub: user.id, name: user.name, email: user.email },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

// Verify JWT token
export function verifyToken(token: string): JWTPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as JWTPayload;
  } catch {
    return null;
  }
}

// Express middleware: require valid JWT
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'No token provided' });
    return;
  }
  
  const token = authHeader.slice(7);
  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ error: 'Invalid token' });
    return;
  }
  
  (req as any).user = payload;
  next();
}

// Get user by ID
export async function getUserById(id: string): Promise<User | null> {
  const res = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return res.rows[0] || null;
}

// Get user by email
export async function getUserByEmail(email: string): Promise<User | null> {
  const res = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  return res.rows[0] || null;
}

// Get user by OAuth provider
export async function getUserByProvider(provider: 'google' | 'github', providerId: string): Promise<User | null> {
  const res = await pool.query(
    'SELECT * FROM users WHERE provider = $1 AND provider_id = $2',
    [provider, providerId]
  );
  return res.rows[0] || null;
}

// Create or update user from OAuth
export async function upsertOAuthUser(params: {
  provider: 'google' | 'github';
  providerId: string;
  email: string;
  name: string;
  avatarUrl?: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
}): Promise<User> {
  const existing = await getUserByProvider(params.provider, params.providerId);
  
  if (existing) {
    await pool.query(
      `UPDATE users SET 
        name = $1, email = $2, avatar_url = $3, 
        updated_at = NOW()
       WHERE id = $4`,
      [params.name, params.email, params.avatarUrl, existing.id]
    );
    
    await pool.query(
      `INSERT INTO oauth_accounts (id, user_id, provider, provider_account_id, access_token, refresh_token, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, provider) DO UPDATE SET
         provider_account_id = EXCLUDED.provider_account_id,
         access_token = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         expires_at = EXCLUDED.expires_at,
         updated_at = NOW()`,
      [randomUUID(), existing.id, params.provider, params.providerId, params.accessToken, params.refreshToken, params.expiresAt]
    );
    
    return { ...existing, name: params.name, email: params.email, avatar_url: params.avatarUrl };
  }
  
  const userId = randomUUID();
  await pool.query(
    `INSERT INTO users (id, name, email, avatar_url, provider, provider_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, params.name, params.email, params.avatarUrl, params.provider, params.providerId]
  );
  
  await pool.query(
    `INSERT INTO oauth_accounts (id, user_id, provider, provider_account_id, access_token, refresh_token, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [randomUUID(), userId, params.provider, params.providerId, params.accessToken, params.refreshToken, params.expiresAt]
  );
  
  return {
    id: userId,
    name: params.name,
    email: params.email,
    avatar_url: params.avatarUrl,
    provider: params.provider,
    provider_id: params.providerId,
    created_at: new Date(),
  };
}

// Verify admin password
export async function verifyAdminPassword(password: string): Promise<boolean> {
  return password === ADMIN_PASSWORD;
}

// Create password user (for initial setup)
export async function createPasswordUser(email: string, password: string, name: string): Promise<User> {
  const userId = randomUUID();
  const passwordHash = hashPassword(password);
  
  await pool.query(
    `INSERT INTO users (id, name, email, provider, provider_id)
     VALUES ($1, $2, $3, 'password', $4)`,
    [userId, name, email, passwordHash]
  );
  
  return {
    id: userId,
    name,
    email,
    provider: 'password',
    created_at: new Date(),
  };
}

// Verify password login
export async function verifyPasswordLogin(email: string, password: string): Promise<User | null> {
  const user = await getUserByEmail(email);
  if (!user || user.provider !== 'password') return null;
  
  const res = await pool.query(
    'SELECT access_token FROM oauth_accounts WHERE user_id = $1 AND provider = $2',
    [user.id, 'password']
  );
  
  const hash = res.rows[0]?.access_token;
  if (!hash || !(await verifyPassword(password, hash))) return null;
  
  return user;
}

export { JWT_SECRET, ADMIN_PASSWORD };