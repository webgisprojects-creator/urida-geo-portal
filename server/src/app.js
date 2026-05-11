import express from 'express';
import cors from 'cors';
import compression from 'compression';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import cityRoutes from './routes/cityRoutes.js';
import authRoutes from './routes/authRoutes.js';
import roadNetworkRoutes from './roadNetwork.js';
import { auditLogger } from './middleware/authMiddleware.js';
import { createProxyMiddleware } from 'http-proxy-middleware';

dotenv.config({ path: path.resolve(process.cwd(), 'server/.env') });

const app = express();
app.set('trust proxy', 1);

app.use(compression()); // Compress all responses

const defaultAllowedOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:3002',
  'http://localhost:8060',
  'http://uridageoportal.com',
  'https://uridageoportal.com',
  'http://www.uridageoportal.com',
  'https://www.uridageoportal.com'
];

const envAllowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

const allowedOrigins = [...new Set([...defaultAllowedOrigins, ...envAllowedOrigins])];
const ngrokPattern = /https?:\/\/.+\.(ngrok\.io|ngrok-free\.app)$/;

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    if (ngrokPattern.test(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST'],
  credentials: true
}));

// Proxy for Geoserver - must be before body-parser
// Target is configurable via GEOSERVER_PROXY_TARGET, for example http://localhost:8080/geoserver
app.use(
  '/geoserver',
  createProxyMiddleware({
    target: process.env.GEOSERVER_PROXY_TARGET || 'http://localhost:8080',
    changeOrigin: true,
    onProxyRes: function (proxyRes, req, res) {
      // Ensure CORS headers are present on the proxied response
      proxyRes.headers['Access-Control-Allow-Origin'] = '*';
      proxyRes.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS, PUT, PATCH, DELETE';
      proxyRes.headers['Access-Control-Allow-Headers'] = 'X-Requested-With,Content-Type,Authorization';
    },
    onError: (err, req, res) => {
      console.error('Proxy Error:', err);
      res.status(502).send('Proxy Error');
    }
  })
);

app.use(bodyParser.json());
app.use(helmet({
  contentSecurityPolicy: false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));
app.use(auditLogger);

const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

// Routes
app.use('/api', cityRoutes);
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/road-networks', roadNetworkRoutes);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientBuildPath = path.resolve(__dirname, '../../client/build');
app.use(express.static(clientBuildPath));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) {
    return next();
  }
  return res.sendFile(path.join(clientBuildPath, 'index.html'));
});

export default app;
