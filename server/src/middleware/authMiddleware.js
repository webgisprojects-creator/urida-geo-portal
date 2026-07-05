import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { pool } from '../config/db.js';
dotenv.config();

// __dirname-relative, not process.cwd()-relative: the old
// path.join(process.cwd(), 'server', 'logs', ...) silently wrote to a
// wrong, doubled-up path (server/server/logs/audit.log) whenever the
// process was actually started with its cwd already inside server/ (the
// normal case for `npm run dev` there) — audit.log at the expected path
// went stale while a real one grew unnoticed one directory deeper.
const __filename_auth = fileURLToPath(import.meta.url);
const __dirname_auth = path.dirname(__filename_auth);
const AUDIT_LOG_FILE = path.join(__dirname_auth, '..', '..', 'logs', 'audit.log');

const cookieName = process.env.AUTH_COOKIE_NAME || 'auth_token';
const tokenBlacklist = new Map();
const idleTimeoutMs = Number(process.env.SESSION_IDLE_TIMEOUT_MS || 15 * 60 * 1000);
const absoluteTimeoutMs = Number(process.env.SESSION_ABSOLUTE_TIMEOUT_MS || 30 * 60 * 1000);
let activeTokensReady = false;

export const parseCookies = (cookieHeader) => {
  if (!cookieHeader) return {};
  return cookieHeader.split(';').reduce((acc, part) => {
    const trimmed = part.trim();
    if (!trimmed) return acc;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) return acc;
    const name = decodeURIComponent(trimmed.slice(0, eqIdx));
    const value = decodeURIComponent(trimmed.slice(eqIdx + 1));
    acc[name] = value;
    return acc;
  }, {});
};

export const getClientIp = (req) => {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const rawIp = forwarded || req.ip || req.socket?.remoteAddress || '';
  return String(rawIp).replace(/^::ffff:/, '');
};

const purgeExpiredTokens = () => {
  const now = Date.now();
  for (const [token, expMs] of tokenBlacklist.entries()) {
    if (!expMs || expMs <= now) {
      tokenBlacklist.delete(token);
    }
  }
};

export const blacklistToken = (token, expSeconds) => {
  if (!token) return;
  const expMs = expSeconds ? expSeconds * 1000 : Date.now() + 5 * 60 * 1000;
  tokenBlacklist.set(token, expMs);
};

const hashToken = (token) =>
  crypto.createHash('sha256').update(token).digest('hex');

export const ensureActiveTokensTable = async () => {
  if (activeTokensReady) return true;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS active_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        issued_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        last_activity_time TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
      )
    `);
    await pool.query(`ALTER TABLE active_tokens ADD COLUMN IF NOT EXISTS token_hash TEXT`);
    await pool.query(`ALTER TABLE active_tokens ADD COLUMN IF NOT EXISTS user_id TEXT`);
    await pool.query(`ALTER TABLE active_tokens ADD COLUMN IF NOT EXISTS issued_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE active_tokens ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE active_tokens ADD COLUMN IF NOT EXISTS last_activity_time TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE active_tokens ADD COLUMN IF NOT EXISTS status TEXT`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS active_tokens_token_hash_uidx ON active_tokens (token_hash)`);
    const { rows } = await pool.query(
      `SELECT data_type
       FROM information_schema.columns
       WHERE table_name = 'active_tokens' AND column_name = 'user_id'
       LIMIT 1`
    );
    const userIdType = rows[0]?.data_type || "";
    if (userIdType && !["text", "character varying"].includes(userIdType)) {
      await pool.query(
        `ALTER TABLE active_tokens
         ALTER COLUMN user_id TYPE TEXT
         USING user_id::text`
      );
    }
    activeTokensReady = true;
  } catch (err) {
    console.error('active_tokens init failed:', err?.message || err);
    throw err;
  }
  return activeTokensReady;
};

export const storeActiveToken = async ({ token, userId, issuedAt, expiresAt }) => {
  if (!token || !userId) return;
  await ensureActiveTokensTable();
  const tokenHash = hashToken(token);
  try {
    await pool.query(
      `INSERT INTO active_tokens (token_hash, user_id, issued_at, expires_at, last_activity_time, status)
       VALUES ($1, $2, $3, $4, $5, 'active')
       ON CONFLICT (token_hash) DO UPDATE
       SET user_id = EXCLUDED.user_id,
           issued_at = EXCLUDED.issued_at,
           expires_at = EXCLUDED.expires_at,
           last_activity_time = EXCLUDED.last_activity_time,
           status = 'active'`,
      [tokenHash, String(userId), issuedAt, expiresAt, issuedAt]
    );
  } catch (err) {
    console.error('active_tokens insert failed:', err?.message || err);
    throw err;
  }
};

export const revokeActiveToken = async (token) => {
  if (!token) return;
  await updateActiveTokenStatus(token, 'revoked');
};

export const updateActiveTokenStatus = async (token, status) => {
  if (!token || !status) return;
  await ensureActiveTokensTable();
  const tokenHash = hashToken(token);
  try {
    await pool.query(
      `UPDATE active_tokens
       SET status = $1
       WHERE token_hash = $2`,
      [status, tokenHash]
    );
  } catch (err) {
    console.error('active_tokens status update failed:', err?.message || err);
    throw err;
  }
};

export const clearActiveTokensForUser = async (userId) => {
  if (!userId) return;
  await ensureActiveTokensTable();
  try {
    await pool.query(`DELETE FROM active_tokens WHERE user_id = $1`, [String(userId)]);
  } catch (err) {
    console.error('active_tokens user purge failed:', err?.message || err);
    throw err;
  }
};

export const verifyToken = async (req, res, next) => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    return res.status(500).json({ message: 'Something went wrong. Please contact administrator.' });
  }
  const cookies = parseCookies(req.headers.cookie);
  const authHeader = req.headers.authorization;
  const headerToken = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
  const token = cookies[cookieName] || headerToken;
  if (!token) return res.status(401).json({ message: 'Unauthorized' });

  let decoded;
  try {
    decoded = jwt.verify(token, secret);
  } catch {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  try {
    purgeExpiredTokens();
    if (tokenBlacklist.has(token)) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    await ensureActiveTokensTable();
    const tokenHash = hashToken(token);
    const { rows } = await pool.query(
      `SELECT token_hash, user_id, issued_at, expires_at, last_activity_time, status
       FROM active_tokens
       WHERE token_hash = $1`,
      [tokenHash]
    );
    const entry = rows[0];
    if (!entry || entry.status !== 'active') {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    const now = new Date();
    const expiresAt = entry.expires_at ? new Date(entry.expires_at) : null;
    if (!expiresAt || expiresAt.getTime() <= now.getTime()) {
      await updateActiveTokenStatus(token, 'session_expired');
      return res.status(401).json({ message: 'Unauthorized' });
    }
    const lastActivity = entry.last_activity_time ? new Date(entry.last_activity_time) : null;
    if (!lastActivity || now.getTime() - lastActivity.getTime() > idleTimeoutMs) {
      await updateActiveTokenStatus(token, 'inactivated');
      return res.status(401).json({ message: 'Unauthorized' });
    }
    if (now.getTime() - new Date(entry.issued_at).getTime() > absoluteTimeoutMs) {
      await updateActiveTokenStatus(token, 'session_expired');
      return res.status(401).json({ message: 'Unauthorized' });
    }
    await pool.query(
      `UPDATE active_tokens SET last_activity_time = $1 WHERE token_hash = $2`,
      [now, tokenHash]
    );
    req.user = decoded;
    req.token = token;
    next();
  } catch {
    return res.status(500).json({ message: 'Something went wrong. Please contact administrator.' });
  }
};

export const tryVerifyToken = async (req, res, next) => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    return next();
  }
  const cookies = parseCookies(req.headers.cookie);
  const authHeader = req.headers.authorization;
  const headerToken = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
  const token = cookies[cookieName] || headerToken;
  if (!token) return next();

  let decoded;
  try {
    decoded = jwt.verify(token, secret);
  } catch {
    return next();
  }
  try {
    purgeExpiredTokens();
    if (tokenBlacklist.has(token)) {
      return next();
    }
    await ensureActiveTokensTable();
    const tokenHash = hashToken(token);
    const { rows } = await pool.query(
      `SELECT token_hash, user_id, issued_at, expires_at, last_activity_time, status
       FROM active_tokens
       WHERE token_hash = $1`,
      [tokenHash]
    );
    const entry = rows[0];
    if (!entry || entry.status !== 'active') {
      return next();
    }
    const now = new Date();
    const expiresAt = entry.expires_at ? new Date(entry.expires_at) : null;
    if (!expiresAt || expiresAt.getTime() <= now.getTime()) {
      await updateActiveTokenStatus(token, 'session_expired');
      return next();
    }
    const lastActivity = entry.last_activity_time ? new Date(entry.last_activity_time) : null;
    if (!lastActivity || now.getTime() - lastActivity.getTime() > idleTimeoutMs) {
      await updateActiveTokenStatus(token, 'inactivated');
      return next();
    }
    if (now.getTime() - new Date(entry.issued_at).getTime() > absoluteTimeoutMs) {
      await updateActiveTokenStatus(token, 'session_expired');
      return next();
    }
    await pool.query(
      `UPDATE active_tokens SET last_activity_time = $1 WHERE token_hash = $2`,
      [now, tokenHash]
    );
    req.user = decoded;
    req.token = token;
    next();
  } catch {
    return next();
  }
};

export const verifyRole = (...roles) => (req, res, next) => {
  const userRole = String(req.user?.role || '').toLowerCase();
  const allowed = roles.map((r) => String(r || '').toLowerCase());
  if (!userRole || !allowed.includes(userRole)) {
    return res.status(403).json({ message: 'Forbidden' });
  }
  next();
};

export const enforceCityScope = (paramNames = []) => (req, res, next) => {
  const role = String(req.user?.role || '').toLowerCase();
  if (role === 'admin') return next();
  const userCity = String(req.user?.city || '').toLowerCase();
  if (!userCity) return res.status(403).json({ message: 'Forbidden' });
  paramNames.forEach((name) => {
    if (req.params && Object.prototype.hasOwnProperty.call(req.params, name)) {
      req.params[name] = userCity;
    }
  });
  if (req.query && Object.prototype.hasOwnProperty.call(req.query, 'city')) {
    req.query.city = userCity;
  }
  req.cityScope = userCity;
  next();
};

// Response duration + status are attached via `res.on('finish')` rather
// than logged up front, so this line doubles as a timing record — how long
// every request (including tile/GWC fetches) actually took end to end, not
// just that it happened. Async append (not the old appendFileSync) so a
// disk write is never on the blocking path for high-frequency tile
// requests.
export const auditLogger = (req, res, next) => {
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    try {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Math.round(durationMs),
        username: req.user?.username || 'anonymous',
        role: req.user?.role || 'none',
        ip: req.ip,
        ua: req.headers['user-agent'] || ''
      }) + '\n';
      fs.mkdir(path.dirname(AUDIT_LOG_FILE), { recursive: true }, () => {
        fs.appendFile(AUDIT_LOG_FILE, line, () => {});
      });
    } catch {}
  });
  next();
};
