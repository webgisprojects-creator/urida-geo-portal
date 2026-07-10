// SQLite-backed cache index for the Smart Shared Cache Delivery Engine.
//
// This is the single source of truth for "what's on disk, how big is it,
// when was it last used" — replacing the old recursive/spread-based
// walkFiles() approach in tiles.js (which threw "Maximum call stack size
// exceeded" once the cache grew past ~1.3M files: `results.push(...(await
// walkFiles(full)))` spreads an ever-growing array as call arguments,
// which V8 caps well below that count). Every query here is an indexed
// SQL lookup instead of a full directory walk, so eviction and stats never
// need to touch the filesystem tree itself.
//
// Multi-process note: PM2 runs this app in cluster mode (one process per
// CPU core - deploy/ecosystem.config.js), and every worker opens this same
// on-disk .sqlite file. WAL mode + a busy_timeout lets concurrent
// readers/writers across processes coexist without manual locking; this is
// the standard, supported way to share one better-sqlite3 file across
// processes.
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_ROOT = path.join(__dirname, "..", "..", "tile-cache");
const DB_PATH = path.join(CACHE_ROOT, "cache-index.sqlite");

let db = null;

function getDb() {
  if (db) return db;
  fs.mkdirSync(CACHE_ROOT, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS cache_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cache_key TEXT NOT NULL,
      cache_key_hash TEXT NOT NULL UNIQUE,
      family TEXT NOT NULL,
      share_scope TEXT,
      owner_user_id TEXT,
      city TEXT,
      layer_name TEXT,
      style_name TEXT,
      boundary_layer TEXT,
      cql_normalized TEXT,
      cql_hash TEXT,
      style_hash TEXT,
      boundary_hash TEXT,
      z INTEGER,
      x INTEGER,
      y INTEGER,
      file_path TEXT NOT NULL UNIQUE,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      data_version TEXT,
      access_policy_hash TEXT,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      last_accessed_at INTEGER NOT NULL,
      expires_at INTEGER,
      hit_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE INDEX IF NOT EXISTS idx_cache_entries_family ON cache_entries(family, status);
    CREATE INDEX IF NOT EXISTS idx_cache_entries_family_lru ON cache_entries(family, status, last_accessed_at);
    CREATE INDEX IF NOT EXISTS idx_cache_entries_path ON cache_entries(file_path);

    -- Performance-hardening pass: cache_key_hash already has an implicit
    -- unique index from its column constraint (O(1) point lookup) —
    -- these are the additional composite indexes requested for eviction/
    -- reporting/future-access-audit query shapes, none of which are on the
    -- request hot path (that path derives file_path directly from the
    -- request params and does a single fs.stat — see tiles.js's
    -- tileCachePath/gwcTileCachePath/etc — so it never needs any of these).
    CREATE INDEX IF NOT EXISTS idx_cache_entries_family_city_layer_zxy
      ON cache_entries(family, city, layer_name, z, x, y);
    CREATE INDEX IF NOT EXISTS idx_cache_entries_family_expires
      ON cache_entries(family, expires_at);
    CREATE INDEX IF NOT EXISTS idx_cache_entries_family_lru_hits
      ON cache_entries(family, last_accessed_at, hit_count);
    CREATE INDEX IF NOT EXISTS idx_cache_entries_status
      ON cache_entries(status);
    CREATE INDEX IF NOT EXISTS idx_cache_entries_access_policy_hash
      ON cache_entries(access_policy_hash);

    CREATE TABLE IF NOT EXISTS cache_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  return db;
}

function nowMs() {
  return Date.now();
}

function metaGet(key) {
  const row = getDb().prepare("SELECT value FROM cache_meta WHERE key = ?").get(key);
  return row ? row.value : null;
}

function metaSet(key, value) {
  getDb()
    .prepare(
      `INSERT INTO cache_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(key, String(value));
}

// ---------------------------------------------------------------------
// Write path: called at the moment a tile/response is written to disk
// (fetchAndCacheTile, getMaskedTile, fetchAndCacheGwcTile,
// fetchAndCacheFilteredWmsTile, fetchBoundaryGeoJson, road-wfs-cache) with
// everything cacheKey.js computed for that request. Upserts by file_path
// so re-fetching the same tile (TTL expiry, GWC refresh) updates the
// existing row instead of accumulating duplicates.
//
// Complexity: O(1) — a single indexed upsert keyed on the file_path UNIQUE
// constraint, on the MISS path only (a HIT never reaches recordWrite; see
// touchAccess below). This is the "plus upstream/render time" half of the
// documented MISS-path complexity target.
// ---------------------------------------------------------------------
const upsertStmt = () =>
  getDb().prepare(`
    INSERT INTO cache_entries (
      cache_key, cache_key_hash, family, share_scope, owner_user_id, city,
      layer_name, style_name, boundary_layer, cql_normalized, cql_hash,
      style_hash, boundary_hash, z, x, y, file_path, size_bytes,
      data_version, access_policy_hash, created_by, created_at,
      last_accessed_at, expires_at, hit_count, status
    ) VALUES (
      @cacheKey, @cacheKeyHash, @family, @shareScope, @ownerUserId, @city,
      @layerName, @styleName, @boundaryLayer, @cqlNormalized, @cqlHash,
      @styleHash, @boundaryHash, @z, @x, @y, @filePath, @sizeBytes,
      @dataVersion, @accessPolicyHash, @createdBy, @createdAt,
      @lastAccessedAt, @expiresAt, 0, @status
    )
    ON CONFLICT(file_path) DO UPDATE SET
      cache_key = excluded.cache_key,
      cache_key_hash = excluded.cache_key_hash,
      size_bytes = excluded.size_bytes,
      data_version = excluded.data_version,
      access_policy_hash = excluded.access_policy_hash,
      last_accessed_at = excluded.last_accessed_at,
      expires_at = excluded.expires_at,
      status = excluded.status
  `);

export function recordWrite(entry) {
  const params = {
    cacheKey: entry.cacheKey || "",
    cacheKeyHash: entry.cacheKeyHash || "",
    family: entry.family || "unknown",
    shareScope: entry.shareScope || null,
    ownerUserId: entry.ownerUserId || null,
    city: entry.city || null,
    layerName: entry.layerName || null,
    styleName: entry.styleName || null,
    boundaryLayer: entry.boundaryLayer || null,
    cqlNormalized: entry.cqlNormalized || null,
    cqlHash: entry.cqlHash || null,
    styleHash: entry.styleHash || null,
    boundaryHash: entry.boundaryHash || null,
    z: Number.isFinite(entry.z) ? entry.z : null,
    x: Number.isFinite(entry.x) ? entry.x : null,
    y: Number.isFinite(entry.y) ? entry.y : null,
    filePath: entry.filePath,
    // 0 for a hardlinked empty-tile row (see emptyTile.js) — it shares an
    // inode with the family's one canonical empty file, so it costs no
    // marginal disk space and must not be double-counted toward the
    // family's cap.
    sizeBytes: entry.sizeBytes || 0,
    dataVersion: entry.dataVersion || null,
    accessPolicyHash: entry.accessPolicyHash || null,
    createdBy: entry.createdBy || null,
    createdAt: nowMs(),
    lastAccessedAt: nowMs(),
    expiresAt: entry.expiresAt || null,
    status: entry.status || "active",
  };
  try {
    upsertStmt().run(params);
  } catch (err) {
    // Index bookkeeping must never break a real tile response — the file
    // on disk is the actual cache; the index is a management layer on top.
    console.error("[cacheIndex] recordWrite failed:", err.message);
  }
}

// ---------------------------------------------------------------------
// Hit accounting — batched, not synchronous-per-request.
//
// touchAccess() is called on every single cache HIT (the overwhelmingly
// common case once the cache is warm), so it must be O(1) *and* must not
// put a SQLite write on the request's critical path — a per-request
// UPDATE was the one place Phase 1 still did synchronous-ish I/O on every
// HIT. Now it's a plain in-memory Map increment; a timer (or a size
// safety-valve, see HIT_FLUSH_MAX_ENTRIES) periodically flushes the whole
// batch as a single transaction. Reads (getEntryByPath, family stats,
// eviction candidate selection) are unaffected in correctness — they may
// briefly see a slightly stale hit_count/last_accessed_at (bounded by the
// flush interval), which is fine for LRU eviction ordering and completely
// fine for metrics.
// ---------------------------------------------------------------------
const hitAccumulator = new Map(); // file_path -> { hits, lastAccessedAt }
const HIT_FLUSH_INTERVAL_MS = Number(process.env.CACHE_HIT_FLUSH_INTERVAL_MS) > 0
  ? Number(process.env.CACHE_HIT_FLUSH_INTERVAL_MS)
  : 10000;
// Safety valve, not a normal code path: bounds the accumulator's memory
// under pathological key diversity (e.g. a burst of distinct z/x/y hits
// across many layers within one flush window) by flushing early rather
// than letting the Map grow without bound between timer ticks.
const HIT_FLUSH_MAX_ENTRIES = Number(process.env.CACHE_HIT_FLUSH_MAX_ENTRIES) > 0
  ? Number(process.env.CACHE_HIT_FLUSH_MAX_ENTRIES)
  : 5000;

export function touchAccess(filePath) {
  // O(1): a Map get+set, no I/O, no lock contention with other workers.
  const now = nowMs();
  const existing = hitAccumulator.get(filePath);
  if (existing) {
    existing.hits += 1;
    existing.lastAccessedAt = now;
  } else {
    hitAccumulator.set(filePath, { hits: 1, lastAccessedAt: now });
  }
  if (hitAccumulator.size >= HIT_FLUSH_MAX_ENTRIES) flushHitAccumulator();
}

// O(number of distinct files touched since the last flush), run inside a
// single SQLite transaction — never O(total cache size). Safe to call from
// the timer, the size safety-valve above, or on graceful shutdown.
export function flushHitAccumulator() {
  if (hitAccumulator.size === 0) return;
  const entries = Array.from(hitAccumulator.entries());
  hitAccumulator.clear();
  try {
    const stmt = getDb().prepare(
      `UPDATE cache_entries SET hit_count = hit_count + ?, last_accessed_at = ? WHERE file_path = ?`
    );
    const applyBatch = getDb().transaction((rows) => {
      for (const [filePath, data] of rows) stmt.run(data.hits, data.lastAccessedAt, filePath);
    });
    applyBatch(entries);
  } catch (err) {
    console.error("[cacheIndex] flushHitAccumulator failed:", err.message);
  }
}

// Diagnostics-only — lets the health report/endpoint surface that this Map
// stays small and bounded rather than growing across the process lifetime.
export function getHitAccumulatorStats() {
  return { pendingKeys: hitAccumulator.size, maxEntries: HIT_FLUSH_MAX_ENTRIES, flushIntervalMs: HIT_FLUSH_INTERVAL_MS };
}

let hitFlushTimer = null;

// Runs in every PM2 worker (unlike the eviction schedule/backfill, which
// are singleton-worker-only) — each worker accumulates hits for the
// requests it personally served, so each worker must flush its own batch.
export function startHitAccumulatorFlushSchedule() {
  hitFlushTimer = setInterval(flushHitAccumulator, HIT_FLUSH_INTERVAL_MS);
}

export function stopHitAccumulatorFlushSchedule() {
  if (hitFlushTimer) clearInterval(hitFlushTimer);
  hitFlushTimer = null;
  flushHitAccumulator(); // don't lose the last <flush-interval> of hits on shutdown/reload
}

export function getEntryByPath(filePath) {
  try {
    return getDb().prepare("SELECT * FROM cache_entries WHERE file_path = ?").get(filePath) || null;
  } catch (err) {
    console.error("[cacheIndex] getEntryByPath failed:", err.message);
    return null;
  }
}

// Complexity: O(1) from the caller's perspective — an indexed aggregate
// query (idx_cache_entries_family covers family+status) that SQLite
// answers by scanning only that family's index range, not the whole
// table and never the filesystem. Called once per family per eviction
// sweep/diagnostics call (O(number of families), never O(number of files)).
export function getFamilyStats(family) {
  try {
    const row = getDb()
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS totalBytes
         FROM cache_entries WHERE family = ? AND status = 'active'`
      )
      .get(family);
    return { count: row.count, totalBytes: row.totalBytes };
  } catch (err) {
    console.error("[cacheIndex] getFamilyStats failed:", err.message);
    return { count: 0, totalBytes: 0 };
  }
}

export function getOverallStats() {
  try {
    const row = getDb()
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS totalBytes
         FROM cache_entries WHERE status = 'active'`
      )
      .get();
    return { count: row.count, totalBytes: row.totalBytes };
  } catch (err) {
    console.error("[cacheIndex] getOverallStats failed:", err.message);
    return { count: 0, totalBytes: 0 };
  }
}

// ---------------------------------------------------------------------
// Indexed batch eviction. Selects the oldest-accessed rows for a family
// (or overall) directly via an indexed ORDER BY — no directory walk, no
// full file list in memory, no recursion. Capped at `limit` (default 500)
// per call; the scheduler below calls this repeatedly (short interval)
// while a family is over cap and falls back to the long interval once it
// isn't, so a single call never has to do more than one bounded batch of
// disk I/O.
//
// Complexity: O(log N + K) — idx_cache_entries_family_lru (family, status,
// last_accessed_at) lets SQLite walk straight to the oldest rows for this
// family via a B-tree seek + ordered scan, stopping at K=`limit` rows; it
// never scans, sorts, or loads the family's full row set (N), let alone
// the whole cache_entries table.
// ---------------------------------------------------------------------
export function selectEvictionBatch(family, limit = 500) {
  try {
    return getDb()
      .prepare(
        `SELECT id, file_path, size_bytes FROM cache_entries
         WHERE family = ? AND status = 'active'
         ORDER BY last_accessed_at ASC
         LIMIT ?`
      )
      .all(family, limit);
  } catch (err) {
    console.error("[cacheIndex] selectEvictionBatch failed:", err.message);
    return [];
  }
}

export async function deleteEntries(rows) {
  if (!rows.length) return;
  const ids = rows.map((r) => r.id);
  for (const row of rows) {
    try {
      await fs.promises.unlink(row.file_path);
    } catch {
      // already gone / race with another worker — fine, still drop the row
    }
  }
  try {
    const placeholders = ids.map(() => "?").join(",");
    getDb().prepare(`DELETE FROM cache_entries WHERE id IN (${placeholders})`).run(...ids);
  } catch (err) {
    console.error("[cacheIndex] deleteEntries failed:", err.message);
  }
}

// Hardening pass (post-incident — see cachePolicy.js's isEvictionConfirmed/
// isEvictionForced/isEvictionDryRun comments): this now ALWAYS logs the
// planned deletion (count + bytes) the moment a family is found over cap,
// before any of the confirm/dry-run/force gates are even checked, so the
// intent is visible in logs regardless of whether anything actually gets
// deleted this run.
async function runOneFamilyEvictionBatch(family, capBytes, batchSize, { confirmed, forced, dryRun }) {
  const { totalBytes } = getFamilyStats(family);
  if (totalBytes <= capBytes) {
    return { family, overCap: false, plannedCount: 0, plannedBytes: 0, deleted: 0, stillOverCap: false, skippedReason: null };
  }

  const batch = selectEvictionBatch(family, batchSize);
  const plannedBytes = batch.reduce((sum, row) => sum + (row.size_bytes || 0), 0);

  console.warn(
    `[cacheIndex] eviction plan: family="${family}" over cap ` +
    `(${(totalBytes / 1024 / 1024 / 1024).toFixed(2)}G used vs ${(capBytes / 1024 / 1024 / 1024).toFixed(2)}G cap) — ` +
    `would delete ${batch.length} file(s) / ${(plannedBytes / 1024 / 1024).toFixed(1)}MB this batch`
  );

  if (!confirmed) {
    console.warn(`[cacheIndex] eviction skipped for "${family}": CACHE_EVICTION_CONFIRM is not true`);
    return { family, overCap: true, plannedCount: batch.length, plannedBytes, deleted: 0, stillOverCap: true, skippedReason: "not_confirmed" };
  }
  if (dryRun) {
    console.warn(`[cacheIndex] eviction dry-run for "${family}": no files deleted (CACHE_EVICTION_DRY_RUN=true)`);
    return { family, overCap: true, plannedCount: batch.length, plannedBytes, deleted: 0, stillOverCap: true, skippedReason: "dry_run" };
  }
  if (!forced) {
    console.warn(`[cacheIndex] eviction refused for "${family}": over cap but CACHE_EVICTION_FORCE is not true — no files deleted`);
    return { family, overCap: true, plannedCount: batch.length, plannedBytes, deleted: 0, stillOverCap: true, skippedReason: "not_forced" };
  }
  if (!batch.length) {
    return { family, overCap: true, plannedCount: 0, plannedBytes: 0, deleted: 0, stillOverCap: false, skippedReason: null };
  }

  await deleteEntries(batch);
  const after = getFamilyStats(family);
  console.log(`[cacheIndex] eviction executed for "${family}": deleted ${batch.length} file(s) / ${(plannedBytes / 1024 / 1024).toFixed(1)}MB`);
  return {
    family,
    overCap: true,
    plannedCount: batch.length,
    plannedBytes,
    deleted: batch.length,
    stillOverCap: after.totalBytes > capBytes,
    skippedReason: null,
  };
}

// ---------------------------------------------------------------------
// Iterative (non-recursive) disk backfill — indexes files that predate
// this engine (the ~43G / ~1.39M files already on disk) so the eviction
// sweep above actually knows about the whole cache, not just entries
// written after this deploy. Explicit stack instead of recursive
// walkFiles()/spread — this is precisely what avoided the crash: paths
// are pushed into flat batches and flushed with plain `for` loops, never
// `push(...bigArray)`. Yields to the event loop between batches so a
// ~1.39M-file backfill never blocks a request for more than a few ms at a
// time, and runs once (tracked via cache_meta) so it doesn't re-walk the
// tree on every restart.
const BACKFILL_BATCH_SIZE = 500;

export function isBackfillComplete() {
  return metaGet("backfill_complete") === "1";
}

export async function backfillFromDisk({ onProgress } = {}) {
  if (isBackfillComplete()) return { skipped: true };

  const insertIfMissing = getDb().prepare(`
    INSERT INTO cache_entries (
      cache_key, cache_key_hash, family, share_scope, file_path, size_bytes,
      created_at, last_accessed_at, hit_count, status
    ) VALUES (@cacheKey, @cacheKeyHash, @family, @shareScope, @filePath, @sizeBytes,
      @createdAt, @lastAccessedAt, 0, 'active')
    ON CONFLICT(file_path) DO NOTHING
  `);
  const insertBatch = getDb().transaction((rows) => {
    for (const row of rows) insertIfMissing.run(row);
  });

  function familyFromRelativePath(relPath) {
    // tile-cache/<style>/... (basemap) | tile-cache/<style>/<boundaryKey>/...
    // (clipped-basemap, when the 2nd segment isn't a numeric zoom level) |
    // tile-cache/gwc/<layer>/... | tile-cache/wms-filtered/<layer>/<hash>/...
    const segments = relPath.split(path.sep);
    const first = segments[0];
    if (first === "gwc") return "gwc";
    if (first === "wms-filtered") return "wms-filtered";
    const secondIsZoom = /^\d+$/.test(segments[1] || "");
    return secondIsZoom ? "basemap" : "clipped-basemap";
  }

  let indexed = 0;
  let batch = [];
  const stack = [CACHE_ROOT];

  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirEntry of entries) {
      const full = path.join(dir, dirEntry.name);
      if (dirEntry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!dirEntry.isFile() || dirEntry.name.endsWith(".sqlite") || dirEntry.name.includes("cache-index.sqlite")) {
        continue;
      }
      const stat = await fs.promises.stat(full).catch(() => null);
      if (!stat) continue;
      const relPath = path.relative(CACHE_ROOT, full);
      const family = familyFromRelativePath(relPath);
      batch.push({
        cacheKey: `backfill/${relPath}`,
        cacheKeyHash: relPath,
        family,
        shareScope: family === "clipped-basemap" ? "boundary" : family === "gwc" ? "layer" : "global",
        filePath: full,
        sizeBytes: stat.size,
        createdAt: Math.round(stat.mtimeMs),
        lastAccessedAt: Math.round(stat.mtimeMs),
      });
      if (batch.length >= BACKFILL_BATCH_SIZE) {
        insertBatch(batch);
        indexed += batch.length;
        batch = [];
        if (onProgress) onProgress(indexed);
        // Yield to the event loop between batches — this is what keeps a
        // ~1.39M-file backfill from blocking real tile requests.
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
  }
  if (batch.length) {
    insertBatch(batch);
    indexed += batch.length;
  }

  metaSet("backfill_complete", "1");
  metaSet("backfill_completed_at", String(nowMs()));
  metaSet("backfill_indexed_count", String(indexed));
  console.log(`[cacheIndex] backfill complete: indexed ${indexed} pre-existing cache files`);
  return { skipped: false, indexed };
}

// ---------------------------------------------------------------------
// Scheduling. Mirrors the existing hourly-sweep shape in tiles.js/
// wfsCache.js, but adapts: if a family is found over its cap, re-check it
// again soon (short interval) instead of waiting a full hour, so real
// overshoot converges quickly without ever doing more than one
// `CACHE_EVICTION_BATCH_SIZE`-sized batch of file deletions per tick.
// ---------------------------------------------------------------------
import {
  getFamilyCapBytes,
  getEvictionBatchSize,
  isEvictionEnabled,
  isEvictionConfirmed,
  isEvictionForced,
  isEvictionDryRun,
} from "./cachePolicy.js";

const FAMILIES = ["basemap", "clipped-basemap", "gwc", "wms-filtered", "boundary-geojson", "wfs-bbox"];
const NORMAL_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly, same cadence as before
const CATCHUP_SWEEP_DELAY_MS = 15 * 1000; // re-check soon if still over cap

let sweepTimer = null;
let lastEvictionResult = null;

// "Never delete if cache index appears incomplete" — the index is only as
// trustworthy as the backfill that populated it. A sweep running against a
// partially-backfilled index would see a fraction of a family's real
// on-disk footprint and could wrongly conclude it's under cap (or over,
// depending on what happened to be indexed so far), either of which is an
// unsafe basis for deleting anything. Blocks on the same completeness flag
// backfillFromDisk() sets once it's fully walked the tree.
function isIndexTrustworthy() {
  if (!isBackfillComplete()) return { ok: false, reason: "backfill_not_complete" };
  const overall = getOverallStats();
  if (overall.count <= 0) return { ok: false, reason: "index_empty" };
  return { ok: true, reason: null };
}

export async function runIndexedEvictionSweep() {
  const enabled = isEvictionEnabled();
  const confirmed = isEvictionConfirmed();
  const forced = isEvictionForced();
  const dryRun = isEvictionDryRun();
  const ranAt = nowMs();

  if (!enabled) {
    lastEvictionResult = { ranAt, enabled, confirmed, forced, dryRun, skipped: "disabled", families: [] };
    return { evicted: 0, stillOverCap: false };
  }

  const trust = isIndexTrustworthy();
  if (!trust.ok) {
    console.warn(`[cacheIndex] eviction sweep skipped: cache index is not trustworthy yet (${trust.reason}) — refusing to delete`);
    lastEvictionResult = { ranAt, enabled, confirmed, forced, dryRun, skipped: trust.reason, families: [] };
    return { evicted: 0, stillOverCap: false };
  }

  const batchSize = getEvictionBatchSize();
  let evicted = 0;
  let stillOverCap = false;
  const familyResults = [];
  for (const family of FAMILIES) {
    try {
      const result = await runOneFamilyEvictionBatch(family, getFamilyCapBytes(family), batchSize, {
        confirmed,
        forced,
        dryRun,
      });
      familyResults.push(result);
      evicted += result.deleted;
      stillOverCap = stillOverCap || result.stillOverCap;
    } catch (err) {
      // One family's eviction failing must never take down the others,
      // nor crash the scheduler loop (this is exactly the failure mode
      // this module replaces).
      console.error(`[cacheIndex] eviction sweep failed for family "${family}":`, err.message);
      familyResults.push({ family, error: err.message });
    }
  }
  if (evicted > 0) {
    console.log(`[cacheIndex] eviction sweep: removed ${evicted} file(s) across all families`);
  }
  lastEvictionResult = { ranAt, enabled, confirmed, forced, dryRun, skipped: null, families: familyResults };
  return { evicted, stillOverCap };
}

export function getLastEvictionResult() {
  return lastEvictionResult;
}

export function getEvictionConfigSnapshot() {
  return {
    enabled: isEvictionEnabled(),
    confirmed: isEvictionConfirmed(),
    forced: isEvictionForced(),
    dryRun: isEvictionDryRun(),
    batchSize: getEvictionBatchSize(),
    familyCapsBytes: Object.fromEntries(FAMILIES.map((f) => [f, getFamilyCapBytes(f)])),
  };
}

export function startIndexedEvictionSchedule() {
  const tick = async () => {
    const { stillOverCap } = await runIndexedEvictionSweep();
    sweepTimer = setTimeout(tick, stillOverCap ? CATCHUP_SWEEP_DELAY_MS : NORMAL_SWEEP_INTERVAL_MS);
  };
  sweepTimer = setTimeout(tick, NORMAL_SWEEP_INTERVAL_MS);
}

export function stopIndexedEvictionSchedule() {
  if (sweepTimer) clearTimeout(sweepTimer);
  sweepTimer = null;
}

export function getDbPathForDiagnostics() {
  return DB_PATH;
}

// ---------------------------------------------------------------------
// Health checks — all read-only, all safe to call on demand (diagnostics
// endpoint/script below), none of them touch the request path.
// ---------------------------------------------------------------------

// Deterministic modulo sample (not ORDER BY RANDOM(), which forces a full
// table sort on 1.4M+ rows) — cheap linear scan of the rowid index,
// verifies a spread-out subset's files still exist on disk. A high missing
// ratio suggests the index has drifted from reality (files deleted outside
// this engine, a moved cache root, etc.) and is a signal to re-run backfill
// rather than trust eviction decisions.
async function sampleMissingFiles(sampleSize = 2000) {
  let rows;
  try {
    rows = getDb()
      .prepare(`SELECT id, file_path FROM cache_entries WHERE id % 700 = 0 LIMIT ?`)
      .all(sampleSize);
  } catch (err) {
    return { sampled: 0, missing: 0, missingRatio: 0, error: err.message };
  }
  let missing = 0;
  await Promise.all(
    rows.map(async (row) => {
      const exists = await fs.promises
        .stat(row.file_path)
        .then(() => true)
        .catch(() => false);
      if (!exists) missing += 1;
    })
  );
  return { sampled: rows.length, missing, missingRatio: rows.length ? missing / rows.length : 0 };
}

// Full disk walk purely to COUNT files (no stat beyond directory entries,
// no inserts) — same iterative-stack shape as backfillFromDisk, so it
// shares the same non-recursive safety property. This is genuinely
// expensive (comparable cost to the original backfill, ~15-60s across
// 1.4M files) so it is NEVER run automatically; getIndexHealthReport only
// runs it when explicitly asked via `includeUnindexedEstimate: true`.
async function countFilesOnDisk() {
  let count = 0;
  const stack = [CACHE_ROOT];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && !entry.name.includes("cache-index.sqlite")) {
        count += 1;
      }
    }
    // Yield periodically — this walk is diagnostics-only but must never
    // block real traffic any more than the backfill itself does.
    if (count % 50000 === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  return count;
}

export async function getIndexHealthReport({ includeUnindexedEstimate = false, missingSampleSize = 2000 } = {}) {
  const overall = getOverallStats();
  const families = FAMILIES.map((f) => ({ family: f, ...getFamilyStats(f) }));
  const statusCounts = getDb().prepare(`SELECT status, COUNT(*) AS count FROM cache_entries GROUP BY status`).all();
  const lastIndexedRow = getDb()
    .prepare(`SELECT MAX(created_at) AS lastCreatedAt, MAX(last_accessed_at) AS lastAccessedAt FROM cache_entries`)
    .get();
  const missingFileSample = await sampleMissingFiles(missingSampleSize);

  let unindexedEstimate = null;
  if (includeUnindexedEstimate) {
    const diskCount = await countFilesOnDisk();
    unindexedEstimate = Math.max(0, diskCount - overall.count);
  }

  return {
    totalIndexedRows: overall.count,
    totalIndexedBytes: overall.totalBytes,
    families,
    statusCounts,
    missingFileSample,
    unindexedEstimate, // null unless includeUnindexedEstimate was requested
    lastIndexedAt: lastIndexedRow?.lastCreatedAt || null,
    lastAccessedAt: lastIndexedRow?.lastAccessedAt || null,
    backfillComplete: isBackfillComplete(),
    backfillCompletedAt: metaGet("backfill_completed_at"),
    backfillIndexedCount: metaGet("backfill_indexed_count"),
    indexTrustworthy: isIndexTrustworthy(),
  };
}

export default {
  recordWrite,
  touchAccess,
  flushHitAccumulator,
  getHitAccumulatorStats,
  startHitAccumulatorFlushSchedule,
  stopHitAccumulatorFlushSchedule,
  getEntryByPath,
  getFamilyStats,
  getOverallStats,
  selectEvictionBatch,
  deleteEntries,
  backfillFromDisk,
  isBackfillComplete,
  runIndexedEvictionSweep,
  getLastEvictionResult,
  getEvictionConfigSnapshot,
  startIndexedEvictionSchedule,
  stopIndexedEvictionSchedule,
  getDbPathForDiagnostics,
  getIndexHealthReport,
};
