// src/services/cityService.js
import { pool } from '../config/db.js';
import { getWardTable, getZoneTable } from '../config/cityConfig.js';

export const getZoneSummary = async (city) => {
  try {
    const table = getZoneTable(city);
    // Use safe interpolation for table name (identifiers cannot be parameterized directly in pg)
    // But we validate city via config mapping, so it's relatively safe.
    const query = `SELECT * FROM ${table}`; 
    const result = await pool.query(query);
    return result.rows;
  } catch (error) {
    console.error(`Error in getZoneSummary for ${city}:`, error.message);
    throw error;
  }
};

export const getWardSummary = async (city) => {
  try {
    const table = getWardTable(city);
    const query = `SELECT * FROM ${table}`;
    const result = await pool.query(query);
    return result.rows;
  } catch (error) {
    console.error(`Error in getWardSummary for ${city}:`, error.message);
    throw error;
  }
};
