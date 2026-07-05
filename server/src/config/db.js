import pkg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const { Pool } = pkg;

const dbPort = Number(process.env.DB_PORT || 5432);
const dbConnTimeout = Number(process.env.DB_CONN_TIMEOUT || 5000);
const dbIdleTimeout = Number(process.env.DB_IDLE_TIMEOUT || 30000);
const dbPoolMax = Number(process.env.DB_POOL_MAX || 20);
const dbUseSsl = String(process.env.DB_SSL || "").toLowerCase() === "true";
const dbSslRejectUnauthorized = String(process.env.DB_SSL_REJECT_UNAUTHORIZED || "").toLowerCase() === "true";

export const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number.isFinite(dbPort) ? dbPort : 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  max: Number.isFinite(dbPoolMax) ? dbPoolMax : 20,
  idleTimeoutMillis: Number.isFinite(dbIdleTimeout) ? dbIdleTimeout : 30000,
  connectionTimeoutMillis: Number.isFinite(dbConnTimeout) ? dbConnTimeout : 5000,
  keepAlive: true,
  ssl: dbUseSsl ? { rejectUnauthorized: dbSslRejectUnauthorized } : undefined,
});

pool.connect()
  .then((client) => {
    console.log('✅ Connected to PostgreSQL');
    client.release();
  })
  .catch(err => console.error('❌ Database connection error:', err));

pool.on("error", (err) => {
  console.error("❌ Unexpected PG pool error:", err);
});
