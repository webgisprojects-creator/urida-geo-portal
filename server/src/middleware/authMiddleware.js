import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { pool } from '../config/db.js';
import { fieldTaskUsernames } from '../utils/cityAccess.js';
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
// Field-task/chainage accounts (client/src/App.js:38 already special-cases
// this same account list to a 30-minute idle allowance for its own local
// "you're about to be logged out" countdown) — the server-side idle check
// below must honor the same 30 minutes, or the server silently invalidates
// the session at the global 15-minute default well before the client's own
// UI expects it to, logging a mid-task field worker out without warning.
const fieldTaskIdleTimeoutMs = Number(process.env.FIELD_TASK_SESSION_IDLE_TIMEOUT_MS || 30 * 60 * 1000);
const getIdleTimeoutMsForUser = (username) =>
  fieldTaskUsernames().has(String(username || "").toLowerCase().trim())
    ? fieldTaskIdleTimeoutMs
    : idleTimeoutMs;
let activeTokensReady = false;

// verifyToken runs on *every* request, including tile/GWC/WFS traffic —
// which fires in large simultaneous bursts (a single pan/zoom triggers 9+
// requests at once). Without this cache, every one of those requests did
// its own SELECT + UPDATE against active_tokens, and a 200-concurrent-user
// load test confirmed the real-world cost: GeoServer and Postgres both
// stayed near-idle throughout, but median request latency was ~20s anyway
// — the bottleneck was entirely the app's own DB_POOL_MAX=5 connection
// pool being saturated by redundant session-lookup queries, not real work.
// Caching a validated session for a few seconds turns "N requests in this
// window" into "1 DB round trip per token per window", which is what
// actually fixes the bottleneck rather than just widening the pool (which
// would still pay a DB round trip on every single tile request).
const SESSION_CACHE_TTL_MS = Number(process.env.SESSION_CACHE_TTL_MS || 5000);
const sessionCache = new Map(); // tokenHash -> { entry, userId, cachedAt }

const invalidateSessionCache = (token) => {
  if (!token) return;
  sessionCache.delete(hashToken(token));
};

const invalidateSessionCacheForUser = (userId) => {
  if (!userId) return;
  const id = String(userId);
  for (const [tokenHash, cached] of sessionCache.entries()) {
    if (cached.userId === id) sessionCache.delete(tokenHash);
  }
};

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
  invalidateSessionCache(token);
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
    // "Which machine is this user logged in from" (admin panel session
    // list) had nothing to show — this table never recorded it. Nullable
    // so existing rows (issued before this column existed) don't break.
    await pool.query(`ALTER TABLE active_tokens ADD COLUMN IF NOT EXISTS ip_address TEXT`);
    await pool.query(`ALTER TABLE active_tokens ADD COLUMN IF NOT EXISTS user_agent TEXT`);
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

export const storeActiveToken = async ({ token, userId, issuedAt, expiresAt, ip = null, userAgent = null }) => {
  if (!token || !userId) return;
  await ensureActiveTokensTable();
  const tokenHash = hashToken(token);
  try {
    await pool.query(
      `INSERT INTO active_tokens (token_hash, user_id, issued_at, expires_at, last_activity_time, status, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, 'active', $6, $7)
       ON CONFLICT (token_hash) DO UPDATE
       SET user_id = EXCLUDED.user_id,
           issued_at = EXCLUDED.issued_at,
           expires_at = EXCLUDED.expires_at,
           last_activity_time = EXCLUDED.last_activity_time,
           status = 'active',
           ip_address = EXCLUDED.ip_address,
           user_agent = EXCLUDED.user_agent`,
      [tokenHash, String(userId), issuedAt, expiresAt, issuedAt, ip, userAgent]
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
    invalidateSessionCache(token);
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
    invalidateSessionCacheForUser(userId);
  } catch (err) {
    console.error('active_tokens user purge failed:', err?.message || err);
    throw err;
  }
};

// Called at login, before the new session is created. Allows up to
// `maxSessions` concurrent devices per account (e.g. phone + browser) —
// logging in on a 3rd device evicts only the single oldest still-active
// session (by issued_at), not every other session, so a second device
// doesn't kick out a first one that's still within the allowed count.
export const enforceSessionLimit = async (userId, maxSessions) => {
  if (!userId) return;
  await ensureActiveTokensTable();
  try {
    const { rows } = await pool.query(
      `SELECT token_hash FROM active_tokens
       WHERE user_id = $1 AND status = 'active'
       ORDER BY issued_at ASC`,
      [String(userId)]
    );
    const overflow = rows.length - (maxSessions - 1);
    if (overflow <= 0) return;
    const toEvict = rows.slice(0, overflow).map((r) => r.token_hash);
    await pool.query(
      `UPDATE active_tokens SET status = 'session_limit_evicted' WHERE token_hash = ANY($1)`,
      [toEvict]
    );
    for (const tokenHash of toEvict) sessionCache.delete(tokenHash);
  } catch (err) {
    console.error('enforceSessionLimit failed:', err?.message || err);
    throw err;
  }
};

// Shared by verifyToken/tryVerifyToken: looks up an active_tokens row,
// serving a short-lived in-memory cached copy when available instead of
// hitting Postgres on every single request (see SESSION_CACHE_TTL_MS
// above for why this exists). The idle/absolute-timeout checks below may
// read a `last_activity_time` that's up to SESSION_CACHE_TTL_MS stale,
// which is negligible against timeouts measured in minutes.
const loadSessionEntry = async (token, tokenHash) => {
  const cached = sessionCache.get(tokenHash);
  if (cached && Date.now() - cached.cachedAt < SESSION_CACHE_TTL_MS) {
    return { entry: cached.entry, fromCache: true };
  }
  await ensureActiveTokensTable();
  const { rows } = await pool.query(
    `SELECT token_hash, user_id, issued_at, expires_at, last_activity_time, status
     FROM active_tokens
     WHERE token_hash = $1`,
    [tokenHash]
  );
  const entry = rows[0] || null;
  sessionCache.set(tokenHash, { entry, userId: entry?.user_id, cachedAt: Date.now() });
  return { entry, fromCache: false };
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
    const tokenHash = hashToken(token);
    const { entry, fromCache } = await loadSessionEntry(token, tokenHash);
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
    if (!lastActivity || now.getTime() - lastActivity.getTime() > getIdleTimeoutMsForUser(decoded?.username)) {
      await updateActiveTokenStatus(token, 'inactivated');
      return res.status(401).json({ message: 'Unauthorized' });
    }
    if (now.getTime() - new Date(entry.issued_at).getTime() > absoluteTimeoutMs) {
      await updateActiveTokenStatus(token, 'session_expired');
      return res.status(401).json({ message: 'Unauthorized' });
    }
    // Only actually touch the DB when this request is the one that did a
    // real fetch (cache miss) — every request riding the cached entry
    // within the same TTL window skips this write entirely, which is the
    // other half of the fix (a busy tile-loading burst used to fire one
    // UPDATE per request; now at most one per SESSION_CACHE_TTL_MS window).
    if (!fromCache) {
      await pool.query(
        `UPDATE active_tokens SET last_activity_time = $1 WHERE token_hash = $2`,
        [now, tokenHash]
      );
    }
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
    const tokenHash = hashToken(token);
    const { entry, fromCache } = await loadSessionEntry(token, tokenHash);
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
    if (!lastActivity || now.getTime() - lastActivity.getTime() > getIdleTimeoutMsForUser(decoded?.username)) {
      await updateActiveTokenStatus(token, 'inactivated');
      return next();
    }
    if (now.getTime() - new Date(entry.issued_at).getTime() > absoluteTimeoutMs) {
      await updateActiveTokenStatus(token, 'session_expired');
      return next();
    }
    if (!fromCache) {
      await pool.query(
        `UPDATE active_tokens SET last_activity_time = $1 WHERE token_hash = $2`,
        [now, tokenHash]
      );
    }
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
        // HIT/MISS/STALE from tiles.js/wfsCache.js when present — lets a
        // load test (or anyone reading audit.log) tell "slow because this
        // was a genuine cache miss doing real upstream work" apart from
        // "slow even though it was already cached", which would point at a
        // different problem (disk I/O, event-loop contention) instead.
        cache: res.get('X-Cache') || undefined,
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

// active_tokens gets a new row on every login and never had anything
// deleting old ones — non-active rows (logged_out, expired, inactivated,
// revoked, password_changed) just accumulated forever, with only the
// admin panel's manual "Clear Inactive History" button as a way to shrink
// it. Deliberately scoped to status <> 'active' only — an active session
// is left alone regardless of idle time, so a returning user's session
// (and anything it was legitimately still relying on) is never pulled out
// from under them by a background sweep. Same shape as tiles.js/
// wfsCache.js's own eviction schedules: a single lightweight DELETE on a
// long interval, off the request path, so this can never itself spike
// load.
const ACTIVE_TOKENS_RETENTION_MS = Number(process.env.ACTIVE_TOKENS_RETENTION_MS || 45 * 24 * 60 * 60 * 1000); // 45 days
const ACTIVE_TOKENS_SWEEP_INTERVAL_MS = Number(process.env.ACTIVE_TOKENS_SWEEP_INTERVAL_MS || 6 * 60 * 60 * 1000); // 6 hours

export async function runActiveTokensRetentionSweep() {
  try {
    await ensureActiveTokensTable();
    const cutoff = new Date(Date.now() - ACTIVE_TOKENS_RETENTION_MS);
    const result = await pool.query(
      `DELETE FROM active_tokens WHERE status <> 'active' AND last_activity_time < $1`,
      [cutoff]
    );
    if ((result.rowCount || 0) > 0) {
      console.log(`[active_tokens] retention sweep removed ${result.rowCount} stale inactive session record(s)`);
    }
  } catch (err) {
    console.error('active_tokens retention sweep failed:', err?.message || err);
  }
}

export function startActiveTokensRetentionSchedule() {
  setInterval(runActiveTokensRetentionSweep, ACTIVE_TOKENS_SWEEP_INTERVAL_MS);
}
