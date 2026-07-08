import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { pool } from '../config/db.js';
import { blacklistToken, storeActiveToken, enforceSessionLimit, updateActiveTokenStatus, ensureActiveTokensTable, parseCookies, getClientIp } from '../middleware/authMiddleware.js';

// One account, up to this many devices logged in at once (e.g. phone +
// browser) — logging in on one more evicts only the single oldest
// session, not every other session.
const MAX_SESSIONS_PER_USER = Number(process.env.MAX_SESSIONS_PER_USER || 2);
dotenv.config();

const cookieName = process.env.AUTH_COOKIE_NAME || 'auth_token';
const captchaCookieName = process.env.CAPTCHA_COOKIE_NAME || 'auth_captcha';
const absoluteTimeoutMs = Number(process.env.SESSION_ABSOLUTE_TIMEOUT_MS || 30 * 60 * 1000);
const cookieMaxAgeMs = Number(process.env.JWT_COOKIE_MAX_AGE_MS || absoluteTimeoutMs);
const jwtExpiresIn = process.env.JWT_EXPIRES_IN || `${Math.max(1, Math.floor(absoluteTimeoutMs / 60000))}m`;
const lockoutWindowMs = 15 * 60 * 1000;
const captchaTtlMs = Number(process.env.CAPTCHA_TTL_MS || 5 * 60 * 1000);
const captchaStore = new Map();

// Shared accounts used only by KMC/iGile field-task redirects (multiple
// field staff sign in as the same account, identified afterward by the
// redirect URL's own user_id/title — see Header.jsx's profile dropdown).
// These must never be usable as an ordinary direct login: they're not tied
// to one person, so letting anyone log in with them from the plain login
// form would defeat the whole point of routing field work through KMC's
// own redirect links. Not a hard security boundary against a determined
// attacker forging a redirect string — there's no signed token from KMC to
// verify against — but it does stop the casual/accidental case of someone
// finding the shared credentials and using them outside that flow.
const FIELD_TASK_ONLY_USERNAMES = new Set(
  String(process.env.FIELD_TASK_ONLY_USERNAMES || 'chainage')
    .split(',')
    .map((u) => u.trim().toLowerCase())
    .filter(Boolean)
);

const isFieldTaskRedirectContext = (redirect) => {
  if (typeof redirect !== 'string' || !redirect) return false;
  return redirect.startsWith('/chainage') || /(?:^|[?&])mode=CHAINAGE(?:&|$)/i.test(redirect);
};

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
    // 'lax' (not 'strict') so the session cookie is still attached on a
    // top-level GET navigation from an external origin (e.g. the KMC field
    // app opening a fresh /chainage?... deep link) — 'strict' silently
    // withheld an already-valid cookie on that navigation, bouncing a
    // logged-in user back to the login page. Still blocked on cross-site
    // POST/fetch, so CSRF protection is unchanged.
    sameSite: 'lax',
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
  let mustChangePasswordCol;
  let passwordChangedAtCol;
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
    mustChangePasswordCol = resolveColumn(map, ['must_change_password']);
    passwordChangedAtCol = resolveColumn(map, ['password_changed_at']);
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
    mustChangePasswordCol = resolveColumn(map, ['must_change_password']);
    passwordChangedAtCol = resolveColumn(map, ['password_changed_at']);
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
    mustChangePasswordCol,
    passwordChangedAtCol,
  };
  return usersTableCache;
};

const ADMIN_ROLES = new Set(['admin', 'superadmin']);
const isAdminRole = (role) => ADMIN_ROLES.has(String(role || '').toLowerCase());

// Same policy adminRoutes.js's validatePassword() uses for admin-initiated
// resets — kept in sync manually rather than shared, since these are two
// separate route modules with no existing shared validators module.
const isPasswordPolicyValid = (value) => String(value || '').length >= 6;

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
      // Plaintext only for the frontend's audio ("speak the captcha")
      // accessibility control — never sent back in any error message, and
      // the actual answer check in consumeCaptcha() still validates
      // server-side against answerHash, so this doesn't change what login
      // requires. It does mean anyone reading this response can read the
      // captcha directly instead of solving the image — an inherent
      // trade-off of any client-side-spoken audio captcha, not something
      // fixable without server-side text-to-speech.
      audioText: captchaValue,
      expiresInSeconds: Math.floor(captchaTtlMs / 1000),
    },
  });
};

export const login = async (req, res) => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    return res.status(500).json({ success: false, message: 'Something went wrong. Please contact administrator.' });
  }
  const { username, password, captcha, redirect } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Invalid login credentials.' });
  }
  if (FIELD_TASK_ONLY_USERNAMES.has(String(username).toLowerCase()) && !isFieldTaskRedirectContext(redirect)) {
    logEvent('login_failed', username, { ip: getClientIp(req), reason: 'field_task_account_direct_login_blocked' });
    return res.status(403).json({
      success: false,
      message: 'This account is only available through an authorized field-task link.',
    });
  }
  const captchaResult = consumeCaptcha(req, res, captcha);
  if (!captchaResult.ok) {
    logEvent('login_captcha_failed', username, { ip: getClientIp(req) });
    // Unified user-facing wording regardless of the specific reason
    // (missing/expired/mismatched) — consumeCaptcha's own messages are
    // accurate but more detail than a login form should surface, and none
    // of them ever include the correct captcha value itself.
    return res.status(captchaResult.status).json({
      success: false,
      message: 'Incorrect captcha. Please enter the characters shown.',
    });
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
    const mustChangePasswordExpr = columns.mustChangePasswordCol
      ? `${quoteIdentifier(columns.mustChangePasswordCol)} AS must_change_password`
      : `NULL AS must_change_password`;
    const sql = `
      SELECT
        ${userIdExpr},
        ${quoteIdentifier(columns.usernameCol)} AS username,
        ${quoteIdentifier(columns.passwordCol)} AS password_hash,
        ${roleExpr},
        ${cityExpr},
        ${failedAttemptsExpr},
        ${lockUntilExpr},
        ${mustChangePasswordExpr}
      FROM ${tableRef}
      WHERE ${quoteIdentifier(columns.usernameCol)} = $1
      LIMIT 1
    `;
    const { rows } = await pool.query(sql, [username]);
    const user = rows[0];
    if (!user || !user.password_hash) {
      logEvent('login_failed', username, { ip: req.ip });
      return res.status(401).json({ success: false, message: 'Invalid login credentials.' });
    }
    // Admin/superadmin accounts are exempt from lockout entirely — never
    // locked, never counted toward it — per the requirement that an admin
    // must always be able to get back in. Failed attempts are still logged
    // below (logEvent runs unconditionally) for audit/debugging.
    const isAdmin = isAdminRole(user.role);
    const supportsLockout = Boolean(columns.failedAttemptsCol && columns.lockUntilCol) && !isAdmin;
    const lockUntil = user.lock_until ? new Date(user.lock_until) : null;
    if (supportsLockout && lockUntil && lockUntil.getTime() > Date.now()) {
      logEvent('login_failed', username, { ip: req.ip });
      return res.status(429).json({
        success: false,
        message: 'Your account has been locked. Please contact RSAC-UP to unlock your account.',
      });
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
      // supportsLockout is already false for admin accounts (see above), so
      // this increment never touches an admin's failed_attempts/lock_until.
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
      return res.status(401).json({ success: false, message: 'Invalid login credentials.' });
    }
    if (Boolean(columns.failedAttemptsCol && columns.lockUntilCol)) {
      const resetSql = `
        UPDATE ${tableRef}
        SET ${quoteIdentifier(columns.failedAttemptsCol)} = $1,
            ${quoteIdentifier(columns.lockUntilCol)} = $2
        WHERE ${quoteIdentifier(columns.usernameCol)} = $3
      `;
      await pool.query(resetSql, [0, null, user.username]);
    }
    const userIdForToken = user.user_id ?? user.username;
    const mustChangePassword = Boolean(user.must_change_password);
    const payload = {
      user_id: userIdForToken,
      username: user.username,
      role: user.role || 'user',
      city: user.city || null,
      must_change_password: mustChangePassword,
    };
    await enforceSessionLimit(userIdForToken, MAX_SESSIONS_PER_USER);
    const token = jwt.sign(payload, secret, { expiresIn: jwtExpiresIn });
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + absoluteTimeoutMs);
    await storeActiveToken({ token, userId: userIdForToken, issuedAt, expiresAt });
    res.cookie(cookieName, token, buildCookieOptions(req, cookieMaxAgeMs));
    logEvent('login', user.username, { ip: req.ip, mustChangePassword });
    return res.json({ success: true, role: payload.role, city: payload.city, mustChangePassword, user: payload });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Login failed';
    logEvent('login_failed', username, { ip: req.ip, error: message });
    console.error('Login failed:', message);
    const payload = { success: false, message: 'Something went wrong. Please contact administrator.' };
    return res.status(500).json(payload);
  }
};

// Self-service password change — the counterpart to admin's
// generate-temp-password/reset-password in adminRoutes.js. Reached after a
// user logs in with a temporary password (login() returns
// mustChangePassword: true); also usable any time by an already-logged-in
// user. Requires an existing valid session (verifyToken applied on the
// route), never a plaintext-password-in-URL reset link — this portal has
// no forgot-password flow by design, only admin-initiated resets.
export const changePassword = async (req, res) => {
  const { newPassword, confirmPassword } = req.body || {};
  if (!newPassword || !confirmPassword) {
    return res.status(400).json({ success: false, message: 'Please enter and confirm your new password.' });
  }
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ success: false, message: 'Passwords do not match.' });
  }
  if (!isPasswordPolicyValid(newPassword)) {
    return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
  }
  const username = req.user?.username;
  if (!username) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  try {
    const info = await loadUsersTableInfo();
    const { schema, table, columns } = info;
    const tableRef = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
    const hashed = await bcrypt.hash(newPassword, 10);
    const values = [hashed];
    const setParts = [`${quoteIdentifier(columns.passwordCol)} = $1`];
    if (columns.mustChangePasswordCol) {
      values.push(false);
      setParts.push(`${quoteIdentifier(columns.mustChangePasswordCol)} = $${values.length}`);
    }
    if (columns.passwordChangedAtCol) {
      values.push(new Date());
      setParts.push(`${quoteIdentifier(columns.passwordChangedAtCol)} = $${values.length}`);
    }
    const sql = `
      UPDATE ${tableRef}
      SET ${setParts.join(', ')}
      WHERE ${quoteIdentifier(columns.usernameCol)} = $${values.length + 1}
    `;
    const result = await pool.query(sql, [...values, username]);
    if ((result.rowCount || 0) === 0) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    // The JWT is stateless — req.user (and anything decoded from the old
    // cookie on the *next* request) would still carry must_change_password:
    // true from before this update, sending the user straight back to the
    // force-change-password screen in an infinite loop. Reissue the session
    // exactly as login() does, with the flag now cleared, and retire the
    // old token so there isn't a stale duplicate sitting in active_tokens.
    const secret = process.env.JWT_SECRET;
    if (secret) {
      const payload = {
        user_id: req.user.user_id,
        username: req.user.username,
        role: req.user.role,
        city: req.user.city,
        must_change_password: false,
      };
      const token = jwt.sign(payload, secret, { expiresIn: jwtExpiresIn });
      const issuedAt = new Date();
      const expiresAt = new Date(issuedAt.getTime() + absoluteTimeoutMs);
      await storeActiveToken({ token, userId: payload.user_id, issuedAt, expiresAt });
      if (req.token) {
        await updateActiveTokenStatus(req.token, 'password_changed');
      }
      res.cookie(cookieName, token, buildCookieOptions(req, cookieMaxAgeMs));
    }

    logEvent('password_changed', username, { ip: getClientIp(req) });
    return res.json({ success: true, message: 'Password updated successfully.' });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Password change failed';
    logEvent('password_change_failed', username, { ip: getClientIp(req), error: message });
    console.error('Password change failed:', message);
    return res.status(500).json({ success: false, message: 'Something went wrong. Please contact administrator.' });
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
