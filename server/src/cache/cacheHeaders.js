// Applies the Smart Shared Cache Delivery Engine's diagnostic headers to a
// response. Purely additive — every route already sets its own
// Cache-Control/X-Cache headers (existing, load-bearing behavior for
// Nginx's proxy_cache and the browser); this module only adds new
// `X-` headers alongside them, never replaces an existing header, and
// never changes status code or body.
//
// info: {
//   nodeCache: "HIT" | "MISS" | "STALE" | "FALLBACK",
//   family: string,
//   shareScope: string,
//   keyHash: string,
//   fallbackUsed?: string,   // tier name from fallbackManager, omitted if none
//   loadMs: number,
//   accessPolicyHash?: string,
// }
export function applyCacheHeaders(res, info) {
  if (!info) return;
  if (info.nodeCache) res.set("X-Node-Cache", String(info.nodeCache));
  if (info.family) res.set("X-Cache-Family", String(info.family));
  if (info.shareScope) res.set("X-Cache-Share-Scope", String(info.shareScope));
  if (info.keyHash) res.set("X-Cache-Key-Hash", String(info.keyHash));
  if (info.fallbackUsed) res.set("X-Fallback-Used", String(info.fallbackUsed));
  if (Number.isFinite(info.loadMs)) res.set("X-Tile-Load-Ms", String(Math.round(info.loadMs)));
  if (info.accessPolicyHash) res.set("X-Access-Policy-Hash", String(info.accessPolicyHash));
}

// Small helper for route handlers: wraps a `meta` object's contents (as
// already populated by tiles.js's own cacheHit/isFallback conventions)
// into the extended header shape above.
export function nodeCacheStateFromMeta(meta) {
  if (!meta) return "MISS";
  if (meta.isFallback) return "FALLBACK";
  if (meta.cacheHit === "stale") return "STALE";
  if (meta.cacheHit === true) return "HIT";
  return "MISS";
}

export default { applyCacheHeaders, nodeCacheStateFromMeta };
