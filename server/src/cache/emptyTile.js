// Empty/transparent-tile disk-space optimization (hardening pass).
//
// GeoServer legitimately answers "no features here" for large chunks of a
// sparse layer's extent (e.g. Road Network only exists inside built-up
// areas) with a fully-transparent PNG, `transparent=true` was requested.
// Storing each of those as its own file is a real, avoidable disk-space
// cost — but naively "serve one shared PNG for status='empty' rows" would
// require the read path (getGwcTileBuffer/getFilteredWmsTileBuffer in
// tiles.js) to consult the SQLite index before every file read, which is
// exactly the kind of extra hop we do NOT want on the request hot path.
//
// Instead: hard-link the per-tile path to one canonical empty-tile file per
// family. A hard link is a second directory entry pointing at the same
// inode/data blocks — it costs a few dozen bytes of directory metadata,
// not a duplicate copy of the PNG — while the per-tile path still resolves
// completely normally for fs.stat/fs.readFile, so tiles.js's read path
// needs zero changes and zero added lookups. Eviction is also unaffected:
// unlinking one hardlinked path only removes that directory entry: the
// canonical file and every other tile hardlinked to it are untouched
// (standard POSIX hardlink semantics), so a family's LRU eviction keeps
// working exactly as before even for these rows.
//
// Detection is conservative on purpose: only a decoded, fully-transparent
// (alpha channel max === 0) small PNG qualifies. An upstream error page,
// a 502, or genuine (non-transparent) imagery never qualifies — this must
// never be the mechanism that quietly caches a failure as if it were valid
// no-data.
import fs from "fs";
import path from "path";
import sharp from "sharp";

const CANDIDATE_MAX_BYTES = Number(process.env.CACHE_EMPTY_TILE_MAX_BYTES) > 0
  ? Number(process.env.CACHE_EMPTY_TILE_MAX_BYTES)
  : 2048;

export function isEmptyTileDedupEnabled() {
  return String(process.env.CACHE_EMPTY_TILE_DEDUP_ENABLED ?? "true").toLowerCase() !== "false";
}

// Memoizes "does the shared file for this family root already exist" so
// repeated detections don't re-stat it every time — safe to keep in memory
// since the shared file, once written, is never rewritten.
const sharedFileReady = new Set();

async function ensureSharedEmptyFile(familyRoot, buffer) {
  if (sharedFileReady.has(familyRoot)) return path.join(familyRoot, "_shared_empty_tile.png");
  const sharedPath = path.join(familyRoot, "_shared_empty_tile.png");
  const exists = await fs.promises.stat(sharedPath).catch(() => null);
  if (!exists) {
    await fs.promises.mkdir(familyRoot, { recursive: true });
    await fs.promises.writeFile(sharedPath, buffer);
  }
  sharedFileReady.add(familyRoot);
  return sharedPath;
}

// Returns true if `buffer` was stored as a hardlink to the family's shared
// empty-tile file at `filePath` (caller must skip its own fs.writeFile in
// this case). Returns false if the buffer isn't a confirmed-empty tile —
// caller must write it normally.
export async function tryStoreEmptyTile({ buffer, filePath, familyRoot }) {
  if (!isEmptyTileDedupEnabled()) return false;
  if (!buffer || buffer.length > CANDIDATE_MAX_BYTES) return false;

  let isFullyTransparent = false;
  try {
    const { channels } = await sharp(buffer).stats();
    const alpha = channels[3];
    isFullyTransparent = Boolean(alpha) && alpha.max === 0;
  } catch {
    // Not a decodable PNG (e.g. some other format, or corrupt bytes) —
    // never guess; treat as a normal tile.
    return false;
  }
  if (!isFullyTransparent) return false;

  const sharedPath = await ensureSharedEmptyFile(familyRoot, buffer);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.promises.link(sharedPath, filePath);
  } catch (err) {
    if (err.code === "EEXIST") return true; // a concurrent request already linked it — fine
    if (err.code === "EXDEV") {
      // Cross-device link (tile-cache spans multiple mounts) — fall back
      // to a normal write so the tile is never silently dropped.
      await fs.promises.writeFile(filePath, buffer);
      return false;
    }
    console.error("[emptyTile] hardlink failed, falling back to normal write:", err.message);
    await fs.promises.writeFile(filePath, buffer);
    return false;
  }
  return true;
}

export default { isEmptyTileDedupEnabled, tryStoreEmptyTile };
