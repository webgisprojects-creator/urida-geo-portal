/* Road network API: filters, search, summaries, analysis, and road details. */
import { pool } from "./config/db.js";
import express from "express";
import NodeCache from "node-cache";
import { getRoadTable, getWardTable, citySchemaMap, getAmenityTable, getCityUtmEpsg, getDrainTable } from "./config/cityConfig.js";
import { verifyToken } from "./middleware/authMiddleware.js";
import {
  refreshUnderdevelopedAnalysis,
  getUnderdevelopedAnalysis,
  getUnderdevelopedAnalysisCounts,
  getStreetLightGeojson,
  getStreetLightCounts,
  refreshEncroachmentSummary,
  getEncroachmentGeojson,
  getEncroachmentSummary,
  getDssHealth,
} from "./controllers/dssController.js";

const router = express.Router();
const queryCache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // Cache for 5 minutes

router.use(verifyToken);

/*
 |-------------------------------------------------------------|
 |   ALLOWED FILTER FIELDS                                     |
 |-------------------------------------------------------------|
*/
const allowedFilters = {
  gis_id: "gis_id",
  road_id: "road_id",
  zone_no: "zone_no",
  zone_name: "zone_name",
  ward_no: "ward_no",
  ward_name: "ward_name",
  ownership: "ownership",
  road_name: "road_name",
  condition: "condition",
  category: "category",
  material: "material",
  yoc: "yoc",
  cus_class: "cus_class",
  row_meter: "row_meter",
  carriage_w: "carriage_w",
  length_km: "length_km", // Added to support filtering by length
};

/*
 |-------------------------------------------------------------|
 |   SAFE FILTER BUILDER (PARAMETERIZED)                       |
 |-------------------------------------------------------------|
*/

function buildSafeFilter(filterString) {
  console.log("buildSafeFilter received:", filterString);
  if (!filterString) return { text: "", values: [] };

  const parts = [];
  const values = [];

  const splitConditions = (input) => {
    const s = String(input || "");
    const out = [];
    let current = "";
    let inQuote = false;
    let parenDepth = 0;
    let betweenPending = false;
    let i = 0;

    const isWordBoundary = (ch) => !ch || /[^A-Za-z0-9_]/.test(ch);

    while (i < s.length) {
      const ch = s[i];

      if (ch === "'") {
        const next = s[i + 1];
        if (inQuote && next === "'") {
          current += "''";
          i += 2;
          continue;
        }
        inQuote = !inQuote;
        current += ch;
        i += 1;
        continue;
      }

      if (!inQuote) {
        if (ch === "(") parenDepth++;
        if (ch === ")") parenDepth--;

        const rest = s.slice(i);

        const betweenMatch = rest.match(/^(BETWEEN)\b/i);
        if (betweenMatch) {
          const before = s[i - 1];
          const after = s[i + betweenMatch[1].length];
          if (isWordBoundary(before) && isWordBoundary(after)) {
            betweenPending = true;
          }
          current += rest.slice(0, betweenMatch[1].length);
          i += betweenMatch[1].length;
          continue;
        }

        const andMatch = rest.match(/^\s+AND\s+/i);
        if (andMatch) {
          if (betweenPending) {
            betweenPending = false;
            current += andMatch[0];
            i += andMatch[0].length;
            continue;
          }
          // Only split if not inside parentheses
          if (parenDepth === 0) {
            const trimmed = current.trim();
            if (trimmed) out.push(trimmed);
            current = "";
            i += andMatch[0].length;
            continue;
          }
        }
      }

      current += ch;
      i += 1;
    }

    const trimmed = current.trim();
    if (trimmed) out.push(trimmed);
    return out;
  };

  // Helper to check if string has balanced outer parentheses
  const hasBalancedOuterParens = (str) => {
    if (!str.startsWith("(") || !str.endsWith(")")) return false;
    let depth = 0;
    for (let i = 0; i < str.length - 1; i++) { // stop before last char
      if (str[i] === "(") depth++;
      if (str[i] === ")") depth--;
      if (depth === 0) return false; // closed too early
    }
    return true;
  };

  // Helper to process a single condition string
  const processCondition = (condStr) => {
    condStr = condStr.trim();
    if (!condStr) return;

    // 0. Strip outer parentheses (recursively)
    while (hasBalancedOuterParens(condStr)) {
      condStr = condStr.slice(1, -1).trim();
    }

    // 1. Handle BETWEEN (e.g. "col BETWEEN val1 AND val2")
    // Revised Regex:
    // - Captures column name more permissively (handles quotes/spaces)
    // - Matches BETWEEN ... AND ...
    const betweenMatch = condStr.match(/^(.+?)\s+BETWEEN\s+(.+?)\s+AND\s+(.+)$/i);
    if (betweenMatch) {
      let col = betweenMatch[1].trim();
      let v1 = betweenMatch[2].trim();
      let v2 = betweenMatch[3].trim();

      // Clean up column name (remove quotes)
      col = col.replace(/^"|"$/g, "").replace(/^'|'$/g, "");

      const colKey = col.toLowerCase();
      if (allowedFilters[colKey]) {
        const dbCol = allowedFilters[colKey];
        // Remove quotes from values if present
        v1 = v1.replace(/^'|'$/g, "");
        v2 = v2.replace(/^'|'$/g, "");

        values.push(v1, v2);
        parts.push(`${dbCol} BETWEEN $${values.length - 1} AND $${values.length}`);
      } else {
        console.warn(`Filter column ignored (not allowed): ${col}`);
      }
      return true; // Handled
    }

    // 1.5 Handle IN (e.g. "col IN (val1, val2)")
    const inMatch = condStr.match(/^(.+?)\s+IN\s*\((.+)\)$/i);
    if (inMatch) {
      let col = inMatch[1].trim();
      const valStr = inMatch[2];

      // Clean up column name
      col = col.replace(/^"|"$/g, "").replace(/^'|'$/g, "");
      const colKey = col.toLowerCase();

      if (allowedFilters[colKey]) {
        const dbCol = allowedFilters[colKey];

        // Parse values safely (handle quotes and commas)
        const inValues = [];
        let currentVal = "";
        let inValQuote = false;
        for (let i = 0; i < valStr.length; i++) {
          const ch = valStr[i];
          if (ch === "'") inValQuote = !inValQuote;
          if (ch === ',' && !inValQuote) {
            inValues.push(currentVal.trim().replace(/^'|'$/g, ""));
            currentVal = "";
          } else {
            currentVal += ch;
          }
        }
        if (currentVal.trim()) inValues.push(currentVal.trim().replace(/^'|'$/g, ""));

        if (inValues.length > 0) {
          // Generate placeholders: $1, $2, etc.
          const placeholders = inValues.map(v => {
            values.push(v);
            return `$${values.length}`;
          });
          parts.push(`${dbCol} IN (${placeholders.join(", ")})`);
        }
      } else {
        console.warn(`Filter column ignored (not allowed): ${col}`);
      }
      return true;
    }

    // 1.8 Handle INCLUDE (skip)
    if (condStr.toUpperCase() === "INCLUDE") return true;

    // 2. Handle Binary Operators (=, <>, >, <, >=, <=, LIKE, ILIKE)
    // Revised Regex for permissive column matching (multi-character operators must come first)
    const binaryMatch = condStr.match(/^(.+?)\s*(>=|<=|!=|<>|=|>|<|LIKE|ILIKE)\s*(.+)$/i);
    if (binaryMatch) {
      let col = binaryMatch[1].trim();
      const op = binaryMatch[2].toUpperCase();
      let val = binaryMatch[3].trim();

      // Clean up column name
      col = col.replace(/^"|"$/g, "").replace(/^'|'$/g, "");

      const colKey = col.toLowerCase();
      if (allowedFilters[colKey]) {
        const dbCol = allowedFilters[colKey];

        // Remove quotes from value
        val = val.replace(/^'|'$/g, "");

        values.push(val);
        parts.push(`${dbCol} ${op} $${values.length}`);
      } else {
        console.warn(`Filter column ignored (not allowed): ${col}`);
      }
      return true; // Handled
    }
    return false; // Not recognized
  };

  const conditions = splitConditions(filterString);
  conditions.forEach((cond) => processCondition(cond));

  console.log("buildSafeFilter result:", { text: parts.join(" AND "), values });
  return {
    text: parts.length > 0 ? parts.join(" AND ") : "",
    values
  };
}

/*
 |-------------------------------------------------------------|
 |   ROUTES                                                    |
 |-------------------------------------------------------------|
*/

// A table's geometry column name and SRID are fixed schema properties —
// they never change while the server is running, but every single road
// selection was re-running these information_schema/geometry_columns
// lookups (plus, on a cold SRID lookup, a further sample-row query) before
// ever reaching the actual road data — several extra DB round trips paid
// on every click, entirely avoidably. Cached under the same queryCache
// instance already used elsewhere in this file.
async function getGeometryColumn(schema, table) {
  const cacheKey = `geomcol_${schema}_${table}`;
  const cached = queryCache.get(cacheKey);
  if (cached) return cached;

  const q1 = `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = $1 AND table_name = $2 AND udt_name = 'geometry'
    LIMIT 1
  `;
  const r1 = await pool.query(q1, [schema, table]);
  let result = r1.rows[0]?.column_name;
  if (!result) {
    const q2 = `
      SELECT f_geometry_column
      FROM geometry_columns
      WHERE f_table_schema = $1 AND f_table_name = $2
      LIMIT 1
    `;
    const r2 = await pool.query(q2, [schema, table]);
    result = r2.rows[0]?.f_geometry_column || "geom";
  }
  queryCache.set(cacheKey, result);
  return result;
}

function parseQualified(qualified) {
  const [schema, table] = qualified.split(".");
  return { schema, table };
}

function isSafeIdent(value) {
  return /^[A-Za-z0-9_]+$/.test(String(value || ""));
}

function extractLayerBaseName(layerName) {
  const raw = String(layerName || "").trim();
  if (!raw) return "";
  const parts = raw.split(":");
  return (parts[parts.length - 1] || "").trim();
}

function normalizeRelname(value) {
  return String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

async function resolveRelationForLayer(schema, cityCode, layerName) {
  const base = extractLayerBaseName(layerName);
  const guess = normalizeRelname(base);
  if (!guess) return null;
  if (!isSafeIdent(schema)) return null;

  const city = String(cityCode || "").toLowerCase();
  const candidates = [];
  if (guess) candidates.push(guess);
  if (city && guess.startsWith(`${city}_`)) {
    candidates.push(guess.slice(city.length + 1));
  }

  const exactSql = `
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1
      AND c.relkind IN ('r','v','m')
      AND c.relname = ANY($2)
    LIMIT 1
  `;
  const exact = await pool.query(exactSql, [schema, candidates]);
  if (exact.rows[0]?.relname) return exact.rows[0].relname;

  const tokens = Array.from(
    new Set(
      guess
        .split("_")
        .map((t) => t.trim())
        .filter(Boolean)
    )
  );
  if (tokens.length === 0) return null;

  const buildTokenSql = (includeCity) => {
    const filtered = includeCity ? tokens : tokens.filter((t) => t !== city);
    if (filtered.length === 0) return null;
    const conditions = filtered
      .map((_, i) => `lower(c.relname) LIKE $${i + 2}`)
      .join(" AND ");
    return {
      text: `
        SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1
          AND c.relkind IN ('r','v','m')
          AND ${conditions}
        ORDER BY length(c.relname) ASC
        LIMIT 1
      `,
      values: [schema, ...filtered.map((t) => `%${t.toLowerCase()}%`)],
    };
  };

  const strictQuery = buildTokenSql(true);
  if (strictQuery) {
    const strict = await pool.query(strictQuery.text, strictQuery.values);
    if (strict.rows[0]?.relname) return strict.rows[0].relname;
  }

  const relaxedQuery = buildTokenSql(false);
  if (relaxedQuery) {
    const relaxed = await pool.query(relaxedQuery.text, relaxedQuery.values);
    if (relaxed.rows[0]?.relname) return relaxed.rows[0].relname;
  }

  return null;
}

async function getNonGeometryColumns(schema, table) {
  const sql = `
    SELECT column_name, udt_name
    FROM information_schema.columns
    WHERE table_schema = $1
      AND table_name = $2
    ORDER BY ordinal_position ASC
  `;
  const r = await pool.query(sql, [schema, table]);
  const cols = (r.rows || [])
    .filter((c) => String(c.udt_name || "").toLowerCase() !== "geometry")
    .map((c) => c.column_name)
    .filter((name) => isSafeIdent(name));
  return cols;
}

async function resolveRelationInSchemas(schemas, relname) {
  const list = (schemas || [])
    .map((s) => String(s || "").trim())
    .filter((s) => s && isSafeIdent(s));
  const rel = String(relname || "").trim();
  if (!rel || !isSafeIdent(rel) || list.length === 0) return null;

  const sql = `
    SELECT n.nspname AS schema, c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ANY($1)
      AND c.relkind IN ('r','v','m')
      AND c.relname = $2
    LIMIT 1
  `;
  const r = await pool.query(sql, [list, rel]);
  return r.rows[0] || null;
}

async function resolveRelationAnySchema(relname, preferredSchemas = []) {
  const rel = String(relname || "").trim();
  if (!rel || !isSafeIdent(rel)) return null;

  const preferred = (preferredSchemas || [])
    .map((s) => String(s || "").trim())
    .filter((s) => s && isSafeIdent(s));

  const sql = `
    SELECT n.nspname AS schema, c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r','v','m','p','f')
      AND c.relname = $1
      AND n.nspname NOT IN ('pg_catalog','information_schema')
    ORDER BY
      CASE WHEN n.nspname::text = ANY($2::text[]) THEN 0 ELSE 1 END,
      length(n.nspname) ASC
    LIMIT 1
  `;
  const r = await pool.query(sql, [rel, preferred]);
  return r.rows[0] || null;
}

function normalizeAmenityType(type) {
  const t = String(type || "").toLowerCase();
  const map = {
    educationroad: "education",
    bankroad: "atm_bank",
    hospitalroad: "hospital",
    hotelroad: "hotel", // hotel
    metroroad: "metro",
    landmarkroad: "landmark",
    parkroad: "park",
    drainroad: "drain",
    bank: "atm_bank",
  };
  return map[t] || t;
}

async function findAmenityTable(schema, city, amenityType) {
  const type = String(amenityType).toLowerCase();
  const synonyms = {
    atm_bank: ["atm_bank", "atm", "bank"],
    education: ["education", "education_merge", "school", "college", "university"],
    hospital: ["hospital", "hospitals", "health", "clinic"],
    hotel: ["hotel", "hotels", "lodging"],
    metro: ["metro", "metro_station"],
    landmark: ["landmark", "land_mark"],
    park: ["park", "parks", "garden"],
    drain: ["drain", "drainage", "nallah", "nala"],
    post_office: ["post_office", "postoffice"],
  };
  const tokens = synonyms[type] || [type];
  const patterns = tokens.map(
    t => `%${city.toLowerCase()}%${t.toLowerCase()}%`
  );
  const clauses = patterns
    .map((_, i) => `lower(table_name) LIKE $${i + 2}`)
    .join(" OR ");
  const sql = `
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = $1
      AND table_type = 'BASE TABLE'
      AND (${clauses})
    ORDER BY length(table_name) ASC
    LIMIT 1
  `;
  const params = [schema, ...patterns];
  const res = await pool.query(sql, params);
  if (res.rows[0]?.table_name) return res.rows[0].table_name;

  // Fallback 2: search by amenity tokens only (without city in name)
  const tokenClauses = tokens
    .map((t, i) => `lower(table_name) LIKE $${i + 2}`)
    .join(" OR ");
  const tokenSql = `
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = $1
      AND table_type = 'BASE TABLE'
      AND (${tokenClauses})
    ORDER BY length(table_name) ASC
    LIMIT 1
  `;
  const tokenParams = [schema, ...tokens.map(t => `%${t.toLowerCase()}%`)];
  const res2 = await pool.query(tokenSql, tokenParams);
  return res2.rows[0]?.table_name || null;
}

async function getTableSRID(schema, table, geomCol) {
  const cacheKey = `srid_${schema}_${table}_${geomCol}`;
  const cached = queryCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let result = 0;
  // Try to get SRID from geometry_columns first
  const q1 = `SELECT srid FROM geometry_columns WHERE f_table_schema = $1 AND f_table_name = $2 AND f_geometry_column = $3`;
  try {
    const r1 = await pool.query(q1, [schema, table, geomCol]);
    if (r1.rows.length > 0) result = r1.rows[0].srid;
  } catch (e) {
    // ignore
  }
  if (!result) {
    // Fallback to querying the table
    const q2 = `SELECT ST_SRID(${geomCol}) as srid FROM ${schema}.${table} LIMIT 1`;
    try {
      const r2 = await pool.query(q2);
      result = r2.rows[0]?.srid || 0;
    } catch (e) {
      result = 0;
    }
  }
  // Only cache a real, non-zero SRID — 0 means "couldn't determine it",
  // and that's worth retrying on the next call rather than caching a miss.
  if (result) queryCache.set(cacheKey, result);
  return result;
}

async function detectSridFromSample(schema, table, geomCol, utmSrid) {
  const q = `
    SELECT 
      ST_X(ST_PointOnSurface(${geomCol})) AS x,
      ST_Y(ST_PointOnSurface(${geomCol})) AS y
    FROM ${schema}.${table}
    WHERE ${geomCol} IS NOT NULL
    LIMIT 1
  `;
  try {
    const r = await pool.query(q);
    const x = Number(r.rows[0]?.x);
    const y = Number(r.rows[0]?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const ax = Math.abs(x);
    const ay = Math.abs(y);
    if (ax <= 180 && ay <= 90) return 4326;
    if (ax <= 1000000 && ay <= 10000000) {
      try {
        const qUtm = `
          SELECT
            ST_X(ST_Transform(ST_SetSRID(ST_PointOnSurface(${geomCol}), 32643), 4326)) AS lon43,
            ST_Y(ST_Transform(ST_SetSRID(ST_PointOnSurface(${geomCol}), 32643), 4326)) AS lat43,
            ST_X(ST_Transform(ST_SetSRID(ST_PointOnSurface(${geomCol}), 32644), 4326)) AS lon44,
            ST_Y(ST_Transform(ST_SetSRID(ST_PointOnSurface(${geomCol}), 32644), 4326)) AS lat44
          FROM ${schema}.${table}
          WHERE ${geomCol} IS NOT NULL
          LIMIT 1
        `;
        const utmRes = await pool.query(qUtm);
        const row = utmRes.rows[0] || {};
        const lon43 = Number(row.lon43);
        const lat43 = Number(row.lat43);
        const lon44 = Number(row.lon44);
        const lat44 = Number(row.lat44);

        const inIndia = (lon, lat) =>
          Number.isFinite(lon) &&
          Number.isFinite(lat) &&
          lon >= 68 &&
          lon <= 98 &&
          lat >= 6 &&
          lat <= 38;

        const inZone43 = inIndia(lon43, lat43) && lon43 >= 72 && lon43 < 78;
        const inZone44 = inIndia(lon44, lat44) && lon44 >= 78 && lon44 < 84;

        if (inZone43 && !inZone44) return 32643;
        if (inZone44 && !inZone43) return 32644;
      } catch { }
      if (utmSrid) return utmSrid;
    }
    if (ax <= 20037508 && ay <= 20037508) return 3857;
    return null;
  } catch (e) {
    return null;
  }
}

// 🔟 GET DISTINCT VALUES FOR COLUMN (Generic, with Filter) - Moved to top
router.get("/:cityCode/distinct/:column", async (req, res) => {
  console.log(`DISTINCT ROUTE CALLED: ${req.params.cityCode} - ${req.params.column} - Filter: ${req.query.filter}`);
  try {
    const { cityCode, column } = req.params;
    const { filter } = req.query;
    const table = getRoadTable(cityCode);

    // Validate column
    const colKey = column.toLowerCase();
    if (!allowedFilters[colKey]) {
      console.warn(`Invalid column requested: ${colKey}`);
      return res.status(400).json({ error: "Invalid column" });
    }
    const dbCol = allowedFilters[colKey];

    // Build filter
    const { text, values } = buildSafeFilter(filter);
    const whereScope = text ? `AND ${text}` : "";

    const sql = `
      SELECT DISTINCT ${dbCol} as value
      FROM ${table}
      WHERE ${dbCol} IS NOT NULL
      ${whereScope}
      ORDER BY ${dbCol}
    `;

    const result = await pool.query(sql, values);
    res.json(result.rows.map(r => r.value));
  } catch (err) {
    console.error(`Error fetching distinct ${column}:`, err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/:cityCode/specialized-details", async (req, res) => {
  let debugStage = "init";
  let resolutionDebug = null;
  try {
    const { cityCode } = req.params;
    const layer = String(req.query.layer || "").trim();
    const network = String(req.query.network || "").trim();
    const option = String(req.query.option || "").trim();
    const limitRaw = Number(req.query.limit);
    const pageRaw = Number(req.query.page);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 5000) : 2000;
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
    const offset = (page - 1) * limit;

    if (!layer && !network) {
      return res.status(400).json({ error: "Missing layer or network" });
    }

    const cityKey = String(cityCode || "").toLowerCase();
    const citySchema = citySchemaMap[cityKey];
    if (!citySchema) {
      return res.status(400).json({ error: `Invalid city: ${cityCode}` });
    }

    let schema = citySchema;
    let relname = null;
    debugStage = "init";
    resolutionDebug = {
      cityKey,
      citySchema,
      network,
      option,
      layer,
      relInCity: null,
      relInPublic: null,
      fixedFallback: null,
      resolvedSchema: null,
      resolvedRelation: null,
      columns: null,
      stage: "init",
    };

    if (network) {
      const n = network.toLowerCase();
      const o = option.toLowerCase();

      if (!o || o === "none") {
        return res.json({
          relation: null,
          layer,
          network: n,
          option: o || null,
          columns: [],
          page,
          limit,
          total: 0,
          data: [],
        });
      }

      if (n === "drainage") {
        // For drainage, always use the city-specific drain table regardless of option
        const drainTable = getDrainTable(cityKey);
        const { schema: drainSchema, table: drainRelname } = parseQualified(drainTable);
        
        // Verify the table exists
        const checkSql = `
          SELECT n.nspname AS schema, c.relname
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1
            AND c.relkind IN ('r','v','m')
            AND c.relname = $2
          LIMIT 1
        `;
        const checkRes = await pool.query(checkSql, [drainSchema, drainRelname]);
        
        if (checkRes.rows[0]) {
          schema = drainSchema;
          relname = drainRelname;
        } else {
          resolutionDebug.stage = "drain-table-not-found";
          return res.status(404).json({
            error: `Drainage table not found: ${drainTable}`,
            debug: resolutionDebug,
          });
        }
      } else if (n === "slum") {
        // Slum logic remains unchanged
        const fixed = o === "roads" ? "ann_slum_roads" : (o === "boundary" ? "ann_slum_boundary" : null);
        
        if (layer) {
          const relInCity = await resolveRelationForLayer(citySchema, cityKey, layer);
          resolutionDebug.relInCity = relInCity;
          if (relInCity) {
            relname = relInCity;
            schema = citySchema;
          } else {
            const relInPublic = await resolveRelationForLayer("public", cityKey, layer);
            resolutionDebug.relInPublic = relInPublic;
            if (relInPublic) {
              relname = relInPublic;
              schema = "public";
            }
          }
        }

        if (!relname && fixed) {
          resolutionDebug.fixedFallback = fixed;
          const preferredSchemas = [citySchema, "public"];

          const sql = `
            SELECT n.nspname AS schema, c.relname
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname::text = ANY($1::text[])
              AND c.relkind IN ('r','v','m','p','f')
              AND c.relname = $2
            ORDER BY CASE WHEN n.nspname::text = $3 THEN 0 ELSE 1 END
            LIMIT 1
          `;
          const r = await pool.query(sql, [preferredSchemas, fixed, citySchema]);
          const found = r.rows[0] || null;

          if (!found) {
            resolutionDebug.stage = "fixed-fallback-miss";
            return res.status(404).json({
              error: `Table not found: ${fixed}`,
              debug: resolutionDebug,
            });
          }

          schema = found.schema;
          relname = found.relname;
        }
      } else if (!relname) {
        if (layer) {
          const relInCity = await resolveRelationForLayer(citySchema, cityKey, layer);
          if (relInCity) {
            relname = relInCity;
            schema = citySchema;
          } else {
            const relInPublic = await resolveRelationForLayer("public", cityKey, layer);
            if (relInPublic) {
              relname = relInPublic;
              schema = "public";
            }
          }
        }

        if (!relname) {
          return res.status(400).json({ error: "Unsupported specialized dataset" });
        }
      }
    } else {
      const relInCity = await resolveRelationForLayer(citySchema, cityKey, layer);
      if (relInCity) {
        relname = relInCity;
        schema = citySchema;
      } else {
        const relInPublic = await resolveRelationForLayer("public", cityKey, layer);
        if (relInPublic) {
          relname = relInPublic;
          schema = "public";
        }
      }

      if (!relname) {
        return res.status(404).json({ error: "No matching table found for layer" });
      }
    }

    resolutionDebug.resolvedSchema = schema;
    resolutionDebug.resolvedRelation = relname;

    if (!isSafeIdent(schema) || !isSafeIdent(relname)) {
      resolutionDebug.stage = "unsafe-identifier";
      return res.status(400).json({ error: "Unsafe identifier", debug: resolutionDebug });
    }

    debugStage = "columns";
    resolutionDebug.stage = debugStage;
    const columns = await getNonGeometryColumns(schema, relname);
    resolutionDebug.columns = columns;
    if (!columns.length) {
      resolutionDebug.stage = "no-readable-columns";
      return res.status(404).json({ error: "No readable columns found", debug: resolutionDebug });
    }

    const identCols = columns.map((c) => `"${c}"`).join(", ");
    const dataSql = `SELECT ${identCols} FROM "${schema}"."${relname}" LIMIT $1 OFFSET $2`;
    const countSql = `SELECT COUNT(1)::int AS total FROM "${schema}"."${relname}"`;

    debugStage = "query";
    resolutionDebug.stage = debugStage;
    const [dataRes, countRes] = await Promise.all([
      pool.query(dataSql, [limit, offset]),
      pool.query(countSql),
    ]);

    res.json({
      relation: `${schema}.${relname}`,
      layer,
      network: network ? network.toLowerCase() : null,
      option: option ? option.toLowerCase() : null,
      columns,
      page,
      limit,
      total: countRes.rows[0]?.total || 0,
      data: dataRes.rows || [],
    });
  } catch (err) {
    console.error("Error fetching specialized details:", err);
    res.status(500).json({
      error: "Internal server error",
      debug: {
        ...(typeof resolutionDebug === "object" && resolutionDebug ? resolutionDebug : {}),
        stage: debugStage || resolutionDebug?.stage || "unknown",
        message: err?.message || String(err),
      },
    });
  }
});

router.get("/:cityCode/road-analysis/:amenityType", async (req, res) => {
  try {
    const city = req.params.cityCode;
    const amenityRaw = req.params.amenityType;
    const amenityType = normalizeAmenityType(amenityRaw);
    const { refresh } = req.query; // Check for refresh param

    console.log(`[road-analysis] city=${city} amenityType=${amenityType} refresh=${refresh}`);
    const roadQualified = getRoadTable(city);
    const { schema: roadSchema, table: roadTable } = parseQualified(roadQualified);
    let amenityQualified;
    let amenitySchema;
    let amenityTable;
    try {
      amenityQualified = getAmenityTable(city, amenityType);
      ({ schema: amenitySchema, table: amenityTable } = parseQualified(amenityQualified));
    } catch (e) {
      const fallback = await findAmenityTable(roadSchema, city, amenityType);
      if (!fallback) {
        console.error(`[road-analysis] Amenity table not found for ${city}:${amenityType}`);
        return res.status(404).json({ error: `Amenity table not found for ${city}:${amenityType}` });
      }
      amenitySchema = roadSchema;
      amenityTable = fallback;
      amenityQualified = `${amenitySchema}.${amenityTable}`;
    }
    console.log(`[road-analysis] roads: ${roadSchema}.${roadTable} amenities: ${amenitySchema}.${amenityTable}`);
    const utmSrid = getCityUtmEpsg(city);

    const roadGeomCol = await getGeometryColumn(roadSchema, roadTable);
    const amenityGeomCol = await getGeometryColumn(amenitySchema, amenityTable);
    console.log(`[road-analysis] geom cols -> road: ${roadGeomCol}, amenity: ${amenityGeomCol}, utm: ${utmSrid}`);

    const roadSrid = await getTableSRID(roadSchema, roadTable, roadGeomCol);
    console.log(`[road-analysis] roadSrid: ${roadSrid}`);

    const mvName = `${roadSchema}.mv_${city.toLowerCase()}_${amenityType}_roads`;
    const indexName = `idx_${city.toLowerCase()}_${amenityType}_roads_geom`;

    const existsQ = `
      SELECT 1 FROM pg_matviews WHERE schemaname = $1 AND matviewname = $2
    `;
    const exists = await pool.query(existsQ, [roadSchema, mvName.split(".")[1]]);

    if (exists.rowCount > 0 && refresh === "true") {
      console.log(`[road-analysis] Refreshing MV ${mvName}`);
      try {
        await pool.query(`REFRESH MATERIALIZED VIEW ${mvName}`);
        console.log(`[road-analysis] MV refreshed: ${mvName}`);
      } catch (e) {
        console.error(`[road-analysis] Failed to refresh MV: ${e.message}`);
        // Continue to return existing data or error?
        // If refresh fails, we might still want to return data, but let's log it.
      }
    }

    if (exists.rowCount === 0) {
      console.log(`[road-analysis] creating MV ${mvName}`);

      // Optimization: use index on road table if possible.
      // We assume data is lat/lon (approx). 0.001 deg ~= 111m.
      const indexFilter = `ST_DWithin(r.${roadGeomCol}, ST_SetSRID(a.${amenityGeomCol}, ${roadSrid}), 0.001)`;

      const createSql = `
        CREATE MATERIALIZED VIEW ${mvName} AS
        SELECT DISTINCT 
          r.gis_id, r.road_id, r.road_name, r.zone_no, r.zone_name, r.ward_no, r.ward_name,
          r.ownership, r.condition, r.category, r.material, r.yoc, r.cus_class, r.row_meter, r.carriage_w,
          ST_Transform(ST_Force2D(CASE WHEN ST_SRID(r.${roadGeomCol}) = 0 THEN ST_SetSRID(r.${roadGeomCol}, 4326) ELSE r.${roadGeomCol} END), 4326) AS geom
        FROM ${roadSchema}.${roadTable} r
        JOIN ${amenitySchema}.${amenityTable} a
          ON ${indexFilter}
          AND ST_DWithin(
            ST_Transform(CASE WHEN ST_SRID(r.${roadGeomCol}) = 0 THEN ST_SetSRID(r.${roadGeomCol}, 4326) ELSE r.${roadGeomCol} END, ${utmSrid}),
            ST_Transform(CASE WHEN ST_SRID(a.${amenityGeomCol}) = 0 THEN ST_SetSRID(a.${amenityGeomCol}, 4326) ELSE a.${amenityGeomCol} END, ${utmSrid}),
            10
          )
      `;
      try {
        await pool.query(createSql);
        console.log(`[road-analysis] MV created: ${mvName}`);
      } catch (e) {
        console.error("Failed to create materialized view:", e);
        return res.status(500).json({ error: "Failed to create materialized view" });
      }
      const indexSql = `
        CREATE INDEX IF NOT EXISTS ${indexName} ON ${mvName} USING GIST(geom)
      `;
      try {
        await pool.query(indexSql);
        console.log(`[road-analysis] GIST index created: ${indexName}`);
      } catch (e) {
        console.warn("Index creation warning:", e.message);
      }
    }

    const geojsonQ = `
      SELECT json_build_object(
        'type','FeatureCollection',
        'features', COALESCE(json_agg(
          json_build_object(
            'type','Feature',
            'geometry', ST_AsGeoJSON(t.geom)::json,
            'properties', to_jsonb(t) - 'geom'
          )
        ), '[]'::json)
      ) AS geojson
      FROM ${mvName} t
    `;
    const result = await pool.query(geojsonQ);
    res.json(result.rows[0]?.geojson || { type: "FeatureCollection", features: [] });
  } catch (err) {
    console.error("road-analysis error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 1️⃣ GET WARDS (specific)
router.get("/:cityCode/wards", async (req, res) => {
  console.log("🔥🔥🔥 WARDS ROUTE EXECUTED FOR", req.params.cityCode, "🔥🔥🔥");

  try {
    const { cityCode } = req.params;
    const { zone } = req.query;
    
    // Check Cache
    const cacheKey = `wards_${cityCode}_${zone || 'all'}`;
    const cachedData = queryCache.get(cacheKey);
    if (cachedData) return res.json(cachedData);

    const table = getRoadTable(cityCode);

    let sql;
    let params = [];

    if (zone && zone !== "undefined" && zone !== "null" && zone !== "") {
      sql = `
        SELECT DISTINCT ward_no, ward_name
        FROM ${table}
        WHERE zone_no = $1
          AND ward_no IS NOT NULL
        ORDER BY ward_no;
      `;
      params = [zone];
    } else {
      sql = `
        SELECT DISTINCT ward_no, ward_name
        FROM ${table}
        WHERE ward_no IS NOT NULL
        ORDER BY ward_no;
      `;
    }

    const result = await pool.query(sql, params);
    const mappedResponse = result.rows.map((r) => ({
      ward_no: r.ward_no,
      ward_name: r.ward_name,
      name: r.ward_name || "",
    }));
    
    queryCache.set(cacheKey, mappedResponse);
    res.json(mappedResponse);
  } catch (err) {
    console.error("Error fetching wards:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Field-task deep links load roads for the URL's ward plus whatever wards
// spatially border it, instead of the whole zone — the boundary polygons
// already reveal adjacency (shared/near edges), no separate adjacency table
// needed. Not every city's ward boundary table carries zone_no (Agra's
// doesn't), so the zone filter is applied only when the column exists;
// otherwise adjacency alone still returns a sane (if zone-unaware) answer.
router.get("/:cityCode/adjacent-wards", async (req, res) => {
  try {
    const { cityCode } = req.params;
    const { zone, ward } = req.query;
    if (!ward) {
      return res.status(400).json({ error: "ward is required" });
    }

    const wardTable = getWardTable(cityCode);
    const [schema, table] = wardTable.split(".");

    const hasZoneColCacheKey = `wardtbl_haszonecol_${wardTable}`;
    let hasZoneCol = queryCache.get(hasZoneColCacheKey);
    if (hasZoneCol === undefined) {
      const colCheck = await pool.query(
        `SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = 'zone_no'`,
        [schema, table]
      );
      hasZoneCol = colCheck.rows.length > 0;
      queryCache.set(hasZoneColCacheKey, hasZoneCol, 3600);
    }

    const useZoneFilter = hasZoneCol && zone;
    const sql = `
      SELECT DISTINCT w2.ward_no, w2.ward_name
      FROM ${wardTable} w1
      JOIN ${wardTable} w2
        ON ST_DWithin(w1.geom::geography, w2.geom::geography, 50)
      WHERE w1.ward_no = $1
        ${useZoneFilter ? "AND w2.zone_no = $2" : ""}
      ORDER BY w2.ward_no;
    `;
    const params = useZoneFilter ? [ward, zone] : [ward];
    const result = await pool.query(sql, params);
    res.json(
      result.rows.map((r) => ({
        ward_no: r.ward_no,
        ward_name: r.ward_name,
        name: r.ward_name || "",
      }))
    );
  } catch (err) {
    console.error("Error fetching adjacent wards:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Multi-road patch creation (field-task mode): given a road already in the
// selection, find roads whose geometry actually touches/nearly-touches it
// (a shared or very close endpoint), restricted to the ward set — this is
// road-level adjacency, a finer-grained sibling of /adjacent-wards above.
// Building the multi-road tree by always expanding from an already-picked
// road's own neighbors guarantees the resulting selection is a genuinely
// connected chain, with no separate validation query needed.
router.get("/:cityCode/adjacent-roads", async (req, res) => {
  try {
    const { cityCode } = req.params;
    const { road_id, wards } = req.query;
    if (!road_id) {
      return res.status(400).json({ error: "road_id is required" });
    }

    const table = getRoadTable(cityCode);
    const wardNums = wards
      ? String(wards).split(",").map((w) => Number(w.trim())).filter(Number.isFinite)
      : [];

    const params = [road_id, road_id];
    let wardClause = "";
    if (wardNums.length) {
      params.push(wardNums);
      wardClause = `AND r2.ward_no = ANY($${params.length}::int[])`;
    }

    const sql = `
      SELECT DISTINCT
        r2.road_id,
        r2.road_name,
        r2.ward_no,
        r2.zone_no,
        COALESCE(r2.length_km, ST_Length(r2.geom::geography) / 1000.0) AS length_km
      FROM ${table} r1
      JOIN ${table} r2
        ON ST_DWithin(r1.geom::geography, r2.geom::geography, 15)
      WHERE r1.road_id = $1
        AND r2.road_id != $2
        ${wardClause}
      ORDER BY r2.road_name
      LIMIT 30
    `;
    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching adjacent roads:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/:cityCode/street-light", getStreetLightGeojson);
router.get("/:cityCode/street-light/counts", getStreetLightCounts);

router.post("/:cityCode/underdeveloped-analysis/refresh", refreshUnderdevelopedAnalysis);
router.get("/:cityCode/underdeveloped-analysis", getUnderdevelopedAnalysis);
router.get("/:cityCode/underdeveloped-analysis/counts", getUnderdevelopedAnalysisCounts);

router.post("/:cityCode/encroachment-analysis/refresh", refreshEncroachmentSummary);
router.get("/:cityCode/encroachment-analysis", getEncroachmentGeojson);
router.get("/:cityCode/encroachment-analysis/summary", getEncroachmentSummary);
router.get("/:cityCode/dss/health", getDssHealth);

// 2️⃣ GET ZONES (generic)
router.get("/:cityCode", async (req, res) => {
  try {
    const table = getRoadTable(req.params.cityCode);

    const zones = await pool.query(`
      SELECT DISTINCT zone_no, zone_name AS name
      FROM ${table}
      WHERE zone_no IS NOT NULL
      ORDER BY zone_no;
    `);

    res.json(zones.rows);
  } catch (err) {
    console.error("Error fetching zones:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 3️⃣ GET CATEGORY (optionally filtered by zone)
router.get("/:cityCode/categories", async (req, res) => {
  try {
    const { cityCode } = req.params;
    const { zone } = req.query;
    const table = getRoadTable(cityCode);

    let sql;
    let params = [];

    if (zone && zone !== "undefined" && zone !== "null" && zone !== "") {
      sql = `
        SELECT DISTINCT category
        FROM ${table}
        WHERE category IS NOT NULL
          AND zone_no = $1
        ORDER BY category;
      `;
      params = [zone];
    } else {
      sql = `
        SELECT DISTINCT category
        FROM ${table}
        WHERE category IS NOT NULL
        ORDER BY category;
      `;
    }

    const result = await pool.query(sql, params);
    res.json(result.rows.map((r) => r.category));
  } catch (err) {
    console.error("Error fetching categories:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 4️⃣ GET CONDITION (optionally filtered by zone)
router.get("/:cityCode/conditions", async (req, res) => {
  try {
    const { cityCode } = req.params;
    const { zone } = req.query;
    const table = getRoadTable(cityCode);

    let sql;
    let params = [];

    if (zone && zone !== "undefined" && zone !== "null" && zone !== "") {
      sql = `
        SELECT DISTINCT condition
        FROM ${table}
        WHERE condition IS NOT NULL
          AND zone_no = $1
        ORDER BY condition;
      `;
      params = [zone];
    } else {
      sql = `
        SELECT DISTINCT condition
        FROM ${table}
        WHERE condition IS NOT NULL
        ORDER BY condition;
      `;
    }

    const result = await pool.query(sql, params);
    res.json(result.rows.map((r) => r.condition));
  } catch (err) {
    console.error("Error fetching conditions:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 5️⃣ MATERIAL (optionally filtered by zone)
router.get("/:cityCode/materials", async (req, res) => {
  try {
    const { cityCode } = req.params;
    const { zone } = req.query;
    const table = getRoadTable(cityCode);

    let sql;
    let params = [];

    if (zone && zone !== "undefined" && zone !== "null" && zone !== "") {
      sql = `
        SELECT DISTINCT material
        FROM ${table}
        WHERE material IS NOT NULL
          AND zone_no = $1
        ORDER BY material;
      `;
      params = [zone];
    } else {
      sql = `
        SELECT DISTINCT material
        FROM ${table}
        WHERE material IS NOT NULL
        ORDER BY material;
      `;
    }

    const result = await pool.query(sql, params);
    res.json(result.rows.map((r) => r.material));
  } catch (err) {
    console.error("Error fetching materials:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 6️⃣ OWNERSHIP (optionally filtered by zone)
router.get("/:cityCode/ownership", async (req, res) => {
  try {
    const { cityCode } = req.params;
    const { zone } = req.query;
    const table = getRoadTable(cityCode);

    let sql;
    let params = [];

    if (zone && zone !== "undefined" && zone !== "null" && zone !== "") {
      sql = `
        SELECT DISTINCT ownership
        FROM ${table}
        WHERE ownership IS NOT NULL
          AND zone_no = $1
        ORDER BY ownership;
      `;
      params = [zone];
    } else {
      sql = `
        SELECT DISTINCT ownership
        FROM ${table}
        WHERE ownership IS NOT NULL
        ORDER BY ownership;
      `;
    }

    const result = await pool.query(sql, params);
    res.json(result.rows.map((r) => r.ownership));
  } catch (err) {
    console.error("Error fetching ownership:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 7️⃣ CUS (optionally filtered by zone)
router.get("/:cityCode/cus", async (req, res) => {
  try {
    const { cityCode } = req.params;
    const { zone } = req.query;
    const table = getRoadTable(cityCode);

    let sql;
    let params = [];

    if (zone && zone !== "undefined" && zone !== "null" && zone !== "") {
      sql = `
        SELECT DISTINCT cus_class
        FROM ${table}
        WHERE cus_class IS NOT NULL
          AND zone_no = $1
        ORDER BY cus_class;
      `;
      params = [zone];
    } else {
      sql = `
        SELECT DISTINCT cus_class
        FROM ${table}
        WHERE cus_class IS NOT NULL
        ORDER BY cus_class;
      `;
    }

    const result = await pool.query(sql, params);
    res.json(result.rows.map((r) => r.cus_class));
  } catch (err) {
    console.error("Error fetching CUS Class:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 7️⃣ CUS CLASS (Legacy/Alternate)
router.get("/:cityCode/cus_class", async (req, res) => {
  try {
    const table = getRoadTable(req.params.cityCode);
    const result = await pool.query(`
      SELECT DISTINCT cus_class
      FROM ${table}
      WHERE cus_class IS NOT NULL
      ORDER BY cus_class;
    `);

    res.json(result.rows.map((r) => r.cus_class));
  } catch (err) {
    console.error("Error fetching CUS Class:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// SUMMARY AGGREGATES
router.get("/:cityCode/summary", async (req, res) => {
  try {
    const { cityCode } = req.params;
    const { filter, bbox } = req.query;

    // Check Cache - bbox is part of the key so different viewports (the
    // legend's dynamic counts are now extent-aware, same as the table)
    // never share a cached summary from a different area.
    const cacheKey = `summary_${cityCode}_${filter || 'all'}_${bbox || 'nobbox'}`;
    const cachedData = queryCache.get(cacheKey);
    if (cachedData) return res.json(cachedData);

    const table = getRoadTable(cityCode);

    // Use buildSafeFilter to handle complex filters (zone, ward, condition, etc.)
    const { text, values: baseValues } = buildSafeFilter(filter);
    let values = baseValues;
    let scopeText = text;

    // Live extent sync: the legend's dynamic road-count items (e.g. "Roads
    // > 10m ROW (N)") used to stay static while the table below them
    // updated live with the map's viewport - same bbox=minLon,minLat,
    // maxLon,maxLat (EPSG:4326) contract as /details.
    const bboxParts = bbox ? String(bbox).split(",").map(Number) : null;
    if (bboxParts && bboxParts.length === 4 && bboxParts.every(Number.isFinite)) {
      const { schema, table: tableName } = parseQualified(table);
      const geomCol = await getGeometryColumn(schema, tableName);
      let srid = await getTableSRID(schema, tableName, geomCol);
      if (!srid) {
        const utmSrid = getCityUtmEpsg(cityCode);
        srid = (await detectSridFromSample(schema, tableName, geomCol, utmSrid)) || utmSrid;
      }
      const [minLon, minLat, maxLon, maxLat] = bboxParts;
      const baseIdx = values.length;
      const envelope = `ST_MakeEnvelope($${baseIdx + 1},$${baseIdx + 2},$${baseIdx + 3},$${baseIdx + 4},4326)`;
      const bboxClause = srid === 4326
        ? `${geomCol} && ${envelope} AND ST_Intersects(${geomCol}, ${envelope})`
        : `${geomCol} && ST_Transform(${envelope}, ${srid}) AND ST_Intersects(${geomCol}, ST_Transform(${envelope}, ${srid}))`;
      values = [...values, minLon, minLat, maxLon, maxLat];
      scopeText = scopeText ? `(${scopeText}) AND ${bboxClause}` : bboxClause;
    }

    const whereScope = scopeText ? `AND ${scopeText}` : "";

    const totalRoadsQ = `SELECT COUNT(*)::int AS count FROM ${table} WHERE 1=1 ${whereScope};`;
    const totalWardsQ = `SELECT COUNT(DISTINCT ward_no)::int AS count FROM ${table} WHERE ward_no IS NOT NULL ${whereScope};`;
    const totalZonesQ = `SELECT COUNT(DISTINCT zone_no)::int AS count FROM ${table} WHERE zone_no IS NOT NULL ${whereScope};`;
    const totalLengthQ = `SELECT COALESCE(SUM(ST_Length(geom::geography))/1000.0,0)::numeric(12,3) AS km FROM ${table} WHERE 1=1 ${whereScope};`;

    const byCategoryQ = `SELECT category AS label, COUNT(*)::int AS count, COALESCE(SUM(COALESCE(length_km, ST_Length(geom::geography)/1000.0)),0)::numeric(12,3) AS length_km FROM ${table} WHERE category IS NOT NULL ${whereScope} GROUP BY category ORDER BY count DESC;`;
    const byConditionQ = `SELECT condition AS label, COUNT(*)::int AS count, COALESCE(SUM(COALESCE(length_km, ST_Length(geom::geography)/1000.0)),0)::numeric(12,3) AS length_km FROM ${table} WHERE condition IS NOT NULL ${whereScope} GROUP BY condition ORDER BY count DESC;`;
    const byMaterialQ = `SELECT material AS label, COUNT(*)::int AS count, COALESCE(SUM(COALESCE(length_km, ST_Length(geom::geography)/1000.0)),0)::numeric(12,3) AS length_km FROM ${table} WHERE material IS NOT NULL ${whereScope} GROUP BY material ORDER BY count DESC;`;
    const byOwnershipQ = `SELECT ownership AS label, COUNT(*)::int AS count, COALESCE(SUM(COALESCE(length_km, ST_Length(geom::geography)/1000.0)),0)::numeric(12,3) AS length_km FROM ${table} WHERE ownership IS NOT NULL ${whereScope} GROUP BY ownership ORDER BY count DESC;`;
    const byCusQ = `SELECT cus_class AS label, COUNT(*)::int AS count, COALESCE(SUM(COALESCE(length_km, ST_Length(geom::geography)/1000.0)),0)::numeric(12,3) AS length_km FROM ${table} WHERE cus_class IS NOT NULL ${whereScope} GROUP BY cus_class ORDER BY count DESC;`;
    const byZoneQ = `SELECT zone_no AS label, COUNT(*)::int AS count, COALESCE(SUM(COALESCE(length_km, ST_Length(geom::geography)/1000.0)),0)::numeric(12,3) AS length_km FROM ${table} WHERE zone_no IS NOT NULL ${whereScope} GROUP BY zone_no ORDER BY zone_no ASC;`;
    const byWardQ = `SELECT ward_no AS label, COUNT(*)::int AS count, COALESCE(SUM(COALESCE(length_km, ST_Length(geom::geography)/1000.0)),0)::numeric(12,3) AS length_km FROM ${table} WHERE ward_no IS NOT NULL ${whereScope} GROUP BY ward_no ORDER BY ward_no ASC;`;

    const [
      totalRoads,
      totalWards,
      totalZones,
      totalLength,
      byCategory,
      byCondition,
      byMaterial,
      byOwnership,
      byCus,
      byZone,
      byWard,
    ] = await Promise.all([
      pool.query(totalRoadsQ, values),
      pool.query(totalWardsQ, values),
      pool.query(totalZonesQ, values),
      pool.query(totalLengthQ, values),
      pool.query(byCategoryQ, values),
      pool.query(byConditionQ, values),
      pool.query(byMaterialQ, values),
      pool.query(byOwnershipQ, values),
      pool.query(byCusQ, values),
      pool.query(byZoneQ, values),
      pool.query(byWardQ, values),
    ]);

    const summaryResponse = {
      totalRoads: totalRoads.rows[0]?.count ?? 0,
      totalWards: totalWards.rows[0]?.count ?? 0,
      zones: totalZones.rows[0]?.count ?? 0,
      roadLengthKm: Number(totalLength.rows[0]?.km ?? 0),
      byCategory: byCategory.rows,
      byCondition: byCondition.rows,
      byMaterial: byMaterial.rows,
      byOwnership: byOwnership.rows,
      byCus: byCus.rows,
      byZone: byZone.rows,
      byWard: byWard.rows,
    };
    
    queryCache.set(cacheKey, summaryResponse);
    res.json(summaryResponse);
  } catch (err) {
    console.error("Error building summary:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/:cityCode/amenities-count", async (req, res) => {
  try {
    const { cityCode } = req.params;
    const { tables } = req.body || {};
    const tableKeys = Array.isArray(tables) ? tables : [];
    const schema = citySchemaMap[String(cityCode || "").toLowerCase()];
    if (!schema) {
      return res.status(400).json({ error: "Invalid city code" });
    }

    const counts = await Promise.all(
      tableKeys.map(async (tableKey) => {
        let qualified;
        try {
          qualified = getAmenityTable(cityCode, tableKey);
        } catch (err) {
          const fallback = await findAmenityTable(schema, cityCode, tableKey);
          if (!fallback) {
            return { name: tableKey, count: 0 };
          }
          qualified = `${schema}.${fallback}`;
        }

        const { schema: tblSchema, table } = parseQualified(qualified);
        const result = await pool.query(`SELECT COUNT(*)::int AS count FROM ${tblSchema}.${table}`);
        return { name: tableKey, count: result.rows[0]?.count ?? 0 };
      })
    );

    res.json(counts);
  } catch (err) {
    console.error("Error fetching amenities count:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 8️⃣ ROAD DETAILS TABLE
router.get("/:cityCode/details", async (req, res) => {
  console.log(`🛣️ API CALLED: /${req.params.cityCode}/details (Filtered Road List) - Filter: ${req.query.filter}`);
  try {
    const { cityCode } = req.params;
    const { filter, include_geom, page, limit, bbox, includeRoadId } = req.query;
    const table = getRoadTable(cityCode);

    const { schema, table: tableName } = parseQualified(table);
    const geomCol = await getGeometryColumn(schema, tableName);

    const { text, values } = buildSafeFilter(filter);

    // Pagination logic (limit=0 means unlimited, used for exports)
    const pageNum = parseInt(page) || 1;
    const rawLimit = parseInt(limit);
    const limitNum = rawLimit === 0 ? 0 : (rawLimit || 1000); // 0 = unlimited, default 1000
    const offset = limitNum === 0 ? 0 : (pageNum - 1) * limitNum;

    // Resolving the table's real SRID is needed both for returning geometry
    // (include_geom) and for the bbox/extent filter below - only do the
    // (cached, but still async) lookup once if either needs it.
    let resolvedSrid = null;
    const resolveSrid = async () => {
      if (resolvedSrid !== null) return resolvedSrid;
      const tableSrid = await getTableSRID(schema, tableName, geomCol);
      if (tableSrid) {
        resolvedSrid = tableSrid;
      } else {
        const utmSrid = getCityUtmEpsg(cityCode);
        resolvedSrid = (await detectSridFromSample(schema, tableName, geomCol, utmSrid)) || utmSrid;
      }
      return resolvedSrid;
    };

    let geomSelect = "";
    if (include_geom === "true") {
      const srid = await resolveSrid();
      geomSelect = srid === 4326
        ? `, ST_AsGeoJSON(${geomCol})::json as geom`
        : `, ST_AsGeoJSON(ST_Transform(ST_SetSRID(${geomCol}, ${srid}), 4326))::json as geom`;
    }

    // Live extent sync: when the map's current viewport is passed as
    // bbox=minLon,minLat,maxLon,maxLat (EPSG:4326), only return roads that
    // actually intersect it - this is what lets the table track "what's on
    // screen" instead of paging through the whole filtered set.
    let combinedText = text;
    let combinedValues = values;
    const bboxParts = bbox ? String(bbox).split(",").map(Number) : null;
    if (bboxParts && bboxParts.length === 4 && bboxParts.every(Number.isFinite)) {
      const [minLon, minLat, maxLon, maxLat] = bboxParts;
      const srid = await resolveSrid();
      const baseIdx = combinedValues.length;
      const envelope = `ST_MakeEnvelope($${baseIdx + 1},$${baseIdx + 2},$${baseIdx + 3},$${baseIdx + 4},4326)`;
      let bboxClause = srid === 4326
        ? `${geomCol} && ${envelope} AND ST_Intersects(${geomCol}, ${envelope})`
        : `${geomCol} && ST_Transform(${envelope}, ${srid}) AND ST_Intersects(${geomCol}, ST_Transform(${envelope}, ${srid}))`;
      combinedValues = [...combinedValues, minLon, minLat, maxLon, maxLat];
      // A road click typically pans/zooms the map (changing the extent this
      // same request is scoped to) - OR the clicked/selected road into the
      // bbox condition so it's guaranteed present (and thus stays
      // highlighted) in the very next extent-scoped fetch, without a
      // separate request racing this one. Still respects the rest of the
      // filter (zone/ward/category scope) - only the geographic bbox is
      // bypassed, and only for this one road.
      if (includeRoadId) {
        combinedValues.push(String(includeRoadId));
        bboxClause = `(${bboxClause} OR road_id = $${combinedValues.length})`;
      }
      combinedText = combinedText ? `(${combinedText}) AND ${bboxClause}` : bboxClause;
    }

    // Get Total Count and Length
    const countSql = `
      SELECT
        COUNT(*) as total,
        COALESCE(SUM(COALESCE(length_km, ST_Length(${geomCol}::geography)/1000.0)), 0)::numeric(12,3) as total_length_km
      FROM ${table}
      ${combinedText ? `WHERE ${combinedText}` : ""}
    `;
    const countResult = await pool.query(countSql, combinedValues);
    const total = parseInt(countResult.rows[0]?.total || 0);
    const total_length_km = parseFloat(countResult.rows[0]?.total_length_km || 0);

    // Get Data
    const paginationClause = limitNum > 0
      ? `LIMIT $${combinedValues.length + 1} OFFSET $${combinedValues.length + 2}`
      : '';
    const sql = `
      SELECT
        gis_id, road_id, zone_no, zone_name, ward_no, ward_name,
        ownership, road_name, condition, category, material,
        yoc, cus_class, row_meter, carriage_w,
        COALESCE(length_km, ROUND((ST_Length(${geomCol}::geography)/1000)::numeric, 2)) as length_km
        ${geomSelect}
      FROM ${table}
      ${combinedText ? `WHERE ${combinedText}` : ""}
      ORDER BY road_id
      ${paginationClause};
    `;

    const queryValues = limitNum > 0 ? [...combinedValues, limitNum, offset] : combinedValues;
    const result = await pool.query(sql, queryValues);

    res.json({
      data: result.rows,
      total,
      total_length_km,
      page: pageNum,
      limit: limitNum
    });

  } catch (err) {
    console.error("Error fetching road details:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// for search roads at search button
router.get("/:cityCode/search", async (req, res) => {
  console.log(`🔍 API CALLED: /${req.params.cityCode}/search (Search Query: ${req.query.q})`);
  try {
    const { cityCode } = req.params;
    const { q, page = 1, limit = 50, wards } = req.query; // Default to 50 items per page

    const table = getRoadTable(cityCode);
    const offset = (page - 1) * limit;

    // Field-task redirects pass their target ward + neighbors here so the
    // preloaded dropdown/search results only ever cover that area instead
    // of the whole city — normal dashboard search never sends this.
    const wardNums = wards
      ? String(wards).split(",").map((w) => Number(w.trim())).filter(Number.isFinite)
      : [];

    const params = [];
    const whereClauses = [];

    if (q && q.trim() !== "") {
      // Road number (road_id) is searchable here specifically for the
      // field-task case — a KMC field worker is far more likely to have
      // been given a road ID than to know its name.
      params.push(`%${q}%`);
      const qIdx = params.length;
      whereClauses.push(`(road_name ILIKE $${qIdx} OR ward_name ILIKE $${qIdx} OR road_id ILIKE $${qIdx})`);
    }

    if (wardNums.length) {
      params.push(wardNums);
      whereClauses.push(`ward_no = ANY($${params.length}::int[])`);
    }

    params.push(limit);
    const limitIdx = params.length;
    params.push(offset);
    const offsetIdx = params.length;

    const query = `
      SELECT DISTINCT
        gis_id,
        road_id,
        road_name,
        ward_no,
        ward_name,
        zone_no
      FROM ${table}
      ${whereClauses.length ? `WHERE ${whereClauses.join(" AND ")}` : ""}
      ORDER BY road_name, ward_name
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `;

    console.log("🔍 SEARCH querying:", table, "Page:", page, "Limit:", limit, "Wards:", wardNums.join(",") || "(all)");

    const result = await pool.query(query, params);

    res.json(
      result.rows.map((row) => ({
        gis_id: row.gis_id,
        road_id: row.road_id,
        road_name: row.road_name,
        ward_no: row.ward_no,
        ward_name: row.ward_name,
        zone_no: row.zone_no,
      }))
    );
  } catch (err) {
    console.error("Search error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 9️⃣ GET SINGLE ROAD DETAILS BY GIS_ID
router.get("/:cityCode/road/:gisId", async (req, res) => {
  console.log(`🛣️ API CALLED: /${req.params.cityCode}/road/${req.params.gisId} (Single Road Details)`);
  try {
    const { cityCode, gisId } = req.params;
    const table = getRoadTable(cityCode);

    // Fetch ALL columns
    const sql = `
      SELECT *
      FROM ${table}
      WHERE gis_id = $1
    `;

    const result = await pool.query(sql, [gisId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Road not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error fetching road details:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 9️⃣ UNIQUE VALUES FOR ATTRIBUTE
router.get("/:cityCode/values/:attribute", async (req, res) => {
  try {
    const { cityCode, attribute } = req.params;
    
    // Validate attribute against allowed list to prevent SQL injection
    if (!allowedFilters[attribute]) {
      return res.status(400).json({ error: "Invalid attribute" });
    }

    // Check Cache
    const cacheKey = `values_${cityCode}_${attribute}`;
    const cachedData = queryCache.get(cacheKey);
    if (cachedData) return res.json(cachedData);

    const table = getRoadTable(cityCode);

    const sql = `
      SELECT DISTINCT ${attribute} as val
      FROM ${table}
      WHERE ${attribute} IS NOT NULL
      ORDER BY val
    `;

    const result = await pool.query(sql);
    const mappedResponse = result.rows.map(r => r.val);
    
    queryCache.set(cacheKey, mappedResponse);
    res.json(mappedResponse);
  } catch (err) {
    console.error(`Error fetching values for ${req.params.attribute}:`, err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
