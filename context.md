# URIDA Geo Portal — Project Context

## What this project is

The **URIDA Geo Portal** is a web-based GIS application that visualizes and manages urban infrastructure data (roads, wards, zones, amenities) for 17 cities in Uttar Pradesh, India. It is operated under the Uttar Pradesh Urban Roads Infrastructure Development Agency (URIDA), with mapping data sourced/served via Remote Sensing Applications Centre (RSAC) infrastructure.

Public production URL: `https://www.uridageoportal.com` (also exposed via tunnel at `prod-uridageo-rsac.loca.lt`).

## Repository layout

The repo lives at `D:\urida_prod\urida_prod\` and contains a frontend, backend, and a couple of legacy/duplicate server folders.

```
urida_prod/
├── client/              React 19 SPA (Create React App)
├── server/              Active Node.js + Express backend (port 8060)
├── server_new/          Newer/experimental server variant (similar tech)
├── servernew/           Legacy logs directory only
├── ecosystem.config.js  PM2 process configuration
├── vercel.json          SPA rewrite rule (for Vercel-hosted frontend)
├── package.json         Top-level — only OpenLayers + react-router deps
├── README.md            Quick start
├── PROJECT_ANALYSIS.md  Full system architecture (v1.0.0, 2026-02-24)
├── PROJECT_CONTEXT.md   Detailed project context (34 KB)
├── DEVELOPER_CONTEXT.md Developer onboarding notes
├── TASK_CONTEXT.md      Per-task notes
├── CHANGELOG.md         Keep-a-Changelog format
├── GEOSERVER_NOTES.md   GeoServer admin notes
├── Whatfixed.md         Fix log
└── test_*.{js,html,png} Ad-hoc backend / WMS test scripts and screenshots
```

Note: there are three server folders. `server/` is the production target referenced by `ecosystem.config.js`; `server_new/` and `servernew/` appear to be experimental copies and stray logs.

## Technology stack

| Layer | Tech | Notes |
|---|---|---|
| Frontend | React 19 + react-scripts 5 | OpenLayers (`ol`), `ol-geocoder`, `ol-layerswitcher`, `ol-popup` for maps |
| Charts/export | Chart.js 4, react-chartjs-2, jsPDF, jspdf-autotable, html2canvas, file-saver, xlsx | Dashboard reports |
| Animations | framer-motion | UI transitions |
| Backend | Node.js + Express 4 (ESM) | `helmet`, `cors`, `compression`, `express-rate-limit`, `body-parser` |
| Auth | JWT (`jsonwebtoken`) + `bcryptjs` | Token stored in `localStorage.authToken` on the client |
| DB | PostgreSQL 13+ with PostGIS | One schema per city (`agra`, `kanpur`, …); Lucknow uses `public` |
| DB driver | `pg` pool | Configured in `server/src/config/db.js` |
| Map server | GeoServer 2.x | Proxied at `/geoserver` → `localhost:8080` |
| Web server | Nginx (port 80/443 with SSL) | Reverse proxy, terminates TLS |
| Process mgr | PM2 | Two apps: `urida-backend`, `urida-localtunnel` |
| Tunneling | ngrok (preferred) → localhost.run → localtunnel fallback | Configured in `ecosystem.config.js` |

## Backend (`server/`)

Entry point: `server/src/server.js` boots the Express app from `server/src/app.js`.

Key directories:
- `src/config/` — `db.js` (pg pool), `cityConfig.js` (city → schema mapping)
- `src/controllers/` — `authController.js`, `cityController.js`, `roadNetworkController.js`
- `src/routes/` — `authRoutes.js`, `cityRoutes.js`
- `src/roadNetwork.js` — road network query endpoints (mounted at `/api/road-networks`)
- `src/middleware/` — `authMiddleware.js` (JWT verify + audit logger)
- `src/services/` — `authService.js`, `cityService.js`
- `src/scripts/` — utilities like `add_indexes.js`
- `src/update_lengths.js`, `inspect_db_schema.js` — one-off DB maintenance scripts

API surface (mounted under `/api`):

Auth
- `POST /api/auth/login` — credential exchange for JWT
- `GET  /api/auth/profile` — current user (JWT-gated)
- `POST /api/auth/logout`

City-level aggregates (`cityRoutes.js`)
- `GET /api/home/summary` — landing-page totals
- `GET /api/:city/zone-summary`
- `GET /api/:city/ward-summary`
- `GET /api/:city/roads/above10m/geojson` — roads with right-of-way ≥ 10 m
- `GET /api/:city/roads/click` — feature-info on map click
- `GET /api/test-db` — health check

Road network filters & details (`roadNetwork.js`, mounted at `/api/road-networks`)
- `GET /:cityCode` — roads with filters
- `GET /:cityCode/wards | categories | conditions | materials | ownership | cus | cus_class | summary`
- `GET /:cityCode/distinct/:column`
- `GET /:cityCode/road-analysis/:amenityType`
- `POST /:cityCode/amenities-count`
- `GET /:cityCode/details | search | road/:gisId | values/:attribute`

Reverse-proxy: any request to `/geoserver/*` is forwarded to `http://localhost:8080` with permissive CORS headers added on the way back.

### Database schema strategy

`All_DB` on PostgreSQL holds one schema per city. Standard table pattern per schema:
- `{city}_road_net` — road geometries + attributes (length_km/length_met, row_meter, carriage_w, ownership, condition, category, ward_no, zone_no, …)
- `{city}_ward_boundary`
- `{city}_zone_boundary`
- amenity tables: `atm_bank`, `bus_stop`, `education`, `hospital`, `hotel`, `park`, `petrol_pump`, `post_office`

Lucknow is a special case — it lives in the `public` schema and several amenity tables (`education`, `hospital`, `atm_bank`, `hotel`) are unprefixed. Zone analysis pulls from `lko_analysis.zone_development_summary_lnn`.

The road queries normalize messy real-world data heavily — safe numeric casts (`regexp_replace` to strip non-numeric chars before `::numeric`), tolerant ownership matching for "Nagar Nigam / Municipal Corp / NN" variants, and condition bucketing into good/moderate/poor/unknown.

### Cities supported (17)

agra, aligarh, ayodhya, bareilly, firozabad, ghaziabad, gorakhpur, jhansi, kanpur, lucknow, mathura, meerut, moradabad, prayagraj, saharanpur, shahjahanpur, varanasi.

### Environment variables (`server/.env`)

`PORT=8060`, `DB_HOST=162.245.218.6`, `DB_PORT=5432`, `DB_USER=postgres`, `DB_PASS`, `DB_NAME=All_DB`, `JWT_SECRET`.

## Frontend (`client/`)

Bootstrapped with Create React App, proxies dev requests to `http://localhost:8061` (note: production backend listens on 8060).

Routes (`client/src/App.js`):
- `/` — `LoginPage` (public)
- `/home` — `HomePage` (JWT-gated by `localStorage.authToken`)
- `/dashboard` — `Dashboard` (JWT-gated)

Source structure:
- `src/components/` — `MapContainer`, `MapToolbar`, `MapNavigation`, `MapLegend`, `HomeMapLegend`, `Sidebar`, `Header`, `Footer`, `ChartPanel`, `SummaryTable`, `QueryPanel`, `Chainage`, `MeasureOptions`, `DrainFilter`, `ResponsiveImage`
- `src/pages/Login/` — `LoginPage.jsx` plus a v2 variant
- `src/pages/HomePage/` — `HomePage.js` + CSS module
- `src/pages/Dashboard.jsx`
- `src/services/authService.js`
- `src/utils/gisExport.js` — export helpers (likely PDF/Excel)
- `src/assets/` — amenity icons, NN (Nagar Nigam) logos for each city, login imagery, configs (`cityConfig.js` mirrored client-side)
- `libs/`, `scripts/`, `public/`, `build/` — standard CRA layout

## Deployment

Production target directory: `/var/www/urida_prod` on the server.

PM2 (`ecosystem.config.js`) runs:
1. **urida-backend** — `node ./server/src/server.js`, `NODE_ENV=production`, `PORT=8060`, autorestart, 1 GB max memory
2. **urida-localtunnel** — picks ngrok if `NGROK_AUTHTOKEN` is set (with optional `NGROK_DOMAIN`), else SSH-tunnels via `localhost.run`, else falls back to `lt --subdomain prod-uridageo-rsac` on port 8060

Nginx (`/etc/nginx/sites-enabled/default`) terminates TLS with certs at `/etc/nginx/ssl/urida_geodirectory.crt|.key`, proxies `/` → `:8060` and `/geoserver` → `:8080` (with CORS).

`vercel.json` contains a SPA fallback rewrite — suggests the client build can also be hosted on Vercel separately from the Node backend.

## Security posture

- JWT auth with secrets in `.env`
- `helmet` (CSP disabled, strict-origin-when-cross-origin referrer)
- `express-rate-limit` (100 requests / 10 min on auth)
- CORS allowlist: localhosts, `162.245.218.6`, `uridageoportal.com`, the loca.lt subdomain, and any `*.ngrok.io` / `*.ngrok-free.app`
- HTTPS enforced via Nginx
- Audit logger middleware on all requests

## Known quirks / things to watch for

- **Three server folders** (`server`, `server_new`, `servernew`) — only `server/` is wired into PM2. The other two should probably be cleaned up or merged, but check before deleting.
- **CRA proxy port mismatch**: `client/package.json` proxies to `:8061` while production backend runs on `:8060`. Local dev may need a `.env` override or proxy fix.
- **Lucknow special-cases** litter `cityConfig.js` (schema is `public`, several tables unprefixed). Adding a city is otherwise just a `citySchemaMap` entry plus matching tables.
- **Test artifacts in repo root** — `test_*.{js,html,png}` and `nohup.out`, `output.xml`, `find_roads.js`, `debug_geometry.js` are scratch files that survived into the repo.
- **Long-lived docs** — `PROJECT_ANALYSIS.md`, `PROJECT_CONTEXT.md`, `DEVELOPER_CONTEXT.md`, `TASK_CONTEXT.md`, `Whatfixed.md`, `GEOSERVER_NOTES.md` overlap heavily; treat `PROJECT_ANALYSIS.md` as the canonical architecture doc.
- **Database column inconsistency** — `length_km`/`length_met`, `row_meter`/`carriage_w` may be stored as varchar in some city imports (e.g., Shahjahanpur). The road-stats SQL handles this with safe regex casts; preserve that pattern when adding new aggregates.
- **Single backend instance** — PM2 is set to `instances: 1`; switch to `'max'` for multi-core if load grows.

## Quick start

Production (on the server):
```bash
cd /var/www/urida_prod
pm2 start ecosystem.config.js
pm2 save
pm2 logs
```

Local development:
```bash
# Backend
cd server && npm install && npm run dev      # nodemon → :8060

# Frontend
cd client && npm install && npm start         # CRA dev server → :3000
```
