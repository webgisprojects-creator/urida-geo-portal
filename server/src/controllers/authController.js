import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { pool } from '../config/db.js';
dotenv.config({ path: path.resolve(process.cwd(), 'server/.env') });

/* ── Audit logger (unchanged) ──────────────────────────────────────────── */
const logEvent = (type, username, extra = {}) => {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      type,
      username,
      ...extra,
    }) + '\n';
    const logFile = path.join(process.cwd(), 'servernew', 'logs', 'audit.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, line);
  } catch {}
};

/* ── Password verification — handles both bcrypt hashes and plaintext ── */
const verifyPassword = async (input, stored) => {
  if (stored && stored.startsWith('$2')) {
    // bcrypt hash (e.g. admin account)
    return bcrypt.compare(input, stored);
  }
  // plaintext (city user accounts)
  return input === stored;
};

/* ── POST /api/auth/login ──────────────────────────────────────────────── */
export const login = async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username and password are required' });
  }

  try {
    const result = await pool.query(
      `SELECT id, username, password, role, city, is_active
       FROM public.users
       WHERE username = $1
       LIMIT 1`,
      [username.trim()]
    );

    const user = result.rows[0];

    if (!user || !user.is_active) {
      logEvent('login_failed', username, { ip: req.ip, reason: user ? 'account_inactive' : 'user_not_found' });
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const valid = await verifyPassword(password, user.password);
    if (!valid) {
      logEvent('login_failed', username, { ip: req.ip, reason: 'wrong_password' });
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    // Issue JWT — payload compatible with existing authMiddleware.js
    const payload = {
      id: user.id,
      username: user.username,
      role: user.role,
      city: user.city,
    };
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '8h' });

    // Update last_login (non-blocking — don't await)
    pool.query(
      `UPDATE public.users SET last_login = NOW() WHERE id = $1`,
      [user.id]
    ).catch(() => {});

    logEvent('login', user.username, { ip: req.ip, role: user.role, city: user.city });

    // Keep exact same response shape the client already expects
    return res.json({ success: true, token, role: user.role, city: user.city });

  } catch (err) {
    console.error('Login error:', err.message);
    return res.status(500).json({ success: false, message: 'Server error during login' });
  }
};

/* ── POST /api/auth/logout ─────────────────────────────────────────────── */
export const logout = (req, res) => {
  const username = req.user?.username || 'unknown';
  logEvent('logout', username, { ip: req.ip });
  res.json({ success: true });
};

/* ── GET /api/auth/profile ─────────────────────────────────────────────── */
export const profile = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, username, email, role, city, is_active, last_login
       FROM public.users
       WHERE id = $1
       LIMIT 1`,
      [req.user.id]
    );
    const user = result.rows[0];
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    return res.json({ success: true, user });
  } catch {
    // Fallback: return the decoded JWT payload if DB query fails
    return res.json({ success: true, user: req.user });
  }
};
