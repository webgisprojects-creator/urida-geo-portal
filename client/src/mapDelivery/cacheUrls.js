// src/mapDelivery/cacheUrls.js
// Shared URL/key helpers for frontend tile delivery.
// Extracted from MapContainer.jsx without changing URL behavior.

export const TILE_CACHE_BASE = (process.env.REACT_APP_TILE_CACHE_BASE || "").replace(/\/$/, "");

export const getCachedTileUrl = (style, boundary) =>
  `${TILE_CACHE_BASE}/api/tiles/${style}/{z}/{x}/{y}.png` +
  (boundary ? `?boundary=${encodeURIComponent(boundary)}` : "");

export const applyTileTemplate = (template, z, x, y) =>
  template.replace("{z}", z).replace("{x}", x).replace("{y}", y);

export const getWorkspaceFromLayerName = (layerName, fallbackWorkspace = "") => {
  if (typeof layerName === "string" && layerName.includes(":")) {
    return layerName.split(":")[0];
  }
  return fallbackWorkspace;
};

export const stripEmptyWmsParams = (params) => {
  Object.keys(params).forEach((key) => {
    if (params[key] === undefined || params[key] === null || params[key] === "") {
      delete params[key];
    }
  });
  return params;
};

export const getGwcCachedTileUrl = (layerName, z, x, y) =>
  `${TILE_CACHE_BASE}/api/gwc-tiles/${encodeURIComponent(layerName)}/${z}/${x}/${y}.png`;

export const getFilteredWmsCachedTileUrl = (layerName, cqlFilter, styles, z, x, y) =>
  `${TILE_CACHE_BASE}/api/wms-tile-cache/${encodeURIComponent(layerName)}/${z}/${x}/${y}.png` +
  `?cqlFilter=${encodeURIComponent(cqlFilter || "")}&styles=${encodeURIComponent(styles || "")}`;
