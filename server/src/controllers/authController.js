import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { pool } from '../config/db.js';
import { blacklistToken, storeActiveToken, clearActiveTokensForUser, updateActiveTokenStatus, ensureActiveTokensTable, parseCookies, getClientIp } from '../middleware/authMiddleware.js';
dotenv.config();

const cookieName = process.env.AUTH_COOKIE_NAME || 'auth_token';
const captchaCookieName = process.env.CAPTCHA_COOKIE_NAME || 'auth_captcha';
const absoluteTimeoutMs = Number(process.env.SESSION_ABSOLUTE_TIMEOUT_MS || 30 * 60 * 1000);
const cookieMaxAgeMs = Number(process.env.JWT_COOKIE_MAX_AGE_MS || absoluteTimeoutMs);
const jwtExpiresIn = process.env.JWT_EXPIRES_IN || `${Math.max(1, Math.floor(absoluteTimeoutMs / 60000))}m`;
const lockoutWindowMs = 15 * 60 * 1000;
const captchaTtlMs = Number(process.env.CAPTCHA_TTL_MS || 5 * 60 * 1000);
const captchaStore = new Map();

const usersTableCache = {
  schema: null,
  table: null,
  columns: null,
};

const quoteIdentifier = (value) => `"${String(value).replace(/"/g, '""')}"`;

const buildCookieOptions = (req, maxAge) => {
  const host = String(req.hostname || req.headers.host || '').toLowerCase();
  const isLocalhost = host.includes('localhost') || host.startsWith('127.0.0.1');
  const isSecureCookie =
    !isLocalhost &&
    (req.secure ||
      String(process.env.COOKIE_SECURE || '').toLowerCase() === 'true' ||
      process.env.NODE_ENV === 'production');
  return {
    httpOnly: true,
    secure: isSecureCookie,
    sameSite: 'strict',
    maxAge,
    path: '/',
  };
};

const purgeExpiredCaptchas = () => {
  const now = Date.now();
  for (const [captchaId, entry] of captchaStore.entries()) {
    if (!entry || entry.expiresAt <= now) {
      captchaStore.delete(captchaId);
    }
  }
};

const sanitizeCaptchaInput = (value) =>
  String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

const hashCaptchaValue = (value) =>
  crypto.createHash('sha256').update(sanitizeCaptchaInput(value)).digest('hex');

const generateCaptchaText = (length = 5) => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
};

const buildCaptchaDataUrl = (value) => {
  const chars = value.split('');
  const width = 240;
  const height = 74;
  const curvedNoise = [
    `<path d="M8,6 C28,18 18,48 50,58 S114,72 142,54" fill="none" stroke="rgba(72,114,221,0.58)" stroke-width="3.4" stroke-linecap="round"/>`,
    `<path d="M86,18 C120,10 156,18 168,42 S188,72 214,68" fill="none" stroke="rgba(72,114,221,0.52)" stroke-width="3.1" stroke-linecap="round"/>`,
    `<path d="M32,28 C76,46 116,30 150,42" fill="none" stroke="rgba(72,114,221,0.36)" stroke-width="2.1" stroke-linecap="round"/>`,
  ].join('');
  const textNodes = chars.map((char, idx) => {
    const x = 26 + idx * 39;
    const y = 40 + (idx % 2 === 0 ? 4 : -2);
    const rotate = [-12, -4, 8, -7, 11][idx] || 0;
    return `
      <g transform="rotate(${rotate} ${x} ${y})">
        <text x="${x}" y="${y}" font-family="Georgia, 'Times New Roman', serif" font-size="44" font-weight="700" fill="rgba(95,132,226,0.22)" stroke="rgba(95,132,226,0.18)" stroke-width="2.6">${char}</text>
        <text x="${x}" y="${y}" font-family="Georgia, 'Times New Roman', serif" font-size="41" font-weight="700" fill="#5b7fdc">${char}</text>
      </g>
    `;
  }).join('');
  const dots = Array.from({ length: 90 }, (_, idx) => {
    const cx = 8 + (idx * 17) % (width - 16);
    const cy = 8 + (idx * 23) % (height - 16);
    const r = idx % 5 === 0 ? 2 : 1.2;
    const opacity = idx % 7 === 0 ? 0.36 : 0.22;
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="rgba(81,123,223,${opacity})"/>`;
  }).join('');
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="CAPTCHA">
      <defs>
        <filter id="captchaBlur" x="-10%" y="-10%" width="120%" height="120%">
          <feGaussianBlur stdDeviation="0.35"/>
        </filter>
      </defs>
      <rect width="${width}" height="${height}" rx="2" fill="#f7f8fc" stroke="#d7deef"/>
      ${dots}
      <g filter="url(#captchaBlur)">
        ${textNodes}
      </g>
      ${curvedNoise}
    </svg>
  `.trim();
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
};

const consumeCaptcha = (req, res, captchaValue) => {
  purgeExpiredCaptchas();
  const normalized = sanitizeCaptchaInput(captchaValue);
  if (!normalized) {
    return { ok: false, status: 400, message: 'CAPTCHA is required.' };
  }
  const cookies = parseCookies(req.headers.cookie);
  const captchaId = cookies[captchaCookieName];
  if (!captchaId) {
    return { ok: false, status: 400, message: 'CAPTCHA is required.' };
  }
  const entry = captchaStore.get(captchaId);
  const cookieOptions = buildCookieOptions(req, captchaTtlMs);
  res.clearCookie(captchaCookieName, cookieOptions);
  captchaStore.delete(captchaId);
  if (!entry) {
    return { ok: false, status: 400, message: 'CAPTCHA expired. Please try again.' };
  }
  if (entry.expiresAt <= Date.now()) {
    return { ok: false, status: 400, message: 'CAPTCHA expired. Please try again.' };
  }
  if (entry.ip !== getClientIp(req) || entry.userAgent !== String(req.headers['user-agent'] || '')) {
    return { ok: false, status: 400, message: 'Invalid CAPTCHA.' };
  }
  if (entry.answerHash !== hashCaptchaValue(normalized)) {
    return { ok: false, status: 400, message: 'Invalid CAPTCHA.' };
  }
  return { ok: true };
};

const resolveColumn = (columnMap, candidates) => {
  for (const candidate of candidates) {
    const match = columnMap.get(candidate.toLowerCase());
    if (match) return match;
  }
  return null;
};

const loadUsersTableInfo = async () => {
  if (usersTableCache.schema && usersTableCache.table && usersTableCache.columns) {
    return usersTableCache;
  }
  const { rows: tableRows } = await pool.query(
    `SELECT table_schema, table_name
     FROM information_schema.tables
     WHERE table_name = 'users' AND table_type = 'BASE TABLE'
     ORDER BY (table_schema = 'public') DESC, table_schema
     LIMIT 1`
  );
  const target = tableRows[0];
  const findBestUserTable = async () => {
    const { rows } = await pool.query(
      `SELECT table_schema, table_name, column_name
       FROM information_schema.columns
       WHERE table_schema NOT IN ('pg_catalog', 'information_schema')`
    );
    const tableMap = new Map();
    rows.forEach((row) => {
      const key = `${row.table_schema}.${row.table_name}`;
      if (!tableMap.has(key)) {
        tableMap.set(key, {
          schema: row.table_schema,
          table: row.table_name,
          columns: new Map(),
        });
      }
      tableMap.get(key).columns.set(row.column_name.toLowerCase(), row.column_name);
    });
    let best = null;
    let bestScore = -1;
    for (const entry of tableMap.values()) {
      const map = entry.columns;
      const usernameCol = resolveColumn(map, ['username', 'user_name', 'login', 'email']);
      const passwordCol = resolveColumn(map, ['password_hash', 'password', 'pass_hash', 'passwd', 'pwd']);
      if (!usernameCol || !passwordCol) continue;
      const roleCol = resolveColumn(map, ['role', 'user_role', 'userrole', 'user_type', 'usertype']);
      const cityCol = resolveColumn(map, ['city', 'city_name', 'city_code', 'citycode', 'ulb', 'ulb_code']);
      const score = 2 + 2 + (roleCol ? 1 : 0) + (cityCol ? 1 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = { ...entry, usernameCol, passwordCol, roleCol, cityCol };
      }
    }
    return best;
  };
  const resolveTarget = async () => {
    if (target) {
      return { schema: target.table_schema, table: target.table_name };
    }
    return null;
  };
  const selectedTarget = await resolveTarget();
  let map;
  let usernameCol;
  let passwordCol;
  let roleCol;
  let cityCol;
  let idCol;
  let failedAttemptsCol;
  let lockUntilCol;
  if (selectedTarget) {
    const { rows: colRows } = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
      [selectedTarget.schema, selectedTarget.table]
    );
    map = new Map(colRows.map((r) => [r.column_name.toLowerCase(), r.column_name]));
    usernameCol = resolveColumn(map, ['username', 'user_name', 'login', 'email']);
    passwordCol = resolveColumn(map, ['password_hash', 'password', 'pass_hash', 'passwd', 'pwd']);
    roleCol = resolveColumn(map, ['role', 'user_role', 'userrole', 'user_type', 'usertype']);
    cityCol = resolveColumn(map, ['city', 'city_name', 'city_code', 'citycode', 'ulb', 'ulb_code']);
    idCol = resolveColumn(map, ['user_id', 'id']);
    failedAttemptsCol = resolveColumn(map, ['failed_attempts', 'failed_attempt', 'login_attempts']);
    lockUntilCol = resolveColumn(map, ['lock_until', 'locked_until']);
  } else {
    const best = await findBestUserTable();
    if (!best) {
      throw new Error('users table not found');
    }
    map = best.columns;
    usernameCol = best.usernameCol;
    passwordCol = best.passwordCol;
    roleCol = best.roleCol;
    cityCol = best.cityCol;
    idCol = resolveColumn(map, ['user_id', 'id']);
    failedAttemptsCol = resolveColumn(map, ['failed_attempts', 'failed_attempt', 'login_attempts']);
    lockUntilCol = resolveColumn(map, ['lock_until', 'locked_until']);
    usersTableCache.schema = best.schema;
    usersTableCache.table = best.table;
  }
  if (!usernameCol || !passwordCol) {
    const missing = [];
    if (!usernameCol) missing.push('username');
    if (!passwordCol) missing.push('password');
    throw new Error(`users table missing required columns: ${missing.join(', ')}`);
  }
  if (!usersTableCache.schema || !usersTableCache.table) {
    usersTableCache.schema = selectedTarget.schema;
    usersTableCache.table = selectedTarget.table;
  }
  usersTableCache.columns = {
    idCol,
    usernameCol,
    passwordCol,
    roleCol,
    cityCol,
    failedAttemptsCol,
    lockUntilCol,
  };
  return usersTableCache;
};

const logEvent = (type, username, extra = {}) => {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      type,
      username,
      ...extra,
    }) + '\n';
    const logFile = path.join(process.cwd(), 'server', 'logs', 'audit.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, line);
  } catch {}
};

export const getCaptcha = (req, res) => {
  purgeExpiredCaptchas();
  const captchaValue = generateCaptchaText();
  const captchaId = crypto.randomUUID();
  captchaStore.set(captchaId, {
    answerHash: hashCaptchaValue(captchaValue),
    expiresAt: Date.now() + captchaTtlMs,
    ip: getClientIp(req),
    userAgent: String(req.headers['user-agent'] || ''),
  });
  res.cookie(captchaCookieName, captchaId, buildCookieOptions(req, captchaTtlMs));
  return res.json({
    success: true,
    captcha: {
      image: buildCaptchaDataUrl(captchaValue),
      expiresInSeconds: Math.floor(captchaTtlMs / 1000),
    },
  });
};

export const login = async (req, res) => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    return res.status(500).json({ success: false, message: 'Something went wrong. Please contact administrator.' });
  }
  const { username, password, captcha } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Invalid login details.' });
  }
  const captchaResult = consumeCaptcha(req, res, captcha);
  if (!captchaResult.ok) {
    logEvent('login_captcha_failed', username, { ip: getClientIp(req) });
    return res.status(captchaResult.status).json({ success: false, message: captchaResult.message });
  }
  try {
    await ensureActiveTokensTable();
    const info = await loadUsersTableInfo();
    const { schema, table, columns } = info;
    const tableRef = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
    const userIdExpr = columns.idCol
      ? `${quoteIdentifier(columns.idCol)} AS user_id`
      : `${quoteIdentifier(columns.usernameCol)} AS user_id`;
    const roleExpr = columns.roleCol
      ? `${quoteIdentifier(columns.roleCol)} AS role`
      : `NULL AS role`;
    const cityExpr = columns.cityCol
      ? `${quoteIdentifier(columns.cityCol)} AS city`
      : `NULL AS city`;
    const failedAttemptsExpr = columns.failedAttemptsCol
      ? `${quoteIdentifier(columns.failedAttemptsCol)} AS failed_attempts`
      : `NULL AS failed_attempts`;
    const lockUntilExpr = columns.lockUntilCol
      ? `${quoteIdentifier(columns.lockUntilCol)} AS lock_until`
      : `NULL AS lock_until`;
    const sql = `
      SELECT
        ${userIdExpr},
        ${quoteIdentifier(columns.usernameCol)} AS username,
        ${quoteIdentifier(columns.passwordCol)} AS password_hash,
        ${roleExpr},
        ${cityExpr},
        ${failedAttemptsExpr},
        ${lockUntilExpr}
      FROM ${tableRef}
      WHERE ${quoteIdentifier(columns.usernameCol)} = $1
      LIMIT 1
    `;
    const { rows } = await pool.query(sql, [username]);
    const user = rows[0];
    if (!user || !user.password_hash) {
      logEvent('login_failed', username, { ip: req.ip });
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    const supportsLockout = Boolean(columns.failedAttemptsCol && columns.lockUntilCol);
    const lockUntil = user.lock_until ? new Date(user.lock_until) : null;
    if (supportsLockout && lockUntil && lockUntil.getTime() > Date.now()) {
      logEvent('login_failed', username, { ip: req.ip });
      return res.status(429).json({ success: false, message: 'Too many login attempts. Please try again later.' });
    }
    const storedHash = String(user.password_hash || '');
    const looksBcrypt = storedHash.startsWith('$2a$') || storedHash.startsWith('$2b$') || storedHash.startsWith('$2y$');
    let match = false;
    if (looksBcrypt) {
      match = await bcrypt.compare(password, storedHash);
    } else {
      match = password === storedHash;
      if (match) {
        const nextHash = await bcrypt.hash(password, 10);
        const updateSql = `
          UPDATE ${tableRef}
          SET ${quoteIdentifier(columns.passwordCol)} = $1
          WHERE ${quoteIdentifier(columns.usernameCol)} = $2
        `;
        await pool.query(updateSql, [nextHash, user.username]);
      }
    }
    if (!match) {
      if (supportsLockout) {
        const currentFailed = Number(user.failed_attempts || 0);
        const nextFailed = currentFailed + 1;
        const lockUntilNext = nextFailed >= 5 ? new Date(Date.now() + lockoutWindowMs) : null;
        const updateSql = `
          UPDATE ${tableRef}
          SET ${quoteIdentifier(columns.failedAttemptsCol)} = $1,
              ${quoteIdentifier(columns.lockUntilCol)} = $2
          WHERE ${quoteIdentifier(columns.usernameCol)} = $3
        `;
        await pool.query(updateSql, [nextFailed, lockUntilNext, user.username]);
      }
      logEvent('login_failed', username, { ip: req.ip });
      return res.status(401).json({ success: false, message: 'Invalid login details.' });
    }
    if (supportsLockout) {
      const resetSql = `
        UPDATE ${tableRef}
        SET ${quoteIdentifier(columns.failedAttemptsCol)} = $1,
            ${quoteIdentifier(columns.lockUntilCol)} = $2
        WHERE ${quoteIdentifier(columns.usernameCol)} = $3
      `;
      await pool.query(resetSql, [0, null, user.username]);
    }
    const userIdForToken = user.user_id ?? user.username;
    const payload = {
      user_id: userIdForToken,
      username: user.username,
      role: user.role || 'user',
      city: user.city || null,
    };
    await clearActiveTokensForUser(userIdForToken);
    const token = jwt.sign(payload, secret, { expiresIn: jwtExpiresIn });
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + absoluteTimeoutMs);
    await storeActiveToken({ token, userId: userIdForToken, issuedAt, expiresAt });
    res.cookie(cookieName, token, buildCookieOptions(req, cookieMaxAgeMs));
    logEvent('login', user.username, { ip: req.ip });
    return res.json({ success: true, role: payload.role, city: payload.city, user: payload });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Login failed';
    logEvent('login_failed', username, { ip: req.ip, error: message });
    console.error('Login failed:', message);
    const payload = { success: false, message: 'Something went wrong. Please contact administrator.' };
    return res.status(500).json(payload);
  }
};

export const logout = async (req, res) => {
  const username = req.user?.username || 'unknown';
  const exp = req.user?.exp;
  res.clearCookie(cookieName, buildCookieOptions(req, cookieMaxAgeMs));
  if (req.token) {
    blacklistToken(req.token, exp);
    try {
      await updateActiveTokenStatus(req.token, 'logged_out');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'logout_failed';
      logEvent('logout_failed', username, { ip: req.ip, error: message });
      return res.status(500).json({ success: false, message: 'Something went wrong. Please contact administrator.' });
    }
  }
  logEvent('logout', username, { ip: req.ip });
  return res.json({ success: true });
};

export const profile = (req, res) => {
  if (!req.user) {
    return res.json({ success: false });
  }
  return res.json({ success: true, user: req.user });
};
