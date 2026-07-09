import express from 'express';
import cors from 'cors';
import compression from 'compression';
import dotenv from 'dotenv';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import cityRoutes from './routes/cityRoutes.js';
import authRoutes from './routes/authRoutes.js';
// import chainageRoutes from './routes/chainage.js';
import adminRoutes from './routes/adminRoutes.js';
import roadNetworkRoutes from './roadNetwork.js';
import { auditLogger, tryVerifyToken, verifyToken, verifyRole, startActiveTokensRetentionSchedule } from './middleware/authMiddleware.js';
import { pool } from './config/db.js';
import { createProxyMiddleware } from 'http-proxy-middleware';
import chainageRoutes from "./routes/chainage.js";//chainage
import kmcRoutes from "./routes/kmc.js";
import tileRoutes, { startTileCacheEvictionSchedule } from "./routes/tiles.js";
import telemetryRoutes from "./routes/telemetry.js";
import wfsCacheRoutes, { startWfsCacheEvictionSchedule } from "./routes/wfsCache.js";
import { startCacheWarmer } from "./services/cacheWarmer.js";
import { startMetricsSampler, getCurrentMetrics } from "./services/metricsSampler.js";

// Use __dirname-relative path so this works regardless of which directory
// the process is started from (project root, server/, or anywhere else).
const __filename_app = fileURLToPath(import.meta.url);
const __dirname_app  = path.dirname(__filename_app);
dotenv.config({ path: path.resolve(__dirname_app, '../../server/.env') });

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(compression()); // Compress all responses

// Origins always allowed in production (and dev)
const productionAllowedOrigins = [
  'https://27.100.38.133',
  'http://27.100.38.133',
  'http://uridageoportal.com',
  'https://uridageoportal.com',
  'http://www.uridageoportal.com',
  'https://www.uridageoportal.com'
];

// Extra origins from .env (comma-separated), merged in for any environment
const envAllowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

const allowedOrigins = [...new Set([...productionAllowedOrigins, ...envAllowedOrigins])];

// Patterns always allowed regardless of environment
const localhostPattern = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const ngrokPattern    = /^https?:\/\/.+\.(ngrok\.io|ngrok-free\.app)$/;

const isDev = (process.env.NODE_ENV || 'development') !== 'production';
const cspConnectSources = [
  "'self'",
  'https://27.100.38.133',
  'https://nominatim.openstreetmap.org',
  'https://photon.komoot.io',
  'https://overpass-api.de',
  'https://maps.googleapis.com',
  'https://geocode.arcgis.com',
  'https://services.arcgisonline.com'
];
if (isDev) {
  cspConnectSources.push(
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:8060',
    'http://127.0.0.1:8060',
    'http://localhost:8080',
    'http://127.0.0.1:8080'
  );
}

app.use(cors({
  origin: (origin, callback) => {
    // Non-browser requests (curl, server-to-server) have no Origin — allow them
    if (!origin) return callback(null, true);

    // Normalize: some browsers / proxies append a trailing slash to the origin
    const o = origin.replace(/\/$/, '');

    // In development: automatically allow any localhost / 127.0.0.1 origin
    // on any port so developers never need to touch .env for CORS.
    if (isDev && localhostPattern.test(o)) return callback(null, true);

    // Production allowlist (hardcoded domains + CORS_ORIGINS from .env)
    if (allowedOrigins.includes(o)) return callback(null, true);

    // Ngrok tunnels (used for staging / demos)
    if (ngrokPattern.test(o)) return callback(null, true);

    console.warn(`[CORS] Blocked origin: ${origin}`);
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
      const origin = String(req.headers.origin || '').replace(/\/$/, '');
      if (origin && (allowedOrigins.includes(origin) || (isDev && localhostPattern.test(origin)) || ngrokPattern.test(origin))) {
        proxyRes.headers['Access-Control-Allow-Origin'] = origin;
        proxyRes.headers['Vary'] = 'Origin';
      }
      proxyRes.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
      proxyRes.headers['Access-Control-Allow-Headers'] = 'X-Requested-With,Content-Type,Authorization';
    },
    onError: (err, req, res) => {
      console.error('Proxy Error:', err);
      res.status(502).send('Bad gateway');
    }
  })
);

app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '15mb' }));
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: cspConnectSources,
      fontSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'self'"],
      upgradeInsecureRequests: isDev ? null : [],
    },
  },
  frameguard: { action: 'sameorigin' },
  noSniff: true,
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
  },
  referrerPolicy: { policy: 'no-referrer-when-downgrade' }
}));
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=(), usb=(), fullscreen=(self)');
  if (req.path.startsWith('/static/')) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return next();
  }
  if (req.path.startsWith('/api/tiles/')) {
    return next();
  }
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  next();
});
app.use(auditLogger);

// Routes
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/road-networks', roadNetworkRoutes);
app.use(chainageRoutes);//chainage
app.use(kmcRoutes);
app.use(tileRoutes);
app.use(wfsCacheRoutes);
app.use(telemetryRoutes);
app.use('/api', cityRoutes);

// Live "what's happening right now" snapshot (event-loop lag, memory,
// concurrency-limiter queue depth) — admin-only, since this is operational
// internals, not app data. Meant for watching during a load test rather
// than only reading after the fact from logs/metrics.log.
app.get('/api/internal/metrics', verifyToken, verifyRole('admin'), (req, res) => {
  res.json(getCurrentMetrics());
});

// Under PM2 cluster mode (deploy/ecosystem.config.js), this module loads
// once per worker process — running the cache warmer or the eviction
// sweep in every worker would multiply the same disk-scan/GeoServer-warm
// work by the worker count for zero benefit (they'd all warm/evict the
// same shared disk cache). NODE_APP_INSTANCE is unset in plain `node
// src/server.js` (local dev, no PM2) and "0" in the first cluster worker
// — both cases should run these singleton tasks; workers 1+ skip them.
// Per-worker observability (metrics sampler) is NOT gated here — event
// loop lag/memory are genuinely per-process and each worker should report
// its own.
const isSingletonWorker = !process.env.NODE_APP_INSTANCE || process.env.NODE_APP_INSTANCE === '0';
if (isSingletonWorker) {
  startTileCacheEvictionSchedule();
  startWfsCacheEvictionSchedule();
  startActiveTokensRetentionSchedule();
  startCacheWarmer();
}
startMetricsSampler();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientBuildPath = path.resolve(__dirname, '../../client/build');
const clientIndexPath = path.join(clientBuildPath, 'index.html');
const hasClientBuild = fs.existsSync(clientIndexPath);

app.get('/robots.txt', (req, res) => {
  res.status(404).type('text/plain').send('Not found');
});

if (hasClientBuild) {
  app.use(express.static(clientBuildPath));
  ['/home', '/dashboard', '/dss', '/admin'].forEach((routePath) => {
    app.get(routePath, tryVerifyToken, (req, res) => {
      if (!req.user) return res.redirect('/');
      return res.sendFile(clientIndexPath);
    });
  });
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) {
      return next();
    }
    return res.sendFile(clientIndexPath);
  });
} else {
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) {
      return next();
    }
    return res.status(404).send('Not found');
  });
}

export default app;
