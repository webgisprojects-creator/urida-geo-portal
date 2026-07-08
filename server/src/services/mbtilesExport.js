// Packages the on-disk raw tile cache (server/tile-cache/<style>/{z}/{x}/{y}.png)
// into one standard .mbtiles (SQLite) file per basemap style, under
// server/mbtiles/. Runs automatically after the cache-warmer's initial pass
// (see cacheWarmer.js) so a staging box that's been allowed internet access
// always has up-to-date, portable archives ready to hand-carry to the
// production server (scripts/restore-mbtiles.mjs is the other half).
//
// Re-export is skipped per style when the existing .mbtiles is already newer
// than every cached tile for that style — repeated server restarts don't
// rewrite multi-hundred-MB files for nothing.
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { STYLES } from "../routes/tiles.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_ROOT = path.join(__dirname, "..", "..", "tile-cache");
const DEFAULT_OUT_DIR = path.join(__dirname, "..", "..", "mbtiles");

const ATTRIBUTION = {
  osm: "© OpenStreetMap contributors",
  positron: "© CARTO, © OpenStreetMap contributors",
  toner: "© CARTO, © OpenStreetMap contributors",
  topo: "© OpenTopoMap, SRTM, © OpenStreetMap contributors",
  satellite: "Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
  labels: "Source: Esri",
};

// Walks CACHE_ROOT/<style>/<z>/<x>/<y>.png, yielding {z, x, y, filePath, mtimeMs}.
// Non-numeric directories (per-boundary masked derivatives nested under the
// style dir) are intentionally skipped — they're cheap to regenerate from
// these raw tiles and would bloat the archive with per-city duplicates.
function* walkTiles(style) {
  const styleDir = path.join(CACHE_ROOT, style);
  if (!fs.existsSync(styleDir)) return;
  for (const zDir of fs.readdirSync(styleDir, { withFileTypes: true })) {
    if (!zDir.isDirectory()) continue;
    const z = Number(zDir.name);
    if (!Number.isInteger(z)) continue;
    const zPath = path.join(styleDir, zDir.name);
    for (const xDir of fs.readdirSync(zPath, { withFileTypes: true })) {
      if (!xDir.isDirectory()) continue;
      const x = Number(xDir.name);
      if (!Number.isInteger(x)) continue;
      const xPath = path.join(zPath, xDir.name);
      for (const yFile of fs.readdirSync(xPath, { withFileTypes: true })) {
        if (!yFile.isFile() || !yFile.name.endsWith(".png")) continue;
        const y = Number(yFile.name.replace(/\.png$/, ""));
        if (!Number.isInteger(y)) continue;
        yield { z, x, y, filePath: path.join(xPath, yFile.name) };
      }
    }
  }
}

// True when the existing archive already covers every cached tile (no tile
// on disk is newer than the archive file itself).
function archiveIsCurrent(style, outPath) {
  const stat = fs.statSync(outPath, { throwIfNoEntry: false });
  if (!stat) return false;
  for (const t of walkTiles(style)) {
    const tileStat = fs.statSync(t.filePath, { throwIfNoEntry: false });
    if (tileStat && tileStat.mtimeMs > stat.mtimeMs) return false;
  }
  return true;
}

export function exportStyleToMbtiles(style, outDir = DEFAULT_OUT_DIR) {
  const outPath = path.join(outDir, `${style}.mbtiles`);
  if (archiveIsCurrent(style, outPath)) {
    return { style, skipped: true, outPath };
  }

  const tiles = [...walkTiles(style)];
  if (!tiles.length) {
    return { style, skipped: true, empty: true };
  }

  fs.mkdirSync(outDir, { recursive: true });
  // Build into a temp file and rename at the end, so a crash/restart mid-
  // export never leaves a truncated .mbtiles pretending to be a real one.
  const tmpPath = `${outPath}.tmp`;
  fs.rmSync(tmpPath, { force: true });

  const db = new Database(tmpPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE metadata (name TEXT, value TEXT);
    CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);
    CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);
  `);

  let minZoom = Infinity;
  let maxZoom = -Infinity;
  for (const t of tiles) {
    if (t.z < minZoom) minZoom = t.z;
    if (t.z > maxZoom) maxZoom = t.z;
  }

  const insertMeta = db.prepare("INSERT INTO metadata (name, value) VALUES (?, ?)");
  insertMeta.run("name", style);
  insertMeta.run("format", "png");
  insertMeta.run("type", "baselayer");
  insertMeta.run("version", "1.0.0");
  insertMeta.run("description", `${style} basemap cache, exported ${new Date().toISOString()}`);
  insertMeta.run("minzoom", String(minZoom));
  insertMeta.run("maxzoom", String(maxZoom));
  insertMeta.run("attribution", ATTRIBUTION[style] || style);

  // MBTiles uses TMS row numbering (Y flipped, origin at the bottom) while
  // the disk cache and every XYZ source in the app use origin-at-the-top —
  // this flip is the one detail that silently produces upside-down tiles
  // if skipped. scripts/restore-mbtiles.mjs applies the inverse.
  const insertTile = db.prepare(
    "INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)"
  );
  const insertMany = db.transaction((rows) => {
    for (const { z, x, y, filePath } of rows) {
      const tmsRow = Math.pow(2, z) - 1 - y;
      insertTile.run(z, x, tmsRow, fs.readFileSync(filePath));
    }
  });
  insertMany(tiles);
  db.close();

  fs.rmSync(outPath, { force: true });
  fs.renameSync(tmpPath, outPath);
  const sizeMb = fs.statSync(outPath).size / (1024 * 1024);
  return { style, tiles: tiles.length, minZoom, maxZoom, sizeMb, outPath };
}

export function exportAllMbtiles(outDir = DEFAULT_OUT_DIR) {
  const results = [];
  for (const style of Object.keys(STYLES)) {
    try {
      const result = exportStyleToMbtiles(style, outDir);
      results.push(result);
      if (result.skipped) {
        console.log(
          `[mbtiles] ${style}: ${result.empty ? "no cached tiles, skipped" : "archive current, skipped"}`
        );
      } else {
        console.log(
          `[mbtiles] ${style}: ${result.tiles} tiles (z${result.minZoom}-${result.maxZoom}) -> ${path.basename(result.outPath)} (${result.sizeMb.toFixed(1)} MB)`
        );
      }
    } catch (err) {
      console.error(`[mbtiles] ${style} export failed: ${err.message}`);
      results.push({ style, error: err.message });
    }
  }
  return results;
}
