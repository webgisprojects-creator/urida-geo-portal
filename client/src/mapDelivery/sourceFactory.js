// src/mapDelivery/sourceFactory.js
// OpenLayers source factories for frontend smart tile delivery.
// Behavior intentionally mirrors the original MapContainer.jsx helper block.

import XYZ from "ol/source/XYZ";
import TileWMS from "ol/source/TileWMS";

import {
  getCachedTileUrl,
  applyTileTemplate,
  getWorkspaceFromLayerName,
  stripEmptyWmsParams,
  getGwcCachedTileUrl,
  getFilteredWmsCachedTileUrl,
} from "./cacheUrls";

export const makeCachedXyzSource = ({
  style,
  fallbackUrl,
  attributions,
  maxZoom,
  boundary,
  transition = 0,
  cacheSize,
}) =>
  new XYZ({
    url: getCachedTileUrl(style, boundary),
    ...(cacheSize ? { cacheSize } : {}),
    transition,
    crossOrigin: "anonymous",
    attributions,
    maxZoom,
    tileLoadFunction: (tile, src) => {
      const image = tile.getImage();
      let triedFallback = false;
      image.crossOrigin = "anonymous";
      image.onerror = () => {
        if (triedFallback || !fallbackUrl) return;
        triedFallback = true;
        const coord = tile.getTileCoord?.();
        if (!coord) return;
        const [z, x, y] = coord;
        image.src = applyTileTemplate(fallbackUrl, z, x, -y - 1);
      };
      image.src = src;
    },
  });

export const getWorkspaceWmsUrl = (geoserverBase, gwcWms, workspace, cacheable = false) => {
  if (cacheable) return gwcWms;
  return workspace ? `${geoserverBase}/${workspace}/wms` : `${geoserverBase}/wms`;
};

export const makeTileWmsSource = ({
  layerName,
  workspace,
  cacheable = true,
  params = {},
  geoserverBase,
  gwcWms,
}) => {
  const source = new TileWMS({
    url: getWorkspaceWmsUrl(
      geoserverBase,
      gwcWms,
      workspace || getWorkspaceFromLayerName(layerName),
      cacheable
    ),
    params: stripEmptyWmsParams({
      LAYERS: layerName,
      TILED: true,
      FORMAT: "image/png",
      TRANSPARENT: true,
      // Must stay 1.1.1: GeoServer GWC endpoint expects SRS, not CRS.
      VERSION: "1.1.1",
      ...params,
    }),
    serverType: "geoserver",
    transition: 0,
    crossOrigin: "anonymous",
    hidpi: !cacheable,
    tileLoadFunction: !cacheable
      ? undefined
      : (tile, src) => {
          const image = tile.getImage();
          image.crossOrigin = "anonymous";

          const liveParams = source.getParams();
          const cqlFilter = liveParams?.CQL_FILTER;
          const hasSldBody = !!liveParams?.SLD_BODY;
          const coord = tile.getTileCoord?.();

          // SLD_BODY remains direct to GeoServer exactly as before.
          if (hasSldBody || !coord) {
            image.src = src;
            return;
          }

          const [z, x, y] = coord;
          let triedFallback = false;
          image.onerror = () => {
            if (triedFallback) return;
            triedFallback = true;
            image.src = src;
          };

          image.src = cqlFilter
            ? getFilteredWmsCachedTileUrl(layerName, cqlFilter, liveParams?.STYLES, z, x, y)
            : getGwcCachedTileUrl(layerName, z, x, y);
        },
  });

  return source;
};

export const setWmsSourceUrl = (source, url) => {
  if (!source || source.getUrls?.()?.[0] === url) return;
  if (source.setUrl) {
    source.setUrl(url);
  } else if (source.setUrls) {
    source.setUrls([url]);
  }
};

export const updateWmsParams = (source, nextParams) => {
  const params = source?.getParams?.();
  if (!params || !source?.updateParams) return;

  Object.entries(nextParams).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") {
      delete params[key];
    } else {
      params[key] = value;
    }
  });

  source.updateParams({ _t: Date.now() });
};

export const applyCqlToTileLayer = (
  layer,
  filter,
  workspace,
  { geoserverBase, gwcWms } = {}
) => {
  const source = layer?.getSource?.();
  if (!source) return;

  const useLiveWms = !!filter;
  setWmsSourceUrl(source, getWorkspaceWmsUrl(geoserverBase, gwcWms, workspace, !useLiveWms));
  updateWmsParams(source, { CQL_FILTER: filter || null, _t: useLiveWms ? Date.now() : null });
};
