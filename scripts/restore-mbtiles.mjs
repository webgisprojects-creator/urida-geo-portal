// The other half of scripts/build-mbtiles.mjs: unpacks one or more .mbtiles
// files back into the server's on-disk raw tile cache
// (server/tile-cache/<style>/{z}/{x}/{y}.png), so a production server can be
// bootstrapped from a staging-warmed cache without ever hitting the upstream
// CDNs itself. The live serving code (server/src/routes/tiles.js) needs no
// changes - it just finds the files already on disk and treats them as
// cache hits.
//
// Usage: node scripts/restore-mbtiles.mjs [mbtilesDir]
//   mbtilesDir defaults to server/mbtiles - every *.mbtiles file in it is
//   restored, named after its basename (osm.mbtiles -> tile-cache/osm/...).
//
// Existing tiles on disk are left alone (skip, not overwrite) so a restore
// never clobbers tiles the server has since fetched fresh.
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_ROOT = path.join(__dirname, "..", "server", "tile-cache");
const IN_DIR = process.argv[2] || path.join(__dirname, "..", "server", "mbtiles");

function restore(mbtilesPath) {
  const style = path.basename(mbtilesPath, ".mbtiles");
  const db = new Database(mbtilesPath, { readonly: true });

  const total = db.prepare("SELECT COUNT(*) AS c FROM tiles").get().c;
  let written = 0;
  let skipped = 0;

  const rows = db.prepare(
    "SELECT zoom_level AS z, tile_column AS x, tile_row AS tmsRow, tile_data AS data FROM tiles"
  ).iterate();

  for (const row of rows) {
    // Undo the MBTiles TMS row flip (see build-mbtiles.mjs) back to the
    // standard XYZ scheme the disk cache uses.
    const y = Math.pow(2, row.z) - 1 - row.tmsRow;
    const filePath = path.join(CACHE_ROOT, style, String(row.z), String(row.x), `${y}.png`);
    if (fs.existsSync(filePath)) {
      skipped += 1;
      continue;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, row.data);
    written += 1;
  }

  db.close();
  console.log(`[${style}] restored ${written} tiles, skipped ${skipped} already present (${total} in archive)`);
}

if (!fs.existsSync(IN_DIR)) {
  console.error(`No such directory: ${IN_DIR}`);
  process.exit(1);
}
const files = fs.readdirSync(IN_DIR).filter((f) => f.endsWith(".mbtiles"));
if (!files.length) {
  console.log(`No .mbtiles files found in ${IN_DIR}`);
  process.exit(0);
}
console.log(`Restoring ${files.length} archive(s) from ${IN_DIR} into ${CACHE_ROOT}`);
for (const f of files) {
  restore(path.join(IN_DIR, f));
}
