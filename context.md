# URIDA Geo Portal Context

## What This Project Is

URIDA Geo Portal is a GIS web application for visualizing and managing urban road infrastructure across 17 cities in Uttar Pradesh. It uses a React/OpenLayers frontend, an Express backend, PostgreSQL/PostGIS for city data, and GeoServer for WMS/WFS map layers.

## Current Architecture

- `client/` - React single page app with OpenLayers map, dashboard, login, legends, and chainage workflows.
- `server/` - Express backend on port `8060`, API routes, auth/session handling, tile/WFS cache proxies, and GeoServer proxying.
- `server/src/config/cityConfig.js` - backend city/schema/table mapping.
- `client/src/assets/configs/cityConfig.js` - frontend city/layer mapping.
- `client/src/assets/configs/chainageCityConfig.js` - frontend chainage layer availability.
- `server/src/routes/chainage.js` - backend chainage table config and patch/project routes.
- `geoserver/styles/` - SLD/XML styles intended for GeoServer.
- `deploy/` - PM2 and Nginx deployment assets.
- `scripts/` - bounded smoke, load, migration, and cache utility scripts.

## Maintained Documentation

- `README.md` - quick start and documentation index.
- `docs/PROJECT_ANALYSIS.md` - canonical architecture, infrastructure, and runbooks.
- `docs/LOCAL_DEVELOPMENT.md` - local setup and troubleshooting.
- `docs/DEVELOPER_GUIDE.md` - developer workflow and contribution guide.
- `docs/DB_NOTES.md` - database and spatial-index notes.
- `docs/GEOSERVER_NOTES.md` - GeoServer publishing/configuration notes.
- `docs/GEOSERVER_RHEL_MIGRATION.md` - GeoServer migration runbook.
- `docs/LB2_NGINX_PERFORMANCE_AUDIT.md` - load balancer and Nginx performance notes.
- `docs/DESIGN_AUDIT.md` - frontend design audit.

## Local-Only / Generated Content

The following should not be committed:

- `node_modules/`, `client/node_modules/`, `server/node_modules/`
- `.agents/`, `.claude/`, `.codex/`, `graphify-out/`
- `.npm-cache/`
- `server/tile-cache/`, `server/boundary-cache/`, `server/wfs-cache/`, `server/mbtiles/`, `server/logs/`
- old duplicate folders such as `servernew/`, `server/server/`, and `server/servernew/`
- local security reports, spreadsheets, `.env` files, and temporary scripts

## Change Safety

- Treat `server/.env` and `client/.env` as secret local files.
- Prefer read-only validation before changing DB, GeoServer, or production deployment behavior.
- For missing WMS/WFS/database-backed features, return graceful unavailable-feature responses instead of raw errors.
- Chainage should be treated as a capability, not merely a city name. Enable it only when DB tables, GeoServer layers, required columns, and topology checks pass.
