# URIDA Geo Portal

GIS-based urban infrastructure management portal for 17 cities in Uttar Pradesh — visualizes roads, wards, zones, and amenities for the Uttar Pradesh Urban Roads Infrastructure Development Agency (URIDA).

Production: https://www.uridageoportal.com

## Tech stack

- **Frontend** — React 19 (Create React App) + OpenLayers
- **Backend** — Node.js + Express 4 (ESM)
- **Database** — PostgreSQL + PostGIS (one schema per city)
- **Map server** — GeoServer 2.x (WMS/WFS), proxied via Express at `/geoserver`
- **Web server** — Nginx (TLS termination, reverse proxy)
- **Process manager** — PM2

For the full architecture, schema strategy, API surface, and deployment notes see [`context.md`](./context.md) and [`docs/PROJECT_ANALYSIS.md`](./docs/PROJECT_ANALYSIS.md).

## Repository layout

```
.
├── client/              React 19 SPA
├── server/              Express backend (port 8060)
├── docs/                Architecture, design, and historical notes
├── archive/             Stale files kept locally, excluded from git
├── ecosystem.config.js  PM2 process configuration
├── vercel.json          SPA fallback rewrite (frontend-only host)
├── CHANGELOG.md
├── context.md           High-level project context (start here)
└── README.md
```

## Quick start

### 1. Clone and install

```bash
git clone <repo_url> urida_prod
cd urida_prod
(cd server && npm install)
(cd client && npm install)
```

### 2. Configure environment

```bash
cp server/.env.example server/.env   # fill in DB_* and JWT_SECRET
cp client/.env.example client/.env   # point REACT_APP_GEOSERVER_BASE at your GeoServer
```

### 3. Run in development

```bash
# Backend  → http://localhost:8060
cd server && npm run dev

# Frontend → http://localhost:3000
cd client && npm start
```

> `client/package.json`'s `"proxy"` already points at `http://localhost:8060`, matching the backend's default `PORT` in `server/.env` — no change needed unless you deliberately run the backend on a different port.

### 4. Run in production (PM2)

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 logs
```

## Documentation

| File | Purpose |
|---|---|
| [`context.md`](./context.md) | Single-page project overview — start here |
| [`docs/PROJECT_ANALYSIS.md`](./docs/PROJECT_ANALYSIS.md) | Canonical architecture, infrastructure, runbooks |
| [`docs/LOCAL_DEVELOPMENT.md`](./docs/LOCAL_DEVELOPMENT.md) | Local setup and troubleshooting |
| [`docs/DEVELOPER_GUIDE.md`](./docs/DEVELOPER_GUIDE.md) | Developer workflow and contribution guide |
| [`docs/DB_NOTES.md`](./docs/DB_NOTES.md) | Database and spatial-index notes |
| [`docs/GEOSERVER_NOTES.md`](./docs/GEOSERVER_NOTES.md) | GeoServer admin / layer-publishing notes |
| [`docs/GEOSERVER_RHEL_MIGRATION.md`](./docs/GEOSERVER_RHEL_MIGRATION.md) | GeoServer migration runbook |
| [`docs/LB2_NGINX_PERFORMANCE_AUDIT.md`](./docs/LB2_NGINX_PERFORMANCE_AUDIT.md) | Load balancer / Nginx performance audit |
| [`docs/DESIGN_AUDIT.md`](./docs/DESIGN_AUDIT.md) | Frontend design audit |

## Cities supported

Agra · Aligarh · Ayodhya · Bareilly · Firozabad · Ghaziabad · Gorakhpur · Jhansi · Kanpur · Lucknow · Mathura · Meerut · Moradabad · Prayagraj · Saharanpur · Shahjahanpur · Varanasi

## License

TBD.
