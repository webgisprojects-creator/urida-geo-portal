// src/mapDelivery/layerHealth.js
// Tiny non-invasive source health helper for later gradual wiring.
// It is intentionally unused in Phase 2A-1 unless a caller opts in.

export function attachTileHealth(source, { layerName = "Layer", layerType = "unknown", onError } = {}) {
  if (!source?.on || source.__tileHealthAttached) return () => {};
  source.__tileHealthAttached = true;

  const state = {
    layerName,
    layerType,
    loading: 0,
    loaded: 0,
    errors: 0,
  };

  const start = () => {
    state.loading += 1;
  };

  const end = () => {
    state.loading = Math.max(0, state.loading - 1);
    state.loaded += 1;
  };

  const error = (event) => {
    state.loading = Math.max(0, state.loading - 1);
    state.errors += 1;
    if (typeof onError === "function") {
      onError({ ...state, event });
    }
  };

  source.on("tileloadstart", start);
  source.on("tileloadend", end);
  source.on("tileloaderror", error);

  return () => {
    source.un?.("tileloadstart", start);
    source.un?.("tileloadend", end);
    source.un?.("tileloaderror", error);
  };
}
