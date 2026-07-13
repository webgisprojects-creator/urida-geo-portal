// Access-policy check that must run *before* a cached file is served, per
// this phase's requirements. Built on top of cachePolicy.js's share-scope
// table and reuses the same city-authorization rules already enforced
// elsewhere in this app (server/src/utils/cityAccess.js's
// authorizeCityAccess) rather than inventing a second notion of "who can
// see what".
//
// Phase 1 scope: every route this wraps today (basemap, clipped-basemap,
// gwc, wms-filtered, boundary-geojson) already grants any authenticated
// user access regardless of city (verifyToken is the only gate currently
// in tiles.js/wfsCache.js) - there is no existing per-user/private tile
// family in production yet. So for those share scopes this check is
// intentionally a no-op ALLOW: it does not add a new restriction on top
// of today's behavior (hard rule: "do not remove existing working cache
// behavior" cuts both ways - it also means don't quietly add a new one
// that could break a currently-working view). The teeth are in the
// `user`/`none` scopes, wired up now so a future private/temp/
// getfeatureinfo cache family (not yet implemented) has a real check to
// plug into instead of retrofitting one later.
import crypto from "crypto";
import { getShareScope } from "./cachePolicy.js";

function normalize(value) {
  return String(value || "").toLowerCase().trim();
}

export function computeAccessPolicyHash({ shareScope, city, layerName, ownerUserId }) {
  const normalized = JSON.stringify({
    shareScope: shareScope || "",
    city: normalize(city),
    layerName: layerName || "",
    ownerUserId: shareScope === "user" ? ownerUserId || "" : "",
  });
  return crypto.createHash("sha1").update(normalized).digest("hex").slice(0, 16);
}

// Returns { allowed: boolean, reason?: string }. Never throws.
export function checkAccess(req, { family, city, ownerUserId } = {}) {
  const shareScope = getShareScope(family);

  switch (shareScope) {
    case "global":
    case "layer":
    case "filter":
    case "boundary":
    case "bbox-filter":
      // Reuse-dimension only, not an access restriction beyond "this
      // route is already behind verifyToken" — matches current
      // production behavior for basemap/gwc/wms-filtered/clipped-basemap/
      // wfs-bbox.
      return { allowed: true };

    case "city": {
      // boundary-geojson: any authenticated user may currently fetch any
      // known layer's boundary geometry (used for admin cross-city views,
      // the state-wide boundary, etc.) - same no-op-allow reasoning as
      // above. City is recorded for indexing/observability even though it
      // isn't enforced here yet.
      return { allowed: true, city };
    }

    case "user": {
      // JWT payload shape (server/src/controllers/authController.js) is
      // `{ user_id, username, role, city, ... }` — there is no `id` field.
      const requesterId = String(req?.user?.user_id || req?.user?.username || "");
      if (!requesterId) return { allowed: false, reason: "No authenticated user" };
      const role = normalize(req?.user?.role);
      if (role === "admin") return { allowed: true };
      if (!ownerUserId || requesterId === String(ownerUserId)) return { allowed: true };
      return { allowed: false, reason: "Cached entry belongs to a different user" };
    }

    case "none":
    default:
      return { allowed: false, reason: `No sharing permitted for family "${family}"` };
  }
}

export default { computeAccessPolicyHash, checkAccess };
