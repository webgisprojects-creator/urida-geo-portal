// FallbackManager — runs an ordered list of "tiers" and returns the first
// one that produces a result, tagging the response with which tier
// actually served it (surfaced via the X-Fallback-Used header — see
// cacheHeaders.js).
//
// Each tier is `{ name, run: async () => Buffer|null }`. `run` should
// return `null`/`undefined` to mean "this tier has nothing, try the next
// one" and only throw for a genuinely unexpected error; a thrown error
// from a non-final tier is treated the same as `null` (logged, then the
// chain moves on) so one flaky tier can't take down every tier after it.
//
// Phase 1 scope: tiles.js's existing getRawTileBuffer/getMaskedTile/
// getGwcTileBuffer/getFilteredWmsTileBuffer already implement the
// fresh-cache / stale-cache / live-fetch / ancestor-fallback tiers inline
// (and correctly - this has been through real incident fixes, see the
// comments in tiles.js around the upstream circuit breaker and ancestor
// fallback). Rewriting those call sites to go through this generic runner
// is out of scope for a first wrap (hard rule: "do not rewrite the whole
// tile system blindly") - the value this module adds in Phase 1 is a
// reusable, testable `runChain` plus the one new, previously-missing tier
// this phase turns on: an explicit transparent-tile tier for total
// failures, gated behind CACHE_TRANSPARENT_FALLBACK_ENABLED (default off)
// so today's "502 on total upstream failure" behavior is unchanged unless
// an operator opts in. See tiles.js's use of `runChain` on the GWC and
// wms-filtered routes for the wiring.
const TRANSPARENT_TILE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAYAAABccqhmAAAACXBIWXMAAAPoAAAD6AG1e1JrAAABFUlEQVR4nO3BMQEAAADCoPVP7WsIoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA6AwBPAABo9vSmwAAAABJRU5ErkJggg==",
  "base64"
);

export function isTransparentFallbackEnabled() {
  return String(process.env.CACHE_TRANSPARENT_FALLBACK_ENABLED || "false").toLowerCase() === "true";
}

export class FallbackManager {
  // `tiers`: ordered array of { name, run }. The final tier is
  // conventionally a transparent-tile (or otherwise "never fails") tier so
  // the chain always resolves rather than throwing, but that's the
  // caller's choice, not enforced here.
  async runChain(tiers) {
    let lastError = null;
    for (const tier of tiers) {
      try {
        const result = await tier.run();
        if (result) return { buffer: result, tier: tier.name };
      } catch (err) {
        lastError = err;
        console.warn(`[fallbackManager] tier "${tier.name}" failed: ${err.message}`);
      }
    }
    if (lastError) throw lastError;
    return null;
  }

  // Convenience tier factory for the always-succeeds transparent-tile
  // bottom rung, honoring the opt-in gate above.
  transparentTileTier() {
    return {
      name: "transparent-tile",
      run: async () => (isTransparentFallbackEnabled() ? TRANSPARENT_TILE : null),
    };
  }
}

export const fallbackManager = new FallbackManager();

export { TRANSPARENT_TILE };
export default FallbackManager;
