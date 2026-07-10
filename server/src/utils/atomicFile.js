import fs from "fs";
import path from "path";
import crypto from "crypto";

// Writes `data` to `filePath` without ever leaving a truncated/partial file
// visible at that path. Writes to a uniquely-named sibling temp file first,
// then renames into place — rename() is atomic on the same filesystem, so a
// reader either sees the old file (if any) or the fully-written new one,
// never an in-between state.
//
// This is the actual mechanism behind the 2026-07-10 outage: plain
// fs.promises.writeFile opens its target with O_TRUNC before writing, so a
// write that fails partway through (disk full, process killed, etc.) still
// leaves a 0-byte file sitting at the real path — and every cache-hit check
// in tiles.js/wfsCache.js only checked `stat` truthiness, so that 0-byte
// file was read back as a valid, permanent cache hit. scripts/build-mbtiles.mjs
// already used this same temp+rename pattern for exactly this reason; this
// just makes it a shared helper instead of one-off per call site.
export async function atomicWriteFile(filePath, data) {
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`
  );
  try {
    await fs.promises.writeFile(tmpPath, data);
    await fs.promises.rename(tmpPath, filePath);
  } catch (err) {
    await fs.promises.unlink(tmpPath).catch(() => {});
    throw err;
  }
}
