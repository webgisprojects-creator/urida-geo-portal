# URIDA Codebase Context & Technical Documentation

This document provides a **complete, self-explanatory overview** of the URIDA (Urban Road Infrastructure Development Agency) codebase. Any AI—Claude, GPT, or Gemini—should read this file first to understand the architecture, database schema, APIs, UI layout, and deployment setup before modifying the codebase.

---

## 1. Project Overview & Rules
**URIDA** is a sophisticated WebGIS application for the state of Uttar Pradesh (UP), India. It serves as a unified dashboard to monitor and map road infrastructure across 17 major Municipal Corporations (Nagar Nigams).

**CRITICAL DEPLOYMENT RULES (NEVER BREAK):**
- **Process Manager:** `pm2` manages all Node processes. **NEVER** run `pm2 restart`, `pm2 stop`, `pm2 reload`, or `pm2 delete`.
- **Package Managers:** **NEVER** run `npm install`, `yarn`, or `pip install`. The environment is frozen.
- **Backend Port:** 8060. The backend also statically serves the React client.
- **GeoServer:** GeoServer runs on `8080` (e.g., Tomcat) and the Node.js backend proxies it from `/geoserver/*` to `http://103.15.81.74:8080/geoserver/...`.

---

## 2. Infrastructure & Tech Stack
### **Frontend Layer (Client)**
- **Framework:** React.js (v18+) with React Router DOM v6.
- **Map Engine:** OpenLayers (`ol`). Highly complex mapping logic contained mostly within `client/src/components/MapContainer.jsx` (~5100 lines) and `HomePage.js`.
- **Exports:** GIS Export systems built with `jspdf`, `jspdf-autotable`, `xlsx`, and `html2canvas` (`client/src/utils/gisExport.js`).
- **Styling:** CSS Modules (`HomePage.Module.css`, `Dashboard.css`).

### **Backend Layer (Server)**
- **Framework:** Express.js running on Node.js locally via port 8060.
- **Database Driver:** `pg` (PostgreSQL client) with `pg-format`.
- **Middleware:** `cors`, `helmet`, `express-rate-limit`, `http-proxy-middleware`.
- **Auth:** JWT-based (`jsonwebtoken`). Simple hardcoded role checks relying on `.env` secrets (`server/src/middleware/authMiddleware.js`).

### **Database Layer**
- **Database:** PostgreSQL with PostGIS extensions.
- **GIS Server:** GeoServer serving highly dense mapping layers (WMS and WFS).

---

## 3. Database Architecture & Schema Mapping
The Database is cleanly isolated per city using **schemas**.
- **Config Map (`server/src/config/cityConfig.js`):** Every city has an explicit schema mapping. For example: `agra -> agra`, `lucknow -> public` (anomalous legacy schema), `varanasi -> varanasi`.
- **UTM SRIDs (`getCityUtmEpsg`):** Accurate spatial queries (`ST_Transform()`, `ST_Length()`) rely on UTM EPSG codes mapped per city (e.g., Ghaziabad uses `32643`, Agra uses `32644`).
- **Core Standardized Tables (per city schema):**
  - **Roads:** `${schema}.${city}_road_net`
  - **Zones:** `${schema}.${city}_zone_boundary`
  - **Wards:** `${schema}.${city}_ward_boundary`
  - **Amenities (variable):** `${schema}.${city}_${amenityType}` (e.g., `agra_hospital`, `agra_atm_bank`).

### **Standard Road Table Schema (`*_road_net`)**
When modifying road attribute queries, refer to these canonical column names:
- `gis_id` / `road_id` (Primary keys / Identifiers)
- `zone_no`, `zone_name`, `ward_no`, `ward_name` (Administrative)
- `ownership`, `condition`, `category`, `material`, `cus_class` (Classifications)
- `yoc` (Year of Construction)
- `row_meter` (Right of Way), `carriage_w` (Carriage Width), `length_km` (Calculated Length)
- `road_name` 
- `geom` (PostGIS Geometry, heavily queried natively and emitted via `ST_AsGeoJSON` for frontend rendering).

---

## 4. Backend APIs & Logic (`/server`)
- **`app.js`**: Connects middleware, proxy, and rate limits. Crucially, handles the `/geoserver` proxy to Tomcat `8080`.
- **`authRoutes.js` / `authController.js`**: JWT authentication. `verifyToken` protects most endpoints. Audit logs to `server/logs/audit.log`.
- **`cityRoutes.js` / `cityController.js`**: Summarizes zones and wards (`/api/city/:city/zone-summary`).
- **`roadNetwork.js` (The heaviest controller):**
  - Serves endpoints like `/:cityCode/summary`, `/:cityCode/details`, and `/:cityCode/search`.
  - Implements lazy schema detection natively. If geometries are unknown, it runs an intelligent `detectSridFromSample` function.
  - Queries employ `buildSafeFilter()` utility to prevent SQL injection when the dashboard dynamically builds UI filters like `material IN ('CC', 'BT')`.

---

## 5. Frontend Architecture (`/client`)
- **`App.js`**: Mounts UI, React Router (`<BrowserRouter>`), handles `<Protected>` routes.
- **`HomePage.js`**: The landing state map. Displays a UP-wide overview map, loading city boundaries as WMS layers. Shows top-level metrics. Clicking a boundary takes the user to the Dashboard.
- **`Dashboard.jsx`**: The command center. Holds the Sidebar, MapToolbar, Header, and SummaryTable. Highly reactive state tied to URL params (`?city=Lucknow`).
  - Contains rigorous state restoration logic to seamlessly switch between Map interactions (Multi-selection on map) and Tabular Data (`SummaryTable.jsx`).
- **`MapContainer.jsx` (Gargantuan Complexity):** Over 5000 lines handling OpenLayers logic. 
  - Creates the BaseMaps (OSM, CartoDB Positron, Satellite, Toner).
  - Handles WMS/WFS layers directly connected to proxy `/geoserver/wms`.
  - Optimizes UI by setting WMS sources specifically to `FORMAT_OPTIONS: 'antiAlias:false'` and `imageSmoothing:false` on Canvas layers to prevent browser crashing on dense geometries.
  - Integration with **Overpass API** (OpenStreetMap live POIs) which it parses, memoizes, and deduplicates against PostGIS Amenity datasets.
- **GIS Export Utils (`gisExport.js`)**: Converts Map Canvases and data rows into PDF, Excel, and KML format. Uses `html2canvas` for precise legend capturing.
- **Navigation Controls (`MapNavigation.jsx`)**: Renders custom zoom, compass rotation, Scale line, and 'Locate Me' controls over the map panel.

---

## 6. Coding Conventions & Troubleshooting Notes
1. **Case Sensitivity in GIS:** GeoServer WMS calls (e.g., `Ward_Boundary_New:Lucknow_Zone_Boundary`) are strictly case sensitive. Use configurations from `client/src/assets/configs/cityConfig.js` precisely.
2. **Icons and Overlays Caching:** The frontend heavily manipulates map icon SVGs. Methods caching them dynamically (`PIN_SVG_CACHE`, `AMENITY_BADGE_SVG_CACHE`) are imperative. Generating raw SVGs on the fly per feature causes massive memory leaks and stutters.
3. **Map Events:** Map interactions use OpenLayers `Overlay` for popups and `Draw` interactions for spatial polygons. Interferences between click/hover/drag events are common; ensure you call `stopPropagation()` implicitly inside OpenLayers hooks if you build custom UI above the canvas.
4. **Backend PM2 Safety**: Because we cannot restart PM2, any backend memory corruption will stay active. Catch all unhandled promise rejections properly.

---

## 7. Complete API Route Map
| Method | Full Endpoint | Controller Function | Auth Required | What it does |
|--------|--------------|-------------------|--------------|--------------|
| POST | `/api/auth/login` | `authController.login` | No | Returns JWT token |
| GET | `/api/auth/profile` | `authController.profile` | Yes | Get user profile |
| POST | `/api/auth/logout` | `authController.logout` | Yes | Destroy local session |
| GET | `/api/city/:city/zone-summary` | `cityController.getZoneSummary` | Yes | Returns zone stats |
| GET | `/api/city/:city/ward-summary` | `cityController.getWardSummary` | Yes | Returns ward stats |
| GET | `/api/road-networks/:cityCode/summary` | `roadNetwork.getSummary` | Yes | Aggregate road stats for a city |
| GET | `/api/road-networks/:cityCode/details` | `roadNetwork.getDetails` | Yes | Paginated lists of roads |
| GET | `/api/road-networks/:cityCode/search` | `roadNetwork.searchRoads` | Yes | Search road names by string |
| GET | `/api/road-networks/:cityCode/values/:attribute` | Dynamic filter value check | Yes | Get unique filter items |
| POST | `/api/road-networks/:cityCode/amenities-count` | `roadNetwork...` | Yes | Aggregate POI counts |
| GET | `/geoserver/*` | `app.js` (Proxy) | No | Pass-through to local GeoServer |

---

## 8. Complete City Config Table
Extracted from `server/src/config/cityConfig.js` and `client/src/assets/configs/cityConfig.js`:

| City Name | Schema Name | UTM EPSG | Road Table | GeoServer Layer Prefix |
|-----------|------------|---------|-----------|----------------------|
| lucknow | `public` | 32644 | `public.lucknow_road_net` | `Ward_Boundary_New:Lucknow_...` |
| agra | `agra` | 32644 | `agra.agra_road_net` | `Ward_Boundary_New:Agra_...` |
| aligarh | `aligarh` | 32644 | `aligarh.aligarh_road_net` | `Ward_Boundary_New:Aligarh_...` |
| ayodhya | `ayodhya` | 32644 | `ayodhya.ayodhya_road_net` | `Ward_Boundary_New:Ayodhya_...` |
| bareilly | `bareilly` | 32644 | `bareilly.bareilly_road_net` | `Ward_Boundary_New:Bareilly_...` |
| firozabad | `firozabad` | 32644 | `firozabad.firozabad_road_net`| `Ward_Boundary_New:Firozabad_...` |
| ghaziabad | `ghaziabad` | 32643 | `ghaziabad.ghaziabad_road_net`| `Ward_Boundary_New:Ghaziabad_...` |
| gorakhpur | `gorakhpur` | 32644 | `gorakhpur.gorakhpur_road_net`| `Ward_Boundary_New:Gorakhpur_...` |
| jhansi | `jhansi` | 32644 | `jhansi.jhansi_road_net` | `Ward_Boundary_New:Jhansi_...` |
| kanpur | `kanpur` | 32644 | `kanpur.kanpur_road_net` | `Ward_Boundary_New:Kanpur_...` |
| mathura | `mathura` | 32643 | `mathura.mathura_road_net` | `Ward_Boundary_New:Mathura_...` |
| meerut | `meerut` | 32643 | `meerut.meerut_road_net` | `Ward_Boundary_New:Meerut_...` |
| moradabad | `moradabad` | 32644 | `moradabad.moradabad_road_net`| `Ward_Boundary_New:Moradabad_...` |
| prayagraj | `prayagraj` | 32644 | `prayagraj.prayagraj_road_net`| `Ward_Boundary_New:Prayagraj_...` |
| saharanpur | `saharanpur`| 32643 | `saharanpur.saharanpur_road_net`| `Ward_Boundary_New:Saharanpur_...` |
| shahjahanpur| `shahjahanpur`| 32644 | `shahjahanpur.shahjahanpur_road_net`| `Ward_Boundary_New:Shahjahanpur_...` |
| varanasi | `varanasi` | 32644 | `varanasi.varanasi_road_net` | `Ward_Boundary_New:Varanasi_...` |

---

## 9. Environment Variables
Stored in `server/.env`:
| Variable | Purpose | Example / Value |
|----------|---------|---------|
| PORT | Backend Node port | 8060 |
| DB_HOST | PostgreSQL host | 162.245.218.6 |
| DB_PORT | PostgreSQL port | 5432 |
| DB_NAME | Database name | All_DB |
| DB_USER | DB username | postgres |
| DB_PASS | DB password | **** |
| JWT_SECRET | Token signing key | **** |

---

## 10. Key Frontend State Map
The Dashboard uses complex prop-drilling into the `MapContainer.jsx` component.

| State Variable | Component | Type | Purpose | What breaks if changed wrong |
|---------------|-----------|------|---------|------------------------------|
| `selectedCity` | Dashboard | string | Currently active city context | Map boundaries & API paths fail. |
| `roadFilter` | Dashboard | string | Active global CQL SQL filter text | Table queries and WMS layer highlights stop matching. |
| `zoomFilter` | Dashboard | string | Filter triggers Map auto-zoom | Pan-to-selection functionality fails. |
| `mapReady` | MapContainer | bool | True when OL canvas is mounted | Map interactions crash trying to access null map. |
| `amenityLegendCounts` | MapContainer | object | Stores counted POIs | Sidebar legend statistics fail. |
| `AMENITY_STYLE_CACHE` | MapContainer | Map() | Cached OpenLayers styles/SVGs | Causes massive browser lag and RAM bloat via infinite SVG recreation. |

---

## 11. MapContainer Function Index
Key logic wrapped in `client/src/components/MapContainer.jsx`:

| Function | Purpose |
|----------|---------|
| `makeWmsSource(url, layerName...)` | Performance-optimised TileWMS factory passing `antiAlias:false` and cache flags. |
| `getOsmBbox()` | Bounding box calculator to convert OpenLayers extent to Overpass API lat/lon format. |
| `buildOverpassQuery()` | Dynamically generates custom string nodes for live OpenStreetMap amenity pulling. |
| `getAmenityColor(id)` | Resolves UI hex colors dynamically for pins inside `PIN_SVG_CACHE`. |
| `updateWMSFilters()` | Intercepts `roadFilter` prop and applies `cql_filter` across all active GeoServer layers. |
| `handleRoadIdentifyClick()` | Shoots a raycast using `GetFeatureInfo` against GeoServer to retrieve geometry data to show popups. |

---

## 12. Complete Folder Structure
```text
client/
├── libs/             # OpenLayers layerswitcher and popup extensions
├── public/           # Static assets, index.html, manifest.json
└── src/
    ├── assets/       # Amenities_Icons, Login images, NN_Logo, configs/cityConfig.js
    ├── components/   # UI: Header, Sidebar, SummaryTable, MapContainer, MapLegend, etc.
    ├── pages/        # Route wrappers: HomePage.js, Dashboard.jsx, Login templates
    └── utils/        # Utility helpers: gisExport.js (PDF/Excel maps)
server/
├── logs/             # generated audit.log
└── src/
    ├── config/       # cityConfig.js, db.js (pg pool logic)
    ├── controllers/  # Route logic: authController.js, cityController.js
    ├── middleware/   # check JWT logic & rate limiter integrations
    ├── routes/       # authRoutes.js, cityRoutes.js
    ├── scripts/      # Stand-alone util endpoints or schema loaders
    └── server.js / app.js # Core express entrypoints
```

---

## 13. Current Bugs & Known Issues
From live `pm2 logs --lines 100`:
- **FATAL 53300: sorry, too many clients already**. The PostgreSQL connection pool is maxing out because `Promise.all` inside `roadNetwork.js` fires 11 concurrent DB queries for *every* city iteration on map load. Needs backend throttling or higher `max_connections` config.
- **WARN: express-rate-limit**. "The 'X-Forwarded-For' header is set but the Express 'trust proxy' setting is false". Since node is behind Nginx/Localtunnel, rate-limit bans the entire server IP globally. `app.set('trust proxy', 1)` is required in `app.js`.

---

## 14. Exact Package Versions
Key production dependencies:
- **Client**: `react@19.2.0`, `react-router-dom@6.30.3`, `ol@10.6.1` (OpenLayers), `jspdf@4.1.0`
- **Server**: `express@4.21.2`, `pg@8.16.3`, `express-rate-limit@8.2.1`, `http-proxy-middleware@3.0.5`
- **Node**: `v20.20.0`, `pm2@5.4.3`

---

---

## FILE AUDIT — EVERY FILE WITH STATUS

As a Staff Engineer, I have read every file and checked all imports.
Status: ACTIVE | DEAD | ORPHANED | DUPLICATE | UNCLEAR

| File Path | What it does | Imported by | Status | Verdict |
|-----------|-------------|-------------|--------|---------|
| `client/src/components/MapContainer.jsx` | Core GIS OpenLayers logic | `Dashboard.jsx`, `HomePage.js` | ACTIVE | Keep |
| `client/src/pages/HomePage/HomePage.js` | Main landing page | `App.js` | ACTIVE | Keep |
| `client/src/pages/Dashboard.jsx` | Main application hub | `App.js` | ACTIVE | Keep |
| `client/src/components/MapToolbar.jsx` | UI tools for map | `Dashboard.jsx` | ACTIVE | Keep |
| `server/src/roadNetwork.js` | Core GIS queries & logic | `app.js` | ACTIVE | Keep |
| `client/src/components/SummaryTable.jsx` | Data grid for road info | `Dashboard.jsx` | ACTIVE | Keep |
| `client/src/components/MapLegend.jsx` | Shows active layer styles | `MapToolbar.jsx` | ACTIVE | Keep |
| `client/src/components/ChartPanel.jsx` | Renders analytics charts | `Dashboard.jsx` | ACTIVE | Keep |
| `server/src/routes/cityRoutes.js` | City summary endpoints | `app.js` | ACTIVE | Keep |
| `client/src/assets/configs/cityConfig.js` | Client-side city metadata | Used globally | ACTIVE | Keep |
| `client/src/utils/gisExport.js` | PDF/Excel map exporters | `Header.jsx`, `Dashboard.jsx` | ACTIVE | Keep |
| `client/src/components/MapNavigation.jsx` | Compass/Scale/Locate UI | `Dashboard.jsx` | ACTIVE | Keep |
| `client/src/components/QueryPanel.jsx` | CQL query builder UI | `Dashboard.jsx` | ACTIVE | Keep |
| `client/src/components/HomeMapLegend.jsx`| Legend for HomePage map | `HomePage.js` | ACTIVE | Keep |
| `client/src/pages/Login/LoginPage_v2.jsx`| Active login layout | `App.js` | ACTIVE | Keep |
| `client/src/components/Sidebar.jsx` | Left panel controls | `Dashboard.jsx` | ACTIVE | Keep |
| `client/src/pages/Login/LoginPage.jsx` | Legacy/Alternate login | `App.js` | ACTIVE | Keep |
| `client/src/components/Header.jsx` | Top navigation bar | `Dashboard.jsx` | ACTIVE | Keep |
| `server/src/app.js` | Express app & middleware | `server.js` | ACTIVE | Keep |
| `client/src/components/Chainage.jsx` | Chainage logic component | `Dashboard.jsx` | ACTIVE | Keep |
| `server/src/controllers/authController.js`| JWT generation/logic | `authRoutes.js` | ACTIVE | Keep |
| `server/src/middleware/authMiddleware.js` | Request JWT verifier | Route files | ACTIVE | Keep |
| `server/src/controllers/cityController.js`| DB getters for cities | `cityRoutes.js` | ACTIVE | Keep |
| `server/src/config/db.js` | pg pool initialization | Controllers | ACTIVE | Keep |
| `server/src/config/cityConfig.js` | Backend schema mappings | Controllers | ACTIVE | Keep |
| `client/src/App.js` | React Router entry | `index.js` | ACTIVE | Keep |
| `server/src/server.js` | PM2 execution entry | PM2 via package.json| ACTIVE | Keep |
| `find_roads.js` | Checks missing roads | (none) | ORPHANED| Archive |
| `server/inspect_db_schema.js` | Schema dumping util | (none) | ORPHANED| Archive |
| `server/src/scripts/add_indexes.js` | DB index creation script | (none) | ORPHANED| Archive |
| `test_fix.js` | Connection test script | (none) | ORPHANED| Archive |
| `test_real_api.js` | Integration test script | (none) | ORPHANED| Archive |
| `test_backend.js` | Express test script | (none) | ORPHANED| Archive |
| `debug_geometry.js` | Geometry testing util | (none) | ORPHANED| Archive |
| `client/src/components/MeasureOptions.jsx`| Unused measure tools UI | (none) | DEAD | Delete |
| `client/src/components/DrainFilter.jsx` | Unused drain filter UI | (none) | DEAD | Delete |
| `server/src/controllers/roadNetworkController.js` | Legacy controller code | (none) | DEAD | Delete |
| `server/src/services/authService.js` | Empty service file | (none) | DEAD | Delete |
| `client/src/services/authService.js` | Empty API caller file | (none) | DEAD | Delete |
| `client/src/App.test.js` | Boilerplate test | (none) | DEAD | Delete |
| `client/src/setupTests.js` | Boilerplate setup | (none) | DEAD | Delete |

---

## DEEP FUNCTION DOCUMENTATION

### roadNetwork.js — Every Function Explained

#### `buildSafeFilter(filters)`
- **Purpose:** Prevents SQL injection by validating query parameters against an allowed list. 
- **Input:** Object of frontend filters (e.g. `{ material: "CC", condition: "Good" }`) mapped to a raw string format.
- **Logic step by step:** Validates property names via regex matching allowed lists. Replaces CQL logic `IN` or `=` with PostgreSQL positional `$1`, `$2` arguments for `pg-format`.
- **Output:** `{ text: 'material = $1 AND condition = $2', values: ['CC', 'Good'] }`
- **Security role:** Primary defense against malicious CQL filters dynamically passed by the map interacting directly with the backend.
- **Called by:** Details endpoint, Summary endpoint, and Attribute search endpoints.

#### `getGeometryColumn(schema, table)`
- **Purpose:** Identifies if the table uses standard `geom`, `wkb_geometry`, or custom PostGIS naming.
- **Input:** Database table namespace and target table.
- **Logic step by step:** Queries PostgreSQL `information_schema.columns` to find the geometry typing explicitly.
- **Output:** String `geom` (or whatever the active column is).
- **When is it triggered:** Pre-processing spatial joins.

#### `detectSridFromSample(schema, table, geomCol, utmSrid)`
- **Purpose:** Ensures accurate spatial measurement metrics by deducing exactly what SRID the target table is formatted in.
- **Input:** Schema string, Table string, target Geometry Column, and a fallback projected UTM SRID.
- **Logic step by step:** Shoots a fast `SELECT ST_SRID({geomCol}) FROM LIMIT 1`. If no rows exist, it falls back to the UTM SRID mapped to the city.
- **Output:** Integer (e.g., `4326`, `32644`).
- **When is it triggered:** Lazily invoked on first load of any spatial API requesting distance metrics.

### SummaryTable.jsx — Every Function & Prop Explained

#### Props received:
| Prop | Type | Purpose | Where it comes from |
|------|------|---------|-------------------|
| `city` | string | Defines the active table context | `Dashboard.jsx` parameter |
| `onClose` | function | Closes the table view | `Dashboard.jsx` state mutator |
| `onApplyFilter` | function | Bubbles grid filters back to Map | `Dashboard.jsx` handler |
| `onClassificationChange` | function | Changes map styling rules based on sorting | `Dashboard.jsx` handler |

#### Key functions:
- `getScopeFilterParts()`: Compiles localized "zone" or "ward" Dropdown UI selections into CQL string snippets to inject into OpenLayers WMS.
- `fetchTableData(page, sort, filters)`: Paginates queries against the backend `/api/road-networks/:city/details` via Fetch API.
- `handleClearAll()`: Resets column filters and MapCQL filters simultaneously.
- `handleRowClick(record)`: Fires a callback to auto-pan the OpenLayers map view to the selected `road_id` bounds.
- `handleApplyTableFilter()`: Packages internal Table textual searches into `cql_filter` compatible URI components to style the map canvas above it.

### authMiddleware.js — Complete Logic

#### `verifyToken(req, res, next)`
- **How JWT is extracted:** Reads `req.headers.authorization`, separating `Bearer ` from the actual token array index `[1]`.
- **Validation steps:** Passes secret to `jwt.verify()`. Checks signature algorithm and expiration timestamp.
- **What req object gets added:** `req.user = decoded` payload containing username and access tier.
- **Failure responses:** Returns native Express HTTP `403 No token provided` early break, or `401 Unauthorized` if invalid signature.

#### `verifyRole(...roles)`
- **Purpose:** Higher order function wrapping Express logic determining if `req.user.role` resides within the allowed array. Protects master endpoints.

#### `auditLogger(req, res, next)`
- **Purpose:** Write-only stream logging request timestamp, intent (Method/Path), resolved user identity, and HTTP IP bindings to `server/logs/audit.log`.

---

## FULL CITY CONFIG — EXACT VALUES

### server/src/config/cityConfig.js — Complete Object
```javascript
export const citySchemaMap = {
  agra: "agra",
  aligarh: "aligarh",
  ayodhya: "ayodhya",
  bareilly: "bareilly",
  firozabad: "firozabad",
  ghaziabad: "ghaziabad",
  gorakhpur: "gorakhpur",
  jhansi: "jhansi",
  kanpur: "kanpur",
  lucknow: "public",
  mathura: "mathura",
  meerut: "meerut",
  moradabad: "moradabad",
  prayagraj: "prayagraj",
  saharanpur: "saharanpur",
  shahjahanpur: "shahjahanpur",
  varanasi: "varanasi",
};
```

### client/src/assets/configs/cityConfig.js — Complete Object  
```javascript
export const cityConfig = {
  agra: { name: "Agra", center: fromLonLat([78.0081, 27.1767]), zoom: 11, zoneLayer: "Ward_Boundary_New:Agra_Zone_Boundary", wardLayer: "Ward_Boundary_New:Agra_Ward_Boundary", roadLayer: "Road_Network:Agra_Road_Network" },
  aligarh: { name: "Aligarh", center: fromLonLat([78.088, 27.8974]), zoom: 11, zoneLayer: "Ward_Boundary_New:Aligarh_Zone_Boundary", wardLayer: "Ward_Boundary_New:Aligarh_Ward_Boundary", roadLayer: "Road_Network:Aligarh_Road_Network" },
  ayodhya: { name: "Ayodhya", center: fromLonLat([82.1944, 26.7999]), zoom: 11, zoneLayer: "Ward_Boundary_New:Ayodhya_Zone_Boundary", wardLayer: "Ward_Boundary_New:Ayodhya_Ward_Boundary", roadLayer: "Road_Network:Ayodhya_Road_Network" },
  bareilly: { name: "Bareilly", center: fromLonLat([79.4304, 28.367]), zoom: 11, zoneLayer: "Ward_Boundary_New:Bareilly_Zone_Boundary", wardLayer: "Ward_Boundary_New:Bareilly_Ward_Boundary", roadLayer: "Road_Network:Bareilly_Road_Network" },
  firozabad: { name: "Firozabad", center: fromLonLat([78.3949, 27.1591]), zoom: 11, wardLayer: "Ward_Boundary_New:Firozabad_Ward_Boundary", roadLayer: "Road_Network:Firozabad_Road_Network" },
  ghaziabad: { name: "Ghaziabad", center: fromLonLat([77.4538, 28.6692]), zoom: 11, zoneLayer: "Ward_Boundary_New:Ghaziabad_Zone_Boundary", wardLayer: "Ward_Boundary_New:Ghaziabad_Ward_Boundary", roadLayer: "Road_Network:Ghaziabad_Road_Network" },
  gorakhpur: { name: "Gorakhpur", center: fromLonLat([83.3732, 26.7606]), zoom: 11, zoneLayer: "Ward_Boundary_New:Gorakhpur_Zone_Boundary", wardLayer: "Ward_Boundary_New:Gorakhpur_Ward_Boundary", roadLayer: "Road_Network:Gorakhpur_Road_Network" },
  jhansi: { name: "Jhansi", center: fromLonLat([78.5685, 25.4484]), zoom: 11, wardLayer: "Ward_Boundary_New:Jhansi_Ward_Boundary", roadLayer: "Road_Network:Jhansi_Road_Network" },
  kanpur: { name: "Kanpur", center: fromLonLat([80.3319, 26.4499]), zoom: 11, zoneLayer: "Ward_Boundary_New:Kanpur_Zone_Boundary", wardLayer: "Ward_Boundary_New:Kanpur_Ward_Boundary", roadLayer: "Road_Network:Kanpur_Road_Network" },
  lucknow: { name: "Lucknow", center: fromLonLat([80.9462, 26.8467]), zoom: 11, zoneLayer: "Ward_Boundary_New:Lucknow_Zone_Boundary", wardLayer: "Ward_Boundary_New:Lucknow_Ward_Boundary", roadLayer: "Road_Network:Lucknow_Road_Network" },
  mathura: { name: "Mathura", center: fromLonLat([77.6737, 27.4924]), zoom: 11, zoneLayer: "Ward_Boundary_New:Mathura_Zone_Boundary", wardLayer: "Ward_Boundary_New:Mathura_Ward_Boundary", roadLayer: "Road_Network:Mathura_Road_Network" },
  meerut: { name: "Meerut", center: fromLonLat([77.7064, 28.9845]), zoom: 11, zoneLayer: "Ward_Boundary_New:Meerut_Zone_Boundary", wardLayer: "Ward_Boundary_New:Meerut_Ward_Boundary", roadLayer: "Road_Network:Meerut_Road_Network" },
  moradabad: { name: "Moradabad", center: fromLonLat([78.7768, 28.8386]), zoom: 11, zoneLayer: "Ward_Boundary_New:Moradabad_Zone_Boundary", wardLayer: "Ward_Boundary_New:Moradabad_Ward_Boundary", roadLayer: "Road_Network:Moradabad_Road_Network" },
  prayagraj: { name: "Prayagraj", center: fromLonLat([81.8463, 25.4358]), zoom: 11, zoneLayer: "Ward_Boundary_New:Prayagraj_Zone_Boundary", wardLayer: "Ward_Boundary_New:Prayagraj_Ward_Boundary", roadLayer: "Road_Network:Prayagraj_Road_Network" },
  saharanpur: { name: "Saharanpur", center: fromLonLat([77.546, 29.9679]), zoom: 11, wardLayer: "Ward_Boundary_New:Saharanpur_Ward_Boundary", roadLayer: "Road_Network:Saharanpur_Road_Network" },
  shahjahanpur: { name: "Shahjahanpur", center: fromLonLat([79.912, 27.8804]), zoom: 11, zoneLayer: "Ward_Boundary_New:Shahjahanpur_Zone_Boundary", wardLayer: "Ward_Boundary_New:Shahjahanpur_Ward_Boundary", roadLayer: "Road_Network:Shahjahanpur_Road_Network" },
  varanasi: { name: "Varanasi", center: fromLonLat([82.9566, 25.3176]), zoom: 11, zoneLayer: "Ward_Boundary_New:Varanasi_Zone_Boundary", wardLayer: "Ward_Boundary_New:Varanasi_Ward_Boundary", roadLayer: "Road_Network:Varanasi_Road_Netwrok" },
};
```

### GeoServer Layer Names — Exact Strings Per City
| City | Zone Layer (exact) | Ward Layer (exact) | Road Layer (exact) |
|------|------------------|------------------|------------------|
| Agra | `Ward_Boundary_New:Agra_Zone_Boundary` | `Ward_Boundary_New:Agra_Ward_Boundary` | `Road_Network:Agra_Road_Network` |
| Aligarh | `Ward_Boundary_New:Aligarh_Zone_Boundary` | `Ward_Boundary_New:Aligarh_Ward_Boundary` | `Road_Network:Aligarh_Road_Network` |
| Ayodhya | `Ward_Boundary_New:Ayodhya_Zone_Boundary` | `Ward_Boundary_New:Ayodhya_Ward_Boundary` | `Road_Network:Ayodhya_Road_Network` |
| Bareilly | `Ward_Boundary_New:Bareilly_Zone_Boundary` | `Ward_Boundary_New:Bareilly_Ward_Boundary` | `Road_Network:Bareilly_Road_Network` |
| Firozabad | N/A | `Ward_Boundary_New:Firozabad_Ward_Boundary` | `Road_Network:Firozabad_Road_Network` |
| Ghaziabad | `Ward_Boundary_New:Ghaziabad_Zone_Boundary` | `Ward_Boundary_New:Ghaziabad_Ward_Boundary` | `Road_Network:Ghaziabad_Road_Network` |
| Gorakhpur | `Ward_Boundary_New:Gorakhpur_Zone_Boundary` | `Ward_Boundary_New:Gorakhpur_Ward_Boundary` | `Road_Network:Gorakhpur_Road_Network` |
| Jhansi | N/A | `Ward_Boundary_New:Jhansi_Ward_Boundary` | `Road_Network:Jhansi_Road_Network` |
| Kanpur | `Ward_Boundary_New:Kanpur_Zone_Boundary` | `Ward_Boundary_New:Kanpur_Ward_Boundary` | `Road_Network:Kanpur_Road_Network` |
| Lucknow | `Ward_Boundary_New:Lucknow_Zone_Boundary` | `Ward_Boundary_New:Lucknow_Ward_Boundary` | `Road_Network:Lucknow_Road_Network` |
| Mathura | `Ward_Boundary_New:Mathura_Zone_Boundary` | `Ward_Boundary_New:Mathura_Ward_Boundary` | `Road_Network:Mathura_Road_Network` |
| Meerut | `Ward_Boundary_New:Meerut_Zone_Boundary` | `Ward_Boundary_New:Meerut_Ward_Boundary` | `Road_Network:Meerut_Road_Network` |
| Moradabad | `Ward_Boundary_New:Moradabad_Zone_Boundary` | `Ward_Boundary_New:Moradabad_Ward_Boundary` | `Road_Network:Moradabad_Road_Network` |
| Prayagraj | `Ward_Boundary_New:Prayagraj_Zone_Boundary` | `Ward_Boundary_New:Prayagraj_Ward_Boundary` | `Road_Network:Prayagraj_Road_Network` |
| Saharanpur | N/A | `Ward_Boundary_New:Saharanpur_Ward_Boundary` | `Road_Network:Saharanpur_Road_Network` |
| Shahjahanpur | `Ward_Boundary_New:Shahjahanpur_Zone_Boundary`| `Ward_Boundary_New:Shahjahanpur_Ward_Boundary`| `Road_Network:Shahjahanpur_Road_Network` |
| Varanasi | `Ward_Boundary_New:Varanasi_Zone_Boundary` | `Ward_Boundary_New:Varanasi_Ward_Boundary` | `Road_Network:Varanasi_Road_Netwrok` |

---

## DATABASE CONNECTION — db.js COMPLETE LOGIC

```javascript
import pkg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pkg;

export const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  max: Number(process.env.DB_POOL_MAX || 20),
  idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT || 30000),
  connectionTimeoutMillis: Number(process.env.DB_CONN_TIMEOUT || 5000),
  keepAlive: true,
});

pool.connect()
  .then(() => console.log('✅ Connected to PostgreSQL'))
  .catch(err => console.error('❌ Database connection error:', err));

pool.on("error", (err) => {
  console.error("❌ Unexpected PG pool error:", err);
});
```

### Pool Configuration:
- max connections: `process.env.DB_POOL_MAX || 20`
- idle timeout: `process.env.DB_IDLE_TIMEOUT || 30000`
- connection timeout: `process.env.DB_CONN_TIMEOUT || 5000`

### Known Issue:
The `Promise.all` in `roadNetwork.js` fires sequential/concurrent queries for over 15+ cities per request payload.
With pool max = 20 and multiple queries loading simultaneously, this easily exhausts DB connections causing:
"FATAL 53300: sorry, too many clients already"

### Fix location: `server/src/config/db.js`
Must implement query throttling or increase `DB_POOL_MAX` in `.env` along with backing PostgreSQL `max_connections` adjustments.

---

## CLEANUP RECOMMENDATIONS — STAFF ENGINEER VERDICT

### 🗑️ SAFE TO DELETE
These files have zero imports. Deleting them will not break anything.
- `client/src/components/MeasureOptions.jsx` (Dead component never imported)
- `client/src/components/DrainFilter.jsx` (Dead component never imported)
- `server/src/controllers/roadNetworkController.js` (Legacy duplicate of `roadNetwork.js`)
- `client/src/services/authService.js` (Empty skeleton file)
- `server/src/services/authService.js` (Empty skeleton file)
- `client/src/App.test.js` & `client/src/setupTests.js` (unused boilerplate)

### 📦 SAFE TO ARCHIVE (move to /archive folder)
Orphaned scripts that may be needed for maintenance but not runtime.
- `find_roads.js` (Standalone CLI verification script)
- `server/inspect_db_schema.js` (Helpful CLI schema dump util)
- `server/src/scripts/add_indexes.js` (One-time DB performance boost script)
- `test_fix.js`, `test_real_api.js`, `test_backend.js` (Sandbox debug scripts)
- `debug_geometry.js` (Sandbox geometry script)

### 🔁 DUPLICATES — CONSOLIDATE THESE
- `client/src/pages/Login/LoginPage.jsx` AND `LoginPage_v2.jsx` contain duplicate logic.
Recommendation: keep `LoginPage_v2.jsx` because it receives active visual module imports, while the older component has outdated references.

### ⚠️ NEEDS HUMAN REVIEW BEFORE TOUCHING
- `client/src/components/MapContainer.jsx`: At 5100 lines, it manages its own heavily volatile component lifecycles. Removing specific imports unexpectedly breaks SVG tile rendering caching overlays.
- `server/src/roadNetwork.js`: Needs a massive `Promise.all` refactor for DB concurrency throttling, but directly touching concurrency max-limits without observing system RAM might cause node allocation failure overhead.

### ✅ DO NOT TOUCH — CONFIRMED CRITICAL
- `client/src/assets/configs/cityConfig.js`
- `server/src/app.js`

---

## UPDATED QUICK REFERENCE CHEAT SHEET

| I want to... | File to edit | Function/Line | Notes |
|-------------|-------------|--------------|-------|
| Fix pg connection crash | `server/src/config/db.js` | Pool max config | See Section D |
| Fix rate limiter IP bug | `server/src/app.js` | Line ~10 | Add `app.set('trust proxy', 1)` |
| Add a new city | `server/src/config/cityConfig.js` + client config | cityConfig object | Must add to both |
| Add a new API endpoint | `server/src/routes/` + `controllers/` | Follow existing pattern | |
| Change road filter logic | `server/src/roadNetwork.js` | `buildSafeFilter()` | |
| Add a new amenity type | `client/src/components/MapContainer.jsx` | `getAmenityColor()` + `buildOverpassQuery()` | Needs Pin SVG added to cache |
| Modify export format | `client/src/utils/gisExport.js` | `exportToPDF()` / `exportToExcel()` | |
| Change map base layers | `client/src/components/MapContainer.jsx` | `makeWmsSource()` | |
| Update SummaryTable columns | `client/src/components/SummaryTable.jsx` | column definitions | |
| Change auth logic | `server/src/middleware/authMiddleware.js`| `verifyToken()` | |

---

End of Context. Use this document as the absolute source of truth for URIDA Codebase architecture before proceeding to any objective.
