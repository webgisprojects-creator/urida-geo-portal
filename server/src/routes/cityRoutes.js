/* Home and city-level aggregate APIs for the landing dashboard. */
import express from 'express';
import { getZoneSummary, getWardSummary } from '../controllers/cityController.js';
import { pool } from '../config/db.js';
import { citySchemaMap } from '../config/cityConfig.js';
import { verifyToken } from '../middleware/authMiddleware.js';
const router = express.Router();

router.use(verifyToken);

const amenityTables = [
  'atm_bank',
  'bus_stop',
  'education',
  'hospital',
  'hotel',
  'park',
  'petrol_pump',
  'post_office'
];

const MUNICIPAL_REGEX = "(nagar\\s*nigam|nagarnigam|nagar\\s*nigam\\s*nidhi|municipal\\s*corporation|municipal\\s*corp|\\mnn\\M|\\mn\\.?n\\.?\\M|\\m[a-z]{1,6}nn\\M)";
const MUNICIPAL_NORM_REGEX = "^(ann|bnn|gkpnn|jnn|knn|lnn|mvnn|snn|nn)$";
// Safe numeric cast: strips any non-numeric/non-decimal characters before casting.
// This makes queries resilient to columns stored as varchar (e.g. Shahjahanpur's row_meter)
// and to any future city imports that may have inconsistent column types.
const safeNum = (col) => `NULLIF(regexp_replace(${col}::text, '[^0-9.]', '', 'g'), '')::numeric`;

// Length expression: prefers length_km, falls back to length_met (converting m → km)
const LENGTH_EXPR = `COALESCE(${safeNum('length_km')}, ${safeNum('length_met')} / 1000.0, 0)`;

// Row-of-way width expression: prefers row_meter, falls back to carriage_w
const ROW_WIDTH_EXPR = `COALESCE(${safeNum('row_meter')}, ${safeNum('carriage_w')}, 0)`;

// Ownership and Condition normalised expressions (used in WHERE clauses and CTEs)
const OWNERSHIP_NORM_EXPR = "regexp_replace(lower(coalesce(ownership, '')), '[^a-z0-9]', '', 'g')";
const CONDITION_NORM_EXPR = "regexp_replace(lower(coalesce(condition, '')), '[^a-z0-9]', '', 'g')";

const fetchRoadStats = async (schema, city, options = {}) => {
  const { includeBreakdowns = true, includeUnmatched = true } = options;
  const table = `${schema}.${city}_road_net`;
  const municipalMatch = `(${OWNERSHIP_NORM_EXPR} LIKE '%nagarnigam%' OR ${OWNERSHIP_NORM_EXPR} LIKE '%nagarnigamnidhi%' OR ${OWNERSHIP_NORM_EXPR} LIKE '%municipalcorporation%' OR ${OWNERSHIP_NORM_EXPR} LIKE '%municipalcorp%' OR ${OWNERSHIP_NORM_EXPR} ~* '${MUNICIPAL_NORM_REGEX}' OR ownership ~* '${MUNICIPAL_REGEX}')`;
  const pwdMatch = `(${OWNERSHIP_NORM_EXPR} LIKE '%pwd%' OR ownership ILIKE '%pwd%')`;
  const goodMatch = `(${CONDITION_NORM_EXPR} LIKE 'good%' OR ${CONDITION_NORM_EXPR} IN ('g','gd','vg','vgood','verygood','excellent','ok','okay'))`;
  const moderateMatch = `(${CONDITION_NORM_EXPR} LIKE 'mod%' OR ${CONDITION_NORM_EXPR} IN ('m','med','medium','fair','avg','average'))`;
  const poorMatch = `(${CONDITION_NORM_EXPR} LIKE 'poor%' OR ${CONDITION_NORM_EXPR} IN ('p','bad','verypoor','vp','worst','damaged'))`;
  const conditionUnknownMatch = `(condition IS NULL OR trim(condition) = '' OR condition ILIKE 'na%' OR condition ILIKE 'n/a%')`;
  const sql = `
    WITH normalized AS (
      SELECT *, ${OWNERSHIP_NORM_EXPR} AS ownership_norm, ${CONDITION_NORM_EXPR} AS condition_norm
      FROM ${table}
    )
    SELECT
      COUNT(*)::int AS total_roads,
      COALESCE(SUM(${LENGTH_EXPR}), 0) AS total_length_km,
      COUNT(DISTINCT ward_no)::int AS total_wards,
      COUNT(DISTINCT zone_no)::int AS total_zones,
      COUNT(*) FILTER (WHERE ${ROW_WIDTH_EXPR} >= 10)::int AS above10m_count,
      COALESCE(SUM(CASE WHEN ${ROW_WIDTH_EXPR} >= 10 THEN ${LENGTH_EXPR} ELSE 0 END), 0) AS above10m_length_km,
      COUNT(*) FILTER (WHERE ${goodMatch})::int AS good_count,
      COUNT(*) FILTER (WHERE ${moderateMatch})::int AS moderate_count,
      COUNT(*) FILTER (WHERE ${poorMatch})::int AS poor_count,
      COUNT(*) FILTER (WHERE ${conditionUnknownMatch})::int AS condition_unknown_count,
      COALESCE(SUM(CASE WHEN ${goodMatch} THEN ${LENGTH_EXPR} ELSE 0 END), 0) AS good_length_km,
      COALESCE(SUM(CASE WHEN ${moderateMatch} THEN ${LENGTH_EXPR} ELSE 0 END), 0) AS moderate_length_km,
      COALESCE(SUM(CASE WHEN ${poorMatch} THEN ${LENGTH_EXPR} ELSE 0 END), 0) AS poor_length_km,
      COALESCE(SUM(CASE WHEN ${conditionUnknownMatch} THEN ${LENGTH_EXPR} ELSE 0 END), 0) AS condition_unknown_length_km,
      COUNT(*) FILTER (WHERE category ILIKE 'local%')::int AS category_local_count,
      COUNT(*) FILTER (WHERE category ILIKE 'collector%')::int AS category_collector_count,
      COUNT(*) FILTER (WHERE category ILIKE 'sub%arterial%')::int AS category_sub_arterial_count,
      COUNT(*) FILTER (WHERE category ILIKE 'arterial%' AND category NOT ILIKE 'sub%')::int AS category_arterial_count,
      COUNT(*) FILTER (WHERE category IS NULL OR trim(category) = '' OR category ILIKE 'na%')::int AS category_unknown_count,
      COALESCE(SUM(CASE WHEN category ILIKE 'local%' THEN ${LENGTH_EXPR} ELSE 0 END), 0) AS category_local_length_km,
      COALESCE(SUM(CASE WHEN category ILIKE 'collector%' THEN ${LENGTH_EXPR} ELSE 0 END), 0) AS category_collector_length_km,
      COALESCE(SUM(CASE WHEN category ILIKE 'sub%arterial%' THEN ${LENGTH_EXPR} ELSE 0 END), 0) AS category_sub_arterial_length_km,
      COALESCE(SUM(CASE WHEN category ILIKE 'arterial%' AND category NOT ILIKE 'sub%' THEN ${LENGTH_EXPR} ELSE 0 END), 0) AS category_arterial_length_km,
      COALESCE(SUM(CASE WHEN category IS NULL OR trim(category) = '' OR category ILIKE 'na%' THEN ${LENGTH_EXPR} ELSE 0 END), 0) AS category_unknown_length_km,
      COUNT(*) FILTER (WHERE ${municipalMatch})::int AS ownership_municipal_count,
      COALESCE(SUM(CASE WHEN ${municipalMatch} THEN ${LENGTH_EXPR} ELSE 0 END), 0) AS ownership_municipal_length_km,
      COUNT(*) FILTER (WHERE ${municipalMatch} AND ${goodMatch})::int AS municipal_good_count,
      COUNT(*) FILTER (WHERE ${municipalMatch} AND ${moderateMatch})::int AS municipal_moderate_count,
      COUNT(*) FILTER (WHERE ${municipalMatch} AND ${poorMatch})::int AS municipal_poor_count,
      COUNT(*) FILTER (WHERE ${municipalMatch} AND ${conditionUnknownMatch})::int AS municipal_condition_unknown_count,
      COALESCE(SUM(CASE WHEN ${municipalMatch} AND ${goodMatch} THEN ${LENGTH_EXPR} ELSE 0 END), 0) AS municipal_good_length_km,
      COALESCE(SUM(CASE WHEN ${municipalMatch} AND ${moderateMatch} THEN ${LENGTH_EXPR} ELSE 0 END), 0) AS municipal_moderate_length_km,
      COALESCE(SUM(CASE WHEN ${municipalMatch} AND ${poorMatch} THEN ${LENGTH_EXPR} ELSE 0 END), 0) AS municipal_poor_length_km,
      COALESCE(SUM(CASE WHEN ${municipalMatch} AND ${conditionUnknownMatch} THEN ${LENGTH_EXPR} ELSE 0 END), 0) AS municipal_condition_unknown_length_km,
      COUNT(*) FILTER (WHERE ${pwdMatch})::int AS ownership_pwd_count,
      COALESCE(SUM(CASE WHEN ${pwdMatch} THEN ${LENGTH_EXPR} ELSE 0 END), 0) AS ownership_pwd_length_km,
      COUNT(*) FILTER (WHERE material ILIKE '%bitum%')::int AS material_bitumen_count,
      COUNT(*) FILTER (WHERE material ILIKE '%cc%')::int AS material_cc_count,
      COUNT(*) FILTER (WHERE material ILIKE '%interlock%')::int AS material_interlocking_count,
      COUNT(*) FILTER (WHERE material ILIKE '%kach%')::int AS material_kachcha_count,
      COUNT(*) FILTER (WHERE material IS NULL OR trim(material) = '' OR material ILIKE 'na%')::int AS material_unknown_count,
      COALESCE(SUM(CASE WHEN material ILIKE '%bitum%' THEN ${LENGTH_EXPR} ELSE 0 END), 0) AS material_bitumen_length_km,
      COALESCE(SUM(CASE WHEN material ILIKE '%cc%' THEN ${LENGTH_EXPR} ELSE 0 END), 0) AS material_cc_length_km,
      COALESCE(SUM(CASE WHEN material ILIKE '%interlock%' THEN ${LENGTH_EXPR} ELSE 0 END), 0) AS material_interlocking_length_km,
      COALESCE(SUM(CASE WHEN material ILIKE '%kach%' THEN ${LENGTH_EXPR} ELSE 0 END), 0) AS material_kachcha_length_km,
      COALESCE(SUM(CASE WHEN material IS NULL OR trim(material) = '' OR material ILIKE 'na%' THEN ${LENGTH_EXPR} ELSE 0 END), 0) AS material_unknown_length_km
    FROM normalized;
  `;
  const summaryRes = await pool.query(sql);
  let ownershipCountRes = { rows: [] };
  let ownershipLengthRes = { rows: [] };
  let conditionCountRes = { rows: [] };
  let conditionLengthRes = { rows: [] };
  let materialCountRes = { rows: [] };
  let materialLengthRes = { rows: [] };
  let categoryCountRes = { rows: [] };
  let categoryLengthRes = { rows: [] };
  let ownershipUnmatchedRes = { rows: [] };

  if (includeBreakdowns) {
    [
      ownershipCountRes,
      ownershipLengthRes,
      conditionCountRes,
      conditionLengthRes,
      materialCountRes,
      materialLengthRes,
      categoryCountRes,
      categoryLengthRes
    ] = await Promise.all([
      pool.query(`
        WITH normalized AS (
          SELECT *, ${OWNERSHIP_NORM_EXPR} AS ownership_norm
          FROM ${table}
        )
        SELECT
          CASE
            WHEN ${municipalMatch} THEN 'Nagar Nigam'
            WHEN ${pwdMatch} THEN 'PWD'
            WHEN ownership ILIKE '%nhai%' THEN 'NHAI'
            WHEN ownership ILIKE '%railway%' THEN 'Railway'
            WHEN ownership ILIKE '%defence%' THEN 'Defence'
            WHEN ownership ILIKE '%develop%authority%' THEN 'Development Authority'
            WHEN ownership ILIKE '%department road%' THEN 'Department Road'
            WHEN ownership ILIKE '%institutional%' THEN 'Institutional Road'
            WHEN ownership ILIKE '%upsbc%' THEN 'UPSBC Ltd.'
            WHEN ownership ILIKE '%private%' THEN 'Private'
            WHEN ownership IS NULL OR trim(ownership) = '' THEN 'Unknown'
            ELSE trim(ownership)
          END AS label,
          COUNT(*)::int AS count
        FROM normalized
        GROUP BY label
        ORDER BY count DESC
      `),
      pool.query(`
        WITH normalized AS (
          SELECT *, ${OWNERSHIP_NORM_EXPR} AS ownership_norm
          FROM ${table}
        )
        SELECT
          CASE
            WHEN ${municipalMatch} THEN 'Nagar Nigam'
            WHEN ${pwdMatch} THEN 'PWD'
            WHEN ownership ILIKE '%nhai%' THEN 'NHAI'
            WHEN ownership ILIKE '%railway%' THEN 'Railway'
            WHEN ownership ILIKE '%defence%' THEN 'Defence'
            WHEN ownership ILIKE '%develop%authority%' THEN 'Development Authority'
            WHEN ownership ILIKE '%department road%' THEN 'Department Road'
            WHEN ownership ILIKE '%institutional%' THEN 'Institutional Road'
            WHEN ownership ILIKE '%upsbc%' THEN 'UPSBC Ltd.'
            WHEN ownership ILIKE '%private%' THEN 'Private'
            WHEN ownership IS NULL OR trim(ownership) = '' THEN 'Unknown'
            ELSE trim(ownership)
          END AS label,
          COALESCE(SUM(${LENGTH_EXPR}), 0) AS length_km
        FROM normalized
        GROUP BY label
        ORDER BY length_km DESC
      `),
      pool.query(`
        SELECT
          CASE
            WHEN ${goodMatch} THEN 'Good'
            WHEN ${moderateMatch} THEN 'Moderate'
            WHEN ${poorMatch} THEN 'Poor'
            WHEN ${conditionUnknownMatch} THEN 'NA'
            ELSE initcap(condition)
          END AS label,
          COUNT(*)::int AS count
        FROM ${table}
        GROUP BY label
        ORDER BY count DESC
      `),
      pool.query(`
        SELECT
          CASE
            WHEN ${goodMatch} THEN 'Good'
            WHEN ${moderateMatch} THEN 'Moderate'
            WHEN ${poorMatch} THEN 'Poor'
            WHEN ${conditionUnknownMatch} THEN 'NA'
            ELSE initcap(condition)
          END AS label,
          COALESCE(SUM(${LENGTH_EXPR}), 0) AS length_km
        FROM ${table}
        GROUP BY label
        ORDER BY length_km DESC
      `),
      pool.query(`
        SELECT
          CASE
            WHEN material ILIKE '%bitum%' THEN 'Bitumen'
            WHEN material ILIKE '%boe%' THEN 'BOE'
            WHEN material ILIKE '%cc%' THEN 'CC'
            WHEN material ILIKE '%interlock%' THEN 'Interlocking'
            WHEN material ILIKE '%kach%' THEN 'Kachcha'
            WHEN material IS NULL OR trim(material) = '' OR material ILIKE 'na%' THEN 'NA'
            ELSE initcap(material)
          END AS label,
          COUNT(*)::int AS count
        FROM ${table}
        GROUP BY label
        ORDER BY count DESC
      `),
      pool.query(`
        SELECT
          CASE
            WHEN material ILIKE '%bitum%' THEN 'Bitumen'
            WHEN material ILIKE '%boe%' THEN 'BOE'
            WHEN material ILIKE '%cc%' THEN 'CC'
            WHEN material ILIKE '%interlock%' THEN 'Interlocking'
            WHEN material ILIKE '%kach%' THEN 'Kachcha'
            WHEN material IS NULL OR trim(material) = '' OR material ILIKE 'na%' THEN 'NA'
            ELSE initcap(material)
          END AS label,
          COALESCE(SUM(${LENGTH_EXPR}), 0) AS length_km
        FROM ${table}
        GROUP BY label
        ORDER BY length_km DESC
      `),
      pool.query(`
        SELECT
          CASE
            WHEN category ILIKE 'local%' THEN 'Local'
            WHEN category ILIKE 'collector%' THEN 'Collector'
            WHEN category ILIKE 'sub%arterial%' THEN 'Sub Arterial'
            WHEN category ILIKE 'arterial%' AND category NOT ILIKE 'sub%' THEN 'Arterial'
            WHEN category IS NULL OR trim(category) = '' OR category ILIKE 'na%' THEN 'NA'
            ELSE initcap(category)
          END AS label,
          COUNT(*)::int AS count
        FROM ${table}
        GROUP BY label
        ORDER BY count DESC
      `),
      pool.query(`
        SELECT
          CASE
            WHEN category ILIKE 'local%' THEN 'Local'
            WHEN category ILIKE 'collector%' THEN 'Collector'
            WHEN category ILIKE 'sub%arterial%' THEN 'Sub Arterial'
            WHEN category ILIKE 'arterial%' AND category NOT ILIKE 'sub%' THEN 'Arterial'
            WHEN category IS NULL OR trim(category) = '' OR category ILIKE 'na%' THEN 'NA'
            ELSE initcap(category)
          END AS label,
          COALESCE(SUM(${LENGTH_EXPR}), 0) AS length_km
        FROM ${table}
        GROUP BY label
        ORDER BY length_km DESC
      `)
    ]);
  }

  if (includeUnmatched) {
    ownershipUnmatchedRes = await pool.query(`
      WITH normalized AS (
        SELECT *, ${OWNERSHIP_NORM_EXPR} AS ownership_norm
        FROM ${table}
      )
      SELECT
        trim(ownership) AS label,
        COUNT(*)::int AS count
      FROM normalized
      WHERE ownership IS NOT NULL
        AND trim(ownership) <> ''
        AND NOT ${municipalMatch}
      GROUP BY label
      ORDER BY count DESC
      LIMIT 25
    `);
  }
  const summary = summaryRes.rows[0] || {
    total_roads: 0,
    total_length_km: 0,
    total_wards: 0,
    total_zones: 0,
    above10m_count: 0,
    above10m_length_km: 0,
    good_count: 0,
    moderate_count: 0,
    poor_count: 0,
    condition_unknown_count: 0,
    good_length_km: 0,
    moderate_length_km: 0,
    poor_length_km: 0,
    condition_unknown_length_km: 0,
    category_local_count: 0,
    category_collector_count: 0,
    category_sub_arterial_count: 0,
    category_arterial_count: 0,
    category_unknown_count: 0,
    category_local_length_km: 0,
    category_collector_length_km: 0,
    category_sub_arterial_length_km: 0,
    category_arterial_length_km: 0,
    category_unknown_length_km: 0,
    ownership_municipal_count: 0,
    ownership_municipal_length_km: 0,
    municipal_good_count: 0,
    municipal_moderate_count: 0,
    municipal_poor_count: 0,
    municipal_condition_unknown_count: 0,
    municipal_good_length_km: 0,
    municipal_moderate_length_km: 0,
    municipal_poor_length_km: 0,
    municipal_condition_unknown_length_km: 0,
    ownership_pwd_count: 0,
    ownership_pwd_length_km: 0,
    material_bitumen_count: 0,
    material_cc_count: 0,
    material_interlocking_count: 0,
    material_kachcha_count: 0,
    material_unknown_count: 0,
    material_bitumen_length_km: 0,
    material_cc_length_km: 0,
    material_interlocking_length_km: 0,
    material_kachcha_length_km: 0,
    material_unknown_length_km: 0
  };
  return {
    ...summary,
    ownership_breakdown: ownershipCountRes.rows || [],
    ownership_length_breakdown: ownershipLengthRes.rows || [],
    condition_breakdown: conditionCountRes.rows || [],
    condition_length_breakdown: conditionLengthRes.rows || [],
    material_breakdown: materialCountRes.rows || [],
    material_length_breakdown: materialLengthRes.rows || [],
    category_breakdown: categoryCountRes.rows || [],
    category_length_breakdown: categoryLengthRes.rows || [],
    ownership_municipal_unmatched: ownershipUnmatchedRes.rows || []
  };
};

const AMENITY_PATTERNS = {
  atm_bank: ["atm", "bank"],
  bus_stop: ["bus", "stop"],
  education: ["education", "school", "college", "university"],
  hospital: ["hospital", "health", "clinic"],
  hotel: ["hotel", "guest", "lodge"],
  park: ["park", "garden"],
  petrol_pump: ["petrol", "pump", "fuel"],
  post_office: ["post", "office"]
};

const HOME_SUMMARY_TTL_MS = 10 * 60 * 1000; // 10 min server-side cache
let homeSummaryCache = { ts: 0, payload: null };

const findAmenityTable = (tables, key) => {
  const patterns = AMENITY_PATTERNS[key] || [key];
  const exact = tables.find((name) => name === key);
  if (exact) return exact;
  const candidates = tables.map((name) => {
    const score = patterns.reduce((acc, token) => acc + (name.includes(token) ? 1 : 0), 0);
    return { name, score };
  }).filter((item) => item.score > 0);
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score || a.name.length - b.name.length);
  return candidates[0].name;
};

const fetchAmenityCounts = async (schema) => {
  const existingRes = await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
    [schema]
  );
  const tables = existingRes.rows.map((r) => r.table_name.toLowerCase());
  const results = await Promise.all(
    amenityTables.map(async (tableKey) => {
      const tableName = findAmenityTable(tables, tableKey);
      if (!tableName) return { tableName: tableKey, count: 0 };
      const { rows } = await pool.query(`SELECT COUNT(*)::int AS count FROM ${schema}.${tableName}`);
      return { tableName: tableKey, count: rows[0]?.count ?? 0 };
    })
  );
  return results.reduce((acc, item) => {
    acc[item.tableName] = item.count;
    return acc;
  }, {});
};

router.get('/home/summary', async (req, res) => {
  try {
    if (homeSummaryCache.payload && Date.now() - homeSummaryCache.ts < HOME_SUMMARY_TTL_MS && req.query.refresh !== '1') {
      return res.json(homeSummaryCache.payload);
    }
    const cityKeys = Object.keys(citySchemaMap);

    // Run cities in batches of 4 to avoid exhausting the PG connection pool.
    // Each city can use up to ~3 connections (roadStats + amenities + sub-queries),
    // so 4 concurrent cities ≈ 12 connections, well within the pool max of 20.
    const batchSerial = async (items, batchSize, fn) => {
      const results = [];
      for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        const batchResults = await Promise.all(batch.map(fn));
        results.push(...batchResults);
      }
      return results;
    };

    const perCityEntries = await batchSerial(cityKeys, 4, async (city) => {
      const schema = citySchemaMap[city];
      try {
        const [roadStats, amenities] = await Promise.all([
          fetchRoadStats(schema, city, { includeBreakdowns: false, includeUnmatched: false }),
          fetchAmenityCounts(schema)
        ]);
        return [city, { ...roadStats, amenities }];
      } catch (err) {
        console.error(`Home summary error for ${city}:`, err.message);
        return [city, {
          total_roads: 0,
          total_length_km: 0,
          total_wards: 0,
          total_zones: 0,
          above10m_count: 0,
          above10m_length_km: 0,
          amenities: {}
        }];
      }
    });


    const perCity = Object.fromEntries(perCityEntries);

    const sumFields = [
      'total_roads',
      'total_length_km',
      'total_wards',
      'total_zones',
      'above10m_count',
      'above10m_length_km',
      'good_count',
      'moderate_count',
      'poor_count',
      'condition_unknown_count',
      'good_length_km',
      'moderate_length_km',
      'poor_length_km',
      'condition_unknown_length_km',
      'category_local_count',
      'category_collector_count',
      'category_sub_arterial_count',
      'category_arterial_count',
      'category_unknown_count',
      'category_local_length_km',
      'category_collector_length_km',
      'category_sub_arterial_length_km',
      'category_arterial_length_km',
      'category_unknown_length_km',
      'ownership_municipal_count',
      'ownership_municipal_length_km',
      'municipal_good_count',
      'municipal_moderate_count',
      'municipal_poor_count',
      'municipal_condition_unknown_count',
      'municipal_good_length_km',
      'municipal_moderate_length_km',
      'municipal_poor_length_km',
      'municipal_condition_unknown_length_km',
      'ownership_pwd_count',
      'ownership_pwd_length_km',
      'material_bitumen_count',
      'material_cc_count',
      'material_interlocking_count',
      'material_kachcha_count',
      'material_unknown_count',
      'material_bitumen_length_km',
      'material_cc_length_km',
      'material_interlocking_length_km',
      'material_kachcha_length_km',
      'material_unknown_length_km'
    ];

    const upTotalsRaw = cityKeys.reduce((acc, city) => {
      const data = perCity[city] || {};
      sumFields.forEach((field) => {
        acc[field] = (acc[field] || 0) + Number(data[field] || 0);
      });
      const amenities = data.amenities || {};
      Object.keys(amenities).forEach((k) => {
        acc.amenities[k] = (acc.amenities[k] || 0) + Number(amenities[k] || 0);
      });
      const merge = (target, items, key) => {
        (items || []).forEach((item) => {
          const label = item.label || 'Unknown';
          const value = Number(item[key] || 0);
          target[label] = (target[label] || 0) + value;
        });
      };
      merge(acc._ownershipCounts, data.ownership_breakdown, 'count');
      merge(acc._ownershipLengths, data.ownership_length_breakdown, 'length_km');
      merge(acc._conditionCounts, data.condition_breakdown, 'count');
      merge(acc._conditionLengths, data.condition_length_breakdown, 'length_km');
      merge(acc._materialCounts, data.material_breakdown, 'count');
      merge(acc._materialLengths, data.material_length_breakdown, 'length_km');
      merge(acc._categoryCounts, data.category_breakdown, 'count');
      merge(acc._categoryLengths, data.category_length_breakdown, 'length_km');
      return acc;
    }, {
      total_roads: 0,
      total_length_km: 0,
      total_wards: 0,
      total_zones: 0,
      above10m_count: 0,
      above10m_length_km: 0,
      good_count: 0,
      moderate_count: 0,
      poor_count: 0,
      condition_unknown_count: 0,
      good_length_km: 0,
      moderate_length_km: 0,
      poor_length_km: 0,
      condition_unknown_length_km: 0,
      category_local_count: 0,
      category_collector_count: 0,
      category_sub_arterial_count: 0,
      category_arterial_count: 0,
      category_unknown_count: 0,
      category_local_length_km: 0,
      category_collector_length_km: 0,
      category_sub_arterial_length_km: 0,
      category_arterial_length_km: 0,
      category_unknown_length_km: 0,
      ownership_municipal_count: 0,
      ownership_municipal_length_km: 0,
      municipal_good_count: 0,
      municipal_moderate_count: 0,
      municipal_poor_count: 0,
      municipal_condition_unknown_count: 0,
      municipal_good_length_km: 0,
      municipal_moderate_length_km: 0,
      municipal_poor_length_km: 0,
      municipal_condition_unknown_length_km: 0,
      ownership_pwd_count: 0,
      ownership_pwd_length_km: 0,
      material_bitumen_count: 0,
      material_cc_count: 0,
      material_interlocking_count: 0,
      material_kachcha_count: 0,
      material_unknown_count: 0,
      material_bitumen_length_km: 0,
      material_cc_length_km: 0,
      material_interlocking_length_km: 0,
      material_kachcha_length_km: 0,
      material_unknown_length_km: 0,
      amenities: {},
      _ownershipCounts: {},
      _ownershipLengths: {},
      _conditionCounts: {},
      _conditionLengths: {},
      _materialCounts: {},
      _materialLengths: {},
      _categoryCounts: {},
      _categoryLengths: {}
    });

    const mapToArray = (obj, keyName) => Object.entries(obj).map(([label, value]) => ({
      label,
      [keyName]: Number(value || 0)
    }));

    const upTotals = {
      ...upTotalsRaw,
      ownership_breakdown: mapToArray(upTotalsRaw._ownershipCounts, 'count'),
      ownership_length_breakdown: mapToArray(upTotalsRaw._ownershipLengths, 'length_km'),
      condition_breakdown: mapToArray(upTotalsRaw._conditionCounts, 'count'),
      condition_length_breakdown: mapToArray(upTotalsRaw._conditionLengths, 'length_km'),
      material_breakdown: mapToArray(upTotalsRaw._materialCounts, 'count'),
      material_length_breakdown: mapToArray(upTotalsRaw._materialLengths, 'length_km'),
      category_breakdown: mapToArray(upTotalsRaw._categoryCounts, 'count'),
      category_length_breakdown: mapToArray(upTotalsRaw._categoryLengths, 'length_km')
    };

    delete upTotals._ownershipCounts;
    delete upTotals._ownershipLengths;
    delete upTotals._conditionCounts;
    delete upTotals._conditionLengths;
    delete upTotals._materialCounts;
    delete upTotals._materialLengths;
    delete upTotals._categoryCounts;
    delete upTotals._categoryLengths;

    const payload = {
      generatedAt: new Date().toISOString(),
      cityOrder: cityKeys,
      perCity,
      upTotals
    };
    homeSummaryCache = { ts: Date.now(), payload };
    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=60');
    res.json(payload);
  } catch (err) {
    console.error('Home summary error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:city/zone-summary', getZoneSummary);
router.get('/:city/ward-summary', getWardSummary);

router.get('/test-db', async (req, res) => {
  const { rows } = await pool.query('SELECT NOW()');
  res.json(rows);
});

/** =====================================================================
 *  LIVE ROAD DATA FROM all_db (used by map for hover/click popups)
 *  These endpoints replace static GeoServer WFS so updates to the DB
 *  are immediately reflected in the map without cache invalidation.
 * ===================================================================== */

/**
 * GET /api/:city/roads/above10m/geojson
 * Returns GeoJSON FeatureCollection of roads with row_meter >= 10
 * within an optional bounding box (EPSG:4326).
 * Query params: bbox=minLon,minLat,maxLon,maxLat  (optional)
 */
router.get('/:city/roads/above10m/geojson', async (req, res) => {
  try {
    const city = req.params.city.toLowerCase();
    const schema = citySchemaMap[city];
    if (!schema) return res.status(400).json({ error: `Unknown city: ${city}` });

    const table = `${schema}.${city}_road_net`;
    const { bbox } = req.query;

    let bboxClause = '';
    const params = [];
    if (bbox) {
      const parts = bbox.split(',').map(Number);
      if (parts.length === 4 && parts.every(n => !isNaN(n))) {
        const [minLon, minLat, maxLon, maxLat] = parts;
        params.push(minLon, minLat, maxLon, maxLat);
        // Use raw geom (SRID=0 but actually WGS84) for bbox filtering
        bboxClause = `AND geom && ST_MakeEnvelope($1, $2, $3, $4, 0)`;
      }
    }

    const sql = `
      SELECT
        gid AS fid,
        road_id,
        zone_no,
        zone_name,
        ward_no,
        ward_name,
        ownership,
        own_class,
        road_name,
        category,
        condition,
        material,
        material_c,
        row_meter,
        carriage_w,
        length_km,
        length_met,
        yoc,
        ST_AsGeoJSON(ST_SetSRID(geom, 4326))::json AS geometry
      FROM ${table}
      WHERE ${safeNum('row_meter')} >= 10
      ${bboxClause}
      LIMIT 2000
    `;

    const result = await pool.query(sql, params);

    const features = result.rows.map(row => {
      const { geometry, ...properties } = row;
      return {
        type: 'Feature',
        geometry,
        properties
      };
    });

    res.set('Cache-Control', 'no-store'); // Always fresh from DB
    res.json({ type: 'FeatureCollection', features });
  } catch (err) {
    console.error(`roads/above10m/geojson error for ${req.params.city}:`, err.message);
    res.status(500).json({ error: 'Failed to fetch road data' });
  }
});

/**
 * GET /api/:city/roads/click
 * Returns the single road closest to a click point (lon/lat, EPSG:4326).
 * Query params: lon, lat, buffer (degrees, default 0.0002)
 */
router.get('/:city/roads/click', async (req, res) => {
  try {
    const city = req.params.city.toLowerCase();
    const schema = citySchemaMap[city];
    if (!schema) return res.status(400).json({ error: `Unknown city: ${city}` });

    const table = `${schema}.${city}_road_net`;
    const lon = parseFloat(req.query.lon);
    const lat = parseFloat(req.query.lat);
    const buffer = parseFloat(req.query.buffer || 0.0002);

    if (isNaN(lon) || isNaN(lat)) {
      return res.status(400).json({ error: 'Missing or invalid lon/lat parameters' });
    }

    const sql = `
      SELECT
        gid AS fid,
        road_id,
        zone_no,
        zone_name,
        ward_no,
        ward_name,
        ownership,
        own_class,
        road_name,
        category,
        condition,
        material,
        material_c,
        row_meter,
        carriage_w,
        length_km,
        length_met,
        yoc,
        ST_AsGeoJSON(ST_SetSRID(geom, 4326))::json AS geometry,
        ST_Distance(
          ST_SetSRID(geom, 4326)::geography,
          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
        ) AS distance_m
      FROM ${table}
      WHERE geom && ST_MakeEnvelope($1 - $3, $2 - $3, $1 + $3, $2 + $3, 0)
      ORDER BY distance_m ASC
      LIMIT 1
    `;

    const result = await pool.query(sql, [lon, lat, buffer]);

    if (!result.rows.length) {
      return res.json({ type: 'FeatureCollection', features: [] });
    }

    const { geometry, distance_m, ...properties } = result.rows[0];
    const feature = { type: 'Feature', geometry, properties };
    res.set('Cache-Control', 'no-store');
    res.json({ type: 'FeatureCollection', features: [feature] });
  } catch (err) {
    console.error(`roads/click error for ${req.params.city}:`, err.message);
    res.status(500).json({ error: 'Failed to fetch road at click point' });
  }
});


// export const getZoneSummary = async (city) => {
//   const query = `
//     SELECT *
//     FROM lko_analysis.zone_development_summary_lnn
//     ORDER BY zone_name;
//   `;
//   const result = await pool.query(query);
//   return result.rows;
// };

export default router;
