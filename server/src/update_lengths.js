import 'dotenv/config';
import { pool } from "./config/db.js";
import { citySchemaMap, getRoadTable } from "./config/cityConfig.js";

async function updateLengths() {
  console.log("Starting spatial length pre-computation across all schemas...");
  const cities = Object.keys(citySchemaMap);
  
  for (const city of cities) {
    try {
      const table = getRoadTable(city);
      // Parse schema and table safely
      let schema, tblName;
      if (table.includes('.')) {
        [schema, tblName] = table.split('.');
      } else {
        schema = 'public';
        tblName = table;
      }
      
      // Determine geometry column Name
      const geomRes = await pool.query(`
        SELECT f_geometry_column 
        FROM geometry_columns 
        WHERE f_table_schema = $1 AND f_table_name = $2
      `, [schema, tblName]);
      
      if (geomRes.rowCount === 0) {
        console.warn(`[SKIP] No geometry column found for ${table}`);
        continue;
      }
      
      const geomCol = geomRes.rows[0].f_geometry_column || 'geom';
      
      console.log(`[UPDATE] Processing ${table} using geom column: ${geomCol}`);
      
      const updateSql = `
        UPDATE ${table} 
        SET length_km = ROUND((ST_Length(${geomCol}::geography)/1000)::numeric, 3) 
        WHERE length_km IS NULL OR length_km = 0;
      `;
      
      const res = await pool.query(updateSql);
      console.log(`[SUCCESS] ${table} - Updated ${res.rowCount} rows.`);
      
    } catch (err) {
      console.error(`[ERROR] Failed to update ${city}:`, err.message);
    }
  }
  
  console.log("Spatial pre-computation complete.");
  process.exit(0);
}

updateLengths();
