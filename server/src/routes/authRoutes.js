/* Auth route definitions for login, profile, and logout. */
import express from 'express';
import { login, profile, logout } from '../controllers/authController.js';
import { verifyToken } from '../middleware/authMiddleware.js';

const router = express.Router();

router.post('/login', login);
router.get('/profile', verifyToken, profile);
router.post('/logout', verifyToken, logout);

export default router;
