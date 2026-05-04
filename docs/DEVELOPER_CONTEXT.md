# Developer Context & Technical Deep Dive

## 1. Project Philosophy & Architecture
**URIDA Geo Portal** is a multi-tenant GIS application designed to manage road infrastructure data for multiple cities in Uttar Pradesh.

### Core Architectural Decisions
1.  **Multi-Tenancy via Schemas**: Instead of a single massive table with a `city_id` column, each city gets its own isolated PostgreSQL schema (e.g., `agra`, `kanpur`).
    *   *Why?* Performance and Isolation. GIS queries are expensive. Segregating data prevents index bloat and allows for city-specific customizations without breaking the global schema.
    *   *Exception*: `lucknow` uses the `public` schema (legacy/pilot implementation).
2.  **Frontend-Driven Logic**: The React frontend is "schema-aware". It doesn't just display data; it queries the metadata of the layers (via WFS `DescribeFeatureType`) to build its own UI dynamically.
3.  **Hybrid Map Rendering**:
    *   **WMS (Web Map Service)**: Used for heavy layers like "Road Network" (thousands of lines) to render them as images (tiles) on the server.
    *   **WFS (Web Feature Service)**: Used for interactive layers like "Amenities" (points) to render them as vectors in the browser, allowing for click interactions and client-side styling.

---

## 2. Backend Logic (The "Brain")

### A. The "Router" of the Database: `cityConfig.js`
Location: [cityConfig.js](file:///var/www/urida_prod/server/src/config/cityConfig.js)

This file is the single source of truth for database mapping. It prevents hardcoding table names in queries.

**How it works:**
The frontend sends a `city` parameter (e.g., `agra`). The backend uses `citySchemaMap` to resolve the schema.
```javascript
export const citySchemaMap = {
  agra: "agra",       // Standard pattern
  lucknow: "public",  // Legacy pattern
  // ...
};
```

**Critical Helper Functions:**
*   `getRoadTable(city)`: Resolves to `schema.city_road_net`.
*   `getAmenityTable(city, type)`: Handles the complex logic where some amenities are shared (in `public`) and some are city-specific.
    *   *Logic*: If city is Lucknow, it hardcodes specific tables (e.g., `public.hospital`). For others, it prefixes the table name (e.g., `agra_hospital`).

### B. Security: The Safe Filter Builder
Location: [roadNetwork.js](file:///var/www/urida_prod/server/src/roadNetwork.js)

The frontend allows users to build complex filters like `(Condition = 'Good' OR Width > 7)`. Sending raw SQL WHERE clauses is a security risk (SQL Injection).

**The Solution (`buildSafeFilter`):**
1.  **Tokenization**: It parses the input string character-by-character, respecting parentheses `()` and quotes `'`.
2.  **Whitelist**: It only allows specific columns defined in `allowedFilters`.
3.  **Parameterization**: It converts values into SQL parameters (`$1`, `$2`).
    *   *Input*: `condition = 'Good'`
    *   *Output*: `condition = $1` (with values array `['Good']`)

### C. Data Aggregation: The "Mega Query"
Location: [cityRoutes.js](file:///var/www/urida_prod/server/src/routes/cityRoutes.js)

The Dashboard needs to show total road length, breakdown by condition, breakdown by material, etc. Instead of running 10 separate queries, the system runs one massive CTE (Common Table Expression) query.

**Dirty Data Handling (Regex Normalization):**
The database contains inconsistent data (e.g., "Nagar Nigam", "MNN", "Municipal Corp"). The code fixes this on-the-fly using Regex:
```sql
-- Normalizes ownership to remove spaces/special chars for comparison
const OWNERSHIP_NORM_EXPR = "regexp_replace(lower(coalesce(ownership, '')), '[^a-z0-9]', '', 'g')";
```
*Why?* This ensures that "Nagar Nigam" and "NagarNigam" are counted in the same bucket without modifying the actual database rows.

---

## 3. Frontend Logic (The "Face")

### A. Map Engine State Machine
Location: [MapContainer.jsx](file:///var/www/urida_prod/client/src/components/MapContainer.jsx)

The map component is complex because it manages two parallel layer systems:
1.  **OpenLayers Layers**: The actual visual layers on the map.
2.  **React State**: The visibility toggles in the sidebar.

**Key Logic:**
*   **`AMENITY_ICON_MAP`**: Maps database values (e.g., `atm_bank`) to static assets (`bank_1.png`). If you add a new amenity type in the DB, you MUST add an icon here, or it won't render.
*   **Z-Index Management**: Road layers are always at the bottom (Z-index 1), boundaries on top, and amenities (Points) at the very top (Z-index 100) to ensure clickability.

### B. Dynamic Filtering
Location: [Dashboard.jsx](file:///var/www/urida_prod/client/src/pages/Dashboard.jsx)

The filtering system is "Context-Aware".
*   **Scenario**: User selects `Zone = 2`.
*   **Result**: When the user opens the `Ward` dropdown, it *only* shows wards that are inside Zone 2.
*   **Implementation**: The `FilterDropdown` component sends the *current state of all other filters* to the backend when requesting distinct values.
    *   API Call: `/api/road-networks/agra/distinct/ward_no?filter=(zone_no='2')`

---

## 4. Infrastructure & Deployment

### Nginx Routing
The Nginx config handles traffic routing:
*   `/api` -> Node.js Backend (Port 8070)
*   `/geoserver` -> GeoServer (Port 8080)
*   `/` -> React Static Build

### PM2 Process Management
*   `server`: The Node.js API.
*   `tunnel`: LocalTunnel instance to expose the dev server publicly (for demos).

---

## 5. Developer "Gotchas" (Read Before Coding)

1.  **The "Lucknow" Exception**:
    *   Always check `cityConfig.js` when adding a new city. If the schema structure matches Lucknow (legacy), you might need special handling. If it matches Agra (standard), it should work out of the box.
2.  **Adding New Columns**:
    *   If you add a column to the database (e.g., `traffic_volume`), you must:
        1.  Add it to `allowedFilters` in `server/src/roadNetwork.js`.
        2.  Add it to `ALLOWED_ATTRIBUTES` in `client/src/components/QueryPanel.jsx`.
        3.  Update the WMS/WFS layers in GeoServer to expose this column.
3.  **GeoServer CORS**:
    *   The React app talks to GeoServer via a proxy (`/geoserver` in `setupProxy.js` or Nginx). Do NOT try to hit GeoServer port 8080 directly from the browser, or you will hit CORS errors.
4.  **Date vs Strings**:
    *   Most "numeric" fields in the DB (like `length_km`) might be stored as strings/varchar in some legacy tables. The code uses `::numeric` casting in SQL to handle this safely. Always cast before math operations.
