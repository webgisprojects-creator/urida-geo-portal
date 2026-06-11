/* Auth route definitions for login, profile, and logout. */
import express from 'express';
import rateLimit from 'express-rate-limit';
import { getCaptcha, login, profile, logout } from '../controllers/authController.js';
import { verifyToken, tryVerifyToken, getClientIp } from '../middleware/authMiddleware.js';

const router = express.Router();

const captchaLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many CAPTCHA requests. Please try again later.' },
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `${getClientIp(req)}:${String(req.body?.username || '').trim().toLowerCase() || 'anonymous'}`,
  message: { success: false, message: 'Too many login attempts. Please try again later.' },
});

router.get('/captcha', captchaLimiter, getCaptcha);
router.post('/login', loginLimiter, login);
router.get('/profile', verifyToken, profile);
router.post('/logout', tryVerifyToken, logout);

export default router;
