import { pool } from '../config/db.js';
import { citySchemaMap, getCityUtmEpsg, getCityOwnershipConfig } from '../config/cityConfig.js';

const roadTableCache = new Map();
const tableColumnsCache = new Map();

const MUNICIPAL_REGEX =
  "(nagar\\s*nigam|nagarnigam|nagar\\s*nigam\\s*nidhi|municipal\\s*corporation|municipal\\s*corp|\\mnn\\M|\\mn\\.?n\\.?\\M|\\m[a-z]{1,6}nn\\M)";
const MUNICIPAL_NORM_REGEX = '^(ann|bnn|gkpnn|jnn|knn|lnn|mvnn|snn|nn)$';

const ENCROACHMENT_NN_OWNERSHIP_CODE = {
  agra: 'ANN',
  lucknow: 'LNN',
};

const resolveColumn = (columnMap, candidates) => {
  for (const candidate of candidates) {
    const match = columnMap.get(candidate.toLowerCase());
    if (match) return match;
  }
  return null;
};

const quoteIdentifier = (value) => `"${String(value).replace(/"/g, '""')}"`;
const quoteLiteral = (value) => `'${String(value).replace(/'/g, "''")}'`;

const buildOwnershipClauseLiteral = (city, ownershipTextExpr, ownershipNormExpr) => {
  const config = getCityOwnershipConfig(city);
  if (!config) return 'TRUE';
  if (config.mode === 'values') {
    const values = (config.values || [])
      .map((v) => String(v || '').trim())
      .filter(Boolean)
      .map((v) => v.toLowerCase().replace(/[^a-z0-9]/g, ''));
    if (values.length === 0) return 'FALSE';
    const literals = values.map(quoteLiteral).join(', ');
    return `${ownershipNormExpr} IN (${literals})`;
  }
  if (config.mode === 'regex') {
    const clauses = [];
    if (config.normRegex) {
      clauses.push(`${ownershipNormExpr} ~* ${quoteLiteral(config.normRegex)}`);
    }
    if (config.regex) {
      clauses.push(`${ownershipTextExpr} ~* ${quoteLiteral(config.regex)}`);
    }
    if (clauses.length === 0) return 'TRUE';
    return `(${clauses.join(' OR ')})`;
  }
  return 'TRUE';
};

const getTableColumns = async (schema, table) => {
  const key = `${schema}.${table}`;
  if (tableColumnsCache.has(key)) return tableColumnsCache.get(key);
  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
    [schema, table]
  );
  const map = new Map(rows.map((r) => [r.column_name.toLowerCase(), r.column_name]));
  tableColumnsCache.set(key, map);
  return map;
};

const tableExists = async (schema, table) => {
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2 LIMIT 1`,
    [schema, table]
  );
  return rows.length > 0;
};

const ensureRefreshMetaTable = async (schema) => {
  const metaTable = `${quoteIdentifier(schema)}.${quoteIdentifier('mv_refresh_meta')}`;
  const metaSql = `
    CREATE TABLE IF NOT EXISTS ${metaTable} (
      view_name text PRIMARY KEY,
      last_refresh timestamptz NOT NULL
    )
  `;
  await pool.query(metaSql);
  return metaTable;
};

const resolveRoadTable = async (cityCode) => {
  const cityKey = String(cityCode || '').toLowerCase().trim();
  if (!cityKey) return null;
  if (roadTableCache.has(cityKey)) return roadTableCache.get(cityKey);

  const schema = citySchemaMap[cityKey];
  if (!schema) {
    roadTableCache.set(cityKey, null);
    return null;
  }

  const candidates = [
    `${cityKey}_road_net`,
    `${cityKey}_road_network`,
    `${cityKey}_road`,
    `road_net_${cityKey}`,
    `road_network_${cityKey}`,
    `road_${cityKey}`,
  ];

  for (const table of candidates) {
    if (await tableExists(schema, table)) {
      const resolved = { schema, table, qualified: `${schema}.${table}` };
      roadTableCache.set(cityKey, resolved);
      return resolved;
    }
  }

  const schemaMatch = await pool.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = $1
       AND table_type = 'BASE TABLE'
       AND table_name ILIKE $2
       AND table_name ILIKE '%road%'
     ORDER BY length(table_name) ASC
     LIMIT 1`,
    [schema, `%${cityKey}%`]
  );
  if (schemaMatch.rows[0]?.table_name) {
    const table = schemaMatch.rows[0].table_name;
    const resolved = { schema, table, qualified: `${schema}.${table}` };
    roadTableCache.set(cityKey, resolved);
    return resolved;
  }

  const columnFallback = await pool.query(
    `SELECT table_name
     FROM information_schema.columns
     WHERE table_schema = $1
     GROUP BY table_name
     HAVING
       bool_or(lower(column_name) IN ('road_id', 'gis_id'))
       AND bool_or(lower(column_name) IN ('geom', 'geometry', 'the_geom', 'wkb_geometry', 'geom_4326'))
     ORDER BY length(table_name) ASC
     LIMIT 1`,
    [schema]
  );
  if (columnFallback.rows[0]?.table_name) {
    const table = columnFallback.rows[0].table_name;
    const resolved = { schema, table, qualified: `${schema}.${table}` };
    roadTableCache.set(cityKey, resolved);
    return resolved;
  }

  const globalMatch = await pool.query(
    `SELECT table_schema, table_name
     FROM information_schema.tables
     WHERE table_type = 'BASE TABLE'
       AND table_name ILIKE $1
       AND table_name ILIKE '%road%'
     ORDER BY (table_schema = $2) DESC, length(table_name) ASC
     LIMIT 1`,
    [`%${cityKey}%`, schema]
  );
  if (globalMatch.rows[0]?.table_name) {
    const table = globalMatch.rows[0].table_name;
    const resolved = {
      schema: globalMatch.rows[0].table_schema,
      table,
      qualified: `${globalMatch.rows[0].table_schema}.${table}`,
    };
    roadTableCache.set(cityKey, resolved);
    return resolved;
  }

  roadTableCache.set(cityKey, null);
  return null;
};

async function getGeometryColumn(schema, table) {
  const q1 = `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = $1 AND table_name = $2 AND udt_name = 'geometry'
    LIMIT 1
  `;
  const r1 = await pool.query(q1, [schema, table]);
  if (r1.rows[0]?.column_name) return r1.rows[0].column_name;
  const q2 = `
    SELECT f_geometry_column
    FROM geometry_columns
    WHERE f_table_schema = $1 AND f_table_name = $2
    LIMIT 1
  `;
  const r2 = await pool.query(q2, [schema, table]);
  return r2.rows[0]?.f_geometry_column || 'geom';
}

async function getTableSRID(schema, table, geomCol) {
  const q1 = `SELECT srid FROM geometry_columns WHERE f_table_schema = $1 AND f_table_name = $2 AND f_geometry_column = $3`;
  try {
    const r1 = await pool.query(q1, [schema, table, geomCol]);
    if (r1.rows.length > 0) return r1.rows[0].srid;
  } catch {}
  const q2 = `SELECT ST_SRID(${geomCol}) as srid FROM ${schema}.${table} LIMIT 1`;
  try {
    const r2 = await pool.query(q2);
    return r2.rows[0]?.srid || 0;
  } catch {
    return 0;
  }
}

const ensureUnderdevelopedView = async (city, options = {}) => {
  const { refresh = false } = options;
  const cityKey = String(city || '').toLowerCase().trim();
  const roadInfo = await resolveRoadTable(cityKey);
  if (!roadInfo) {
    const err = new Error('Road table not found');
    err.status = 404;
    throw err;
  }
  const { schema, table } = roadInfo;
  const columns = await getTableColumns(schema, table);
  const roadIdCol = resolveColumn(columns, ['road_id', 'gis_id', 'gid', 'objectid', 'fid', 'roadid', 'id']);
  const ownershipCol = resolveColumn(columns, ['ownership', 'road_ownership', 'road_owner', 'road_own', 'owner']);
  const materialCol = resolveColumn(columns, [
    'material',
    'road_material',
    'surface',
    'road_surface',
    'surf_type',
    'surf',
    'surface_type',
    'surface_typ',
    'road_mat',
  ]);
  const conditionCol = resolveColumn(columns, ['condition', 'road_condition', 'cond', 'road_cond', 'roadcondition', 'condi']);
  const geomCol = await getGeometryColumn(schema, table);

  if (!roadIdCol || !ownershipCol || !materialCol || !conditionCol || !geomCol) {
    const err = new Error('Required columns not found in road table');
    err.status = 400;
    throw err;
  }

  const mvName = `mv_${cityKey}_underdeveloped_analysis`;
  const mvQualified = `${quoteIdentifier(schema)}.${quoteIdentifier(mvName)}`;
  const tableQualified = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;

  const ownershipExpr = quoteIdentifier(ownershipCol);
  const materialExpr = quoteIdentifier(materialCol);
  const conditionExpr = quoteIdentifier(conditionCol);
  const roadIdExpr = quoteIdentifier(roadIdCol);
  const geomExpr = quoteIdentifier(geomCol);

  const ownershipTextExpr = `COALESCE(${ownershipExpr}::text, '')`;
  const ownershipNormExpr = `regexp_replace(lower(${ownershipTextExpr}), '[^a-z0-9]', '', 'g')`;
  const materialTextExpr = `COALESCE(${materialExpr}::text, '')`;
  const conditionTextExpr = `COALESCE(${conditionExpr}::text, '')`;
  const materialNormExpr = `regexp_replace(lower(${materialTextExpr}), '[^a-z0-9]', '', 'g')`;
  const conditionNormExpr = `regexp_replace(lower(${conditionTextExpr}), '[^a-z0-9]', '', 'g')`;

  const isDevMaterial = `(${materialNormExpr} IN ('bitumen','cc','interlocking','cobalt') OR ${materialNormExpr} LIKE 'bitum%')`;
  const isBoe = `(${materialNormExpr} LIKE 'boe%')`;
  const isKachcha = `(${materialNormExpr} LIKE 'kach%')`;
  const isGood = `(${conditionNormExpr} LIKE 'good%')`;
  const isModerate = `(${conditionNormExpr} LIKE 'mod%')`;
  const isPoor = `(${conditionNormExpr} LIKE 'poor%')`;

  const classificationExpr = `CASE
    WHEN ${isDevMaterial} AND ${isGood} THEN 'Developed'
    WHEN (${isDevMaterial} AND (${isModerate} OR ${isPoor})) OR ${isBoe} THEN 'Underdeveloped'
    WHEN ${isKachcha} THEN 'Non-Developed'
    ELSE NULL
  END`;

  const ownershipClause = buildOwnershipClauseLiteral(cityKey, ownershipTextExpr, ownershipNormExpr);

  const tableSrid = await getTableSRID(schema, table, geomCol);
  let geomSelect = `ST_Force2D(${geomExpr})`;
  if (tableSrid && tableSrid > 0 && tableSrid !== 4326) {
    geomSelect = `ST_Transform(${geomExpr}, 4326)`;
  } else if (!tableSrid || tableSrid === 0) {
    const utmSrid = getCityUtmEpsg(cityKey);
    geomSelect = `ST_Transform(ST_SetSRID(${geomExpr}, ${utmSrid}), 4326)`;
  }

  const existsQ = `
    SELECT 1 FROM pg_matviews WHERE schemaname = $1 AND matviewname = $2
  `;
  const exists = await pool.query(existsQ, [schema, mvName]);

  if (exists.rowCount === 0) {
    const metaTable = await ensureRefreshMetaTable(schema);
    const createSql = `
      CREATE MATERIALIZED VIEW ${mvQualified} AS
      SELECT
        ${roadIdExpr} AS road_id,
        ${ownershipExpr} AS ownership,
        ${materialExpr} AS material,
        ${conditionExpr} AS condition,
        ${geomSelect} AS geom,
        ${classificationExpr} AS classification
      FROM ${tableQualified}
      WHERE ${ownershipClause}
        AND (${classificationExpr}) IS NOT NULL
    `;
    await pool.query(createSql);
    const indexName = `idx_${cityKey}_underdeveloped_geom`;
    const indexSql = `
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(indexName)} ON ${mvQualified} USING GIST(geom)
    `;
    await pool.query(indexSql);
    await pool.query(
      `INSERT INTO ${metaTable} (view_name, last_refresh)
       VALUES ($1, NOW())
       ON CONFLICT (view_name) DO UPDATE SET last_refresh = EXCLUDED.last_refresh`,
      [mvName]
    );
  } else if (refresh) {
    await pool.query(`REFRESH MATERIALIZED VIEW ${mvQualified}`);
    const metaTable = await ensureRefreshMetaTable(schema);
    await pool.query(
      `INSERT INTO ${metaTable} (view_name, last_refresh)
       VALUES ($1, NOW())
       ON CONFLICT (view_name) DO UPDATE SET last_refresh = EXCLUDED.last_refresh`,
      [mvName]
    );
  }

  return { schema, mvName, mvQualified };
};

const ensureStreetLightView = async (city) => {
  const cityKey = String(city || '').toLowerCase().trim();
  let roadInfo = await resolveRoadTable(cityKey);
  if (!roadInfo) {
    const schema = citySchemaMap[cityKey];
    if (schema) {
      const table = `${cityKey}_road_net`;
      if (await tableExists(schema, table)) {
        roadInfo = { schema, table, qualified: `${schema}.${table}` };
      }
    }
  }
  if (!roadInfo) {
    const exactTable = `${cityKey}_road_net`;
    const exactMatch = await pool.query(
      `SELECT table_schema, table_name
       FROM information_schema.tables
       WHERE table_type = 'BASE TABLE'
         AND table_name = $1
       LIMIT 1`,
      [exactTable]
    );
    if (exactMatch.rows[0]?.table_name) {
      const schema = exactMatch.rows[0].table_schema;
      const table = exactMatch.rows[0].table_name;
      roadInfo = { schema, table, qualified: `${schema}.${table}` };
    }
  }
  if (!roadInfo) {
    const err = new Error('Road table not found');
    err.status = 404;
    throw err;
  }

  const { schema: roadSchema, table: roadTable } = roadInfo;
  const roadGeomCol = await getGeometryColumn(roadSchema, roadTable);
  if (!roadGeomCol) {
    const err = new Error('Road geometry column not found');
    err.status = 500;
    throw err;
  }
  const columns = await getTableColumns(roadSchema, roadTable);
  const ownershipCol = resolveColumn(columns, ['ownership', 'road_ownership', 'road_owner', 'road_own', 'owner']);
  const streetLightCol = resolveColumn(columns, [
    'strt_slr_l',
    'street_light',
    'streetlight',
    'street_lights',
    'street_light_status',
    'strt_slr',
    'street_lit',
  ]);
  if (!streetLightCol) {
    const err = new Error('Street light column not found');
    err.status = 400;
    throw err;
  }

  const ownershipExpr = ownershipCol ? quoteIdentifier(ownershipCol) : 'NULL';
  const streetExpr = quoteIdentifier(streetLightCol);
  const ownershipTextExpr = `COALESCE(${ownershipExpr}::text, '')`;
  const ownershipNormExpr = `regexp_replace(lower(${ownershipTextExpr}), '[^a-z0-9]', '', 'g')`;
  const municipalMatch = `(${ownershipNormExpr} LIKE '%nagarnigam%' OR ${ownershipNormExpr} LIKE '%nagarnigamnidhi%' OR ${ownershipNormExpr} LIKE '%municipalcorporation%' OR ${ownershipNormExpr} LIKE '%municipalcorp%' OR ${ownershipNormExpr} ~* '${MUNICIPAL_NORM_REGEX}' OR ${ownershipTextExpr} ~* '${MUNICIPAL_REGEX}')`;

  const mvShort = `mv_${cityKey}_street_light`;
  const mvName = `${quoteIdentifier(roadSchema)}.${quoteIdentifier(mvShort)}`;
  const metaTable = await ensureRefreshMetaTable(roadSchema);
  const refreshAfterMs = Number(process.env.MV_REFRESH_AFTER_MS || 15 * 24 * 60 * 60 * 1000);

  const relRes = await pool.query(
    `
      SELECT c.relkind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2
      LIMIT 1
    `,
    [roadSchema, mvShort]
  );
  if (relRes.rowCount > 0 && relRes.rows[0]?.relkind !== 'm') {
    const err = new Error(`Relation ${mvShort} already exists but is not a materialized view`);
    err.status = 500;
    throw err;
  }

  const exists = relRes.rowCount > 0;

  if (!exists) {
    const typeRes = await pool.query(
      `
        SELECT 1
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = $1 AND t.typname = $2
        LIMIT 1
      `,
      [roadSchema, mvShort]
    );
    if (typeRes.rowCount > 0) {
      await pool.query(`DROP TYPE IF EXISTS ${quoteIdentifier(roadSchema)}.${quoteIdentifier(mvShort)} CASCADE`);
    }

    const createSql = `
      CREATE MATERIALIZED VIEW ${mvName} AS
      SELECT
        ${ownershipExpr} AS ownership,
        CASE
          WHEN ${streetExpr}::text = 'Yes' THEN 'ILLUMINATED'
          WHEN ${streetExpr}::text = 'No' THEN 'NON_ILLUMINATED'
          ELSE 'OTHERS'
        END AS illumination_status,
        ST_Transform(
          ST_Force2D(
            CASE
              WHEN ST_SRID(${quoteIdentifier(roadGeomCol)}) = 0 THEN ST_SetSRID(${quoteIdentifier(roadGeomCol)}, 4326)
              ELSE ${quoteIdentifier(roadGeomCol)}
            END
          ),
          4326
        ) AS geom
      FROM ${quoteIdentifier(roadSchema)}.${quoteIdentifier(roadTable)} r
      WHERE ${municipalMatch}
    `;
    await pool.query(createSql);
    await pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`idx_${cityKey}_street_light_status`)} ON ${mvName} (illumination_status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`idx_${cityKey}_street_light_owner`)} ON ${mvName} (ownership)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`idx_${cityKey}_street_light_geom`)} ON ${mvName} USING GIST(geom)`);
    await pool.query(
      `INSERT INTO ${metaTable} (view_name, last_refresh)
       VALUES ($1, NOW())
       ON CONFLICT (view_name) DO UPDATE SET last_refresh = EXCLUDED.last_refresh`,
      [mvShort]
    );
  } else {
    const metaRes = await pool.query(`SELECT last_refresh FROM ${metaTable} WHERE view_name = $1`, [mvShort]);
    const lastRefresh = metaRes.rows[0]?.last_refresh ? new Date(metaRes.rows[0].last_refresh) : null;
    const now = new Date();
    const needsRefresh = !lastRefresh || now.getTime() - lastRefresh.getTime() > refreshAfterMs;
    if (needsRefresh) {
      await pool.query(`REFRESH MATERIALIZED VIEW ${mvName}`);
      await pool.query(
        `INSERT INTO ${metaTable} (view_name, last_refresh)
         VALUES ($1, NOW())
         ON CONFLICT (view_name) DO UPDATE SET last_refresh = EXCLUDED.last_refresh`,
        [mvShort]
      );
    }
  }

  return { mvName, mvShort, roadSchema };
};

const ensureEncroachmentSummaryView = async (city, options = {}) => {
  const { refresh = false } = options;
  const cityKey = String(city || '').toLowerCase().trim();
  const ownershipCode = ENCROACHMENT_NN_OWNERSHIP_CODE[cityKey];
  if (!ownershipCode) {
    const err = new Error('Encroachment analysis is configured only for Nagar Nigam mapped cities');
    err.status = 400;
    throw err;
  }

  const roadInfo = await resolveRoadTable(cityKey);
  if (!roadInfo) {
    const err = new Error('Road table not found');
    err.status = 404;
    throw err;
  }

  const { schema, table } = roadInfo;
  const columns = await getTableColumns(schema, table);
  const roadIdCol = resolveColumn(columns, ['road_id', 'gis_id', 'gid', 'objectid', 'fid', 'roadid', 'id']);
  const zoneCol = resolveColumn(columns, ['zone_no', 'zone', 'zoneid', 'zone_id', 'z_no']);
  const ownershipCol = resolveColumn(columns, ['ownership', 'road_ownership', 'road_owner', 'road_own', 'owner']);
  const rowAprCol = resolveColumn(columns, ['row_apr', 'surveyed_row', 'row_surveyed', 'rowapr']);
  const rowMeterCol = resolveColumn(columns, ['row_meter', 'standard_row', 'row_std', 'rowmeter']);
  if (!roadIdCol || !zoneCol || !ownershipCol || !rowAprCol || !rowMeterCol) {
    const err = new Error('Required columns not found in road table');
    err.status = 400;
    throw err;
  }

  const mvName = `mv_${cityKey}_encroachment_summary`;
  const mvQualified = `${quoteIdentifier(schema)}.${quoteIdentifier(mvName)}`;
  const tableQualified = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
  const roadIdExpr = quoteIdentifier(roadIdCol);
  const zoneExpr = quoteIdentifier(zoneCol);
  const ownershipExpr = quoteIdentifier(ownershipCol);
  const rowAprExpr = quoteIdentifier(rowAprCol);
  const rowMeterExpr = quoteIdentifier(rowMeterCol);
  const ownershipCodeLiteral = quoteLiteral(ownershipCode);
  const ownershipFilter = `lower(trim(COALESCE(${ownershipExpr}::text, ''))) = lower(${ownershipCodeLiteral})`;
  const baseFilter = `${ownershipFilter}
    AND ${rowAprExpr} IS NOT NULL
    AND ${rowMeterExpr} IS NOT NULL`;
  const zoneTextExpr = `COALESCE(NULLIF(trim(${zoneExpr}::text), ''), 'UNKNOWN')`;

  const existsQ = `
    SELECT 1 FROM pg_matviews WHERE schemaname = $1 AND matviewname = $2
  `;
  const exists = await pool.query(existsQ, [schema, mvName]);

  if (exists.rowCount === 0) {
    const metaTable = await ensureRefreshMetaTable(schema);
    const createSql = `
      CREATE MATERIALIZED VIEW ${mvQualified} AS
      SELECT
        ${zoneTextExpr} AS zone_no,
        COUNT(DISTINCT ${roadIdExpr})::int AS total_roads,
        COUNT(DISTINCT CASE WHEN ${rowAprExpr} < ${rowMeterExpr} THEN ${roadIdExpr} END)::int AS encroached_roads,
        ROUND(
          CASE
            WHEN COUNT(DISTINCT ${roadIdExpr}) = 0 THEN 0
            ELSE (
              COUNT(DISTINCT CASE WHEN ${rowAprExpr} < ${rowMeterExpr} THEN ${roadIdExpr} END)::numeric
              * 100.0
            ) / COUNT(DISTINCT ${roadIdExpr})::numeric
          END,
          2
        )::numeric(10,2) AS encroachment_percentage
      FROM ${tableQualified}
      WHERE ${baseFilter}
      GROUP BY 1
    `;
    await pool.query(createSql);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`idx_${cityKey}_encroachment_zone`)} ON ${mvQualified} (zone_no)`
    );
    await pool.query(
      `INSERT INTO ${metaTable} (view_name, last_refresh)
       VALUES ($1, NOW())
       ON CONFLICT (view_name) DO UPDATE SET last_refresh = EXCLUDED.last_refresh`,
      [mvName]
    );
  } else if (refresh) {
    await pool.query(`REFRESH MATERIALIZED VIEW ${mvQualified}`);
    const metaTable = await ensureRefreshMetaTable(schema);
    await pool.query(
      `INSERT INTO ${metaTable} (view_name, last_refresh)
       VALUES ($1, NOW())
       ON CONFLICT (view_name) DO UPDATE SET last_refresh = EXCLUDED.last_refresh`,
      [mvName]
    );
  }

  return {
    schema,
    table,
    mvName,
    mvQualified,
    ownershipCode,
    zoneCol,
    ownershipCol,
    rowAprCol,
    rowMeterCol,
    ownershipFilter,
    zoneTextExpr,
  };
};

export const refreshUnderdevelopedAnalysis = async (req, res) => {
  try {
    const city = req.params.cityCode;
    await ensureUnderdevelopedView(city, { refresh: true });
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('underdeveloped-analysis refresh error:', err);
    res.status(err.status || 500).json({ error: 'Internal server error' });
  }
};

export const getUnderdevelopedAnalysis = async (req, res) => {
  try {
    const city = req.params.cityCode;
    const { mvQualified } = await ensureUnderdevelopedView(city, { refresh: false });
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
      FROM ${mvQualified} t
    `;
    const result = await pool.query(geojsonQ);
    res.json(result.rows[0]?.geojson || { type: 'FeatureCollection', features: [] });
  } catch (err) {
    console.error('underdeveloped-analysis error:', err);
    res.status(err.status || 500).json({ error: 'Internal server error' });
  }
};

export const getUnderdevelopedAnalysisCounts = async (req, res) => {
  try {
    const city = req.params.cityCode;
    const { mvQualified } = await ensureUnderdevelopedView(city, { refresh: false });
    const countsSql = `
      SELECT classification, COUNT(*)::int AS count
      FROM ${mvQualified}
      GROUP BY classification
    `;
    const result = await pool.query(countsSql);
    const payload = { developed: 0, underdeveloped: 0, nonDeveloped: 0, total: 0 };
    result.rows.forEach((row) => {
      const label = String(row.classification || '').toLowerCase();
      if (label === 'developed') payload.developed = row.count ?? 0;
      else if (label === 'underdeveloped') payload.underdeveloped = row.count ?? 0;
      else if (label === 'non-developed') payload.nonDeveloped = row.count ?? 0;
      payload.total += row.count ?? 0;
    });
    res.json(payload);
  } catch (err) {
    console.error('underdeveloped-analysis counts error:', err);
    res.status(err.status || 500).json({ error: 'Internal server error' });
  }
};

export const getStreetLightGeojson = async (req, res) => {
  try {
    const city = req.params.cityCode;
    const { mvName } = await ensureStreetLightView(city);
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
    res.json(result.rows[0]?.geojson || { type: 'FeatureCollection', features: [] });
  } catch (err) {
    console.error('street-light error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getStreetLightCounts = async (req, res) => {
  try {
    const city = req.params.cityCode;
    const { mvName } = await ensureStreetLightView(city);
    const countsSql = `
      SELECT illumination_status, COUNT(*)::int AS count
      FROM ${mvName}
      GROUP BY illumination_status
    `;
    const result = await pool.query(countsSql);
    const payload = { illuminated: 0, nonIlluminated: 0, others: 0, total: 0 };
    result.rows.forEach((row) => {
      const status = String(row.illumination_status || '').toUpperCase();
      if (status === 'ILLUMINATED') payload.illuminated = row.count ?? 0;
      else if (status === 'NON_ILLUMINATED') payload.nonIlluminated = row.count ?? 0;
      else payload.others += row.count ?? 0;
      payload.total += row.count ?? 0;
    });
    res.json(payload);
  } catch (err) {
    console.error('street-light counts error:', err);
    res.status(err.status || 500).json({ error: 'Internal server error' });
  }
};

export const refreshEncroachmentSummary = async (req, res) => {
  try {
    const city = req.params.cityCode;
    await ensureEncroachmentSummaryView(city, { refresh: true });
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('encroachment-analysis refresh error:', err);
    res.status(err.status || 500).json({ error: 'Internal server error' });
  }
};

export const getEncroachmentSummary = async (req, res) => {
  try {
    const city = req.params.cityCode;
    const { mvQualified, ownershipCode } = await ensureEncroachmentSummaryView(city, { refresh: false });
    const summarySql = `
      SELECT
        zone_no::text AS zone_no,
        total_roads::int AS total_roads,
        encroached_roads::int AS encroached_roads,
        encroachment_percentage::float AS encroachment_percentage
      FROM ${mvQualified}
      ORDER BY
        CASE WHEN zone_no ~ '^[0-9]+$' THEN 0 ELSE 1 END,
        CASE WHEN zone_no ~ '^[0-9]+$' THEN zone_no::int END,
        zone_no
    `;
    const result = await pool.query(summarySql);
    res.json({
      city: String(city || '').toLowerCase().trim(),
      ownership_code: ownershipCode,
      zones: result.rows || [],
    });
  } catch (err) {
    console.error('encroachment-analysis summary error:', err);
    res.status(err.status || 500).json({ error: 'Internal server error' });
  }
};

export const getEncroachmentGeojson = async (req, res) => {
  try {
    const city = req.params.cityCode;
    const {
      schema,
      table,
      ownershipCode,
      zoneCol,
      rowAprCol,
      rowMeterCol,
      ownershipFilter,
      zoneTextExpr,
    } = await ensureEncroachmentSummaryView(city, { refresh: false });

    const geomCol = await getGeometryColumn(schema, table);
    if (!geomCol) {
      const err = new Error('Road geometry column not found');
      err.status = 500;
      throw err;
    }
    const tableSrid = await getTableSRID(schema, table, geomCol);
    let geomSelect = `ST_Force2D(${quoteIdentifier(geomCol)})`;
    if (tableSrid && tableSrid > 0 && tableSrid !== 4326) {
      geomSelect = `ST_Transform(${quoteIdentifier(geomCol)}, 4326)`;
    } else if (!tableSrid || tableSrid === 0) {
      const utmSrid = getCityUtmEpsg(city);
      geomSelect = `ST_Transform(ST_SetSRID(${quoteIdentifier(geomCol)}, ${utmSrid}), 4326)`;
    }

    const query = `
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
      FROM (
        SELECT
          ${zoneTextExpr} AS zone_no,
          ${quoteIdentifier(rowAprCol)} AS row_apr,
          ${quoteIdentifier(rowMeterCol)} AS row_meter,
          ${quoteLiteral(ownershipCode)} AS ownership_code,
          ${geomSelect} AS geom
        FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)}
        WHERE ${ownershipFilter}
          AND ${quoteIdentifier(rowAprCol)} IS NOT NULL
          AND ${quoteIdentifier(rowMeterCol)} IS NOT NULL
          AND ${quoteIdentifier(rowAprCol)} < ${quoteIdentifier(rowMeterCol)}
      ) t
    `;
    const result = await pool.query(query);
    res.json(result.rows[0]?.geojson || { type: 'FeatureCollection', features: [] });
  } catch (err) {
    console.error('encroachment-analysis geojson error:', err);
    res.status(err.status || 500).json({ error: 'Internal server error' });
  }
};

export const getDssHealth = async (req, res) => {
  try {
    const city = req.params.cityCode;
    const cityKey = String(city || '').toLowerCase().trim();
    const roadInfo = await resolveRoadTable(cityKey);
    if (!roadInfo) {
      return res.status(404).json({ error: 'Road table not found' });
    }
    const schema = roadInfo.schema;
    const viewNames = {
      street_light: `mv_${cityKey}_street_light`,
      underdeveloped_analysis: `mv_${cityKey}_underdeveloped_analysis`,
      encroachment_summary: `mv_${cityKey}_encroachment_summary`,
    };
    const viewList = Object.values(viewNames);

    const { rows: mvRows } = await pool.query(
      `SELECT matviewname FROM pg_matviews WHERE schemaname = $1 AND matviewname = ANY($2)`,
      [schema, viewList]
    );
    const existing = new Set((mvRows || []).map((r) => r.matviewname));

    const metaReg = await pool.query(`SELECT to_regclass($1) AS reg`, [`${schema}.mv_refresh_meta`]);
    const hasMeta = !!metaReg.rows[0]?.reg;
    const refreshMap = new Map();
    if (hasMeta) {
      const metaTable = `${quoteIdentifier(schema)}.${quoteIdentifier('mv_refresh_meta')}`;
      const metaRows = await pool.query(
        `SELECT view_name, last_refresh FROM ${metaTable} WHERE view_name = ANY($1)`,
        [viewList]
      );
      (metaRows.rows || []).forEach((r) => {
        refreshMap.set(String(r.view_name), r.last_refresh ? new Date(r.last_refresh).toISOString() : null);
      });
    }

    const payload = {};
    Object.entries(viewNames).forEach(([key, name]) => {
      payload[key] = {
        name,
        exists: existing.has(name),
        last_refresh: refreshMap.get(name) || null,
      };
    });

    if (!ENCROACHMENT_NN_OWNERSHIP_CODE[cityKey]) {
      payload.encroachment_summary.supported = false;
    } else {
      payload.encroachment_summary.supported = true;
    }

    const ok = Object.values(payload).some((v) => v.exists);
    return res.json({
      city: cityKey,
      schema,
      ok,
      views: payload,
    });
  } catch (err) {
    console.error('dss health error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
