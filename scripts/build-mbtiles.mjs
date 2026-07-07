// Thin CLI wrapper around the server's own MBTiles exporter — the same
// export also runs automatically after the cache-warmer's initial pass on
// server startup (server/src/services/cacheWarmer.js), so this script is
// only needed to re-package on demand without restarting the server.
//
// Usage: node scripts/build-mbtiles.mjs [outputDir]
// Restore on the target server with: node scripts/restore-mbtiles.mjs
import { exportAllMbtiles } from "../server/src/services/mbtilesExport.js";

exportAllMbtiles(process.argv[2] || undefined);
