
import { pool } from "../config/db.js";

async function addIndexes() {
  console.log("Starting index creation...");

  try {
    // Find all tables that look like road networks
    const res = await pool.query(`
      SELECT table_schema, table_name 
      FROM information_schema.tables 
      WHERE table_name LIKE '%_road_net' 
      AND table_schema NOT IN ('information_schema', 'pg_catalog')
    `);

    const tables = res.rows;
    console.log(`Found ${tables.length} road network tables.`);

    for (const { table_schema, table_name } of tables) {
      const fullTableName = `${table_schema}.${table_name}`;
      console.log(`Processing table: ${fullTableName}`);

      // List of columns to index
      const columns = [
        "zone_no",
        "ward_no",
        "condition",
        "category",
        "material",
        "ownership",
        "cus_class",
        "gis_id"
      ];

      for (const col of columns) {
        const indexName = `idx_${table_schema}_${table_name}_${col}`;
        try {
          // Check if column exists first to avoid errors
          const colCheck = await pool.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_schema = $1 AND table_name = $2 AND column_name = $3
          `, [table_schema, table_name, col]);

          if (colCheck.rowCount > 0) {
            console.log(`  Creating index on ${col}...`);
            await pool.query(`
              CREATE INDEX IF NOT EXISTS ${indexName} 
              ON ${fullTableName} (${col})
            `);
          } else {
            console.log(`  Skipping index on ${col} (column not found).`);
          }
        } catch (err) {
          console.error(`  Error creating index on ${col}:`, err.message);
        }
      }

      // Geometry index (GIST)
      try {
        const geomIndexName = `idx_${table_schema}_${table_name}_geom`;
        // Check if geom column exists (it might be named differently, e.g. wkb_geometry or geom)
        // Usually it's 'geom' in our app
        const geomCheck = await pool.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_schema = $1 AND table_name = $2 AND column_name = 'geom'
          `, [table_schema, table_name]);

        if (geomCheck.rowCount > 0) {
          console.log(`  Creating GIST index on geom...`);
          await pool.query(`
            CREATE INDEX IF NOT EXISTS ${geomIndexName} 
            ON ${fullTableName} USING GIST (geom)
            `);
        } else {
          // check for wkb_geometry
          const wkbCheck = await pool.query(`
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_schema = $1 AND table_name = $2 AND column_name = 'wkb_geometry'
            `, [table_schema, table_name]);
          if (wkbCheck.rowCount > 0) {
            console.log(`  Creating GIST index on wkb_geometry...`);
            await pool.query(`
                CREATE INDEX IF NOT EXISTS ${geomIndexName}_wkb 
                ON ${fullTableName} USING GIST (wkb_geometry)
                `);
          }
        }
      } catch (err) {
        console.error(`  Error creating geometry index:`, err.message);
      }
    }

    console.log("Index creation completed.");
  } catch (err) {
    console.error("Error running script:", err);
  } finally {
    await pool.end();
  }
}

addIndexes();
