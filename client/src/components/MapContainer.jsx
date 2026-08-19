// src/components/MapContainer.jsx
/* OpenLayers map engine: base layers, WMS/WFS overlays, popups, drawing, legend, analysis layers. */
import React, { useEffect, useRef, useState, forwardRef, useImperativeHandle, useMemo, useCallback } from "react";
import { createPortal } from "react-dom";
import "ol/ol.css";

import OLMap from "ol/Map";
import View from "ol/View";
import TileLayer from "ol/layer/Tile";
import ImageLayer from "ol/layer/Image";
import VectorLayer from "ol/layer/Vector";
import LayerGroup from "ol/layer/Group";
import { fromLonLat, toLonLat } from "ol/proj";
import TileWMS from "ol/source/TileWMS";
import ImageWMS from "ol/source/ImageWMS";
import VectorSource from "ol/source/Vector";
import GeoJSON from "ol/format/GeoJSON";
import Feature from "ol/Feature";
import { getCenter, buffer as bufferExtent, getWidth, getHeight, createEmpty, extend, intersects as extentsIntersect } from "ol/extent";
import { defaults as defaultControls } from "ol/control";
import { Style, Stroke, Fill, Circle as CircleStyle, Icon } from "ol/style";
import Point from "ol/geom/Point";
import GeometryCollection from "ol/geom/GeometryCollection";
import { bbox as bboxStrategy, all as allStrategy } from "ol/loadingstrategy";
import { attachInvertedMask, extractClipRings } from "../utils/mapClip";
import { attachBasemapErrorNotifier } from "../utils/basemapHealth";
import { attachMapLoadingTracker } from "../utils/mapLoadingTracker";
import { getIsLowBandwidth } from "../utils/networkStatus";
import MapNavigation from "./MapNavigation"; // ⭐ NEW: Google Maps style navigation suite
import TextStyle from "ol/style/Text";//chainage
import { chainageCityConfig } from "../assets/configs/chainageCityConfig";//chainage
import { useLocation } from "react-router-dom";//chainage

// Import Icons
import bankIcon from "../assets/Amenities_Icons/bank_1.png";
import busIcon from "../assets/Amenities_Icons/bus.png";
import graveyardIcon from "../assets/Amenities_Icons/graveyard.png";
import hospitalIcon from "../assets/Amenities_Icons/hospital.png";
import stadiumIcon from "../assets/Amenities_Icons/stadium.webp";
import educationIcon from "../assets/Amenities_Icons/education.png";
import religiousIcon from "../assets/Amenities_Icons/religious.png";
import toiletIcon from "../assets/Amenities_Icons/Community Toilet.png";
import chargingIcon from "../assets/Amenities_Icons/charging.png";
import govIcon from "../assets/Amenities_Icons/Central.png";
import hotelIcon from "../assets/Amenities_Icons/hotel.png";
import fuelIcon from "../assets/Amenities_Icons/fuel.png";
import landmarkIcon from "../assets/Amenities_Icons/landmark.png";
import postOfficeIcon from "../assets/Amenities_Icons/post-office.png";
import stateGovIcon from "../assets/Amenities_Icons/State.png";
import mosqueIcon from "../assets/Amenities_Icons/Mosque.png";
import locationIcon from "../assets/Amenities_Icons/location.png";
import metroIcon from "../assets/Amenities_Icons/metro.webp";
import manhole from "../assets/Amenities_Icons/manhole.jpg";
import railwayStationIcon from "../assets/Amenities_Icons/railway_station.svg";
import defaultIcon from "../assets/Amenities_Icons/place.png";
import Draw, { createBox, createRegularPolygon } from "ol/interaction/Draw";
import Polygon from "ol/geom/Polygon";
import WKT from "ol/format/WKT";

import { cityConfig } from "../assets/configs/cityConfig";
import MapLegend from "./MapLegend";
import Overlay from "ol/Overlay";
import { drawWatermark } from "../utils/gisExport"; //chainage
import rsacBanner from "../assets/Login/rsac_banner2.png"; //chainage
import { getGeoserverBase } from "../utils/geoserverBase";
import { TILE_CACHE_BASE, getWorkspaceFromLayerName } from "../mapDelivery/cacheUrls";
import {
  makeCachedXyzSource,
  makeTileWmsSource as makeTileWmsSourceBase,
  updateWmsParams,
  applyCqlToTileLayer as applyCqlToTileLayerBase,
} from "../mapDelivery/sourceFactory";

const EMPTY_ARRAY = [];

const GEOSERVER_BASE = getGeoserverBase();

const WARD_ZONE_WMS = `${GEOSERVER_BASE}/Ward_Boundary_New/wms`;
const AMENITIES_WMS = `${GEOSERVER_BASE}/Amenities/wms`;
const AMENITIES_WFS = `${GEOSERVER_BASE}/wfs`; // Use Global WFS Endpoint for robustness
const CHAINAGE_WMS = `${GEOSERVER_BASE}/Chainage/wms`;
const STREET_VIEW_WMS = `${GEOSERVER_BASE}/Street_View/wms`;
const GWC_WMS = `${GEOSERVER_BASE}/gwc/service/wms`;
const SATELLITE_MAX_ZOOM = 18;
const DEFAULT_MAX_ZOOM = 20;
const ROAD_DIM_OPACITY = 0.6;
const ROAD_LABEL_STYLE = "Road_Network:urida_road_labels";

// ---------- Chainage patch preview (single- and multi-road) ----------
// Cartographic halo: a wide white outer stroke plus a narrower colored
// inner stroke reads clearly against any basemap tile or an underlying
// segmented-roads/chainage WMS visualization — a single mid-width colored
// line can blend into busy imagery underneath it.
const PATCH_PREVIEW_STYLE = [
  new Style({ stroke: new Stroke({ color: "rgba(255,255,255,0.95)", width: 11 }) }),
  new Style({ stroke: new Stroke({ color: "#f97316", width: 6 }) }),
];
const makePatchMarkerStyle = (fillColor, radius = 9) =>
  new Style({
    image: new CircleStyle({
      radius,
      fill: new Fill({ color: fillColor }),
      stroke: new Stroke({ color: "#ffffff", width: 2.5 }),
    }),
  });
const PATCH_START_MARKER_STYLE = makePatchMarkerStyle("#16a34a"); // green
const PATCH_END_MARKER_STYLE = makePatchMarkerStyle("#dc2626"); // red
const PATCH_JUNCTION_MARKER_STYLE = makePatchMarkerStyle("#2563eb", 8); // blue
// Feature-aware style function for the preview VectorLayer: marker
// features carry their own explicit style (set via setStyle below), line
// segments fall back to the halo style.
const patchPreviewLayerStyle = (feature) => feature.getStyle() || PATCH_PREVIEW_STYLE;

// Client-rendered chainage distance points/labels, used while a road's
// chainage panel is open — replaces relying on the chainage WMS raster's
// own point styling, whose size is fixed by its GeoServer SLD (out of this
// app's control) and visibly shrinks relative to everything else as you
// zoom in. An OpenLayers vector Circle+Text style is sized in screen
// pixels by default, so it reads the same size at every zoom level with no
// scale-dependent logic needed on either side.
// Road 1's points use the same orange the road-selection highlight already
// uses; Road 2's use the same blue the candidate-road highlight already
// uses — so which road a given chainage number belongs to is visible at a
// glance on the map itself, not just inferred from position (segments from
// two different roads can run close together right near a junction, where
// misreading which point is whose is easiest to do by eye).
const CHAINAGE_POINT_FILL_ROAD1 = new Fill({ color: "#FF6A00" });
const CHAINAGE_POINT_FILL_ROAD2 = new Fill({ color: "#2B7FFF" });
const CHAINAGE_POINT_STROKE = new Stroke({ color: "#ffffff", width: 1.5 });
const CHAINAGE_POINT_TEXT_FILL = new Fill({ color: "#0f172a" });
const CHAINAGE_POINT_TEXT_STROKE = new Stroke({ color: "#ffffff", width: 3 });
function chainagePointStyle(feature) {
  const value = feature.get("distance");
  const isRoad2 = feature.get("road") === 2;
  return new Style({
    image: new CircleStyle({
      radius: 4,
      fill: isRoad2 ? CHAINAGE_POINT_FILL_ROAD2 : CHAINAGE_POINT_FILL_ROAD1,
      stroke: CHAINAGE_POINT_STROKE,
    }),
    text: new TextStyle({
      text: value != null ? String(value) : "",
      font: "bold 11px sans-serif",
      fill: CHAINAGE_POINT_TEXT_FILL,
      stroke: CHAINAGE_POINT_TEXT_STROKE,
      offsetY: -11,
    }),
  });
}

// [firstCoord, lastCoord] of a LineString/MultiLineString geometry, in the
// map's projection — used to place start/end markers on a patch segment.
function getLineEndpoints(geometry) {
  if (!geometry) return [null, null];
  const type = geometry.getType();
  if (type === "LineString") {
    const coords = geometry.getCoordinates();
    return coords.length ? [coords[0], coords[coords.length - 1]] : [null, null];
  }
  if (type === "MultiLineString") {
    const lines = geometry.getCoordinates();
    if (!lines.length) return [null, null];
    const first = lines[0];
    const last = lines[lines.length - 1];
    return [first?.[0] || null, last?.[last.length - 1] || null];
  }
  return [null, null];
}

// Closest pair of endpoints between two roads' own segment features,
// averaged to a single point — a lightweight stand-in for a true
// topological junction (segment geometries alone don't guarantee exact
// snapping), good enough to mark "roughly here is where these connect" on
// the multi-road preview.
function findClosestRoadJunction(featuresA, featuresB) {
  const collectEndpoints = (features) => {
    const points = [];
    features.forEach((f) => {
      const [a, b] = getLineEndpoints(f.getGeometry());
      if (a) points.push(a);
      if (b) points.push(b);
    });
    return points;
  };
  const endpointsA = collectEndpoints(featuresA);
  const endpointsB = collectEndpoints(featuresB);
  let best = null;
  let bestDist = Infinity;
  endpointsA.forEach((pa) => {
    endpointsB.forEach((pb) => {
      const d = Math.hypot(pa[0] - pb[0], pa[1] - pb[1]);
      if (d < bestDist) {
        bestDist = d;
        best = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
      }
    });
  });
  return best;
}

// The backend (server/src/routes/chainage.js) derives every segment's
// chainage position by parsing its segment_id string via PostgreSQL's
// split_part(segment_id, 'S', 2) — e.g. "093400901676S50" -> 50. Mirrored
// here exactly (2nd field after splitting on "S") so a chainage value
// computed client-side for a junction always means the same thing
// /api/patch-preview and /api/create-patch already use it for.
function parseSegmentSuffix(feature) {
  const raw = feature?.get?.("segment_id") ?? feature?.get?.("segmentid") ?? feature?.get?.("seg_id");
  if (raw == null) return null;
  const parts = String(raw).split("S");
  const suffix = Number(parts[1]);
  return Number.isFinite(suffix) ? suffix : null;
}

// The chainage create-form's Start/End dropdowns used to be populated from
// a separate "chainage points" table (/api/chainage) that isn't guaranteed
// to line up with — or even be as complete as — the segment table's own
// numbering (segment_id, the same source the map's chainage points/labels
// and the junction lookup both already use). That mismatch is what caused
// a real junction value (e.g. 46.01) to not appear in the "other" table at
// all, and could leave a dropdown with no valid options even though the
// map clearly showed points for that road. Deriving both from the exact
// same segment features guarantees the dropdown always offers precisely
// what's drawn on the map, junction included.
function sortedSegmentValues(features) {
  return Array.from(
    new Set((features || []).map(parseSegmentSuffix).filter((v) => v != null))
  ).sort((a, b) => a - b);
}

// Same closest-endpoint-pair search as findClosestRoadJunction, but also
// reports which specific segment on each road was closest — needed to read
// off "the chainage value at the junction" on each road via
// parseSegmentSuffix. Still a geometric approximation (nearest endpoint,
// not a guaranteed exact topological snap) — see findClosestRoadJunction's
// own comment.
function findRoadJunctionDetail(featuresA, featuresB) {
  let best = null;
  let bestDist = Infinity;
  featuresA.forEach((fa) => {
    const [a1, a2] = getLineEndpoints(fa.getGeometry());
    [a1, a2].forEach((pa) => {
      if (!pa) return;
      featuresB.forEach((fb) => {
        const [b1, b2] = getLineEndpoints(fb.getGeometry());
        [b1, b2].forEach((pb) => {
          if (!pb) return;
          const d = Math.hypot(pa[0] - pb[0], pa[1] - pb[1]);
          if (d < bestDist) {
            bestDist = d;
            best = {
              point: [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2],
              distance: d,
              suffixA: parseSegmentSuffix(fa),
              suffixB: parseSegmentSuffix(fb),
            };
          }
        });
      });
    });
  });
  return best;
}

// Fits the map to a patch preview's extent (EPSG:3857, meters) before the
// snapshot is captured. Two adjustments beyond a plain view.fit():
//  - Very short patches (a handful of meters) would otherwise fit to a
//    near-zero-size extent and zoom in to a single indistinct point with no
//    surrounding context — pad the extent up to a minimum visible size
//    first, so short and long patches both read as "here's the patch on
//    the road", not just "here's a dot" or "here's the whole city".
//  - Extra clearance on the right/bottom, where captureMapImageBlob's
//    drawWatermark() always draws the RSAC logo — so the patch highlight
//    and its markers don't end up sitting under it in the captured image.
const PATCH_PREVIEW_MIN_EXTENT_METERS = 80;
function fitPatchPreviewExtent(map, extent) {
  let [minX, minY, maxX, maxY] = extent;
  const width = maxX - minX;
  const height = maxY - minY;
  if (width < PATCH_PREVIEW_MIN_EXTENT_METERS) {
    const grow = (PATCH_PREVIEW_MIN_EXTENT_METERS - width) / 2;
    minX -= grow;
    maxX += grow;
  }
  if (height < PATCH_PREVIEW_MIN_EXTENT_METERS) {
    const grow = (PATCH_PREVIEW_MIN_EXTENT_METERS - height) / 2;
    minY -= grow;
    maxY += grow;
  }
  // captureMapImageBlob snapshots the map's full current pixel size (often
  // a wide, short browser viewport), not a small square crop — fitting a
  // short, often near-diagonal patch extent into that shape means the
  // wider of the two on-screen dimensions ends up mostly empty margin
  // unless the padding stays tight. Smaller padding than a plain preview
  // fit would otherwise use, so the patch reads as "in focus" rather than
  // a short highlight lost in a wide, mostly-empty snapshot; right/bottom
  // stay slightly larger than top/left for captureMapImageBlob's watermark.
  // OL padding order: [top, right, bottom, left].
  map.getView().fit([minX, minY, maxX, maxY], {
    padding: [40, 60, 70, 40],
    maxZoom: 20,
  });
}

// For VectorSources this app populates itself (fetch + .clear() + .addFeatures()),
// not via OL's own url/loader convenience. Without an explicit loader, OL still
// calls `loadFeatures()` on every viewport change, finds the extent untracked,
// fires `featuresloadstart`, then invokes the default no-op loader — which never
// calls back, so `featuresloadend`/`featuresloaderror` never fire. Every titled
// layer wrapping one of these sources was consequently reported "stuck loading"
// by mapLoadingTracker's 12s watchdog on every pan/zoom, even though the data
// itself loaded fine via the app's own fetch. A same-tick no-op loader plus the
// "load everything at once" strategy makes OL mark the whole extent as already
// loaded after the first (instant) call, so it stops re-firing loadstart at all.
const manualVectorSourceOptions = () => ({
  loader: (extent, resolution, projection, success) => success([]),
  strategy: allStrategy,
});

const makeTileWmsSource = (options) =>
  makeTileWmsSourceBase({
    ...options,
    geoserverBase: GEOSERVER_BASE,
    gwcWms: GWC_WMS,
  });

const applyCqlToTileLayer = (layer, filter, workspace) =>
  applyCqlToTileLayerBase(layer, filter, workspace, {
    geoserverBase: GEOSERVER_BASE,
    gwcWms: GWC_WMS,
  });

const ROAD_WFS_MIN_ZOOM = 14;
// Below this zoom, a classification/LCLU overlay would render a heavy,
// mostly-useless whole-city WMS tile set — on a detected slow connection,
// defer it (with a courtesy notice) until the user zooms in, rather than
// fetching it immediately just because the sidebar toggle was flipped.
const LOW_BANDWIDTH_OVERLAY_MIN_ZOOM = 13;
const LOCATE_LAYER_ID = "__nav_locate_me_layer__";

const AMENITY_ICON_MAP = {
  atm_bank: bankIcon,
  bus_stop: busIcon,
  bus_stand: busIcon,
  graveyard: graveyardIcon,
  hospital: hospitalIcon,
  hotel: hotelIcon,
  //park: parkIcon,
  petrol_pump: fuelIcon,
  stadium: stadiumIcon,
  //police_station: policeIcon,
  metro: metroIcon,
  railway_station: railwayStationIcon,
};

const OTHER_ICON_MAP = {
  education: educationIcon,
  religious: religiousIcon,
  post_office: postOfficeIcon,
  state_gov: stateGovIcon,
  central_gov: govIcon,
  cental_gov: govIcon,
  centeral_gov: govIcon,
  landmark: landmarkIcon,
  communication: locationIcon,
  community_toilet: toiletIcon,
  e_charging: chargingIcon,
  car_charging: chargingIcon,
  mosque: mosqueIcon,
  temple: religiousIcon,
  manhole: manhole,
};
const ICON_IMG_SIZE = 48;
const ICON_IMG_SIZE_MAP = {
  railway_station: 96,
  state_gov: 28,
  central_gov: 36,
  cental_gov: 36,
  centeral_gov: 36,
};
const getIconImgSize = (id) => ICON_IMG_SIZE_MAP[id] || ICON_IMG_SIZE;


const AMENITY_ICON_SCALE = {
  atm_bank: 0.95,
  bus_stop: 0.9,
  bus_stand: 0.9,
  graveyard: 0.85,
  hospital: 0.9,
  hotel: 0.9,
  park: 0.9,
  petrol_pump: 0.9,
  stadium: 0.8,
  metro: 0.9,
  railway_station: 3,
};

const OTHER_ICON_SCALE = {
  education: 0.85,
  religious: 0.8,
  post_office: 0.85,
  state_gov: 0.5,
  central_gov: 0.6,
  cental_gov: 0.6,
  centeral_gov: 0.6,
  landmark: 0.8,
  communication: 0.85,
  community_toilet: 0.85,
  e_charging: 0.85,
  car_charging: 0.85,
  mosque: 0.78,
  temple: 0.78,
  manhole: 0.65,
};

const getAmenityIconScale = (id) => AMENITY_ICON_SCALE[id] ?? 0.9;
const getOtherIconScale = (id, resolution) => {
  if (id !== "manhole") return OTHER_ICON_SCALE[id] ?? 0.9;
  const zoom = resolution ? Math.log2(156543.03392804097 / resolution) : 0;
  if (zoom >= 17) return 0.25;
  if (zoom >= 15) return 0.35;
  if (zoom >= 13) return 0.5;
  return 0.6;
};


const AMENITY_STYLE_CACHE = new Map();
const OTHER_STYLE_CACHE = new Map();
const PIN_SVG_CACHE = new Map();
const AMENITY_BADGE_SVG_CACHE = new Map();
const OSM_OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const STREET_VIEW_CACHE_KEY = "streetViewAvailabilityCache";
const STREET_VIEW_TTL_MS = 60 * 60 * 1000;
const STREET_VIEW_MAX_ENTRIES = 250;
const STREET_VIEW_TIMEOUT_MS = 2800;
const GOOGLE_STREET_VIEW_API_KEY =
  process.env.REACT_APP_GOOGLE_STREET_VIEW_API_KEY ||
  process.env.REACT_APP_GOOGLE_MAPS_API_KEY ||
  "";
const OSM_DEDUP_DISTANCE_METERS = 30;
const ROAD_PROXIMITY_METERS = 60;
const OSM_AMENITY_FILTERS = {
  atm_bank: [{ key: "amenity", values: ["atm", "bank"] }],
  bus_stop: [
    { key: "highway", values: ["bus_stop"] },
    { key: "amenity", values: ["bus_station"] },
  ],
  bus_stand: [
    { key: "highway", values: ["bus_stop"] },
    { key: "amenity", values: ["bus_station"] },
  ],
  graveyard: [
    { key: "amenity", values: ["grave_yard"] },
    { key: "landuse", values: ["cemetery"] },
  ],
  hospital: [{ key: "amenity", values: ["hospital", "clinic"] }],
  hotel: [{ key: "tourism", values: ["hotel", "guest_house", "motel", "hostel"] }],
  park: [{ key: "leisure", values: ["park", "garden"] }],
  petrol_pump: [{ key: "amenity", values: ["fuel"] }],
  stadium: [{ key: "leisure", values: ["stadium"] }],
  metro: [
    { key: "railway", values: ["subway_entrance"] },
    { key: "station", values: ["subway"] },
    { key: "subway", values: ["yes"] },
  ],
  railway_station: [{ key: "railway", values: ["station"] }],
};
const OSM_OTHER_FILTERS = {
  education: [{ key: "amenity", values: ["school", "college", "university", "kindergarten"] }],
  post_office: [{ key: "amenity", values: ["post_office"] }],
  religious: [{ key: "amenity", values: ["place_of_worship"] }],
  landmark: [
    { key: "tourism", values: ["attraction", "museum", "artwork", "viewpoint", "gallery", "zoo", "theme_park"] },
    { key: "historic", values: ["monument", "memorial", "castle", "fort", "archaeological_site", "ruins"] },
    { key: "man_made", values: ["obelisk", "tower"] },
  ],
  communication: [{ key: "man_made", values: ["communications_tower", "tower"] }],
  community_toilet: [{ key: "amenity", values: ["toilets"] }],
  e_charging: [{ key: "amenity", values: ["charging_station"] }],
  car_charging: [{ key: "amenity", values: ["charging_station"] }],
  mosque: [{ key: "amenity", values: ["place_of_worship"] }],
  temple: [{ key: "amenity", values: ["place_of_worship"] }],
};
const getExtentDistance = (a, b) => {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const dx = Math.max(0, Math.max(a[0] - b[2], b[0] - a[2]));
  const dy = Math.max(0, Math.max(a[1] - b[3], b[1] - a[3]));
  return Math.hypot(dx, dy);
};
const isExtentNearFeatures = (extent, features, distance) => {
  if (!extent || !features?.length) return false;
  for (const feature of features) {
    const geom = feature?.getGeometry?.();
    const fExtent = geom?.getExtent?.();
    if (!fExtent) continue;
    if (getExtentDistance(extent, fExtent) <= distance) return true;
  }
  return false;
};
const getGeometryDistance = (a, b) => {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const extent = b.getExtent?.();
  if (!extent) return Number.POSITIVE_INFINITY;
  const center = [(extent[0] + extent[2]) / 2, (extent[1] + extent[3]) / 2];
  const aPoint = a.getClosestPoint ? a.getClosestPoint(center) : center;
  const bPoint = b.getClosestPoint ? b.getClosestPoint(aPoint) : aPoint;
  return Math.hypot(aPoint[0] - bPoint[0], aPoint[1] - bPoint[1]);
};

const haveCountsChanged = (a, b) => {
  const aKeys = Object.keys(a || {});
  const bKeys = Object.keys(b || {});
  if (aKeys.length !== bKeys.length) return true;
  return aKeys.some((k) => a[k] !== b[k]);
};

const mergeAmenityCounts = (wfsCounts, osmCounts) => {
  const merged = { ...(wfsCounts || {}) };
  Object.entries(osmCounts || {}).forEach(([key, value]) => {
    const base = merged[key] || 0;
    const next = Number.isFinite(value) ? value : 0;
    merged[key] = base + next;
  });
  return merged;
};
const mergeOtherCounts = (wfsCounts, osmCounts) => mergeAmenityCounts(wfsCounts, osmCounts);

const getOsmBbox = (extent, projection) => {
  if (!extent || !projection) return null;
  const [minX, minY, maxX, maxY] = extent;
  const sw = toLonLat([minX, minY], projection);
  const ne = toLonLat([maxX, maxY], projection);
  const south = Math.min(sw[1], ne[1]);
  const west = Math.min(sw[0], ne[0]);
  const north = Math.max(sw[1], ne[1]);
  const east = Math.max(sw[0], ne[0]);
  if (![south, west, north, east].every(Number.isFinite)) return null;
  return [south, west, north, east];
};

const buildOverpassQuery = (filters, bbox) => {
  if (!filters.length || !bbox) return "";
  const [south, west, north, east] = bbox;
  const blocks = filters.map((filter) => {
    const valueRegex = `^(${filter.values.join("|")})$`;
    const tag = `["${filter.key}"~"${valueRegex}"]`;
    const area = `(${south},${west},${north},${east})`;
    return `node${tag}${area};way${tag}${area};relation${tag}${area};`;
  });
  return `[out:json][timeout:25];(${blocks.join("")});out body geom;`;
};

const matchOsmAmenityId = (tags, amenityIds) => {
  if (!tags) return null;
  for (const id of amenityIds) {
    const filters = OSM_AMENITY_FILTERS[id] || [];
    for (const filter of filters) {
      const value = tags[filter.key];
      if (!value) continue;
      if (filter.values.includes(value)) return id;
    }
  }
  return null;
};
const matchOsmOtherId = (tags, otherIds) => {
  if (!tags) return null;
  for (const id of otherIds) {
    const filters = OSM_OTHER_FILTERS[id] || [];
    for (const filter of filters) {
      const value = tags[filter.key];
      if (!value) continue;
      if (filter.values.includes(value)) return id;
    }
  }
  return null;
};

const getOsmElementCoord = (element) => {
  if (!element) return null;
  if (element.type === "node" && Number.isFinite(element.lon) && Number.isFinite(element.lat)) {
    return [element.lon, element.lat];
  }
  const center = element.center;
  if (center && Number.isFinite(center.lon) && Number.isFinite(center.lat)) {
    return [center.lon, center.lat];
  }
  const geometry = element.geometry;
  if (Array.isArray(geometry) && geometry.length) {
    let lonSum = 0;
    let latSum = 0;
    let count = 0;
    geometry.forEach((pt) => {
      if (!pt || !Number.isFinite(pt.lon) || !Number.isFinite(pt.lat)) return;
      lonSum += pt.lon;
      latSum += pt.lat;
      count += 1;
    });
    if (count > 0) {
      return [lonSum / count, latSum / count];
    }
  }
  return null;
};

const getGeomType = (feature) => feature?.getGeometry?.()?.getType?.() || "";

const normalizeLayerName = (value) => String(value || "").replace(/\s*:\s*/g, ":").trim();

const getCaseInsensitive = (obj, key) => {
  if (!obj) return undefined;
  const foundKey = Object.keys(obj).find((k) => k.toLowerCase() === key.toLowerCase());
  return foundKey ? obj[foundKey] : undefined;
};

const extractLegendColor = (legend) => {
  const legendArr = legend?.Legend || legend?.legend || legend;
  const firstLegend = Array.isArray(legendArr) ? legendArr[0] : legendArr;
  const rules = firstLegend?.rules || firstLegend?.Rules || legend?.rules || legend?.Rules;
  const rule = Array.isArray(rules) ? rules[0] : rules;
  const symbolizers =
    rule?.symbolizers || rule?.Symbolizers || rule?.symbolizer || rule?.Symbolizer;
  const symbolizer = Array.isArray(symbolizers) ? symbolizers[0] : symbolizers;
  const polygon = getCaseInsensitive(symbolizer, "Polygon");
  const line = getCaseInsensitive(symbolizer, "Line");
  const point = getCaseInsensitive(symbolizer, "Point");
  return (
    getCaseInsensitive(polygon, "fill") ||
    getCaseInsensitive(polygon, "stroke") ||
    getCaseInsensitive(line, "stroke") ||
    getCaseInsensitive(point, "fill") ||
    getCaseInsensitive(point, "stroke") ||
    null
  );
};

const fetchLegendColor = async (layerName) => {
  if (!layerName) return null;
  try {
    const response = await fetch(
      `${WARD_ZONE_WMS}?REQUEST=GetLegendGraphic&VERSION=1.0.0&FORMAT=application/json&LAYER=${encodeURIComponent(
        layerName
      )}`
    );
    if (!response.ok) return null;
    const json = await response.json();
    return extractLegendColor(json);
  } catch {
    return null;
  }
};

const getFirstCoord = (geometry) => {
  let cur = geometry?.coordinates;
  while (Array.isArray(cur)) {
    if (
      cur.length >= 2 &&
      typeof cur[0] === "number" &&
      typeof cur[1] === "number"
    ) {
      return [cur[0], cur[1]];
    }
    cur = cur[0];
  }
  return null;
};

const detectDataProjection = (geometry, viewProjection) => {
  const firstCoord = getFirstCoord(geometry);
  const viewCode = viewProjection?.getCode?.() || "";
  const assumeLonLat =
    !!firstCoord &&
    Math.abs(firstCoord[0]) <= 180 &&
    Math.abs(firstCoord[1]) <= 90 &&
    String(viewCode).includes("3857");
  return assumeLonLat ? "EPSG:4326" : (viewCode || "EPSG:3857");
};

const computeIconScale = (resolution) => {
  if (!resolution) return 0.085;
  const zoom = Math.log2(156543.03392804097 / resolution);

  const scale = 0.07 + (zoom - 12) * 0.012;

  if (scale < 0.06) return 0.06;
  if (scale > 0.22) return 0.22;
  return scale;
};

const computeStrokeWidth = (resolution, base = 2) => {
  if (!resolution) return base;
  const zoom = Math.log2(156543.03392804097 / resolution);
  const factor = 0.7 + (zoom - 12) * 0.08;
  const width = base * factor;
  if (width < 0.8) return 0.8;
  if (width > base * 1.6) return base * 1.6;
  return width;
};

const fetchJsonWithTimeout = async (url, timeoutMs, outerSignal) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const handleAbort = () => controller.abort();
  if (outerSignal) {
    outerSignal.addEventListener("abort", handleAbort, { once: true });
  }
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return { aborted: false, data: null };
    }
    const data = await response.json();
    return { aborted: false, data };
  } catch (err) {
    return { aborted: controller.signal.aborted, data: null };
  } finally {
    clearTimeout(timeoutId);
  }
};

const getRandomRoadColor = () => {
  const hue = Math.floor(Math.random() * 360);
  return `hsl(${hue}, 85%, 50%)`;
};

const AMENITY_COLOR_MAP = {
  atm_bank: "#2563eb",
  bus_stop: "#f97316",
  bus_stand: "#f97316",
  graveyard: "#64748b",
  hospital: "#ef4444",
  hotel: "#a855f7",
  petrol_pump: "#eab308",
  stadium: "#22c55e",
  metro: "#0ea5e9",
  railway_station: "#1d4ed8",
  park: "#10b981",
};

const adjustColor = (hex, amt) => {
  const c = hex.replace("#", "");
  const num = parseInt(c, 16);
  const r = Math.min(255, Math.max(0, (num >> 16) + amt));
  const g = Math.min(255, Math.max(0, ((num >> 8) & 0x00ff) + amt));
  const b = Math.min(255, Math.max(0, (num & 0x0000ff) + amt));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
};

const getAmenityColor = (id, isDark) => {
  const base = AMENITY_COLOR_MAP[id] || "#ef4444";
  return isDark ? adjustColor(base, 35) : base;
};

const getPinSvg = (id, isDark = false) => {
  const key = `${id}|${isDark ? "dark" : "light"}`;
  const cached = PIN_SVG_CACHE.get(key);
  if (cached) return cached;
  const base = getAmenityColor(id, isDark);
  const top = adjustColor(base, 30);
  const bottom = adjustColor(base, -10);
  const ring = isDark ? "rgba(255,255,255,0.9)" : "#ffffff";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="38" height="56" viewBox="0 0 40 56"><defs><linearGradient id="pinGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${top}"/><stop offset="100%" stop-color="${bottom}"/></linearGradient><filter id="shadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="2" stdDeviation="1.2" flood-color="rgba(0,0,0,0.28)"/></filter></defs><path d="M20 2C11 2 5 8 5 17c0 12 15 35 15 35s15-23 15-35C35 8 29 2 20 2z" fill="url(#pinGrad)" stroke="rgba(0,0,0,0.22)" stroke-width="1.2" filter="url(#shadow)"/><circle cx="20" cy="17" r="9.5" fill="${ring}" stroke="rgba(0,0,0,0.12)" stroke-width="0.9"/></svg>`;
  const url = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  PIN_SVG_CACHE.set(key, url);
  return url;
};

const getAmenityBadgeSvg = (id, isDark = false) => {
  const key = `${id}|${isDark ? "dark" : "light"}`;
  const cached = AMENITY_BADGE_SVG_CACHE.get(key);
  if (cached) return cached;
  const ring = "#ffffff";
  const stroke = getAmenityColor(id, isDark);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="42" height="42" viewBox="0 0 42 42"><defs><filter id="shadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="1" stdDeviation="1.1" flood-color="rgba(0,0,0,0.32)"/></filter></defs><circle cx="21" cy="21" r="15.2" fill="${ring}" stroke="${stroke}" stroke-width="1.8" filter="url(#shadow)"/></svg>`;
  const url = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  AMENITY_BADGE_SVG_CACHE.set(key, url);
  return url;
};

const getSearchPinSvg = () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="42" height="60" viewBox="0 0 40 56"><defs><linearGradient id="searchPinGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#ef4444"/><stop offset="100%" stop-color="#b91c1c"/></linearGradient><filter id="searchShadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="2" stdDeviation="1.3" flood-color="rgba(0,0,0,0.35)"/></filter></defs><path d="M20 2C11 2 5 8 5 17c0 12 15 35 15 35s15-23 15-35C35 8 29 2 20 2z" fill="url(#searchPinGrad)" stroke="rgba(0,0,0,0.25)" stroke-width="1.2" filter="url(#searchShadow)"/><circle cx="20" cy="17" r="9.5" fill="#ffffff" stroke="rgba(0,0,0,0.15)" stroke-width="0.9"/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
};

const createAmenityStyle = (id, isDark = false) => (feature, resolution) => {
  const type = getGeomType(feature);
  const key = `${id}:${type}:${isDark ? 'dark' : 'light'}`;
  const cached = AMENITY_STYLE_CACHE.get(key);
  if (cached) {
    if (type === "Point" || type === "MultiPoint") {
      const styles = Array.isArray(cached) ? cached : [cached];
      const pinScale = computeIconScale(resolution) * 1.25;
      const badgeScale = computeIconScale(resolution) * 0.95;
      const iconScale = computeIconScale(resolution) * 0.78 * getAmenityIconScale(id);
      styles.forEach((style) => {
        const img = style.getImage && style.getImage();
        if (img && typeof img.setScale === "function") {
          const role = img.__styleRole;
          if (role === "pin") img.setScale(pinScale);
          else if (role === "badge") img.setScale(badgeScale);
          else img.setScale(iconScale);
        }
      });
    } else if (type === "Polygon" || type === "MultiPolygon" || type === "LineString" || type === "MultiLineString") {
      const stroke = cached.getStroke?.();
      if (stroke && typeof stroke.setWidth === "function") {
        const base = type === "LineString" || type === "MultiLineString" ? 3 : 2;
        stroke.setWidth(computeStrokeWidth(resolution, base));
      }
    }
    return cached;
  }

  const isPark = id === "park";
  let strokeColor, fillColor;

  if (isPark) {
    strokeColor = isDark ? "rgba(50, 255, 50, 1)" : "rgba(16, 185, 129, 1)";
    fillColor = isDark ? "rgba(50, 255, 50, 0.4)" : "rgba(16, 185, 129, 0.25)";
  } else {
    // Default: Red (Light Map) vs Yellow/Gold (Dark Map)
    strokeColor = isDark ? "rgba(255, 215, 0, 1)" : "rgba(255, 0, 0, 1)";
    fillColor = isDark ? "rgba(255, 215, 0, 0.4)" : "rgba(255, 0, 0, 0.2)";
  }

  let style = null;
  if (type === "Point" || type === "MultiPoint") {
    const iconSrc = AMENITY_ICON_MAP[id] || defaultIcon;
    const iconSize = getIconImgSize(id);
    const pinStyle = new Style({
      image: new Icon({
        src: getPinSvg(id, isDark),
        anchor: [0.5, 1],
        anchorXUnits: "fraction",
        anchorYUnits: "fraction",
        scale: computeIconScale(resolution) * 1.25,
      }),
    });
    pinStyle.getImage().__styleRole = "pin";
    const badgeStyle = new Style({
      image: new Icon({
        src: getAmenityBadgeSvg(id, isDark),
        anchor: [0.5, 0.44],
        anchorXUnits: "fraction",
        anchorYUnits: "fraction",
        scale: computeIconScale(resolution) * 0.95,
      }),
    });
    badgeStyle.getImage().__styleRole = "badge";
    const iconStyle = new Style({
      image: new Icon({
        src: iconSrc,
        anchor: [0.5, 0.44],
        anchorXUnits: "fraction",
        anchorYUnits: "fraction",
        scale: computeIconScale(resolution) * 0.78 * getAmenityIconScale(id),
        imgSize: [iconSize, iconSize],
        crossOrigin: "anonymous",
      }),
    });
    iconStyle.getImage().__styleRole = "icon";
    iconStyle.setZIndex(3);
    badgeStyle.setZIndex(2);
    pinStyle.setZIndex(1);
    style = [pinStyle, badgeStyle, iconStyle];
  } else if (type === "Polygon" || type === "MultiPolygon") {
    style = new Style({
      fill: new Fill({ color: fillColor }),
      stroke: new Stroke({ color: strokeColor, width: computeStrokeWidth(resolution, 2) }),
    });
  } else if (type === "LineString" || type === "MultiLineString") {
    style = new Style({
      stroke: new Stroke({ color: strokeColor, width: computeStrokeWidth(resolution, 3) }),
    });
  } else {
    style = new Style({
      stroke: new Stroke({ color: strokeColor, width: computeStrokeWidth(resolution, 2) }),
      fill: new Fill({ color: fillColor }),
    });
  }

  AMENITY_STYLE_CACHE.set(key, style);
  return style;
};

const createOtherStyle = (id, isDark = false) => (feature, resolution) => {
  const type = getGeomType(feature);
  const key = `${id}:${type}:${isDark ? 'dark' : 'light'}`;
  const cached = OTHER_STYLE_CACHE.get(key);
  if (cached) {
    if (type === "Point" || type === "MultiPoint") {
      const styles = Array.isArray(cached) ? cached : [cached];
      const pinScale = computeIconScale(resolution) * 1.25;
      const badgeScale = computeIconScale(resolution) * 0.95;
      const iconScale = computeIconScale(resolution) * 0.78 * getOtherIconScale(id, resolution);
      styles.forEach((style) => {
        const img = style.getImage && style.getImage();
        if (img && typeof img.setScale === "function") {
          const role = img.__styleRole;
          if (role === "pin") img.setScale(pinScale);
          else if (role === "badge") img.setScale(badgeScale);
          else img.setScale(iconScale);
        }
      });
    } else if (type === "Polygon" || type === "MultiPolygon" || type === "LineString" || type === "MultiLineString") {
      const stroke = cached.getStroke?.();
      if (stroke && typeof stroke.setWidth === "function") {
        const base = type === "LineString" || type === "MultiLineString" ? 3 : 2;
        stroke.setWidth(computeStrokeWidth(resolution, base));
      }
    }
    return cached;
  }

  // Default: Blue (Light Map) vs Cyan (Dark Map)
  const strokeColor = isDark ? "rgba(0, 255, 255, 1)" : "rgba(0, 0, 255, 1)";
  const fillColor = isDark ? "rgba(0, 255, 255, 0.4)" : "rgba(0, 0, 255, 0.2)";

  let style = null;
  if (type === "Point" || type === "MultiPoint") {
    const iconSrc = OTHER_ICON_MAP[id] || defaultIcon;
    const iconSize = getIconImgSize(id);
    const pinStyle = new Style({
      image: new Icon({
        src: getPinSvg(id, isDark),
        anchor: [0.5, 1],
        anchorXUnits: "fraction",
        anchorYUnits: "fraction",
        scale: computeIconScale(resolution) * 1.25,
      }),
    });
    pinStyle.getImage().__styleRole = "pin";
    const badgeStyle = new Style({
      image: new Icon({
        src: getAmenityBadgeSvg(id, isDark),
        anchor: [0.5, 0.44],
        anchorXUnits: "fraction",
        anchorYUnits: "fraction",
        scale: computeIconScale(resolution) * 0.95,
      }),
    });
    badgeStyle.getImage().__styleRole = "badge";
    const iconStyle = new Style({
      image: new Icon({
        src: iconSrc,
        anchor: [0.5, 0.44],
        anchorXUnits: "fraction",
        anchorYUnits: "fraction",
        scale: computeIconScale(resolution) * 0.78 * getOtherIconScale(id, resolution),
        imgSize: [iconSize, iconSize],
        crossOrigin: "anonymous",
      }),
    });
    iconStyle.getImage().__styleRole = "icon";
    iconStyle.setZIndex(3);
    badgeStyle.setZIndex(2);
    pinStyle.setZIndex(1);
    style = [pinStyle, badgeStyle, iconStyle];
  } else if (type === "Polygon" || type === "MultiPolygon") {
    style = new Style({
      fill: new Fill({ color: fillColor }),
      stroke: new Stroke({ color: strokeColor, width: computeStrokeWidth(resolution, 2) }),
    });
  } else if (type === "LineString" || type === "MultiLineString") {
    style = new Style({
      stroke: new Stroke({ color: strokeColor, width: computeStrokeWidth(resolution, 3) }),
    });
  } else {
    style = new Style({
      stroke: new Stroke({ color: strokeColor, width: computeStrokeWidth(resolution, 2) }),
      fill: new Fill({ color: fillColor }),
    });
  }

  OTHER_STYLE_CACHE.set(key, style);
  return style;
};

// ================= CITY VIEWS =================
const cityViews = {
  agra: { center: fromLonLat([78.0081, 27.1767]), zoom: 12.8 },
  aligarh: { center: fromLonLat([78.088, 27.8974]), zoom: 13 },
  ayodhya: { center: fromLonLat([82.1944, 26.7999]), zoom: 13 },
  bareilly: { center: fromLonLat([79.4304, 28.367]), zoom: 13 },
  firozabad: { center: fromLonLat([78.3949, 27.1591]), zoom: 13.8 },
  ghaziabad: { center: fromLonLat([77.4538, 28.6692]), zoom: 12.7 },
  gorakhpur: { center: fromLonLat([83.3732, 26.7606]), zoom: 12.8 },
  jhansi: { center: fromLonLat([78.5685, 25.4484]), zoom: 12.6 },
  kanpur: { center: fromLonLat([80.3319, 26.4499]), zoom: 12.4 },
  lucknow: { center: fromLonLat([80.9462, 26.8467]), zoom: 12 },
  mathura: { center: fromLonLat([77.6737, 27.4924]), zoom: 12 },
  meerut: { center: fromLonLat([77.7064, 28.9845]), zoom: 12.4 },
  moradabad: { center: fromLonLat([78.7768, 28.8386]), zoom: 13 },
  prayagraj: { center: fromLonLat([81.8463, 25.4358]), zoom: 12 },
  saharanpur: { center: fromLonLat([77.546, 29.9679]), zoom: 13 },
  shahjahanpur: { center: fromLonLat([79.912, 27.8804]), zoom: 13.3 },
  varanasi: { center: fromLonLat([82.9566, 25.3176]), zoom: 11 },
  default: { center: fromLonLat([80.9462, 26.8467]), zoom: 6 },
};

const MapContainer = forwardRef(({
  city = "lucknow",
  showChainage,//chainage
  mode = "DASHBOARD",//chainage
  layerVisibility = {},
  lcluOpacity = 1,
  streetViewVisible,
  streetLightVisible = false,
  streetLightGeojson = null,
  streetLightCounts = null,
  streetLightFilters = null,
  onStreetLightFilterChange,
  underdevelopedVisible = false,
  underdevelopedGeojson = null,
  underdevelopedCounts = null,
  underdevelopedFilters = null,
  onUnderdevelopedFilterChange,
  encroachmentVisible = false,
  encroachmentGeojson = null,
  encroachmentZone = "",
  encroachmentTotals = null,
  selectedRoadName,
  selectedRoadId,
  roadFilter, // STRING: zone_no='1' AND condition='Good'
  zoomFilter, // ⭐ ADDED: Filter for auto-zoom functionality
  selectedRoadIds = EMPTY_ARRAY, // ⭐ NEW: Array of currently selected road IDs
  isMultiSelectMode = false, // ⭐ NEW: Multi-select active flag
  multiSelectCandidateRoadIds = EMPTY_ARRAY, //chainage
  tableFilterActive = false,
  layerFilters = {}, // ⭐ NEW
  drawMode = null, // ⭐ NEW
  onSpatialQueryResults, // ⭐ NEW
  onRoadFilterChange, // ⭐ NEW
  onAnalysisDataLoaded, // ⭐ NEW
  onRoadSelected,
  onPopupClosed,
  onPatchTableOpen, //chainage
  onPatchTableClose, //chainage
  onFieldTaskRoadHighlight, //chainage
  onMapExtentChange, // live extent sync for the bottom table
  fieldTaskWardList = null, //chainage
  isMultiSelectModeProp = false, //chainage - Dashboard's table Multi toggle
  baseMap, // ⭐ NEW: For adaptive colors
  isSidebarOpen = false,
  tableHasRows = false,
  tableMinimized = false,
  onMapLoadingChange, // ⭐ NEW: Callback for map layer loading state
  activeDssModule = null, // DSS foundation patch: e.g. "streetLight" | null
  activeDssLayer = null, // resolved GeoServer layer name, e.g. Road_Network:MV_Lucknow_Street_Light
  dssLegendGroups = null, // [{id, title, rows:[{label,color,count}]}] from live GeoServer WFS rows (Dashboard-owned)
  onChainageCandidateContextChange, // Stage 1 chainage candidate guidance — {active, road1Id, road2Id, candidateRoadIds}
}, ref) => {
  const mapElement = useRef(null);
  const mapRef = useRef(null);
  const [mapReady, setMapReady] = useState(false);
  const [coordText, setCoordText] = useState("0.0000, 0.0000");
  const [legendPos, setLegendPos] = useState({ top: 10, left: 10 });
  // Colors actually resolved+applied to the zone/ward boundary layers
  // (fetchLegendColor, below), so MapLegend can show the same color it
  // sees on the map instead of independently re-fetching (and potentially
  // mismatching) its own swatch color.
  const [zoneBoundaryColor, setZoneBoundaryColor] = useState("#e11d48");
  const [wardBoundaryColor, setWardBoundaryColor] = useState("#16a34a");
  const [roadPanelPos, setRoadPanelPos] = useState({ top: null, left: null }); //chainage
  // Dragged panel positions live in this same component instance across a
  // city switch (the `city` prop changes, but MapContainer itself doesn't
  // remount) — without this, dragging the Legend on one city carries the
  // dragged position over to the next city you open, which reads as a
  // wrong/inconsistent "default" position. Reset both on every city change.
  useEffect(() => {
    setLegendPos({ top: 10, left: 10 });
    setRoadPanelPos({ top: null, left: null });
  }, [city]);
  const [coordPos, setCoordPos] = useState({ bottom: 32, left: "50%" });
  // [minLon, minLat, maxLon, maxLat] of the current viewport, kept for the
  // Legend's own dynamic road-count items - see the extent-sync effect below.
  const [legendExtent, setLegendExtent] = useState(null);
  const [amenityLegendCounts, setAmenityLegendCounts] = useState({});
  const [otherLegendCounts, setOtherLegendCounts] = useState({});
  const amenityLegendCountsRef = useRef({});
  const otherLegendCountsRef = useRef({});
  const amenityWfsCountsRef = useRef({});
  const otherWfsCountsRef = useRef({});
  const amenityWfsCountSourceRef = useRef({});
  const otherWfsCountSourceRef = useRef({});
  const osmAmenityCountsRef = useRef({});
  const osmAmenityLayersRef = useRef({});
  const osmAmenityFetchAbortRef = useRef(null);
  const osmAmenityExtentKeyRef = useRef("");
  const osmAmenityCacheRef = useRef(new Map());
  const osmOtherCountsRef = useRef({});
  const osmOtherLayersRef = useRef({});
  const osmOtherFetchAbortRef = useRef(null);
  const osmOtherExtentKeyRef = useRef("");
  const osmOtherCacheRef = useRef(new Map());
  const streetViewCacheRef = useRef(new Map());
  const streetViewCacheLoadedRef = useRef(false);
  const streetViewPendingRef = useRef(new Map());
  const amenityWfsCountCacheRef = useRef(new Map());
  const otherWfsCountCacheRef = useRef(new Map());
  const coordDraggingRef = useRef(false);
  const coordDragOriginRef = useRef({ x: 0, y: 0, left: 0, bottom: 0, w: 0, h: 0 });
  const draggingRef = useRef(false);
  const dragOriginRef = useRef({ x: 0, y: 0, left: 0, top: 0, w: 0, h: 0 });
  const roadPanelDraggingRef = useRef(false); //chainage
  const roadPanelDragOriginRef = useRef({ x: 0, y: 0, left: 0, top: 0, w: 0, h: 0 }); //chainage
  // Popup refs
  const popupRef = useRef(null);
  const popupContentRef = useRef(null);
  const popupCloserRef = useRef(null);
  const overlayRef = useRef(null);
  const popupRequestIdRef = useRef(0);
  const popupFeatureInfoAbortRef = useRef(null);
  const lastPopupWasRoadRef = useRef(false);
  const onPopupClosedRef = useRef(onPopupClosed);
  const onRoadSelectedRef = useRef(onRoadSelected);
  const onPatchTableOpenRef = useRef(onPatchTableOpen); //chainage
  const onPatchTableCloseRef = useRef(onPatchTableClose); //chainage
  const onFieldTaskRoadHighlightRef = useRef(onFieldTaskRoadHighlight); //chainage
  const onChainageCandidateContextChangeRef = useRef(onChainageCandidateContextChange);
  const onMapExtentChangeRef = useRef(onMapExtentChange);
  // Bridges for useImperativeHandle (defined earlier in this file than
  // openChainageForRoadId/handleCreateMultiRoadPatchRequest themselves,
  // which the ref's factory function would otherwise reference before
  // their `const` declarations run) — same pattern as the callback refs
  // above, just pointing at functions local to this component instead of
  // props from Dashboard.
  const openChainageForRoadIdRef = useRef(null); //chainage
  const handleCreateMultiRoadPatchRequestRef = useRef(null); //chainage
  const closeChainagePanelRef = useRef(null); //chainage
  // handleChainageRoadClick's own state (chainageRoad1Id/Road2Id/
  // candidateRoadIds) changes on nearly every relevant click, unlike the
  // functions above whose own dependencies barely ever change within a
  // city session — calling it directly (like openChainageForRoadId is,
  // elsewhere) from the click handler's [city]-only-registered closure
  // would freeze it at its very first (empty) state forever. Must go
  // through this ref, kept current every render, same reason as the
  // Dashboard-callback refs above.
  const handleChainageRoadClickRef = useRef(null);
  // Kept current every render (not just at mount) so the map-click handler,
  // which reads these refs from a stable closure registered once, always
  // calls the latest callback from Dashboard instead of whatever closure
  // happened to exist on first render.
  onPopupClosedRef.current = onPopupClosed;
  onRoadSelectedRef.current = onRoadSelected;
  onPatchTableOpenRef.current = onPatchTableOpen;
  onPatchTableCloseRef.current = onPatchTableClose;
  onFieldTaskRoadHighlightRef.current = onFieldTaskRoadHighlight;
  onChainageCandidateContextChangeRef.current = onChainageCandidateContextChange;
  onMapExtentChangeRef.current = onMapExtentChange;
  // Lags one run behind `mode` — only updated inside the AutoZoom effect
  // below, so it lets that effect tell "mode just changed" apart from
  // "zoomFilter changed" even though both are in its dependency array.
  const prevZoomEffectModeRef = useRef(mode); //chainage
  const showPopupRef = useRef(null);
  const closePopupRef = useRef(null);
  const osmReverseCacheRef = useRef(new Map());
  const amenityMarkerOverlayRef = useRef(null);
  const amenityMarkerElRef = useRef(null);
  const searchMarkerOverlayRef = useRef(null);
  const searchMarkerElRef = useRef(null);
  const searchAreaLayerRef = useRef(null);
  const searchAreaSourceRef = useRef(null);

  const drawInteractionRef = useRef(null); // ⭐ NEW
  const drawLayerRef = useRef(null); // ⭐ NEW
  const drawingActiveRef = useRef(false);

  const amenityLayersRef = useRef({});
  const otherLayersRef = useRef({});
  const lcluLayersRef = useRef({});
  const amenitiesGroupRef = useRef(null);
  const othersGroupRef = useRef(null);
  const streetLayerRef = useRef(null);
  const lastLayerFiltersRef = useRef({});

  const roadNetworkLayerRef = useRef(null); // 🔹 main road layer (search)
  const clickedGeometriesCacheRef = useRef(new Map()); // ⭐ NEW
  const roadClassLayersRef = useRef({}); // 🔹 classification layers
  const roadLabelsLayerRef = useRef(null);
  const analysisLayersRef = useRef({});
  const dssLayersRef = useRef({});
  const dssWmsLayerRef = useRef(null); // single active DSS WMS layer (foundation patch — GeoServer contract)
  const selectedRoadLayerRef = useRef(null);
  const candidateRoadLayerRef = useRef(null); //chainage
  const filteredRoadLayerRef = useRef(null);
  const filteredRoadColorRef = useRef(null);
  const roadWfsLayerRef = useRef(null);
  const roadWfsSourceRef = useRef(null);
  const roadWfsStyleCacheRef = useRef(new Map());
  const segmentedRoadsLayerRef = useRef(null);

  const specializedLayersRef = useRef({});
  const roadDetailsCacheRef = useRef(new Map());
  const featureInfoCacheRef = useRef(new Map());
  const amenityWfsCacheRef = useRef(new Map());
  const otherWfsCacheRef = useRef(new Map());
  const amenityFetchAbortRef = useRef(null);
  const otherFetchAbortRef = useRef(null);
  const roadWfsAbortRef = useRef(null);
  const autoZoomDetailsAbortRef = useRef(null);
  const amenityMoveTimerRef = useRef(null);
  const otherMoveTimerRef = useRef(null);
  const roadMoveTimerRef = useRef(null);
  const amenityExtentKeyRef = useRef("");
  const otherExtentKeyRef = useRef("");
  const roadWfsExtentKeyRef = useRef("");
  const lastSpatialExtentRef = useRef(null);
  const boundaryFeatureCacheRef = useRef(new Map());
  const boundaryFeaturesRef = useRef({ layerName: "", features: [] });
  const boundaryFetchAbortRef = useRef(null);
  // Flattened coordinate rings (in map projection) of the current city's
  // zone/ward boundary — read every render frame by the base-layer clip
  // listeners attached in the map-init effect. null/empty = render unclipped.
  const cityClipRingsRef = useRef(null);
  const stopLoadingTrackerRef = useRef(null);
  const roadOpacityRef = useRef(new Map());
  const selectedRoadGeomRef = useRef(null);
  const [selectedRoadToken, setSelectedRoadToken] = useState(0);
  const [isMobileView, setIsMobileView] = useState(window.innerWidth <= 768);
  const [isLocating, setIsLocating] = useState(false);
  const roadLayerRef = useRef(null); //chainage
  const chainageLayerRef = useRef(null); //chainage
  const [selectedRoad, setSelectedRoad] = useState(null);//chainage

  // Chainage candidate guidance (Stage 1) — automatic adjacent-road
  // highlighting once Road 1 is open in Chainage mode, so the user doesn't
  // have to separately open the table and press Multi to see what connects
  // to the road they're looking at. Deliberately local/independent state,
  // not derived from Dashboard's table-Multi selection (selectedRoadIds/
  // isMultiSelectMode) — the two flows must stay uncoupled.
  const [chainageRoad1Id, setChainageRoad1Id] = useState(null);
  const [chainageRoad2Id, setChainageRoad2Id] = useState(null);
  const [chainageRoad2Name, setChainageRoad2Name] = useState(null);
  const [chainageCandidateRoadIds, setChainageCandidateRoadIds] = useState([]);
  const [chainageCandidateRoads, setChainageCandidateRoads] = useState([]);
  // A 3rd road clicked while Road 1 and Road 2 are both already set — held
  // here while the user picks which of the two to remove, instead of just
  // rejecting the click with a toast.
  const [chainagePendingThirdClick, setChainagePendingThirdClick] = useState(null);
  const chainageCandidateLayerRef = useRef(null);
  const chainageCandidateFetchAbortRef = useRef(null);

  // Stage 2 — junction chainage detection. Once Road 2 is paired, this
  // holds where Road 1 and Road 2 actually meet (in the same chainage unit
  // /api/patch-preview and /api/create-patch already use), so Road 2 gets
  // its own chainage range anchored at that point instead of no chainage
  // data at all.
  const [chainageJunctionInfo, setChainageJunctionInfo] = useState(null); // {road1Value, road2Value, point}
  const [chainageJunctionLoading, setChainageJunctionLoading] = useState(false);
  const [chainageJunctionError, setChainageJunctionError] = useState(null);
  const [chainageRoad2ChainageList, setChainageRoad2ChainageList] = useState([]);
  const [chainageRoad2FreeValue, setChainageRoad2FreeValue] = useState(""); // user-picked end of the free side
  const chainageJunctionAbortRef = useRef(null);
  const chainageJunctionMarkerLayerRef = useRef(null);
  // The on-map chainage dot/label layer (chainageLayerRef, a single shared
  // WMS TileLayer — see its setup near the map init) only ever has one
  // CQL_FILTER active at a time. Rather than spin up a second WMS layer for
  // Road 2 (double the tile requests for the same GeoServer layer), both
  // roads' own already-correctly-quoted single-road predicates are kept
  // here and OR'd together into that one layer's filter — so it still only
  // ever renders exactly the 1-2 selected roads' chainage points, never the
  // whole city's. See applyChainageLayerFilter.
  const chainageRoad1CqlRef = useRef("");
  const chainageRoad2CqlRef = useRef("");
  // Cache of each road's full segment features (geometry + segment_id),
  // keyed by road id so re-rendering the same road's points/markers never
  // re-fetches. Populated by loadChainageSegments — shared by the junction
  // lookup (computeChainageJunction) and the point/live-marker layers below,
  // so pairing Road 2 costs zero extra fetches beyond what junction
  // detection already needed.
  const chainageRoad1SegmentsRef = useRef({ roadId: null, features: [] });
  const chainageRoad2SegmentsRef = useRef({ roadId: null, features: [] });
  // Sorted unique segment-suffix values for each road (sortedSegmentValues
  // applied to the cached features above) — real React state, not read
  // straight from the refs, specifically so the create-form dropdowns
  // re-render the moment a road's segments finish loading instead of
  // silently staying empty until some unrelated state change happens to
  // trigger a re-render.
  const [chainageRoad1Values, setChainageRoad1Values] = useState([]);
  const [chainageRoad2Values, setChainageRoad2Values] = useState([]);
  // All of a road's chainage distance points, rendered client-side (see
  // chainagePointStyle) — the readable replacement for the WMS raster dots.
  const chainagePointsLayerRef = useRef(null);
  // The 1-3 currently-picked Start/End values, shown bigger and in the same
  // green/red the real patch-preview flow already uses, updated live as the
  // user changes any dropdown — separate from chainagePointsLayerRef so
  // these can sit visually on top of the full point set.
  const chainageLiveMarkerLayerRef = useRef(null);
  // Live highlight of the actual patch extent (Road 1's Start->Junc, Road
  // 2's Junc->End) while still picking values, before CREATE is ever
  // pressed — built entirely from the already-cached segment features
  // above (same filter direction /api/patch-preview itself uses server
  // side), so it costs no extra network request no matter how often the
  // dropdowns change.
  const chainageLivePreviewLayerRef = useRef(null);
  // Once Road 2 is paired and its junction chainage on Road 1 is known,
  // Road 1's own End Chainage locks to that value — Road 1 always
  // contributes the free Start of the whole patch, Road 2 always
  // contributes the free End; the junction is the fixed midpoint between
  // them. Fixed roles, not derived from where the junction happens to fall
  // on either road's own range, so "Start Chainage -> Junc" (Road 1) then
  // "Junc -> End Chainage" (Road 2) always reads in that order.
  useEffect(() => {
    if (chainageJunctionInfo) {
      setEndChainage(String(chainageJunctionInfo.road1Value));
    }
  }, [chainageJunctionInfo]);

  const [chainageList, setChainageList] = useState([]);//chainage
  const [startChainage, setStartChainage] = useState("");//chainage
  const [endChainage, setEndChainage] = useState("");//chainage
  const [panelMinimized, setPanelMinimized] = useState(false);//chainage
  const [showCreateChainageForm, setShowCreateChainageForm] = useState(false);//chainage
  const [patchInfo, setPatchInfo] = useState(null);//chainage
  const [showPatchPanel, setShowPatchPanel] = useState(false);//chainage
  const [patchChoice, setPatchChoice] = useState(null);//chainage
  const patchLayerRef = useRef(null);//chainage
  const [patchList, setPatchList] = useState([]);//chainage
  const [selectedPatches, setSelectedPatches] = useState([]);//chainage
  const startMarkerSourceRef = useRef(new VectorSource());//chainage
  const endMarkerSourceRef = useRef(new VectorSource());//chainage
  const startMarkerLayerRef = useRef(null);//chainage
  const endMarkerLayerRef = useRef(null);//chainage
  const [patchTableData, setPatchTableData] = useState([]);//chainage
  const [showPatchTable, setShowPatchTable] = useState(false);//chainage
  const [isTableMinimized, setIsTableMinimized] = useState(false);//chainage
  const hasExternalZoomRef = useRef(false);//chainage
  const [showSubmitConfirm, setShowSubmitConfirm] = useState(false);//chainage
const [mapImage, setMapImage] = useState(null);//chainage
const finalImageBlobRef = useRef(null);//chainage
const [showPatchConfirm, setShowPatchConfirm] = useState(false);//chainage
const [patchConfirmImage, setPatchConfirmImage] = useState(null);//chainage
const [patchConfirmPending, setPatchConfirmPending] = useState(null);//chainage - {roadId, start, end}
const [patchConfirmSaving, setPatchConfirmSaving] = useState(false);//chainage
const patchPreviewLayerRef = useRef(null);//chainage
// Road 2's already-computed {roadId, start, end} for a combined two-road
// patch, set right before Road 1's own preview/confirm opens — once the
// user confirms Road 1's save, handleConfirmSavePatch reads this and
// automatically continues into Road 2's own preview/confirm, so one CREATE
// press walks through both halves of the patch instead of needing a
// second, separately-discovered button.
const pendingRoad2SaveRef = useRef(null);//chainage
  const [allPatchRows, setAllPatchRows] = useState([]);//chainage
  const [currentRoadPatchList, setCurrentRoadPatchList] = useState([]);//chainage
  const chainageRoadDataCacheRef = useRef(new Map());//chainage

  // Multi-road patch creation (field-task mode) — a patch spanning several
  // connected roads. Selection itself happens in Dashboard's table (its
  // Multi/Apply controls, filtered to /adjacent-roads candidates); this
  // component only runs the preview -> confirm -> save flow once Dashboard
  // hands it a finished road list. Reuses /api/create-patch per-road
  // underneath (same DB write path as the single-road flow above) rather
  // than a new schema — a patch ties to exactly one road_id in the DB, so a
  // 3-road patch is 3 rows created together, not 1 row spanning 3 roads.
  // //chainage
  const [multiRoadSelection, setMultiRoadSelection] = useState([]);//chainage - [{road_id, road_name}], set right before preview/confirm
  const [showMultiRoadConfirm, setShowMultiRoadConfirm] = useState(false);//chainage
  const [multiRoadConfirmImage, setMultiRoadConfirmImage] = useState(null);//chainage
  const [multiRoadConfirmSaving, setMultiRoadConfirmSaving] = useState(false);//chainage
  const multiRoadPreviewLayerRef = useRef(null);//chainage

  const URL_LOCATION_PIN_SVG = `data:image/svg+xml;utf8,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="42" height="56" viewBox="0 0 42 56">
  <path d="M21 2C10.5 2 3 9.7 3 20.3C3 34.5 21 54 21 54S39 34.5 39 20.3C39 9.7 31.5 2 21 2Z" fill="#E74C3C" stroke="#B91C1C" stroke-width="2"/>
  <circle cx="21" cy="20" r="7" fill="#FFFFFF" stroke="#B91C1C" stroke-width="2"/>
</svg>
`)}`;
const urlLocationMarkerSourceRef = useRef(new VectorSource());//chainage
const urlLocationMarkerLayerRef = useRef(null);//chainage
// Full-size pin while the worker hasn't picked a road yet ("you were
// dropped here"); once a road is selected, the pin has done its job and
// only needs to stay as a low-key reference point, not compete visually
// with the chainage layer that's now the priority.
const URL_LOCATION_PIN_STYLE = new Style({
  image: new Icon({
    src: URL_LOCATION_PIN_SVG,
    anchor: [0.5, 1],
    anchorXUnits: "fraction",
    anchorYUnits: "fraction",
    scale: 1,
  }),
});
const URL_LOCATION_DOT_STYLE = new Style({
  image: new CircleStyle({
    radius: 6,
    fill: new Fill({ color: "#E74C3C" }),
    stroke: new Stroke({ color: "#B91C1C", width: 1.5 }),
  }),
});
const location = useLocation();//chainage
// Lets the map-click handler (registered once inside the [city]-only map
// effect) read the *current* mode without a stale closure and without
// forcing that whole effect (and the map) to rebuild when mode toggles.
const modeRef = useRef(mode);//chainage
modeRef.current = mode;//chainage
// Same distinguishing signal Dashboard.jsx uses: mode=CHAINAGE alone can
// also mean someone manually toggled the generic Chainage button, not
// necessarily a KMC/iGile field-task redirect — project_id+user_id only
// ever come from the actual redirect link. Declared here (rather than
// nearer its other chainage-URL-param siblings further down) so it's
// available to openChainageForRoadId, defined earlier in this file.
const isFieldTaskMode = mode === "CHAINAGE" && (() => {
  const p = new URLSearchParams(location.search);
  return !!(p.get("project_id") && p.get("user_id"));
})();//chainage
// The one ward a field-task redirect actually assigns work in — neighboring
// wards (fieldTaskWardList) are loaded for context/labels only, per
// openChainageForRoadId's ward-membership gate below.
const fieldTaskTargetWard = isFieldTaskMode
  ? Number(new URLSearchParams(location.search).get("ward"))
  : NaN;//chainage

  useEffect(() => {
    const handleResize = () => {
      setIsMobileView(window.innerWidth <= 768);
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const handleLocateClick = () => {
    if (!navigator.geolocation || !mapRef.current) return;
    setIsLocating(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords || {};
        if (typeof latitude !== "number" || typeof longitude !== "number") {
          setIsLocating(false);
          return;
        }
        const view = mapRef.current.getView();
        const target = fromLonLat([longitude, latitude]);
        const currentZoom = view.getZoom() || 12;
        const targetZoom = Math.max(currentZoom, 16);
        view.animate({ center: target, zoom: targetZoom, duration: 800 });
        setIsLocating(false);
      },
      () => {
        setIsLocating(false);
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
    );
  };

const cfg1 = chainageCityConfig[city?.toLowerCase()];//chainage
  const [featureNotice, setFeatureNotice] = useState(null);
  const featureNoticeKeysRef = useRef(new Set());

  const getCityDisplayName = useCallback(() => {
    const key = String(city || "").toLowerCase();
    return cityConfig[key]?.name || city || "this city";
  }, [city]);

  const showFeatureNotice = useCallback(({
    feature = "This feature",
    message,
    layerName,
    cityName,
    dedupeKey,
    autoDismissMs,
  } = {}) => {
    const resolvedCity = cityName || getCityDisplayName();
    const key = dedupeKey || `${resolvedCity}|${feature}|${layerName || ""}`;
    if (featureNoticeKeysRef.current.has(key)) return;
    featureNoticeKeysRef.current.add(key);
    setFeatureNotice({
      feature,
      cityName: resolvedCity,
      layerName,
      message: message || `${feature} could not be loaded right now for ${resolvedCity}. You can continue using other map tools.`,
      autoDismissMs,
      noticeId: `${key}|${Date.now()}`,
    });
  }, [getCityDisplayName]);

  // Auto-dismiss transient notices (e.g. "please select a road") after their TTL.
  useEffect(() => {
    if (!featureNotice?.autoDismissMs) return;
    const timer = setTimeout(() => {
      setFeatureNotice((current) =>
        current?.noticeId === featureNotice.noticeId ? null : current
      );
    }, featureNotice.autoDismissMs);
    return () => clearTimeout(timer);
  }, [featureNotice]);

  const showApiUnavailableNotice = useCallback((payload, fallbackFeature = "This feature") => {
    if (!payload || payload.error !== "FEATURE_IN_PROGRESS") return false;
    showFeatureNotice({
      feature: payload.feature || fallbackFeature,
      cityName: payload.city,
      message: payload.message,
      dedupeKey: `${payload.city || city}|${payload.feature || fallbackFeature}`,
    });
    return true;
  }, [city, showFeatureNotice]);

  const showLayerUnavailableNotice = useCallback((payload = {}) => {
    const {
      feature = "Map layer",
      layerName,
      reason,
      autoDismissMs = 8000,
      dedupeKey,
    } = payload;
    const resolvedReason = reason || "The requested layer is currently unavailable. You can continue using the map with the other layers.";
    showFeatureNotice({
      feature,
      layerName,
      dedupeKey: dedupeKey || `${city}|layer|${layerName || feature}`,
      message: resolvedReason,
      autoDismissMs,
    });
  }, [city, showFeatureNotice]);

  // Dashboard's road/patch table is a bottom-anchored overlay, not part of
  // the map's own box layout, so a plain view.fit() has no idea it's
  // covering part of the screen — a road near the bottom of the fitted
  // extent can end up centered right underneath it. Measure its *actual*
  // rendered height (rather than the fixed 90/260/320 guesses this used to
  // fall back to) so this stays correct regardless of table content,
  // window size, or zoom level; the old guesses remain only as a fallback
  // for the brief window before the table has actually painted.
  const getTableCoverageHeight = () => {
    if (!tableHasRows) return 0;
    const tableEl = document.querySelector(".table-wrapper");
    const measured = tableEl?.getBoundingClientRect?.().height;
    if (measured && measured > 0) return measured;
    return tableMinimized ? 90 : (isMobileView ? 260 : 320);
  };

  const getAutoZoomPadding = (isIdentifierFilter) => {
    if (isIdentifierFilter) {
      // A single road selected from the table (road_id=X) used a flat 12px
      // pad on every side, ignoring the bottom table entirely - the fitted
      // view had no idea roughly a third of the screen was covered, so the
      // "zoomed to" road could land centered right behind it. Keep the tight
      // left/right/top (this fit is deliberately close-in for one road) but
      // still reserve real, measured space for the table at the bottom,
      // same as every other auto-zoom path below.
      const pad = 12;
      const bottom = tableHasRows ? Math.max(pad, getTableCoverageHeight()) : pad;
      return [pad, pad, bottom, pad];
    }

    if (isMobileView) {
      const bottom = tableHasRows ? getTableCoverageHeight() : 70;
      return [120, 20, bottom, 20];
    }

    const bottom = tableHasRows ? getTableCoverageHeight() : 40;
    const left = isSidebarOpen ? 320 : 40;
    const top = 50;
    const right = 40;
    return [top, right, bottom, left];
  };

  const setRoadDimming = (enabled) => {
    const mapCache = roadOpacityRef.current instanceof Map
      ? roadOpacityRef.current
      : new Map();
    roadOpacityRef.current = mapCache;
    const layers = [
      roadNetworkLayerRef.current,
      ...Object.values(roadClassLayersRef.current || {}),
      segmentedRoadsLayerRef.current,
    ].filter(Boolean);

    if (enabled) {
      layers.forEach((layer) => {
        if (!layer?.getVisible?.()) return;
        if (!mapCache.has(layer)) {
          const currentOpacity = typeof layer.getOpacity === "function" ? layer.getOpacity() : 1;
          mapCache.set(layer, currentOpacity ?? 1);
        }
        if (typeof layer.setOpacity === "function") {
          layer.setOpacity(ROAD_DIM_OPACITY);
        }
      });
      return;
    }

    if (mapCache.size > 0) {
      mapCache.forEach((opacity, layer) => {
        if (typeof layer?.setOpacity === "function") {
          layer.setOpacity(opacity ?? 1);
        }
      });
      mapCache.clear();
      return;
    }

    layers.forEach((layer) => {
      if (typeof layer?.setOpacity === "function") {
        layer.setOpacity(1);
      }
    });
  };

  const getExtentKey = (extent, zoom) => {
    if (!extent || extent.length !== 4) return "";
    const snapped = extent.map((v) => Math.round(v / 128)).join(",");
    const z = Number.isFinite(zoom) ? Math.round(zoom) : 0;
    return `${snapped}|${z}`;
  };

  const getStreetViewCacheKey = (lat, lng) => `${lat.toFixed(5)},${lng.toFixed(5)}`;

  const loadStreetViewCache = () => {
    if (streetViewCacheLoadedRef.current) return;
    streetViewCacheLoadedRef.current = true;
    try {
      const raw = localStorage.getItem(STREET_VIEW_CACHE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return;
      Object.entries(parsed).forEach(([key, value]) => {
        if (!value || typeof value.available !== "boolean" || !value.ts) return;
        if (Date.now() - value.ts < STREET_VIEW_TTL_MS) {
          streetViewCacheRef.current.set(key, value);
        }
      });
    } catch { }
  };

  const persistStreetViewCache = () => {
    try {
      const entries = Array.from(streetViewCacheRef.current.entries()).sort(
        (a, b) => (b[1]?.ts || 0) - (a[1]?.ts || 0)
      );
      const limited = entries.slice(0, STREET_VIEW_MAX_ENTRIES);
      const payload = limited.reduce((acc, [key, value]) => {
        acc[key] = value;
        return acc;
      }, {});
      localStorage.setItem(STREET_VIEW_CACHE_KEY, JSON.stringify(payload));
    } catch { }
  };

  const getCachedStreetView = (cacheKey) => {
    loadStreetViewCache();
    const cached = streetViewCacheRef.current.get(cacheKey);
    if (!cached) return null;
    if (Date.now() - cached.ts > STREET_VIEW_TTL_MS) {
      streetViewCacheRef.current.delete(cacheKey);
      return null;
    }
    return cached;
  };

  const setStreetViewCache = (cacheKey, available) => {
    if (typeof available !== "boolean") return;
    streetViewCacheRef.current.set(cacheKey, { ts: Date.now(), available });
    persistStreetViewCache();
  };

  const getStreetViewUrl = (lat, lng) =>
    `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}`;

  const getAmenityMaxFeatures = (zoom, lowBandwidth) => {
    const z = Number.isFinite(zoom) ? zoom : 0;
    if (lowBandwidth) {
      if (z < 12) return 80;
      if (z < 14) return 200;
      if (z < 16) return 450;
      return 800;
    }
    if (z < 12) return 150;
    if (z < 14) return 450;
    if (z < 16) return 900;
    return 1400;
  };

  const getRoadWfsMaxFeatures = (zoom, lowBandwidth) => {
    const z = Number.isFinite(zoom) ? zoom : 0;
    if (lowBandwidth) {
      if (z < 16) return 0;
      if (z < 18) return 900;
      return 1400;
    }
    if (z < 16) return 0;
    if (z < 18) return 1400;
    return 2200;
  };

  const getFeatureNumeric = (feature, keys) => {
    if (!feature || !keys) return null;
    const props = feature.getProperties?.() || feature.properties || {};
    const entries = Object.entries(props);
    for (const key of keys) {
      const match = entries.find(([k]) => String(k).toLowerCase() === String(key).toLowerCase());
      if (match) {
        const value = Number.parseFloat(match[1]);
        if (Number.isFinite(value)) return value;
      }
    }
    return null;
  };

  const getRoadStrokeWidth = (feature, resolution) => {
    const carriageWidth = getFeatureNumeric(feature, [
      "carriage_w",
      "carriageway",
      "carriage_way",
      "carriage_width",
      "row_meter",
      "row_m",
      "width",
    ]);
    if (Number.isFinite(carriageWidth) && resolution) {
      const px = carriageWidth / resolution;
      return Math.max(2, Math.min(16, px));
    }
    return computeStrokeWidth(resolution, 2.8);
  };

  const getRoadWfsStyle = (feature, resolution) => {
    let width = getRoadStrokeWidth(feature, resolution);
    const cache = roadWfsStyleCacheRef.current;
    if (baseMap === "satellite") {
      width = Math.max(3, width);
    }
    const key = `${baseMap}|${Math.round(width * 10) / 10}`;
    if (cache.has(key)) return cache.get(key);
    const styles = baseMap === "satellite"
      ? [
        new Style({
          stroke: new Stroke({
            color: "rgba(0,0,0,0.65)",
            width: width + 2,
            lineCap: "round",
            lineJoin: "round",
          }),
        }),
        new Style({
          stroke: new Stroke({
            color: "rgba(255,235,59,0.95)",
            width,
            lineCap: "round",
            lineJoin: "round",
          }),
        }),
      ]
      : [
        new Style({
          stroke: new Stroke({
            color: "rgba(0,0,0,0.35)",
            width,
            lineCap: "round",
            lineJoin: "round",
          }),
        }),
      ];
    cache.set(key, styles);
    return styles;
  };

  const fetchNearestRoadFeature = async (coordinate, viewResolution, projection, signal) => {
    const cfg = cityConfig[city.toLowerCase()] || {};
    const typeName = cfg.roadLayer;
    if (!typeName) return null;
    const mapUnitsRadius = Math.max(15, Math.min(viewResolution * 12, 200));
    const [x, y] = toLonLat(coordinate, projection || mapRef.current?.getView?.().getProjection());
    const cql = `DWITHIN(geom, POINT(${x} ${y}), ${mapUnitsRadius}, meters)`;
    const wfsUrl =
      `${GEOSERVER_BASE}/Road_Network/wfs` +
      `?service=WFS` +
      `&version=1.1.0` +
      `&request=GetFeature` +
      `&typeName=${encodeURIComponent(typeName)}` +
      `&outputFormat=application/json` +
      `&srsName=EPSG:4326` +
      `&CQL_FILTER=${encodeURIComponent(cql)}`;

    const response = await fetch(wfsUrl, { signal });
    const data = await response.json();
    const features = data?.features || [];
    if (!features.length) return null;

    const format = new GeoJSON();
    let best = null;
    let bestDist = Number.POSITIVE_INFINITY;
    const viewProj = projection?.getCode?.();
    for (const feature of features) {
      const olFeature = format.readFeature(feature, {
        dataProjection: "EPSG:4326",
        featureProjection: viewProj,
      });
      const geom = olFeature?.getGeometry?.();
      if (!geom || typeof geom.getClosestPoint !== "function") continue;
      const closest = geom.getClosestPoint(coordinate);
      const dx = closest[0] - coordinate[0];
      const dy = closest[1] - coordinate[1];
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        best = feature;
      }
    }
    return best;
  };

  const handleLatLngSearch = async (lat, lng) => {
    const map = mapRef.current;
    if (!map) return;
    const view = map.getView();
    const projection = view?.getProjection?.();
    if (!projection) return;
    const maxZoom = baseMap === "satellite" ? 18 : 20;
    const targetZoom = Math.min(maxZoom, baseMap === "satellite" ? 18 : 19);
    const center = fromLonLat([lng, lat], projection);
    view.animate({ center, zoom: targetZoom, duration: 450 });
    if (searchMarkerOverlayRef.current) {
      searchMarkerOverlayRef.current.setPosition(center);
    }
    const controller = new AbortController();
    const viewResolution = view.getResolution?.() || 1;
    let nearestRoad = null;
    try {
      nearestRoad = await fetchNearestRoadFeature(center, viewResolution, projection, controller.signal);
    } catch { }
    const cacheKey = `${lng.toFixed(5)},${lat.toFixed(5)}`;
    const cached = osmReverseCacheRef.current.get(cacheKey);
    if (cached && Date.now() - cached.ts < 60000) {
      if (cached.feature && showPopupRef.current) {
        const merged = {
          properties: {
            ...(cached.feature.properties || {}),
            nearest_road_name: nearestRoad?.properties?.road_name || nearestRoad?.properties?.ROAD_NAME,
            nearest_road_id: nearestRoad?.properties?.road_id || nearestRoad?.properties?.ROAD_ID,
          },
        };
        await showPopupRef.current(merged, cached.title, center, false, false, null, true);
      }
      return;
    }
    const url =
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(
        lat
      )}&lon=${encodeURIComponent(lng)}&zoom=18&addressdetails=1&extratags=1`;
    const result = await fetchJsonWithTimeout(url, 1800, controller.signal);
    if (!result?.aborted && result?.data) {
      const data = result.data || {};
      const name = data.name || data.display_name || "Location";
      const kind = data.type || data.class;
      const category = data.category || data.class;
      const feature = {
        properties: {
          name,
          category,
          type: kind,
          ...data.address,
          nearest_road_name: nearestRoad?.properties?.road_name || nearestRoad?.properties?.ROAD_NAME,
          nearest_road_id: nearestRoad?.properties?.road_id || nearestRoad?.properties?.ROAD_ID,
        },
      };
      const title = String(name || kind || "Location");
      osmReverseCacheRef.current.set(cacheKey, { ts: Date.now(), feature, title });
      if (showPopupRef.current) {
        await showPopupRef.current(feature, title, center, false, false, null, true);
      }
      return;
    }
    if (nearestRoad && showPopupRef.current) {
      await showPopupRef.current(nearestRoad, "Nearest Road", center, true, true, null, true);
    }
  };

  const handlePlaceSearch = async (place) => {
    if (!place) return;
    const map = mapRef.current;
    if (!map) return;
    const view = map.getView();
    const projection = view?.getProjection?.();
    if (!projection) return;
    const lat = Number(place.lat);
    const lng = Number(place.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const center = fromLonLat([lng, lat], projection);
    const maxZoom = baseMap === "satellite" ? 18 : 20;
    const targetZoom = Math.min(maxZoom, baseMap === "satellite" ? 18 : 19);

    let bbox = null;
    if (Array.isArray(place.boundingbox) && place.boundingbox.length === 4) {
      const south = Number(place.boundingbox[0]);
      const north = Number(place.boundingbox[1]);
      const west = Number(place.boundingbox[2]);
      const east = Number(place.boundingbox[3]);
      if ([south, north, west, east].every((n) => Number.isFinite(n))) {
        bbox = { south, north, west, east };
      }
    }

    if (searchAreaSourceRef.current) {
      searchAreaSourceRef.current.clear();
      if (place.geojson) {
        try {
          const format = new GeoJSON();
          const feature = format.readFeature(
            { type: "Feature", geometry: place.geojson, properties: {} },
            { dataProjection: "EPSG:4326", featureProjection: projection.getCode() }
          );
          if (feature) {
            searchAreaSourceRef.current.addFeature(feature);
            const extent = feature.getGeometry?.().getExtent?.();
            if (extent && view) {
              view.fit(extent, { padding: getAutoZoomPadding(false), duration: 450, maxZoom: targetZoom });
            }
          }
        } catch { }
      } else if (bbox) {
        const min = fromLonLat([bbox.west, bbox.south], projection);
        const max = fromLonLat([bbox.east, bbox.north], projection);
        const extent = [min[0], min[1], max[0], max[1]];
        const geometry = Polygon.fromExtent(extent);
        const feature = new Feature({ geometry });
        searchAreaSourceRef.current.addFeature(feature);
        if (view) {
          view.fit(extent, { padding: getAutoZoomPadding(false), duration: 450, maxZoom: targetZoom });
        }
      }
    }

    if (!place.geojson && view) {
      view.animate({ center, zoom: targetZoom, duration: 450 });
    }
    if (searchMarkerOverlayRef.current) {
      searchMarkerOverlayRef.current.setPosition(center);
    }

    if (bbox) {
      const filter = `BBOX(geom, ${bbox.west}, ${bbox.south}, ${bbox.east}, ${bbox.north})`;
      applyRoadFilterImmediate(filter);
      if (roadNetworkLayerRef.current?.setVisible) roadNetworkLayerRef.current.setVisible(true);
      if (roadLabelsLayerRef.current?.setVisible) roadLabelsLayerRef.current.setVisible(true);
    }

    const controller = new AbortController();
    const viewResolution = view.getResolution?.() || 1;
    let nearestRoad = null;
    try {
      nearestRoad = await fetchNearestRoadFeature(center, viewResolution, projection, controller.signal);
    } catch { }
    if (showPopupRef.current) {
      const feature = {
        properties: {
          name: place.name || place.display_name,
          display_name: place.display_name,
          type: place.type,
          category: place.class,
          ...(place.address || {}),
          nearest_road_name: nearestRoad?.properties?.road_name || nearestRoad?.properties?.ROAD_NAME,
          nearest_road_id: nearestRoad?.properties?.road_id || nearestRoad?.properties?.ROAD_ID,
        },
      };
      const title = String(place.name || place.display_name || "Location");
      await showPopupRef.current(feature, title, center, false, false, null, true);
    }
  };

  const readFeaturesWithProjection = (data, projection) => {
    const raw = data && data.features ? data.features : [];
    const firstCoord = raw.length > 0 ? getFirstCoord(raw[0]?.geometry) : null;
    const viewProj = projection.getCode();
    const assumeLonLat =
      !!firstCoord &&
      Math.abs(firstCoord[0]) <= 180 &&
      Math.abs(firstCoord[1]) <= 90 &&
      String(viewProj).includes("3857");
    return new GeoJSON().readFeatures(data, {
      dataProjection: assumeLonLat ? "EPSG:4326" : viewProj,
      featureProjection: viewProj,
    });
  };

  const getSelectedRoadGeometry = () =>
    selectedRoadGeomRef.current ||
    selectedRoadLayerRef.current?.getSource?.()?.getFeatures?.()?.[0]?.getGeometry?.() ||
    null;
  const setSelectedRoadGeometry = (geometry) => {
    const next = geometry || null;
    const prev = selectedRoadGeomRef.current || null;
    if (!prev && !next) return;
    if (prev === next) return;
    selectedRoadGeomRef.current = next;
    setSelectedRoadToken((value) => value + 1);
  };

  const updateWfsCounts = (id, prefix, count, source) => {
    if (!Number.isFinite(count)) return;
    if (prefix === "AmenityWFS") {
      const prevSource = amenityWfsCountSourceRef.current[id];
      if (source === "features" && prevSource === "hits") return;
      if (amenityWfsCountsRef.current[id] === count && prevSource === source) return;
      amenityWfsCountSourceRef.current = {
        ...amenityWfsCountSourceRef.current,
        [id]: source,
      };
      const wfsNext = { ...amenityWfsCountsRef.current, [id]: count };
      amenityWfsCountsRef.current = wfsNext;
      const merged = mergeAmenityCounts(wfsNext, osmAmenityCountsRef.current);
      if (haveCountsChanged(amenityLegendCountsRef.current, merged)) {
        amenityLegendCountsRef.current = merged;
        setAmenityLegendCounts(merged);
      }
    } else if (prefix === "OtherWFS") {
      const prevSource = otherWfsCountSourceRef.current[id];
      if (source === "features" && prevSource === "hits") return;
      if (otherWfsCountsRef.current[id] === count && prevSource === source) return;
      otherWfsCountSourceRef.current = {
        ...otherWfsCountSourceRef.current,
        [id]: source,
      };
      const next = { ...otherWfsCountsRef.current, [id]: count };
      otherWfsCountsRef.current = next;
      const merged = mergeOtherCounts(next, osmOtherCountsRef.current);
      if (haveCountsChanged(otherLegendCountsRef.current, merged)) {
        otherLegendCountsRef.current = merged;
        setOtherLegendCounts(merged);
      }
    }
  };

  const applyWfsData = (layer, data, projection, id, prefix) => {
    const source = layer.getSource();
    if (!source) return;
    let features = readFeaturesWithProjection(data, projection);
    const selectedRoadGeom = getSelectedRoadGeometry();
    if (selectedRoadGeom && (prefix === "AmenityWFS" || prefix === "OtherWFS")) {
      features = features.filter((feature) => {
        const geom = feature?.getGeometry?.();
        if (!geom) return false;
        return getGeometryDistance(selectedRoadGeom, geom) <= ROAD_PROXIMITY_METERS;
      });
    }

    source.clear();
    source.addFeatures(features);
    if (features.length > 0) {
      source.changed();
      layer.changed();
      const mapObj = mapRef.current;
      if (mapObj) {
        mapObj.render();
      }
    }
    updateWfsCounts(id, prefix, features.length, "features");
    console.log(`[${prefix}] Loaded ${features.length} features for ${id}`);
  };

  const extractWfsCount = (text) => {
    if (!text) return null;
    const match =
      String(text).match(/numberOfFeatures=["'](\d+)["']/i) ||
      String(text).match(/numberMatched=["'](\d+)["']/i);
    return match ? Number(match[1]) : null;
  };

  const fetchWfsCount = ({
    layerName,
    projection,
    extent,
    extentKey,
    cacheRef,
    cacheTtlMs,
    abortSignal,
    id,
    prefix,
  }) => {
    if (!layerName || !projection || !extent) return;
    const cacheKey = `${layerName}|${projection.getCode()}|${extentKey}|hits`;
    if (cacheTtlMs > 0) {
      const cached = cacheRef.current.get(cacheKey);
      if (cached && Date.now() - cached.ts < cacheTtlMs) {
        updateWfsCounts(id, prefix, cached.count, "hits");
        return;
      }
    }
    const url =
      `${AMENITIES_WFS}?service=WFS&version=1.1.0&request=GetFeature` +
      `&typeName=${encodeURIComponent(layerName)}` +
      `&resultType=hits` +
      `&srsName=${encodeURIComponent(projection.getCode())}` +
      `&bbox=${extent.join(",")},${encodeURIComponent(projection.getCode())}`;
    fetch(url, { signal: abortSignal })
      .then((res) => res.text())
      .then((text) => {
        if (abortSignal?.aborted) return;
        const count = extractWfsCount(text);
        if (!Number.isFinite(count)) return;
        if (cacheTtlMs > 0) {
          cacheRef.current.set(cacheKey, { ts: Date.now(), count });
        }
        updateWfsCounts(id, prefix, count, "hits");
      })
      .catch(() => {
        if (abortSignal?.aborted) return;
      });
  };

  const fetchWfsLayerData = ({
    layer,
    layerName,
    projection,
    extent,
    extentKey,
    maxFeatures,
    cacheRef,
    cacheTtlMs,
    abortSignal,
    id,
    prefix,
  }) => {
    if (!layerName || !projection || !extent) return;
    const cacheKey = `${layerName}|${projection.getCode()}|${extentKey}|${maxFeatures}`;
    if (cacheTtlMs > 0) {
      const cached = cacheRef.current.get(cacheKey);
      if (cached && Date.now() - cached.ts < cacheTtlMs) {
        applyWfsData(layer, cached.data, projection, id, prefix);
        return;
      }
    }
    const url =
      `${AMENITIES_WFS}?service=WFS&version=1.1.0&request=GetFeature` +
      `&typeName=${encodeURIComponent(layerName)}` +
      `&outputFormat=application/json` +
      `&srsName=${encodeURIComponent(projection.getCode())}` +
      `&bbox=${extent.join(",")},${encodeURIComponent(projection.getCode())}` +
      `&maxFeatures=${maxFeatures}`;
    fetch(url, { signal: abortSignal })
      .then((res) => res.json())
      .then((data) => {
        if (abortSignal?.aborted) return;
        if (cacheTtlMs > 0) {
          cacheRef.current.set(cacheKey, { ts: Date.now(), data });
        }
        applyWfsData(layer, data, projection, id, prefix);
      })
      .catch((err) => {
        if (abortSignal?.aborted) return;
        showFeatureNotice({
          feature: `${prefix} layer`,
          layerName,
          dedupeKey: `${city}|wfs|${layerName || id}`,
        });
      });
  };

  const applyOsmAmenityData = (elements, projection, amenityIds) => {
    const featuresById = {};
    const counts = {};
    amenityIds.forEach((id) => {
      featuresById[id] = [];
      counts[id] = 0;
    });

    const boundaryFeatures = boundaryFeaturesRef.current?.features || [];
    const hasBoundary = boundaryFeatures.length > 0;

    elements.forEach((element) => {
      const tags = element?.tags || {};
      const matchedId = matchOsmAmenityId(tags, amenityIds);
      if (!matchedId) return;
      const wfsFeatures =
        amenityLayersRef.current?.[matchedId]?.getSource?.()?.getFeatures?.() || [];
      const selectedRoadGeom = getSelectedRoadGeometry();

      if (matchedId === "park") {
        const geom = element?.geometry;
        if (!Array.isArray(geom) || geom.length < 3) return;
        const ring = geom
          .filter((pt) => pt && Number.isFinite(pt.lon) && Number.isFinite(pt.lat))
          .map((pt) => fromLonLat([pt.lon, pt.lat], projection));
        if (ring.length < 3) return;
        const polygon = new Polygon([ring]);
        if (isExtentNearFeatures(polygon.getExtent(), wfsFeatures, OSM_DEDUP_DISTANCE_METERS)) {
          return;
        }
        if (selectedRoadGeom && getGeometryDistance(selectedRoadGeom, polygon) > ROAD_PROXIMITY_METERS) {
          return;
        }
        if (hasBoundary) {
          const isInside = boundaryFeatures.some((feature) =>
            feature.getGeometry?.()?.intersectsExtent?.(polygon.getExtent())
          );
          if (!isInside) return;
        }
        const feature = new Feature({
          geometry: polygon,
          name:
            tags.name ||
            tags.operator ||
            tags.brand ||
            tags.amenity ||
            tags.leisure ||
            tags.highway,
          osm_id: element.id,
          osm_type: element.type,
          ...tags,
        });
        featuresById[matchedId].push(feature);
        return;
      }

      const coord = getOsmElementCoord(element);
      if (!coord) return;
      const mapCoord = fromLonLat(coord, projection);
      const pointExtent = [mapCoord[0], mapCoord[1], mapCoord[0], mapCoord[1]];
      if (isExtentNearFeatures(pointExtent, wfsFeatures, OSM_DEDUP_DISTANCE_METERS)) return;
      if (selectedRoadGeom && getGeometryDistance(selectedRoadGeom, new Point(mapCoord)) > ROAD_PROXIMITY_METERS) {
        return;
      }
      if (hasBoundary) {
        const isInside = boundaryFeatures.some((feature) =>
          feature.getGeometry?.()?.intersectsCoordinate?.(mapCoord)
        );
        if (!isInside) return;
      }
      const geometry = new Point(mapCoord);
      const feature = new Feature({
        geometry,
        name:
          tags.name ||
          tags.operator ||
          tags.brand ||
          tags.amenity ||
          tags.leisure ||
          tags.highway,
        osm_id: element.id,
        osm_type: element.type,
        ...tags,
      });
      featuresById[matchedId].push(feature);
    });

    Object.entries(osmAmenityLayersRef.current || {}).forEach(([id, layer]) => {
      const source = layer.getSource?.();
      if (!source) return;
      source.clear();
      if (featuresById[id]?.length) {
        source.addFeatures(featuresById[id]);
      }
      counts[id] = featuresById[id]?.length || 0;
    });

    const nextOsmCounts = { ...osmAmenityCountsRef.current, ...counts };
    osmAmenityCountsRef.current = nextOsmCounts;
    const merged = mergeAmenityCounts(amenityWfsCountsRef.current, nextOsmCounts);
    if (haveCountsChanged(amenityLegendCountsRef.current, merged)) {
      amenityLegendCountsRef.current = merged;
      setAmenityLegendCounts(merged);
    }
  };

  const fetchOsmAmenityData = async ({ amenityIds, extent, projection, abortSignal }) => {
    if (!amenityIds.length) return;
    const bbox = getOsmBbox(extent, projection);
    if (!bbox) return;
    const filters = amenityIds.flatMap((id) => OSM_AMENITY_FILTERS[id] || []);
    if (!filters.length) return;
    const cacheKey = `${bbox.join(",")}|${amenityIds.slice().sort().join(",")}`;
    const cached = osmAmenityCacheRef.current.get(cacheKey);
    if (cached && Date.now() - cached.ts < 60000) {
      applyOsmAmenityData(cached.data || [], projection, amenityIds);
      return;
    }
    const query = buildOverpassQuery(filters, bbox);
    if (!query) return;
    try {
      const response = await fetch(OSM_OVERPASS_URL, {
        method: "POST",
        body: query,
        signal: abortSignal,
      });
      if (abortSignal?.aborted) return;
      if (!response.ok) return;
      const data = await response.json();
      if (abortSignal?.aborted) return;
      const elements = Array.isArray(data?.elements) ? data.elements : [];
      osmAmenityCacheRef.current.set(cacheKey, { ts: Date.now(), data: elements });
      applyOsmAmenityData(elements, projection, amenityIds);
    } catch (error) {
      if (abortSignal?.aborted || error?.name === "AbortError") return;
      console.error("OSM amenity fetch failed:", error);
    }
  };

  const applyOsmOtherData = (elements, projection, otherIds) => {
    const featuresById = {};
    const counts = {};
    otherIds.forEach((id) => {
      featuresById[id] = [];
      counts[id] = 0;
    });

    const boundaryFeatures = boundaryFeaturesRef.current?.features || [];
    const hasBoundary = boundaryFeatures.length > 0;

    elements.forEach((element) => {
      const tags = element?.tags || {};
      const matchedId = matchOsmOtherId(tags, otherIds);
      if (!matchedId) return;
      const wfsFeatures =
        otherLayersRef.current?.[matchedId]?.getSource?.()?.getFeatures?.() || [];
      const selectedRoadGeom = getSelectedRoadGeometry();
      const coord = getOsmElementCoord(element);
      if (!coord) return;
      const mapCoord = fromLonLat(coord, projection);
      const pointExtent = [mapCoord[0], mapCoord[1], mapCoord[0], mapCoord[1]];
      if (isExtentNearFeatures(pointExtent, wfsFeatures, OSM_DEDUP_DISTANCE_METERS)) return;
      if (selectedRoadGeom && getGeometryDistance(selectedRoadGeom, new Point(mapCoord)) > ROAD_PROXIMITY_METERS) {
        return;
      }
      if (hasBoundary) {
        const isInside = boundaryFeatures.some((feature) =>
          feature.getGeometry?.()?.intersectsCoordinate?.(mapCoord)
        );
        if (!isInside) return;
      }
      const geometry = new Point(mapCoord);
      const feature = new Feature({
        geometry,
        name:
          tags.name ||
          tags.operator ||
          tags.brand ||
          tags.amenity ||
          tags.tourism ||
          tags.historic ||
          tags.man_made,
        osm_id: element.id,
        osm_type: element.type,
        ...tags,
      });
      featuresById[matchedId].push(feature);
    });

    Object.entries(osmOtherLayersRef.current || {}).forEach(([id, layer]) => {
      const source = layer.getSource?.();
      if (!source) return;
      source.clear();
      if (featuresById[id]?.length) {
        source.addFeatures(featuresById[id]);
      }
      counts[id] = featuresById[id]?.length || 0;
    });

    const nextOsmCounts = { ...osmOtherCountsRef.current, ...counts };
    osmOtherCountsRef.current = nextOsmCounts;
    const merged = mergeOtherCounts(otherWfsCountsRef.current, nextOsmCounts);
    if (haveCountsChanged(otherLegendCountsRef.current, merged)) {
      otherLegendCountsRef.current = merged;
      setOtherLegendCounts(merged);
    }
  };

  const fetchOsmOtherData = async ({ otherIds, extent, projection, abortSignal }) => {
    if (!otherIds.length) return;
    const bbox = getOsmBbox(extent, projection);
    if (!bbox) return;
    const filters = otherIds.flatMap((id) => OSM_OTHER_FILTERS[id] || []);
    if (!filters.length) return;
    const cacheKey = `${bbox.join(",")}|${otherIds.slice().sort().join(",")}`;
    const cached = osmOtherCacheRef.current.get(cacheKey);
    if (cached && Date.now() - cached.ts < 60000) {
      applyOsmOtherData(cached.data || [], projection, otherIds);
      return;
    }
    const query = buildOverpassQuery(filters, bbox);
    if (!query) return;
    try {
      const response = await fetch(OSM_OVERPASS_URL, {
        method: "POST",
        body: query,
        signal: abortSignal,
      });
      if (abortSignal?.aborted) return;
      if (!response.ok) return;
      const data = await response.json();
      if (abortSignal?.aborted) return;
      const elements = Array.isArray(data?.elements) ? data.elements : [];
      osmOtherCacheRef.current.set(cacheKey, { ts: Date.now(), data: elements });
      applyOsmOtherData(elements, projection, otherIds);
    } catch (error) {
      if (abortSignal?.aborted || error?.name === "AbortError") return;
      console.error("OSM other fetch failed:", error);
    }
  };

  const refreshWmsLayer = (layer) => {
    if (!layer) return;
    if (typeof layer.getVisible === "function" && !layer.getVisible()) return;
    const source = layer.getSource?.();
    if (!source) return;
    if (typeof source.updateParams === "function") {
      source.updateParams({ _t: Date.now() });
    } else if (typeof source.refresh === "function") {
      source.refresh();
    }
    if (typeof layer.changed === "function") {
      layer.changed();
    }
  };

  const refreshRoadWmsLayers = () => {
    const layers = [
      roadNetworkLayerRef.current,
      roadLabelsLayerRef.current,
      segmentedRoadsLayerRef.current,
      chainageLayerRef.current,
      ...Object.values(specializedLayersRef.current),
      ...Object.values(roadClassLayersRef.current || {}),
    ].filter(Boolean);
    layers.forEach(refreshWmsLayer);
    mapRef.current?.renderSync?.();
  };

  const applyRoadFilterImmediate = (filter) => {
    const filterValue = filter || null;
    applyCqlToTileLayer(roadNetworkLayerRef.current, filterValue, "Road_Network");
    applyCqlToTileLayer(roadLabelsLayerRef.current, filterValue, "Road_Network");
    Object.values(roadClassLayersRef.current || {}).forEach((layer) => {
      applyCqlToTileLayer(layer, filterValue, "Road_Network");
    });
    refreshRoadWmsLayers();
  };

  const ensureMapInteractions = (map) => {
    if (!map?.getInteractions) return;
    map.getInteractions().forEach((interaction) => {
      if (interaction?.setActive) {
        interaction.setActive(true);
      }
    });
  };
  const isValidExtent = (e) =>
    Array.isArray(e) &&
    e.length === 4 &&
    e.every((n) => Number.isFinite(n)) &&
    e[0] <= e[2] &&
    e[1] <= e[3];

  const normalizeExtent = (extent, view) => {
    if (!isValidExtent(extent)) return null;
    const [minX, minY, maxX, maxY] = extent;
    const width = maxX - minX;
    const height = maxY - minY;
    const resolution = view?.getResolution?.() || 1;

    if (width === 0 && height === 0) {
      const pad = resolution * 20;
      return [minX - pad, minY - pad, maxX + pad, maxY + pad];
    }
    if (width === 0) {
      const pad = Math.max(resolution * 10, height * 0.1);
      return [minX - pad, minY, maxX + pad, maxY];
    }
    if (height === 0) {
      const pad = Math.max(resolution * 10, width * 0.1);
      return [minX, minY - pad, maxX, maxY + pad];
    }
    return extent;
  };

  const fetchBoundaryFeatures = async (layerName, projection) => {
    if (!layerName || !projection) return [];
    const cacheKey = `${layerName}|${projection.getCode()}`;
    const cached = boundaryFeatureCacheRef.current.get(cacheKey);
    if (cached) return cached;
    const [workspace, ...layerParts] = String(layerName).split(":");
    const layerId = layerParts.join(":");
    if (!workspace || !layerId) {
      showFeatureNotice({
        feature: "Boundary layer",
        layerName,
        dedupeKey: `${city}|boundary-layer-name|${layerName}`,
      });
      return [];
    }
    if (boundaryFetchAbortRef.current) boundaryFetchAbortRef.current.abort();
    const controller = new AbortController();
    boundaryFetchAbortRef.current = controller;
    const url = `/api/boundary-geojson/${encodeURIComponent(workspace)}/${encodeURIComponent(layerId)}`;
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok || controller.signal.aborted) return [];
      const data = await res.json();
      if (controller.signal.aborted) return [];
      const features = readFeaturesWithProjection(data, projection);
      boundaryFeatureCacheRef.current.set(cacheKey, features);
      return features;
    } catch (err) {
      if (controller.signal.aborted) return [];
      showFeatureNotice({
        feature: "Boundary layer",
        layerName,
        dedupeKey: `${city}|boundary-wfs|${layerName}`,
      });
      return [];
    }
  };

  // =====================================================
  // MAP INITIALIZATION
  // =====================================================
  useEffect(() => {
    const cityKey = city.toLowerCase();
    const cfg = cityConfig[cityKey] || {};
    const activeBaseMap = baseMap || "osm";

    // ---------- BASE MAPS ----------

    // 1️⃣ Create all base layers (migrated from HomePage.js)
    const osmLayer = new TileLayer({
      title: "OpenStreetMap",
      type: "base",
      visible: activeBaseMap === "osm",
      preload: 1,
      maxZoom: 19,
      source: makeCachedXyzSource({
        style: "osm",
        boundary: cfg.zoneLayer || cfg.wardLayer,
        fallbackUrl: "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
        attributions:
          'Map data &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19,
      }),
    });

    const positronLayer = new TileLayer({
      title: "CartoDB Positron",
      type: "base",
      visible: activeBaseMap === "positron",
      preload: 1,
      maxZoom: 20,
      source: makeCachedXyzSource({
        style: "positron",
        boundary: cfg.zoneLayer || cfg.wardLayer,
        fallbackUrl: "https://1.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
        attributions:
          'Map tiles by <a href="https://carto.com/attributions">CARTO</a>, Data by <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 20,
      }),
    });

    const satelliteLayer = new TileLayer({
      title: "Satellite",
      type: "base",
      visible: true,
      preload: 1,
      maxZoom: SATELLITE_MAX_ZOOM,
      source: makeCachedXyzSource({
        style: "satellite",
        boundary: cfg.zoneLayer || cfg.wardLayer,
        fallbackUrl: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        attributions: 'Tiles &copy; <a href="https://www.esri.com/">Esri</a>',
        maxZoom: SATELLITE_MAX_ZOOM,
      }),
    });

    const tonerLayer = new TileLayer({
      title: "Toner",
      type: "base",
      visible: activeBaseMap === "toner",
      preload: 1,
      maxZoom: 20,
      source: makeCachedXyzSource({
        style: "toner",
        boundary: cfg.zoneLayer || cfg.wardLayer,
        fallbackUrl: "https://1.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
        attributions:
          'Map tiles by <a href="https://carto.com/attributions">CARTO</a>, ' +
          'Data by <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, ' +
          'under <a href="https://opendatacommons.org/licenses/odbl/">ODbL</a>.',
        maxZoom: 20,
      }),
    });

    const topoLayer = new TileLayer({
      title: "Topo",
      type: "base",
      visible: activeBaseMap === "topo",
      preload: 1,
      maxZoom: 17,
      source: makeCachedXyzSource({
        style: "topo",
        boundary: cfg.zoneLayer || cfg.wardLayer,
        fallbackUrl: "https://a.tile.opentopomap.org/{z}/{x}/{y}.png",
        attributions:
          'Map data: <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, ' +
          'SRTM | Map style: <a href="https://opentopomap.org">OpenTopoMap</a> ' +
          '(<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)',
        maxZoom: 17,
      }),
    });

    // Esri reference labels — deliberately NOT nested inside
    // satelliteWithLabels below (it used to be, combined via combine:true
    // into a single composited render). LCLU classification layers sit at
    // zIndex 55, and a combined base-map render always draws beneath every
    // regular overlay regardless of what's inside it, so place names were
    // getting buried under an opaque LCLU layer with no way to read them.
    // A standalone layer with its own zIndex above 55 renders labels back
    // on top while the satellite imagery itself stays underneath LCLU,
    // same as every other base map. Own visibility (not inherited from a
    // parent group) is toggled by handleBaseMapChange in Dashboard.jsx —
    // see the "Labels (Esri Reference)" title match there.
    const labelsLayer = new TileLayer({
      title: "Labels (Esri Reference)",
      visible: activeBaseMap === "satellite",
      preload: 1,
      maxZoom: SATELLITE_MAX_ZOOM,
      source: makeCachedXyzSource({
        style: "labels",
        boundary: cfg.zoneLayer || cfg.wardLayer,
        fallbackUrl: "https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
        attributions: 'Labels &copy; <a href="https://www.esri.com/">Esri</a>',
        maxZoom: SATELLITE_MAX_ZOOM,
      }),
    });
    // Above LCLU (55) so satellite-mode place names stay legible over a
    // land-cover overlay; zone/ward boundaries are unaffected by any of
    // this — they're outline+label vector layers with no fill, so they
    // never visually cover labels regardless of z-order.
    labelsLayer.setZIndex(60);

    const satelliteWithLabels = new LayerGroup({
      title: "Satellite + Labels",
      type: "base",
      combine: true,
      visible: activeBaseMap === "satellite",
      layers: [satelliteLayer],
    });

    const baseMaps = new LayerGroup({
      title: "Base Maps",
      layers: [osmLayer, positronLayer, satelliteWithLabels, tonerLayer, topoLayer],
      fold: "open",
    });

    // Basemap outage detection: a burst of tile errors on any style
    // triggers one probe of the tile proxy to classify the failure
    // (deployment network blocking the provider vs the provider's own
    // outage) and tells the user the right story via the same notice UI
    // used for other feature failures. See utils/basemapHealth.js.
    [
      [osmLayer, "osm", "OpenStreetMap"],
      [positronLayer, "positron", "CartoDB Positron"],
      [satelliteLayer, "satellite", "Satellite"],
      [labelsLayer, "labels", "Satellite Labels"],
      [tonerLayer, "toner", "Toner"],
      [topoLayer, "topo", "Topo"],
    ].forEach(([layer, styleKey, displayName]) => {
      attachBasemapErrorNotifier(
        layer.getSource(),
        styleKey,
        displayName,
        `${TILE_CACHE_BASE}/api/tiles/${styleKey}/6/45/27.png`,
        (reason, message) =>
          showFeatureNotice({
            feature: `${displayName} basemap`,
            message,
            dedupeKey: `basemap-health|${styleKey}|${reason}`,
            autoDismissMs: 12000,
          })
      );
    });

    // ---------- ADMIN LAYERS ----------
    // Zone/Ward boundaries used to be a WMS TileLayer styled per-request via
    // a dynamic SLD_BODY — which meant every single tile, on every pan/zoom,
    // was a guaranteed cache miss (GWC/WMS caches key on the request's exact
    // parameters, and the style string was unique per city/color lookup).
    // Confirmed via real telemetry: 10-17s average per view, continuously
    // re-fetched. These boundaries are small (a handful to a few dozen
    // polygons per city) and change essentially never, so instead: fetch the
    // raw features once per city (cached server-side, see
    // /api/boundary-geojson in tiles.js) and style/label them entirely in
    // the browser. GeoServer/GWC still does the heavy lifting for every
    // layer that has a fixed, reusable style (Road Network tiles, basemaps).
    const buildBoundaryCqlFilter = (layerName) => {
      const params = new URLSearchParams(location.search);
      if (params.get("mode") !== "CHAINAGE") return undefined;
      const zoneNum = Number(params.get("zone"));
      const wardNum = Number(params.get("ward"));
      if (layerName === cfg.zoneLayer && Number.isFinite(zoneNum)) return `zone_no=${zoneNum}`;
      if (layerName === cfg.wardLayer && Number.isFinite(zoneNum)) return `zone_no=${zoneNum}`;
      if (layerName === cfg.wardLayer && Number.isFinite(wardNum)) return `ward_no=${wardNum}`;
      return undefined;
    };
    const createBoundaryLayer = (title, layerName, zIndex) => {
      if (!layerName) return null;
      const params = { LAYERS: layerName };
      const cqlFilter = buildBoundaryCqlFilter(layerName);
      if (cqlFilter) params.CQL_FILTER = cqlFilter;
      const layer = new ImageLayer({
        title,
        source: new ImageWMS({
          url: WARD_ZONE_WMS,
          params,
          serverType: "geoserver",
          ratio: 1,
          crossOrigin: "anonymous",
        }),
      });
      layer.setZIndex(zIndex);
      return layer;
    };
    const zoneBoundary = createBoundaryLayer("Zone Boundary", cfg.zoneLayer, 39970);
    const wardBoundary = createBoundaryLayer("Ward Boundary", cfg.wardLayer, 39975);

    const applyRoadLabelStyle = (layer, layerName) => {
      if (!layer || !layerName) return;
      const source = layer.getSource();
      if (source?.updateParams) {
        updateWmsParams(source, { STYLES: ROAD_LABEL_STYLE });
      }
    };

    {
      // Deliberately NOT gated by getIsLowBandwidth(): this data is exactly
      // what the migration above this block moved away from re-fetching
      // per-tile because it's small and changes essentially never — a
      // one-time fetch of a few dozen polygons. Bandwidth-gating it here
      // was a leftover from before that migration. It also has a real user-
      // facing failure mode: navigator.connection.effectiveType (what
      // getIsLowBandwidth() reads) is known to report an artificially
      // conservative estimate on a cold page load before the browser has
      // RTT history, then self-corrects shortly after — which silently
      // skipped Zone/Ward boundaries on a page's first load only, until a
      // remount (confirmed live 2026-07-10).
      const syncBoundaryColors = async () => {
        const [zoneColor, wardColor] = await Promise.all([
          cfg.zoneLayer ? fetchLegendColor(cfg.zoneLayer) : null,
          cfg.wardLayer ? fetchLegendColor(cfg.wardLayer) : null,
        ]);
        if (zoneColor) setZoneBoundaryColor(zoneColor);
        if (wardColor) setWardBoundaryColor(wardColor);
      };
      syncBoundaryColors();
    }

    const adminLayers = new LayerGroup({
      title: "Administrative Layers",
      layers: [zoneBoundary, wardBoundary].filter(Boolean),
      fold: "open",
    });
    adminLayers.setZIndex(20000);

    // ---------- MAIN ROAD NETWORK (SEARCH) ----------
    // Field-task deep links already know their target zone/ward synchronously
    // from the URL at this point — bake it into the very first WMS request
    // instead of constructing this layer unfiltered (whole city) and only
    // narrowing it a moment later once a separate effect gets a chance to
    // run. That gap was a real, observed burst of unfiltered "every road in
    // Kanpur" tile requests on first load.
    let initialRoadCql = null;
    {
      const initParams = new URLSearchParams(location.search);
      // Locking the initial road layer to a zone/ward is a redirect-only
      // behavior — gate on the same project_id+user_id presence as
      // isFieldTaskMode, not mode=CHAINAGE alone, so a bookmarked/typed
      // ?mode=CHAINAGE&zone=..&ward=.. URL with no real field-task
      // redirect params doesn't silently scope a manual chainage session.
      const hasFieldTaskParams = !!(initParams.get("project_id") && initParams.get("user_id"));
      if (initParams.get("mode") === "CHAINAGE" && hasFieldTaskParams) {
        const initZone = Number(initParams.get("zone"));
        const initWard = Number(initParams.get("ward"));
        const parts = [];
        if (Number.isFinite(initZone)) parts.push(`zone_no=${initZone}`);
        if (Number.isFinite(initWard)) parts.push(`ward_no=${initWard}`);
        if (parts.length) initialRoadCql = parts.join(" AND ");
      }
    }
    let roadNetworkLayer = null;
    let roadLabelsLayer = null;
    if (cfg.roadLayer) {
      roadNetworkLayer = new TileLayer({
        title: "Road Network Layer",
        visible: true,
        source: makeTileWmsSource({
          layerName: cfg.roadLayer,
          workspace: "Road_Network",
          cacheable: true,
          params: initialRoadCql ? { CQL_FILTER: initialRoadCql } : {},
        }),
      });
      roadNetworkLayer.setZIndex(40);
      roadLabelsLayer = new TileLayer({
        title: "Road Labels",
        visible: true,
        source: makeTileWmsSource({
          layerName: cfg.roadLayer,
          workspace: "Road_Network",
          cacheable: true,
          params: {
            STYLES: ROAD_LABEL_STYLE,
            ...(initialRoadCql ? { CQL_FILTER: initialRoadCql } : {}),
          },
        }),
      });
      // Same top label tier as wardLabelLayer/zoneLabelLayer (50000s) -
      // labels must never be hidden behind a data layer.
      roadLabelsLayer.setZIndex(50000);
    }
    roadNetworkLayerRef.current = roadNetworkLayer;
    roadLabelsLayerRef.current = roadLabelsLayer;

    let roadWfsLayer = null;
    if (cfg.roadLayer) {
      const roadWfsSource = new VectorSource(manualVectorSourceOptions());
      roadWfsLayer = new VectorLayer({
        title: "Road Network Detail",
        visible: true,
        source: roadWfsSource,
        style: getRoadWfsStyle,
      });
      roadWfsLayer.setZIndex(45);
      roadWfsSourceRef.current = roadWfsSource;
    }
    roadWfsLayerRef.current = roadWfsLayer;

    if (roadLabelsLayer && !getIsLowBandwidth()) {
      applyRoadLabelStyle(roadLabelsLayer, cfg.roadLayer);
    }

    // ---------- SEGMENTED ROADS ----------
    let segmentedRoadsLayer = null;
    let chainageLayer = null;
    const segmentedLayerName = normalizeLayerName(cfg.segmentLayer || "");
    const chainageLayerName = normalizeLayerName(cfg.chainageLayer || "");
    if (segmentedLayerName) {
      segmentedRoadsLayer = new ImageLayer({
        title: "Segmented Roads",
        visible: false,
        source: new ImageWMS({
          url: CHAINAGE_WMS,
          params: {
            LAYERS: segmentedLayerName,
            FORMAT: "image/png",
            TRANSPARENT: true,
            TILED: true,
            FORMAT_OPTIONS: "antiAlias:false",
          },
          serverType: "geoserver",
          ratio: 1,
          crossOrigin: "anonymous",
          projection: "EPSG:4326",
        }),
      });
      // Above the admin zone/ward boundary layers (zIndex ~39970-39985) -
      // this is the visual representation of the currently-selected road
      // during chainage/patch creation and must never render behind them.
      segmentedRoadsLayer.setZIndex(40000);
    }
    if (chainageLayerName) {
      chainageLayer = new ImageLayer({
        title: "Chainage",
        visible: false,
        source: new ImageWMS({
          url: CHAINAGE_WMS,
          params: {
            LAYERS: chainageLayerName,
            FORMAT: "image/png",
            TRANSPARENT: true,
            TILED: true,
            // dpi:180 is a best-effort ask for GeoServer to render this
            // request at ~2x — whether the chainage_distance_label SLD's
            // text actually scales up with it depends entirely on how that
            // style was authored server-side (a plain fixed-px Font size
            // in the SLD won't respond to this at all). The real fix for
            // small/unreadable chainage labels is bumping that SLD's font
            // size directly on GeoServer, which is out of scope here.
            FORMAT_OPTIONS: "antiAlias:false;dpi:180",
          },
          serverType: "geoserver",
          ratio: 1,
          crossOrigin: "anonymous",
          projection: "EPSG:4326",
        }),
      });
      chainageLayer.setZIndex(45);
    }
    segmentedRoadsLayerRef.current = segmentedRoadsLayer;
    chainageLayerRef.current = chainageLayer;

    const specializedLayers = {};
    Object.entries(cfg.specializedNetworks || {}).forEach(([id, specCfg]) => {
      // Support both string-layer and grouped-options structure
      const isGroup = specCfg && typeof specCfg === "object" && specCfg.options;
      const activeOption = layerVisibility?.specializedOptions?.[id];
      const defaultNoneGroup = id === "drainage" || id === "slum";
      const requiresExplicitOption = id === "sewage";
      const wantsNone =
        isGroup &&
        (String(activeOption) === "none" ||
          (defaultNoneGroup && (activeOption === undefined || activeOption === null)) ||
          (requiresExplicitOption && (activeOption === undefined || activeOption === null)));

      let layerName = "";
      if (isGroup) {
        const firstKey = Object.keys(specCfg.options)[0];
        const optKey = activeOption || firstKey;
        const opt = specCfg.options[optKey];
        layerName = typeof opt === "string" ? opt : (opt?.layer || "");
      } else {
        layerName = typeof specCfg === "string" ? specCfg : (specCfg.layer || "");
      }

      const normalizedName = normalizeLayerName(layerName);
      if (!normalizedName) return;

      specializedLayers[id] = new TileLayer({
        title: `Network: ${specCfg.label || id}`,
        visible: !!layerVisibility?.network?.[id] && !wantsNone,
        source: makeTileWmsSource({
          layerName: normalizedName,
          workspace: getWorkspaceFromLayerName(normalizedName),
          cacheable: true,
        }),
      });
      specializedLayers[id].setZIndex(35); // Above basemap, below road network (40)
    });
    specializedLayersRef.current = specializedLayers;

    // ---------- ROAD CLASSIFICATION LAYERS ----------
    const roadClassLayers = {};
    Object.entries(cfg.roadClassifications || {}).forEach(([key, rcfg]) => {
      if (!rcfg || typeof rcfg !== "object") return;
      if (!rcfg.layer) return;

      const classParams = {
        LAYERS: rcfg.layer,
        TILED: true,
        FORMAT: "image/png",
        TRANSPARENT: true,
      };
      if (rcfg.style) {
        classParams.STYLES = rcfg.style;
      }
      roadClassLayers[key] = new TileLayer({
        title: `Roads by ${key}`,
        visible: false,
        source: makeTileWmsSource({
          layerName: rcfg.layer,
          workspace: "Road_Network",
          cacheable: true,
          params: classParams,
        }),
      });
      roadClassLayers[key].setZIndex(45);
    });
    roadClassLayersRef.current = roadClassLayers;

    const lcluLayers = {};
    Object.entries(cfg.LCLUClassifications || {}).forEach(([id, layerName]) => {
      const normalizedName = normalizeLayerName(layerName);
      if (!normalizedName) return;
      lcluLayers[id] = new TileLayer({
        title: `LCLU: ${id}`,
        visible: !!layerVisibility?.lclu?.[id],
        opacity: Number.isFinite(lcluOpacity) ? lcluOpacity : 1,
        // Routed through GWC + the local tile cache like every other
        // static/non-CQL-filtered overlay (see makeTileWmsSource) instead
        // of a raw direct-to-GeoServer TileWMS with a permanent cache-buster
        // baked into its initial params — the visibility-toggle effect
        // already calls updateParams({_t: Date.now()}) itself whenever this
        // layer's LAYERS param actually changes, so a static initial
        // construction doesn't lose any freshness.
        source: makeTileWmsSource({
          layerName: normalizedName,
          workspace: getWorkspaceFromLayerName(normalizedName, "Road_Network"),
          cacheable: true,
        }),
      });
      lcluLayers[id].setZIndex(55);
    });
    lcluLayersRef.current = lcluLayers;

    const amenityLayers = {};
    const isDark = baseMap === "satellite" || baseMap === "toner";
    Object.entries(cfg.amenities || {}).forEach(([id]) => {
      const source = new VectorSource(manualVectorSourceOptions());
      amenityLayers[id] = new VectorLayer({
        title: `Amenity: ${id}`,
        visible: !!layerVisibility.amenities?.[id],
        source,
        style: createAmenityStyle(id, isDark),
        declutter: false,
        renderMode: "image",
        updateWhileAnimating: false,
        updateWhileInteracting: false,
      });
      amenityLayers[id].set("legendColor", isDark ? "rgba(255, 215, 0, 1)" : "rgba(255, 0, 0, 1)");
      amenityLayers[id].setZIndex(30010);
    });
    amenityLayersRef.current = amenityLayers;

    const osmAmenityLayers = {};
    Object.entries(cfg.amenities || {}).forEach(([id]) => {
      const source = new VectorSource(manualVectorSourceOptions());
      osmAmenityLayers[id] = new VectorLayer({
        title: `Amenity: ${id}`,
        visible: !!layerVisibility.amenities?.[id],
        source,
        style: createAmenityStyle(id, isDark),
        declutter: false,
        renderMode: "image",
        updateWhileAnimating: false,
        updateWhileInteracting: false,
      });
      osmAmenityLayers[id].setZIndex(30009);
    });
    osmAmenityLayersRef.current = osmAmenityLayers;

    const amenitiesGroup = new LayerGroup({
      title: "Amenities",
      layers: [...Object.values(amenityLayers), ...Object.values(osmAmenityLayers)],
      fold: "open",
    });
    amenitiesGroup.setZIndex(30000);
    amenitiesGroup.setVisible(true);
    amenitiesGroupRef.current = amenitiesGroup;

    const otherLayers = {};
    Object.entries(cfg.others || {}).forEach(([id]) => {
      const source = new VectorSource(manualVectorSourceOptions());
      otherLayers[id] = new VectorLayer({
        title: `Other: ${id}`,
        visible: !!layerVisibility.others?.[id],
        source,
        style: createOtherStyle(id, isDark),
        declutter: true,
        renderMode: "image",
        updateWhileAnimating: false,
        updateWhileInteracting: false,
      });
      otherLayers[id].set("legendColor", isDark ? "rgba(0, 255, 255, 1)" : "rgba(0, 0, 255, 1)");
      otherLayers[id].setZIndex(30008);
    });
    otherLayersRef.current = otherLayers;

    const osmOtherLayers = {};
    Object.entries(cfg.others || {}).forEach(([id]) => {
      const source = new VectorSource(manualVectorSourceOptions());
      osmOtherLayers[id] = new VectorLayer({
        title: `Other: ${id}`,
        visible: !!layerVisibility.others?.[id],
        source,
        style: createOtherStyle(id, isDark),
        declutter: true,
        renderMode: "image",
        updateWhileAnimating: false,
        updateWhileInteracting: false,
      });
      osmOtherLayers[id].setZIndex(30007);
    });
    osmOtherLayersRef.current = osmOtherLayers;

    const othersGroup = new LayerGroup({
      title: "Others",
      layers: [...Object.values(otherLayers), ...Object.values(osmOtherLayers)],
      fold: "open",
    });
    othersGroup.setZIndex(30000);
    othersGroup.setVisible(true);
    othersGroupRef.current = othersGroup;

    const streetLayer =
      cityKey === "lucknow"
        ? new TileLayer({
          title: "Street View",
          visible: false,
          source: new TileWMS({
            url: STREET_VIEW_WMS,
            params: {
              LAYERS: "Street_View:Lucknow_Street_View",
              TILED: true,
            },
            serverType: "geoserver",
            transition: 0,
            crossOrigin: "anonymous",
          }),
        })
        : null;
    if (streetLayer) streetLayer.setZIndex(70);
    streetLayerRef.current = streetLayer;

    const searchAreaSource = new VectorSource(manualVectorSourceOptions());
    const searchAreaLayer = new VectorLayer({
      title: "Search Area",
      visible: true,
      source: searchAreaSource,
      style: new Style({
        stroke: new Stroke({ color: "rgba(239, 68, 68, 0.95)", width: 2.4, lineDash: [6, 4] }),
        fill: new Fill({ color: "rgba(239, 68, 68, 0.08)" }),
      }),
    });
    searchAreaLayer.setZIndex(29990);
    searchAreaSourceRef.current = searchAreaSource;
    searchAreaLayerRef.current = searchAreaLayer;

    // "Tinted window" mask — a permanent, instantly-applied translucent
    // "glass" fill painted over everywhere *outside* the city's zone/ward
    // boundary. Not a second image/tile layer of any kind (a single static
    // raster looks fine zoomed out but turns into unreadable blown-up
    // pixels/text the moment a user zooms into a city - confirmed live,
    // reverted). Just a soft, permanent translucency so the cut-off doesn't
    // look like a blank void, while the real in-boundary map stays the
    // fast, high-priority, fully-detailed layer it always was. Costs zero
    // network requests of its own: pure canvas drawing reusing geometry
    // already fetched for the boundary layer below.
    const maskLayer = new VectorLayer({
      title: "Focus Mask",
      source: new VectorSource(),
    });
    maskLayer.setZIndex(20);

    // ---------- MAP ----------
    const map = new OLMap({
      target: mapElement.current,
      layers: [
        baseMaps,
        maskLayer,
        adminLayers,
        roadNetworkLayer,
        roadWfsLayer,
        roadLabelsLayer,
        segmentedRoadsLayer,
        chainageLayer,
        ...Object.values(specializedLayers),
        ...Object.values(roadClassLayers),
        ...Object.values(lcluLayers),
        labelsLayer,
        searchAreaLayer,
        amenitiesGroup,
        othersGroup,
        streetLayer,
      ].filter(Boolean),
      view: new View({
        ...(cityViews[cityKey] || cityViews.default),
        maxZoom: baseMap === "satellite" ? SATELLITE_MAX_ZOOM : DEFAULT_MAX_ZOOM,
        // Without this, any area with no rendered tile yet (still loading,
        // or genuinely outside every layer's extent) falls back to
        // OpenLayers' own default fill — reported as stark black bars
        // during initial load/panning. A neutral light gray, matching the
        // skeleton-loading placeholders already used elsewhere in this
        // file, reads as "still loading" instead of looking broken.
        background: "#e5e7eb",
      }),
      controls: defaultControls({ zoom: true, rotate: false }),
    });

    // Dim everywhere outside the current city's zone/ward boundary shape
    // (not just its rectangular extent) via a single tint overlay, rather
    // than hard-clipping the base layers away to nothing out there —
    // cityClipRingsRef starts null on a fresh map instance and is populated
    // shortly after by the boundary-loading effect below, so the map
    // simply renders untinted until then rather than using a stale
    // previous city's shape.
    attachInvertedMask(maskLayer, map, cityClipRingsRef, "rgba(120,120,120,0.28)");

    //chainage
    // Built whenever the city has chainage config at all, regardless of
    // what `mode` happens to be when this [city]-only effect runs (i.e. at
    // mount/city-change). Chainage mode itself is now armed/toggled later
    // via the "Chainage" button without re-running this effect (modeRef,
    // not `mode`, gates the click handler) — gating layer *construction* on
    // `mode === "CHAINAGE"` here meant these layers were only ever built for
    // sessions that happened to start already in chainage mode (a deep
    // link), and silently stayed null/never-created for the normal
    // Dashboard → click "Chainage" → click a road flow. Both layers default
    // to visible:false and are only shown when actually needed.
if (cfg1) {
  roadLayerRef.current = new TileLayer({
    source: new TileWMS({
      url: GEOSERVER_BASE + "/wms",
      params: {
        LAYERS: cfg1.roadLayer,
        TILED: true,
        FORMAT: "image/png",
        TRANSPARENT: true,
        VERSION: "1.1.1",
      },
      serverType: "geoserver",
      crossOrigin: "anonymous",
    }),
    // Hidden by default — this layer exists only to answer WMS GetFeatureInfo
    // identify requests (which don't require the layer to be rendered), not to
    // be drawn as "all roads in the city." It's made visible only when a
    // zone/ward deep-link filter is applied (see the URL marker effect), which
    // is the one legitimate case where showing a filtered road subset is correct.
    visible: false,
    opacity: 0.72,
  });

  roadLayerRef.current.setZIndex(30);

  chainageLayerRef.current = new TileLayer({
    source: new TileWMS({
      url: GEOSERVER_BASE + "/wms",
      params: {
        LAYERS: cfg1.chainageLayer,
        TILED: true,
        FORMAT: "image/png",
        TRANSPARENT: true,
        VERSION: "1.1.1",
      },
      serverType: "geoserver",
      crossOrigin: "anonymous",
    }),
    visible: false,
  });

  // Above the admin zone/ward boundary layers (zIndex ~39970-39985) - this
  // renders the selected road's chainage/distance points during patch
  // creation and must never be hidden behind a boundary line.
  chainageLayerRef.current.setZIndex(40000);

  map.addLayer(roadLayerRef.current);
  map.addLayer(chainageLayerRef.current);
}
    // ---------- MAP LOADING TRACKER ----------
    // Auto-attaches to every layer's source (present now or added later, at
    // any nesting depth) and reports friendly `title`s, not raw GeoServer
    // layer names — see utils/mapLoadingTracker.js. Any future layer added
    // anywhere in this file automatically participates as long as it has a
    // `title`; no extra wiring required.
    if (onMapLoadingChange) {
      stopLoadingTrackerRef.current = attachMapLoadingTracker(map, onMapLoadingChange);
    }

    if (!amenityMarkerElRef.current) {
      const el = document.createElement("div");
      el.style.width = "20px";
      el.style.height = "20px";
      el.style.borderRadius = "50%";
      el.style.background = "rgba(255, 255, 0, 1)";
      el.style.border = "3px solid rgba(0, 0, 0, 1)";
      el.style.boxSizing = "border-box";
      el.style.transform = "translate(-50%, -50%)";
      amenityMarkerElRef.current = el;
    }
    if (!amenityMarkerOverlayRef.current) {
      amenityMarkerOverlayRef.current = new Overlay({
        element: amenityMarkerElRef.current,
        positioning: "center-center",
        stopEvent: false,
      });
    }
    map.addOverlay(amenityMarkerOverlayRef.current);

    if (!searchMarkerElRef.current) {
      const el = document.createElement("div");
      el.style.width = "34px";
      el.style.height = "48px";
      el.style.backgroundImage = `url("${getSearchPinSvg()}")`;
      el.style.backgroundSize = "contain";
      el.style.backgroundRepeat = "no-repeat";
      el.style.transform = "translate(-50%, -100%)";
      searchMarkerElRef.current = el;
    }
    if (!searchMarkerOverlayRef.current) {
      searchMarkerOverlayRef.current = new Overlay({
        element: searchMarkerElRef.current,
        positioning: "bottom-center",
        stopEvent: false,
      });
    }
    map.addOverlay(searchMarkerOverlayRef.current);

    // Create Popup Overlay. Built with document.createElement (like the
    // amenity/search markers above), NOT React JSX + ref: OL's
    // map.addOverlay() reparents `element` into its own internal overlay
    // container, silently moving it out from under whatever parent React
    // rendered it into. If the element were React-owned, any later
    // re-render that inserts/removes a sibling near its original JSX
    // position (e.g. toggling {mode === "CHAINAGE" && (...)}) crashes with
    // "insertBefore: node is not a child of this node", because React's
    // fiber still thinks the node lives at its original DOM position.
    if (!popupRef.current) {
      const popupEl = document.createElement("div");
      popupEl.className = "ol-popup";

      const closerEl = document.createElement("a");
      closerEl.href = "#";
      closerEl.className = "ol-popup-closer";
      closerEl.addEventListener("click", (e) => {
        e.preventDefault();
        try { closePopupRef.current?.(); } catch (err) { console.error("Popup close error:", err); }
      });

      const contentEl = document.createElement("div");
      contentEl.className = "ol-popup-content";

      popupEl.appendChild(closerEl);
      popupEl.appendChild(contentEl);

      popupRef.current = popupEl;
      popupCloserRef.current = closerEl;
      popupContentRef.current = contentEl;
    }

    const overlay = new Overlay({
      element: popupRef.current,
      autoPan: true,
      autoPanAnimation: {
        duration: 250,
      },
      positioning: "bottom-center",
      offset: [0, -18],
    });
    map.addOverlay(overlay);
    overlayRef.current = overlay;

    const toOlFeature = (feature, projection) => {
      if (!feature || !projection) return null;
      if (typeof feature.getGeometry === "function") return feature;
      if (feature?.geometry) {
        const format = new GeoJSON();
        const dataProjection = detectDataProjection(feature.geometry, projection);
        return format.readFeature(feature, {
          dataProjection,
          featureProjection: projection.getCode(),
        });
      }
      return null;
    };

    const getPopupAnchorCoordinate = (feature, clickCoordinate, projection) => {
      try {
        if (feature && typeof feature.getGeometry === "function") {
          const geom = feature.getGeometry();
          if (geom && typeof geom.getClosestPoint === "function") {
            return geom.getClosestPoint(clickCoordinate);
          }
        }
        if (feature?.geometry && projection) {
          const olFeature = toOlFeature(feature, projection);
          const geom = olFeature?.getGeometry?.();
          if (geom && typeof geom.getClosestPoint === "function") {
            return geom.getClosestPoint(clickCoordinate);
          }
        }
      } catch { }
      return clickCoordinate;
    };

    const isRoadFeatureProps = (props) => {
      const keys = Object.keys(props || {}).map((k) => k.toLowerCase());
      return [
        "road_name",
        "gis_id",
        "road_id",
        "category",
        "condition",
        "material",
        "ownership",
        "cus_class",
        "row_meter",
        "carriage_w",
        "length_km",
      ].some((k) => keys.includes(k));
    };

    const fetchNearestRoadFeature = async (coordinate, viewResolution, projection, signal) => {
      const cfg = cityConfig[city.toLowerCase()] || {};
      const typeName = cfg.roadLayer;
      if (!typeName) return null;
      const mapUnitsRadius = Math.max(15, Math.min(viewResolution * 12, 200));
      const [x, y] = toLonLat(coordinate, projection || map.getView().getProjection());
      const cql = `DWITHIN(geom, POINT(${x} ${y}), ${mapUnitsRadius}, meters)`;
      const wfsUrl =
        `${GEOSERVER_BASE}/Road_Network/wfs` +
        `?service=WFS` +
        `&version=1.1.0` +
        `&request=GetFeature` +
        `&typeName=${encodeURIComponent(typeName)}` +
        `&outputFormat=application/json` +
        `&srsName=EPSG:4326` +
        `&CQL_FILTER=${encodeURIComponent(cql)}`;

      const response = await fetch(wfsUrl, { signal });
      const data = await response.json();
      const features = data?.features || [];
      if (!features.length) return null;

      const format = new GeoJSON();
      let best = null;
      let bestDist = Number.POSITIVE_INFINITY;
      for (const feature of features) {
        const olFeature = format.readFeature(feature, {
          dataProjection: "EPSG:4326",
          featureProjection: projection.getCode(),
        });
        const geom = olFeature?.getGeometry?.();
        if (!geom || typeof geom.getClosestPoint !== "function") continue;
        const closest = geom.getClosestPoint(coordinate);
        const dx = closest[0] - coordinate[0];
        const dy = closest[1] - coordinate[1];
        const dist = dx * dx + dy * dy;
        if (dist < bestDist) {
          bestDist = dist;
          best = feature;
        }
      }
      return best;
    };

    const fetchJsonWithTimeout = async (url, timeoutMs, outerSignal) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      const handleAbort = () => controller.abort();
      if (outerSignal) {
        outerSignal.addEventListener("abort", handleAbort, { once: true });
      }
      try {
        const response = await fetch(url, { signal: controller.signal });
        const data = await response.json();
        return { data, aborted: controller.signal.aborted };
      } finally {
        clearTimeout(timeoutId);
        if (outerSignal) {
          outerSignal.removeEventListener("abort", handleAbort);
        }
      }
    };

    const normalizePlaceName = (value) => String(value || "")
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const isNameMatch = (a, b) => {
      const na = normalizePlaceName(a);
      const nb = normalizePlaceName(b);
      if (!na || !nb) return false;
      if (na === nb) return true;
      return na.includes(nb) || nb.includes(na);
    };

    const formatSourceLabel = (key) => {
      if (key === "osm") return "OSM";
      if (key === "google") return "Google";
      if (key === "basemap") return "Basemap";
      return key;
    };

    const buildNameValidation = (names) => {
      const entries = Object.entries(names).filter(([, value]) => value);
      if (entries.length === 0) return { status: "Unknown", sources: [] };
      if (entries.length === 1) return { status: "Unverified", sources: [formatSourceLabel(entries[0][0])] };
      const matched = new Set();
      for (let i = 0; i < entries.length; i += 1) {
        for (let j = i + 1; j < entries.length; j += 1) {
          if (isNameMatch(entries[i][1], entries[j][1])) {
            matched.add(entries[i][0]);
            matched.add(entries[j][0]);
          }
        }
      }
      if (matched.size > 0) {
        return { status: "Verified", sources: Array.from(matched).map(formatSourceLabel) };
      }
      return { status: "Mismatch", sources: entries.map(([key]) => formatSourceLabel(key)) };
    };

    const getBasemapLabel = (mapKey) => {
      if (mapKey === "satellite") return "Esri Satellite";
      if (mapKey === "positron") return "CartoDB Positron";
      if (mapKey === "toner") return "Toner";
      if (mapKey === "topo") return "Topo";
      return "OpenStreetMap";
    };

    const fetchGoogleReverseGeocode = async (lat, lng, outerSignal) => {
      if (!GOOGLE_STREET_VIEW_API_KEY) return null;
      const url =
        `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}` +
        `&key=${GOOGLE_STREET_VIEW_API_KEY}`;
      try {
        const { data, aborted } = await fetchJsonWithTimeout(url, 1800, outerSignal);
        if (aborted || !data) return null;
        const results = Array.isArray(data.results) ? data.results : [];
        const first = results[0];
        if (!first) return null;
        const components = Array.isArray(first.address_components) ? first.address_components : [];
        const nameComponent = components.find((c) =>
          (c.types || []).some((t) =>
            ["point_of_interest", "establishment", "premise", "route"].includes(t)
          )
        );
        const formatted = first.formatted_address;
        const name = nameComponent?.long_name || formatted;
        return { name, formatted };
      } catch {
        return null;
      }
    };

    const fetchBasemapReverseGeocode = async (lat, lng, outerSignal) => {
      const url =
        `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/reverseGeocode` +
        `?f=pjson&location=${lng},${lat}`;
      try {
        const { data, aborted } = await fetchJsonWithTimeout(url, 1800, outerSignal);
        if (aborted || !data) return null;
        const address = data.address || {};
        const name = address.Match_addr || address.LongLabel || data.name || "";
        return { name, address };
      } catch {
        return null;
      }
    };

    const buildLoadingPopupHtml = (titleText) => `
      <div style="min-width: 250px;">
        <h4 style="margin: 0 0 10px 0; border-bottom: 2px solid #007bff; padding-bottom: 8px; color: #333;">${titleText}</h4>
        <div style="display: flex; flex-direction: column; gap: 10px;">
          <div class="popup-skeleton-line" style="height: 12px; width: 85%;"></div>
          <div class="popup-skeleton-line" style="height: 12px; width: 70%;"></div>
          <div class="popup-skeleton-line" style="height: 12px; width: 92%;"></div>
          <div class="popup-skeleton-line" style="height: 12px; width: 60%;"></div>
        </div>
        <style>
          .popup-skeleton-line {
            background: linear-gradient(90deg, #e5e7eb 25%, #f3f4f6 37%, #e5e7eb 63%);
            background-size: 400% 100%;
            animation: popupShimmer 1.2s ease-in-out infinite;
            border-radius: 8px;
          }
          @keyframes popupShimmer {
            0% { background-position: 100% 0; }
            100% { background-position: -100% 0; }
          }
        </style>
      </div>
    `;

    const resolveStreetViewAvailability = async (lat, lng, outerSignal) => {
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { status: "unavailable" };
      const cacheKey = getStreetViewCacheKey(lat, lng);
      const cached = getCachedStreetView(cacheKey);
      if (cached) {
        return {
          status: cached.available ? "available" : "unavailable",
          url: getStreetViewUrl(lat, lng),
        };
      }
      if (streetViewPendingRef.current.has(cacheKey)) {
        return streetViewPendingRef.current.get(cacheKey);
      }
      const task = (async () => {
        if (!GOOGLE_STREET_VIEW_API_KEY) {
          return { status: "unknown", url: getStreetViewUrl(lat, lng) };
        }
        const keyParam = GOOGLE_STREET_VIEW_API_KEY ? `&key=${GOOGLE_STREET_VIEW_API_KEY}` : "";
        const url =
          `https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lng}` +
          `&radius=50${keyParam}`;
        try {
          const { data, aborted } = await fetchJsonWithTimeout(
            url,
            STREET_VIEW_TIMEOUT_MS,
            outerSignal
          );
          if (aborted || !data) return { status: "unknown" };
          const status = String(data.status || "").toUpperCase();
          if (status === "OK") {
            setStreetViewCache(cacheKey, true);
            return { status: "available", url: getStreetViewUrl(lat, lng) };
          }
          if (status === "ZERO_RESULTS") {
            setStreetViewCache(cacheKey, false);
            return { status: "unavailable", url: getStreetViewUrl(lat, lng) };
          }
          return { status: "unknown", url: getStreetViewUrl(lat, lng) };
        } catch {
          return { status: "unknown", url: getStreetViewUrl(lat, lng) };
        }
      })();
      streetViewPendingRef.current.set(cacheKey, task);
      try {
        return await task;
      } finally {
        streetViewPendingRef.current.delete(cacheKey);
      }
    };

    // Click Handler for Popup
    map.on("singleclick", async (evt) => {
      if (drawInteractionRef.current || drawingActiveRef.current) {
        overlay.setPosition(undefined);
        return;
      }

      if (popupFeatureInfoAbortRef.current) {
        popupFeatureInfoAbortRef.current.abort();
      }
      const featureInfoController = new AbortController();
      popupFeatureInfoAbortRef.current = featureInfoController;

      // 1. Check for Vector Features (e.g. Highlighted Road, Draw Layer)
      let vectorFeature = null;
      let vectorLayerTitle = null;
      let vectorIsRoad = false;
      let vectorIsLocate = false;

      map.forEachFeatureAtPixel(evt.pixel, (feature, layer) => {
        if (vectorFeature) return;
        if (!layer) return;
        // We only care about specific vector layers here if needed
        // But previously we checked Amenities/Others here.
        // Now they are WMS, so this loop mainly catches 'selectedRoadLayer' or 'drawLayer'
        const layerId = layer.get?.("id");
        if (layerId === LOCATE_LAYER_ID) {
          vectorFeature = feature;
          vectorLayerTitle = "Current Location";
          vectorIsLocate = true;
          return;
        }
        const title = layer.get("title");
        // Zone/Ward Boundary are outline+label WMS overlays covering the
        // whole city — purely visual, never a click target.
        // target. Without this guard every click anywhere inside a
        // zone/ward polygon (i.e. almost every click) would win this
        // hit-test ahead of the actual road underneath it, since these
        // polygons cover virtually the entire visible map.
        if (title === "Zone Boundary" || title === "Ward Boundary") return;
        vectorFeature = feature;
        vectorLayerTitle = title || "Feature";
        vectorIsRoad = layer === selectedRoadLayerRef.current;
      }, { hitTolerance: 10 });

      if (vectorFeature) {
        if (vectorIsLocate) {
          const view = map.getView();
          const projection = view.getProjection();
          const geometry = vectorFeature.getGeometry?.();
          const featureCoord = geometry?.getCoordinates?.() || evt.coordinate;
          const anchorCoordinate = getPopupAnchorCoordinate(vectorFeature, featureCoord, projection);
          const [lng, lat] = toLonLat(featureCoord, projection);
          const cacheKey = `${lng.toFixed(5)},${lat.toFixed(5)}`;
          const cached = osmReverseCacheRef.current.get(cacheKey);
          if (popupContentRef.current) {
            popupContentRef.current.innerHTML = buildLoadingPopupHtml("Current Location");
          }
          overlay.setPosition(anchorCoordinate);
          if (cached && Date.now() - cached.ts < 60000 && cached.feature) {
            await showPopup(cached.feature, cached.title || "Current Location", anchorCoordinate, false, false, featureInfoController.signal);
            return;
          }
          try {
            const osmUrl =
              `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(
                lat
              )}&lon=${encodeURIComponent(lng)}&zoom=18&addressdetails=1&extratags=1`;
            const [osmResult, googleResult, basemapResult] = await Promise.allSettled([
              fetchJsonWithTimeout(osmUrl, 1500, featureInfoController.signal),
              fetchGoogleReverseGeocode(lat, lng, featureInfoController.signal),
              fetchBasemapReverseGeocode(lat, lng, featureInfoController.signal),
            ]);
            if (featureInfoController.signal.aborted) return;
            const osmData = osmResult.status === "fulfilled" ? (osmResult.value?.data || {}) : {};
            const googleData = googleResult.status === "fulfilled" ? googleResult.value : null;
            const basemapData = basemapResult.status === "fulfilled" ? basemapResult.value : null;
            const osmAddress = osmData?.address || {};
            const street =
              osmAddress.road ||
              osmAddress.pedestrian ||
              osmAddress.footway ||
              osmAddress.cycleway ||
              osmAddress.path ||
              osmAddress.neighbourhood ||
              osmAddress.suburb ||
              "";
            const houseNumber = osmAddress.house_number || "";
            const cityName =
              osmAddress.city ||
              osmAddress.town ||
              osmAddress.village ||
              osmAddress.municipality ||
              osmAddress.county ||
              osmAddress.state_district ||
              osmAddress.state ||
              "";
            const postcode = osmAddress.postcode || "";
            const country = osmAddress.country || "";
            const osmName = String(osmData?.name || osmData?.display_name || "").trim();
            const googleName = String(googleData?.name || "").trim();
            const basemapName = String(basemapData?.name || "").trim();
            const validation = buildNameValidation({
              osm: osmName,
              google: googleName,
              basemap: basemapName,
            });
            const verifiedName =
              googleName ||
              basemapName ||
              osmName ||
              "Current Location";
            const basemapLabel = getBasemapLabel(baseMap);
            const feature = {
              properties: {
                verified_name: verifiedName,
                validation_status: validation.status,
                verified_sources: validation.sources.join(", "),
                osm_name: osmName,
                google_name: googleName,
                basemap_name: basemapName,
                basemap_provider: basemapLabel,
                full_address: osmData?.display_name || "",
                street,
                house_number: houseNumber,
                city: cityName,
                postcode,
                country,
                lat,
                lng,
              },
            };
            osmReverseCacheRef.current.set(cacheKey, { ts: Date.now(), feature, title: verifiedName });
            await showPopup(feature, verifiedName, anchorCoordinate, false, false, featureInfoController.signal);
            return;
          } catch (err) {
            if (featureInfoController.signal.aborted) return;
            const fallbackFeature = {
              properties: {
                name: "Current Location",
                lat,
                lng,
              },
            };
            await showPopup(fallbackFeature, "Current Location", anchorCoordinate, false, false, featureInfoController.signal);
            return;
          }
        }
        const props =
          typeof vectorFeature.getProperties === "function"
            ? vectorFeature.getProperties()
            : vectorFeature.properties || {};
        const derivedIsRoad = vectorIsRoad || isRoadFeatureProps(props);

        // Most road clicks actually resolve here (via the precise vector
        // hit-test against roadWfsLayer/selectedRoadLayer), not through the
        // WMS candidates loop below — chainage-armed mode needs the same
        // branch here too, or it never sees the click at all.
        if (derivedIsRoad && modeRef.current === "CHAINAGE" && cfg1) {
          const roadId =
            (cfg1.roadIdField && props[cfg1.roadIdField]) ||
            props.road_id ||
            props.ROAD_ID ||
            props.gis_id;
          if (roadId) {
            await handleChainageRoadClickRef.current?.(roadId, props, featureInfoController.signal);
            return;
          }
        }

        let displayTitle = vectorLayerTitle;
        if (vectorLayerTitle && vectorLayerTitle.includes(":")) {
          displayTitle = vectorLayerTitle.split(":")[1].trim();
        }
        await showPopup(
          vectorFeature,
          displayTitle,
          evt.coordinate,
          derivedIsRoad,
          derivedIsRoad,
          featureInfoController.signal
        );
        return;
      }

      // 2. WMS Query (Amenities > Others > Roads)
      const view = map.getView();
      const viewResolution = view.getResolution();
      const projection = view.getProjection();

      const candidates = [];
      const activeClassLayer = Object.values(roadClassLayersRef.current).find(l => l.getVisible());

      if (modeRef.current === "CHAINAGE") {
        // Armed: only roads matter for identification, so skip amenities/
        // others/specialized entirely — every sequential candidate tried
        // and missed before reaching a road is pure added latency.
        if (activeClassLayer) {
          candidates.push({ layer: activeClassLayer, isRoad: true });
        } else if (roadNetworkLayerRef.current && roadNetworkLayerRef.current.getVisible()) {
          candidates.push({ layer: roadNetworkLayerRef.current, isRoad: true });
        }
        // Fallback identify target: intentionally always-invisible (see its
        // creation comment) but GetFeatureInfo doesn't require visibility,
        // so it can still resolve a road_id when no visible road layer
        // caught the click.
        if (roadLayerRef.current) {
          candidates.push({ layer: roadLayerRef.current, isRoad: true });
        }
      } else {
        // Roads first: this is a road-network directory, so a road click is
        // the overwhelmingly common case, and each candidate here is tried
        // sequentially (stops at the first hit) — checking amenities/others
        // before roads meant every road click paid for those lookups first
        // even when the click landed squarely on a road, since a
        // GetFeatureInfo request still round-trips even when it comes back
        // empty. Roads (and whatever's actively selected for chainage) go
        // first now; amenities/others/specialized stay as fallback checks.
        if (activeClassLayer) {
          candidates.push({ layer: activeClassLayer, isRoad: true });
        } else if (roadNetworkLayerRef.current && roadNetworkLayerRef.current.getVisible()) {
          candidates.push({ layer: roadNetworkLayerRef.current, isRoad: true });
        }
        if (segmentedRoadsLayerRef.current && segmentedRoadsLayerRef.current.getVisible()) {
          candidates.push({ layer: segmentedRoadsLayerRef.current, isRoad: false });
        }
        if (chainageLayerRef.current && chainageLayerRef.current.getVisible()) {
          candidates.push({ layer: chainageLayerRef.current, isRoad: false });
        }

        // Add visible Amenities
        Object.values(amenityLayersRef.current).forEach(l => {
          if (l.getVisible()) candidates.push({ layer: l, isRoad: false });
        });

        // Add visible Others
        Object.values(otherLayersRef.current).forEach(l => {
          if (l.getVisible()) candidates.push({ layer: l, isRoad: false });
        });

        Object.values(specializedLayersRef.current).forEach((layer) => {
          if (layer.getVisible()) {
            candidates.push({ layer, isRoad: false });
          }
        });
      }

      let foundFeature = null;
      let foundTitle = "";
      let foundIsRoad = false;

      for (const candidate of candidates) {
        const source = candidate.layer.getSource();
        if (!source || typeof source.getFeatureInfoUrl !== 'function') continue;
        const layerTitle = candidate.layer.get("title") || "";
        const coordKey = `${evt.coordinate[0].toFixed(2)},${evt.coordinate[1].toFixed(2)}`;
        const cacheKey = `${layerTitle}|${coordKey}`;
        const cached = featureInfoCacheRef.current.get(cacheKey);
        if (cached && Date.now() - cached.ts < 2000) {
          if (cached.feature) {
            foundFeature = cached.feature;
            foundTitle = layerTitle;
            foundIsRoad = candidate.isRoad;
            break;
          }
          continue;
        }

        const url = source.getFeatureInfoUrl(
          evt.coordinate,
          viewResolution,
          projection,
          {
            'INFO_FORMAT': 'application/json',
            'FEATURE_COUNT': 1
          }
        );

        if (!url) continue;

        try {
          const result = await fetchJsonWithTimeout(url, 1500, featureInfoController.signal);
          if (result?.aborted) {
            if (featureInfoController.signal.aborted) return;
            continue;
          }
          const data = result?.data;
          if (data.features && data.features.length > 0) {
            foundFeature = data.features[0];
            foundTitle = candidate.layer.get("title");
            foundIsRoad = candidate.isRoad;
            featureInfoCacheRef.current.set(cacheKey, { ts: Date.now(), feature: foundFeature });
            break; // Stop at first match (topmost layer)
          }
          featureInfoCacheRef.current.set(cacheKey, { ts: Date.now(), feature: null });
        } catch (err) {
          if (featureInfoController.signal.aborted) {
            return;
          }
          console.warn("WMS GetFeatureInfo failed:", err);
        }
      }

      if (foundFeature && foundIsRoad && modeRef.current === "CHAINAGE" && cfg1) {
        const roadProps = foundFeature.properties || {};
        const roadId =
          (cfg1.roadIdField && roadProps[cfg1.roadIdField]) ||
          roadProps.road_id ||
          roadProps.ROAD_ID ||
          roadProps.gis_id;
        if (roadId) {
          await handleChainageRoadClickRef.current?.(roadId, roadProps, featureInfoController.signal);
          return;
        }
        // No resolvable road_id on this feature — fall through to the
        // normal popup rather than silently doing nothing.
      }

      if (foundFeature) {
        if (foundTitle && foundTitle.includes(":")) {
          foundTitle = foundTitle.split(":")[1].trim();
        }
        await showPopup(
          foundFeature,
          foundTitle,
          evt.coordinate,
          foundIsRoad,
          foundIsRoad,
          featureInfoController.signal
        );
      } else {
        const roadCandidateVisible =
          !!Object.values(roadClassLayersRef.current).find(l => l.getVisible()) ||
          !!roadNetworkLayerRef.current?.getVisible?.() ||
          !!segmentedRoadsLayerRef.current?.getVisible?.();

        if (roadCandidateVisible) {
          try {
            const nearest = await fetchNearestRoadFeature(
              evt.coordinate,
              viewResolution,
              projection,
              featureInfoController.signal
            );
            if (nearest) {
              const nearestProps = nearest.properties || nearest.getProperties?.() || {};
              if (modeRef.current === "CHAINAGE" && cfg1) {
                const roadId =
                  (cfg1.roadIdField && nearestProps[cfg1.roadIdField]) ||
                  nearestProps.road_id ||
                  nearestProps.ROAD_ID ||
                  nearestProps.gis_id;
                if (roadId) {
                  await handleChainageRoadClickRef.current?.(roadId, nearestProps, featureInfoController.signal);
                  return;
                }
              }
              await showPopup(nearest, "Road", evt.coordinate, true, true, featureInfoController.signal);
              return;
            }
          } catch (err) {
            if (featureInfoController.signal.aborted) return;
          }
        }
        const zoom = view?.getZoom?.() || 0;
        if (zoom >= 14) {
          const lonLat = toLonLat(evt.coordinate, projection);
          const cacheKey = `${lonLat[0].toFixed(5)},${lonLat[1].toFixed(5)}`;
          const cached = osmReverseCacheRef.current.get(cacheKey);
          if (cached && Date.now() - cached.ts < 60000) {
            if (cached.feature) {
              await showPopup(cached.feature, cached.title, evt.coordinate, false, false);
              return;
            }
          } else {
            const url =
              `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(
                lonLat[1]
              )}&lon=${encodeURIComponent(lonLat[0])}&zoom=18&addressdetails=1&extratags=1`;
            try {
              const result = await fetchJsonWithTimeout(url, 1500, featureInfoController.signal);
              if (!result?.aborted && result?.data) {
                const data = result.data || {};
                const name = data.name || data.display_name;
                const kind = data.type || data.class;
                const category = data.category || data.class;
                const allowed = new Set([
                  "amenity",
                  "tourism",
                  "shop",
                  "leisure",
                  "historic",
                  "place",
                  "religion",
                  "healthcare",
                  "emergency",
                  "office",
                  "public_transport",
                  "railway",
                ]);
                if (name && category && allowed.has(category)) {
                  const feature = {
                    properties: {
                      name,
                      category,
                      type: kind,
                      ...data.address,
                    },
                  };
                  const title = String(name || kind || "Landmark");
                  osmReverseCacheRef.current.set(cacheKey, { ts: Date.now(), feature, title });
                  await showPopup(feature, title, evt.coordinate, false, false);
                  return;
                }
              }
              osmReverseCacheRef.current.set(cacheKey, { ts: Date.now(), feature: null });
            } catch (err) {
              if (featureInfoController.signal.aborted) return;
            }
          }
        }
        closePopup();
      }
    });



    // Helper function to render popup
    const showPopup = async (
      feature,
      title,
      coordinate,
      isRoad = false,
      selectRoad = false,
      popupSignal = null,
      emitSelection = true
    ) => {
      if (drawInteractionRef.current || drawingActiveRef.current) return;
      lastPopupWasRoadRef.current = !!isRoad;
      const map = mapRef.current;
      const view = map?.getView?.();
      const projection = view?.getProjection?.();
      const olFeature = toOlFeature(feature, projection);
      const anchorCoordinate = isRoad && projection
        ? getPopupAnchorCoordinate(olFeature || feature, coordinate, projection)
        : coordinate;
      // Handle both GeoJSON features (properties) and OL Features (getProperties())
      const requestId = ++popupRequestIdRef.current;
      const props = typeof feature.getProperties === 'function'
        ? feature.getProperties()
        : (feature.properties || {});

      let displayProps = { ...props };
      let finalTitle = title;
      let streetViewInfo = null;
      let streetViewCoords = null;

      // Helper to find key case-insensitively
      const findKey = (obj, key) => Object.keys(obj).find(k => k.toLowerCase() === key.toLowerCase());

      const emitRoadSelected = (sourceProps) => {
        if (!onRoadSelectedRef.current) return;
        const gisIdKey = findKey(sourceProps, "gis_id");
        const roadIdKey = findKey(sourceProps, "road_id");
        const roadNameKey = findKey(sourceProps, "road_name");
        const payload = {
          gis_id: gisIdKey ? sourceProps[gisIdKey] : null,
          road_id: roadIdKey ? sourceProps[roadIdKey] : null,
          road_name: roadNameKey ? sourceProps[roadNameKey] : finalTitle,
        };
        console.log("[MapContainer] emitRoadSelected payload:", payload);
        if (payload.gis_id || payload.road_id || payload.road_name) {
          onRoadSelectedRef.current(payload);
        }
      };

      const resolveLatLng = (sourceProps, fallbackCoord) => {
        const latKey = findKey(sourceProps, "lat") || findKey(sourceProps, "latitude");
        const lngKey =
          findKey(sourceProps, "lng") ||
          findKey(sourceProps, "lon") ||
          findKey(sourceProps, "long") ||
          findKey(sourceProps, "longitude");
        const latVal = latKey ? Number(sourceProps[latKey]) : null;
        const lngVal = lngKey ? Number(sourceProps[lngKey]) : null;
        if (Number.isFinite(latVal) && Number.isFinite(lngVal)) {
          return { lat: latVal, lng: lngVal };
        }
        if (fallbackCoord && projection) {
          const [lng, lat] = toLonLat(fallbackCoord, projection);
          if (Number.isFinite(lat) && Number.isFinite(lng)) {
            return { lat, lng };
          }
        }
        return null;
      };

      const buildPopupHtml = (dataProps, titleText, compactRoad = false, streetViewState = null) => {
        const ignoredFields = ["bbox", "the_geom", "geom", "geometry", "gid", "objectid", "shape_leng", "shape_area", "lat", "long", "latitude", "longitude", "gis_id", "road_id"];
        const keyMap = Object.keys(dataProps).reduce((acc, key) => {
          acc[key.toLowerCase()] = key;
          return acc;
        }, {});
        const resolveKey = (key) => keyMap[String(key).toLowerCase()];

        let contentHtml = `<div style="min-width: 250px;">`;
        contentHtml += `<h4 style="margin: 0 0 10px 0; border-bottom: 2px solid #007bff; padding-bottom: 8px; color: #333;">${titleText}</h4>`;
        contentHtml += `<div style="display: grid; grid-template-columns: 1fr 1.5fr; gap: 6px; font-size: 13px; max-height: 300px; overflow-y: auto;">`;

        const preferredOrder = [
          "verified_name",
          "validation_status",
          "verified_sources",
          "osm_name",
          "google_name",
          "basemap_name",
          "basemap_provider",
          "full_address",
          "street",
          "house_number",
          "city",
          "postcode",
          "country",
          "zone_no", "zone_name",
          "ward_no", "ward_name",
          "ownership",
          "road_name",
          "condition",
          "category",
          "material",
          "yoc",
          "cus_class",
          "row_meter",
          "carriage_w",
          "length_km"
        ];
        const preferredLower = preferredOrder.map((k) => k.toLowerCase());
        const orderedKeys = compactRoad
          ? preferredOrder.map((k) => resolveKey(k)).filter(Boolean)
          : [
            ...preferredOrder.map((k) => resolveKey(k)).filter(Boolean),
            ...Object.keys(dataProps)
              .filter((k) => !preferredLower.includes(String(k).toLowerCase()))
              .sort(),
          ];

        orderedKeys.forEach((key) => {
          let val = dataProps[key];
          if (!ignoredFields.includes(key.toLowerCase()) && val !== null && val !== undefined && val !== "") {
            let label = key.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());

            const lowerKey = key.toLowerCase();
            if (lowerKey === "yoc") label = "Years Of Constructions";
            else if (lowerKey === "cus_class") label = "Scheme";

            if (["row_meter", "carriage_w", "length_km"].includes(key.toLowerCase())) {
              val = Number(val).toFixed(2);
            }

            contentHtml += `<div style="font-weight: 600; color: #555;">${label}:</div><div style="color: #000; word-break: break-word;">${val}</div>`;
          }
        });
        contentHtml += `</div>`;

        if (compactRoad && streetViewState?.url) {
          contentHtml += `<div style="margin-top: 10px; display: flex; flex-direction: column; gap: 6px;">`;
          contentHtml += `<a href="${streetViewState.url}" target="_blank" rel="noopener noreferrer" style="display: inline-block; padding: 6px 10px; background: #0f172a; color: #fff; border-radius: 4px; text-decoration: none; font-size: 12px; text-align: center;">Open Street View</a>`;
          contentHtml += `</div>`;
        }

        contentHtml += `</div>`;
        return contentHtml;
      };

      if (selectRoad && map) {
        if (olFeature) {
          const geometry = olFeature.getGeometry?.() || null;
          if (geometry && props) {
            const roadIdKey = findKey(props, 'road_id');
            const gisIdKey = findKey(props, 'gis_id');
            const rId = roadIdKey ? props[roadIdKey] : null;
            const gId = gisIdKey ? props[gisIdKey] : null;
            if (rId) clickedGeometriesCacheRef.current.set(String(rId), geometry);
            if (gId) clickedGeometriesCacheRef.current.set(String(gId), geometry);
          }
          const view = map.getView?.();
          if (geometry && view?.animate) {
            const center = getCenter(geometry.getExtent());
            if (center && center.every((n) => Number.isFinite(n))) {
              view.animate({ center, duration: 600 });
            }
          }
        }
      }

      if (isRoad) {
        const gisIdKey = findKey(props, 'gis_id');
        const gisId = gisIdKey ? props[gisIdKey] : null;
        const roadNameKey = findKey(props, "road_name");
        finalTitle = roadNameKey ? props[roadNameKey] : title;

        if (emitSelection) {
          emitRoadSelected(props);
        }

        // ⭐ NEW: Zoom and center map to the selected road geometry
        if (olFeature && map) {
          const geometry = olFeature.getGeometry?.() || null;
          const view = map.getView?.();
          if (geometry && view?.animate) {
              const extent = geometry.getExtent();
              view.fit(extent, {
                  padding: getAutoZoomPadding(false),
                  duration: 800,
                  maxZoom: 19
              });
          }
        }
        const coords = resolveLatLng(props, anchorCoordinate);
        if (coords) {
          streetViewCoords = coords;
          streetViewInfo = {
            status: "checking",
            url: `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${coords.lat},${coords.lng}`,
          };
        }

        const initialHtml = buildPopupHtml(displayProps, finalTitle, true, streetViewInfo);
        if (popupContentRef.current) {
          popupContentRef.current.innerHTML = initialHtml;
        }
        overlay.setPosition(anchorCoordinate);

        if (gisId) {
          const detailsCacheKey = String(gisId);
          const cached = roadDetailsCacheRef.current.get(detailsCacheKey);
          if (cached) {
            displayProps = { ...cached };
            finalTitle = cached.road_name || finalTitle;
            const cachedHtml = buildPopupHtml(displayProps, finalTitle, true, streetViewInfo);
            if (popupContentRef.current && popupRequestIdRef.current === requestId) {
              popupContentRef.current.innerHTML = cachedHtml;
            }
          } else {
            try {
              const dbRes = await fetch(`/api/road-networks/${city}/road/${gisId}`);
              if (dbRes.ok) {
                const dbData = await dbRes.json();
                roadDetailsCacheRef.current.set(detailsCacheKey, dbData);
                displayProps = { ...dbData };
                finalTitle = dbData.road_name || finalTitle;
                const refreshedHtml = buildPopupHtml(displayProps, finalTitle, true, streetViewInfo);
                if (popupContentRef.current && popupRequestIdRef.current === requestId) {
                  popupContentRef.current.innerHTML = refreshedHtml;
                }
              }
            } catch (e) {
              console.error("Error fetching details from DB:", e);
            }
          }
        }
        if (streetViewCoords) {
          streetViewInfo = {
            status: "available",
            url: getStreetViewUrl(streetViewCoords.lat, streetViewCoords.lng),
          };
          if (popupContentRef.current) {
            popupContentRef.current.innerHTML = buildPopupHtml(displayProps, finalTitle, true, streetViewInfo);
          }
        }
        // For amenities/specialized, use name or classify fields
        const nameKey = findKey(props, 'name') || findKey(props, 'classify') || findKey(props, 'name_hindi') || findKey(props, 'bank_name');
        if (nameKey && props[nameKey]) {
          finalTitle = props[nameKey];
        } else if (String(title).toLowerCase().includes("lulc")) {
          finalTitle = "LULC Detail";
        } else if (String(title).toLowerCase().includes("sewage")) {
          finalTitle = "Sewage Network";
        } else if (String(title).toLowerCase().includes("drain")) {
          finalTitle = "Drainage Detail";
        }
      }

      if (!isRoad && popupContentRef.current) {
        popupContentRef.current.innerHTML = buildPopupHtml(displayProps, finalTitle);
      }
      overlay.setPosition(anchorCoordinate);
    };
    showPopupRef.current = showPopup;

    mapRef.current = map;
    setMapReady(true);

    let resizeObserver = null;
    const handleResize = () => {
      try {
        map.updateSize();
      } catch { }
    };
    window.addEventListener("resize", handleResize);

    if (typeof ResizeObserver !== "undefined" && mapElement.current) {
      resizeObserver = new ResizeObserver(() => {
        try {
          map.updateSize();
        } catch { }
      });
      resizeObserver.observe(mapElement.current);
    }

    let raf2 = null;
    const raf1 = requestAnimationFrame(() => {
      try {
        map.updateSize();
      } catch { }
      raf2 = requestAnimationFrame(() => {
        try {
          map.updateSize();
        } catch { }
      });
    });

    return () => {
      window.removeEventListener("resize", handleResize);
      if (resizeObserver) resizeObserver.disconnect();
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);

      if (map) {
        if (selectedRoadLayerRef.current) {
          map.removeLayer(selectedRoadLayerRef.current);
          selectedRoadLayerRef.current = null;
        }
        if (map.layerSwitcherControl) {
          map.removeControl(map.layerSwitcherControl);
        }
        if (map.overviewMapControl) {
          map.removeControl(map.overviewMapControl);
        }
        map.setTarget(null);
      }
      mapRef.current = null;
      cityClipRingsRef.current = null;
      stopLoadingTrackerRef.current?.();
      stopLoadingTrackerRef.current = null;
      setMapReady(false);
    };
  }, [city]);

  const dssLegend = useMemo(() => {
    // New GeoServer-WFS-backed DSS path (Dashboard-owned counts, live from
    // the active module's current-BBOX rows) takes priority whenever it has
    // data. The legacy GeoJSON-prop path below stays only for the old /dss
    // page's own MapContainer instance, which still feeds
    // streetLightVisible/streetLightCounts/etc. directly.
    if (Array.isArray(dssLegendGroups) && dssLegendGroups.length > 0) {
      return dssLegendGroups;
    }

    const groups = [];

    if (streetLightVisible) {
      const c = streetLightCounts || {};
      groups.push({
        id: "streetLight",
        title: "Street Light",
        rows: [
          { label: "Illuminated", color: "#10b981", count: c.illuminated },
          { label: "Non-Illuminated", color: "#ef4444", count: c.nonIlluminated },
          { label: "Others", color: "#f59e0b", count: c.others },
        ],
      });
    }

    if (underdevelopedVisible) {
      const c = underdevelopedCounts || {};
      groups.push({
        id: "underdeveloped",
        title: "Underdeveloped Zones",
        rows: [
          { label: "Developed", color: "#10b981", count: c.developed },
          { label: "Underdeveloped", color: "#f59e0b", count: c.underdeveloped },
          { label: "Non-Developed", color: "#ef4444", count: c.nonDeveloped },
        ],
      });
    }

    if (encroachmentVisible) {
      const t = encroachmentTotals || {};
      groups.push({
        id: "encroachment",
        title: "Encroachment",
        rows: [
          { label: "Encroached Roads", color: "#7c3aed", count: t.encroachedRoads },
          { label: "Total Roads", color: "#334155", count: t.totalRoads },
        ],
      });
    }

    return groups;
  }, [
    dssLegendGroups,
    streetLightVisible,
    streetLightCounts,
    underdevelopedVisible,
    underdevelopedCounts,
    encroachmentVisible,
    encroachmentTotals,
  ]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    if (zoomFilter) return;
    const urlParams = new URLSearchParams(location.search);
    // Same isFieldTaskMode-equivalent gate as the marker-placement effect —
    // a lat/lon pair alone (no project_id/user_id) isn't a real field-task
    // redirect, so it shouldn't suppress the normal boundary-fit either.
    const hasUrlTarget =
      urlParams.has("latitude") &&
      urlParams.has("longitude") &&
      !!(urlParams.get("project_id") && urlParams.get("user_id"));
    if (hasUrlTarget) return; // redirected chainage marker owns the initial view
    const cityKey = city.toLowerCase();
    const cfg = cityConfig[cityKey] || {};
    // Zone boundary first, ward boundary as the fallback reference when a
    // city has no zone layer — both cover the same overall city extent, so
    // this only matters for which layer name is used to look up the bbox.
    const layerName = cfg.zoneLayer || cfg.wardLayer;
    if (!layerName) return;

    let cancelled = false;
    const map = mapRef.current;
    const view = map.getView();

    const fitToBoundary = async () => {
      // Boundary features now come through /api/boundary-geojson, the same
      // server-cached path used by the visible boundary vector layers.
      // Reuses fetchBoundaryFeatures (WFS, already fetched/cached for the
      // clip-mask effect below) instead of a separate WMS GetCapabilities
      // call — one less ~2s network round trip before the extent
      // restriction can apply, and the features are already in the map's
      // own projection so no lon/lat conversion is needed either.
      const features = await fetchBoundaryFeatures(layerName, view.getProjection());
      if (cancelled || !features.length) return;
      const projected = createEmpty();
      features.forEach((feature) => {
        const geom = feature.getGeometry?.();
        if (geom) extend(projected, geom.getExtent());
      });
      const fitExtent = normalizeExtent(projected, view);
      if (!fitExtent) return;

      // Restrict panning/zooming to this city's zone/ward extent (padded
      // ~20% so the boundary doesn't feel like a hard wall right at its
      // edge) so the map never requests/renders basemap tiles for the rest
      // of the state once a city dashboard is open. OL bakes the extent
      // constraint into the View at construction time — there's no setter
      // to change it on the live view — so replace the view in place,
      // carrying over its current center/zoom/limits.
      const padding = Math.max(
        getWidth(fitExtent),
        getHeight(fitExtent)
      ) * 0.2;
      const restrictedExtent = bufferExtent(fitExtent, padding);
      const restrictedView = new View({
        projection: view.getProjection(),
        center: view.getCenter(),
        zoom: view.getZoom(),
        rotation: view.getRotation(),
        minZoom: view.getMinZoom(),
        maxZoom: view.getMaxZoom(),
        extent: restrictedExtent,
        // Default (false) forces the *entire viewport* to stay inside
        // `extent`, which silently overrides view.fit()'s chosen zoom with
        // a tighter one whenever the boundary's aspect ratio doesn't match
        // the viewport (very likely for a long, narrow city like Kanpur) —
        // that's what was forcing an over-zoomed initial view. Restricting
        // only the center keeps the same soft pan limit without fighting
        // fit()'s own zoom calculation.
        constrainOnlyCenter: true,
      });
      map.setView(restrictedView);
      restrictedView.fit(fitExtent, {
        padding: getAutoZoomPadding(false),
        duration: 800,
        maxZoom: isMobileView ? 12 : 14,
      });
    };

    fitToBoundary();
    return () => {
      cancelled = true;
    };
  }, [mapReady, city, zoomFilter, isMobileView, location.search]);


   //chainage
  useEffect(() => {
    if (!mapRef.current) return;

    const startLayer = new VectorLayer({
      source: startMarkerSourceRef.current,
      style: new Style({
        image: new CircleStyle({
          radius: 8,
          fill: new Fill({ color: "#22c55e" }),
          stroke: new Stroke({ color: "#000", width: 3 })
        }),
        text: new TextStyle({
          text: "START",
          offsetY: -18,
          font: "bold 12px sans-serif",
          fill: new Fill({ color: "#000" }),
          stroke: new Stroke({ color: "#fff", width: 3 })
        })
      }),
      zIndex: 1000
    });

    const endLayer = new VectorLayer({
      source: endMarkerSourceRef.current,
      style: new Style({
        image: new CircleStyle({
          radius: 8,
          fill: new Fill({ color: "#ef4444" }),
          stroke: new Stroke({ color: "#000", width: 3 })
        }),
        text: new TextStyle({
          text: "END",
          offsetY: -18,
          font: "bold 12px sans-serif",
          fill: new Fill({ color: "#000" }),
          stroke: new Stroke({ color: "#fff", width: 3 })
        })
      }),
      zIndex: 1000
    });

    const urlLocationLayer = new VectorLayer({
      source: urlLocationMarkerSourceRef.current,
      style: URL_LOCATION_PIN_STYLE,
      zIndex: 1300,
    });

    const map = mapRef.current;
    map.addLayer(startLayer);
    map.addLayer(endLayer);
    map.addLayer(urlLocationLayer);

    startMarkerLayerRef.current = startLayer;
    endMarkerLayerRef.current = endLayer;
    urlLocationMarkerLayerRef.current = urlLocationLayer;

    return () => {
      map.removeLayer(startLayer);
      map.removeLayer(endLayer);
      map.removeLayer(urlLocationLayer);
      if (startMarkerLayerRef.current === startLayer) startMarkerLayerRef.current = null;
      if (endMarkerLayerRef.current === endLayer) endMarkerLayerRef.current = null;
      if (urlLocationMarkerLayerRef.current === urlLocationLayer) urlLocationMarkerLayerRef.current = null;
    };
  }, [mapReady]);


  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    const cityKey = city.toLowerCase();
    const cfg = cityConfig[cityKey] || {};
    const boundaryLayerName = cfg.zoneLayer || cfg.wardLayer;
    // Clear immediately on city/roadFilter change so the map never clips to
    // a stale (wrong-city) shape while the fetch below is in flight — it
    // just renders unclipped for that brief window instead.
    cityClipRingsRef.current = null;
    if (!boundaryLayerName) {
      boundaryFeaturesRef.current = { layerName: "", features: [] };
      return;
    }
    const projection = mapRef.current.getView().getProjection();
    let cancelled = false;
    const loadBoundary = async () => {
      const features = await fetchBoundaryFeatures(boundaryLayerName, projection);
      if (cancelled) return;
      boundaryFeaturesRef.current = { layerName: boundaryLayerName, features };
      cityClipRingsRef.current = extractClipRings(features);
      mapRef.current?.render();
    };
    loadBoundary();
    return () => {
      cancelled = true;
    };
  }, [mapReady, city, roadFilter]);

  useEffect(() => {
    const isDark = baseMap === "satellite" || baseMap === "toner";
    Object.entries(amenityLayersRef.current || {}).forEach(([id, layer]) => {
      if (layer && typeof layer.setStyle === "function") {
        layer.setStyle(createAmenityStyle(id, isDark));
        layer.set("legendColor", isDark ? "rgba(255, 215, 0, 1)" : "rgba(255, 0, 0, 1)");
      }
    });
    Object.entries(osmAmenityLayersRef.current || {}).forEach(([id, layer]) => {
      if (layer && typeof layer.setStyle === "function") {
        layer.setStyle(createAmenityStyle(id, isDark));
      }
    });
    Object.entries(otherLayersRef.current || {}).forEach(([id, layer]) => {
      if (layer && typeof layer.setStyle === "function") {
        layer.setStyle(createOtherStyle(id, isDark));
        layer.set("legendColor", isDark ? "rgba(0, 255, 255, 1)" : "rgba(0, 0, 255, 1)");
      }
    });
    Object.entries(osmOtherLayersRef.current || {}).forEach(([id, layer]) => {
      if (layer && typeof layer.setStyle === "function") {
        layer.setStyle(createOtherStyle(id, isDark));
      }
    });
    mapRef.current?.renderSync?.();
  }, [baseMap]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    const view = mapRef.current.getView?.();
    if (!view || typeof view.setMaxZoom !== "function") return;
    const maxZoom = baseMap === "satellite" ? SATELLITE_MAX_ZOOM : DEFAULT_MAX_ZOOM;
    view.setMaxZoom(maxZoom);
  }, [baseMap, mapReady]);

  // =====================================================
  // EXPOSE MAP INSTANCE VIA REF
  // =====================================================

  // Keep callback refs always up-to-date so closures never use stale references

  // Helper to close popup internally
  const closePopup = () => {
    try {
      if (overlayRef.current) {
        overlayRef.current.setPosition(undefined);
      }
      if (popupCloserRef.current) {
        popupCloserRef.current.blur();
      }
      if (selectedRoadLayerRef.current && mapRef.current) {
        mapRef.current.removeLayer(selectedRoadLayerRef.current);
        selectedRoadLayerRef.current = null;
      }
      setSelectedRoadGeometry(null);
      setRoadDimming(false);
      refreshRoadWmsLayers();
      if (!drawInteractionRef.current) {
        ensureMapInteractions(mapRef.current);
      }
      if (lastPopupWasRoadRef.current && typeof onPopupClosedRef.current === "function") {
        onPopupClosedRef.current();
      }
      lastPopupWasRoadRef.current = false;
    } catch (err) {
      console.error("Error closing popup:", err);
      lastPopupWasRoadRef.current = false;
    }
  };
  closePopupRef.current = closePopup;

  useImperativeHandle(ref, () => ({
    map: mapRef.current,
    instance: mapRef.current,
    clearPopup: closePopup,
    getRoadWmsSource: () => roadNetworkLayerRef.current?.getSource?.() || null,
    applyRoadFilterImmediate: (filter) => applyRoadFilterImmediate(filter),
    zoomToLatLng: (lat, lng) => {
      handleLatLngSearch(lat, lng);
    },
    zoomToPlace: (place) => {
      handlePlaceSearch(place);
    },
    showFeatureNotice: (payload) => showFeatureNotice(payload),
    // Lets Dashboard's table drive chainage the same way a map click does —
    // selecting a road (single mode) or finishing a multi-road selection
    // (Apply) both funnel through here instead of duplicating the
    // patches/chainage-fetch logic in Dashboard.jsx. //chainage
    openChainageForRoadId: (roadId, roadProps, signal) =>
      openChainageForRoadIdRef.current?.(roadId, roadProps, signal),
    // Lets Dashboard's table row clicks go through the exact same
    // Road1/Road2 pairing + 2-road cap + toast logic as map clicks, instead
    // of silently falling through to Dashboard's plain single-select. //chainage
    handleChainageRoadClick: (roadId, roadProps, signal) =>
      handleChainageRoadClickRef.current?.(roadId, roadProps, signal),
    createMultiRoadPatch: (roadInfos) =>
      handleCreateMultiRoadPatchRequestRef.current?.(roadInfos),
    // Lets Dashboard's own "Clear" button fully close an open chainage
    // panel/road selection instead of leaving it stranded — see
    // closeChainagePanel below (same routine as the panel's own ✕ button).
    closeChainagePanel: () => closeChainagePanelRef.current?.(),
  }));

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    const map = mapRef.current;
    const handleMove = (evt) => {
      if (!evt?.coordinate) return;
      const [lon, lat] = toLonLat(evt.coordinate, map.getView().getProjection());
      setCoordText(`${lon.toFixed(4)}, ${lat.toFixed(4)}`);
    };
    map.on("pointermove", handleMove);
    return () => {
      map.un("pointermove", handleMove);
    };
  }, [mapReady]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    const map = mapRef.current;
    const handleMoveEnd = () => {
      if (amenityMoveTimerRef.current) clearTimeout(amenityMoveTimerRef.current);
      if (otherMoveTimerRef.current) clearTimeout(otherMoveTimerRef.current);
      if (roadMoveTimerRef.current) clearTimeout(roadMoveTimerRef.current);
      const wait = getIsLowBandwidth() ? 650 : 400;
      const hasAmenityVisible = Object.values(amenityLayersRef.current).some((layer) =>
        layer.getVisible()
      );
      const hasOtherVisible = Object.values(otherLayersRef.current).some((layer) =>
        layer.getVisible()
      );
      const hasRoadVisible =
        !!roadNetworkLayerRef.current?.getVisible?.() ||
        Object.values(roadClassLayersRef.current || {}).some((layer) =>
          layer?.getVisible?.()
        );
      if (!hasAmenityVisible && !hasOtherVisible && !hasRoadVisible) return;

      if (hasAmenityVisible) {
        amenityMoveTimerRef.current = setTimeout(() => {
          const view = map.getView();
          const projection = view.getProjection();
          const extent = view.calculateExtent(map.getSize());
          const zoom = view.getZoom?.();
          const extentKey = getExtentKey(extent, zoom);
          if (extentKey && extentKey === amenityExtentKeyRef.current) return;
          amenityExtentKeyRef.current = extentKey;
          const lowBandwidth = getIsLowBandwidth();
          const cacheTtlMs = lowBandwidth ? 90000 : 30000;
          const maxFeatures = getAmenityMaxFeatures(zoom, lowBandwidth);
          if (amenityFetchAbortRef.current) amenityFetchAbortRef.current.abort();
          const controller = new AbortController();
          amenityFetchAbortRef.current = controller;

          const visibleAmenityIds = Object.entries(amenityLayersRef.current)
            .filter(([, layer]) => layer.getVisible())
            .map(([id]) => id);

          Object.entries(amenityLayersRef.current).forEach(([id, layer]) => {
            if (!visibleAmenityIds.includes(id)) return;
            const cfg = cityConfig[(city || "").toLowerCase()] || {};
            const layerName = cfg.amenities?.[id];
            if (!layerName) return;
            const layerExtentKey = layer.get("extentKey");
            if (layerExtentKey === extentKey) return;
            layer.set("extentKey", extentKey);
            fetchWfsLayerData({
              layer,
              layerName,
              projection,
              extent,
              extentKey,
              maxFeatures,
              cacheRef: amenityWfsCacheRef,
              cacheTtlMs,
              abortSignal: controller.signal,
              id,
              prefix: "AmenityWFS",
            });
            fetchWfsCount({
              layerName,
              projection,
              extent,
              extentKey,
              cacheRef: amenityWfsCountCacheRef,
              cacheTtlMs,
              abortSignal: controller.signal,
              id,
              prefix: "AmenityWFS",
            });
          });

          const osmAmenityIds = visibleAmenityIds.filter(
            (id) => (OSM_AMENITY_FILTERS[id] || []).length > 0
          );
          if (osmAmenityIds.length) {
            const osmExtentKey = `${extentKey}|${osmAmenityIds.slice().sort().join(",")}`;
            if (osmExtentKey !== osmAmenityExtentKeyRef.current) {
              osmAmenityExtentKeyRef.current = osmExtentKey;
              if (osmAmenityFetchAbortRef.current) osmAmenityFetchAbortRef.current.abort();
              const osmController = new AbortController();
              osmAmenityFetchAbortRef.current = osmController;
              fetchOsmAmenityData({
                amenityIds: osmAmenityIds,
                extent,
                projection,
                abortSignal: osmController.signal,
              });
            }
          }
        }, wait);
      }

      if (hasOtherVisible) {
        otherMoveTimerRef.current = setTimeout(() => {
          const view = map.getView();
          const projection = view.getProjection();
          const extent = view.calculateExtent(map.getSize());
          const zoom = view.getZoom?.();
          const extentKey = getExtentKey(extent, zoom);
          if (extentKey && extentKey === otherExtentKeyRef.current) return;
          otherExtentKeyRef.current = extentKey;
          const lowBandwidth = getIsLowBandwidth();
          const cacheTtlMs = lowBandwidth ? 90000 : 30000;
          const maxFeatures = getAmenityMaxFeatures(zoom, lowBandwidth);
          if (otherFetchAbortRef.current) otherFetchAbortRef.current.abort();
          const controller = new AbortController();
          otherFetchAbortRef.current = controller;

          Object.entries(otherLayersRef.current).forEach(([id, layer]) => {
            if (!layer.getVisible()) return;
            const cfg = cityConfig[(city || "").toLowerCase()] || {};
            const layerName = cfg.others?.[id];
            if (!layerName) return;
            const layerExtentKey = layer.get("extentKey");
            if (layerExtentKey === extentKey) return;
            layer.set("extentKey", extentKey);
            fetchWfsLayerData({
              layer,
              layerName,
              projection,
              extent,
              extentKey,
              maxFeatures,
              cacheRef: otherWfsCacheRef,
              cacheTtlMs,
              abortSignal: controller.signal,
              id,
              prefix: "OtherWFS",
            });
            fetchWfsCount({
              layerName,
              projection,
              extent,
              extentKey,
              cacheRef: otherWfsCountCacheRef,
              cacheTtlMs,
              abortSignal: controller.signal,
              id,
              prefix: "OtherWFS",
            });
          });

          const visibleOtherIds = Object.entries(otherLayersRef.current)
            .filter(([, layer]) => layer.getVisible())
            .map(([id]) => id);
          const osmOtherIds = visibleOtherIds.filter(
            (id) => (OSM_OTHER_FILTERS[id] || []).length > 0
          );
          if (osmOtherIds.length) {
            const osmExtentKey = `${extentKey}|${osmOtherIds.slice().sort().join(",")}`;
            if (osmExtentKey !== osmOtherExtentKeyRef.current) {
              osmOtherExtentKeyRef.current = osmExtentKey;
              if (osmOtherFetchAbortRef.current) osmOtherFetchAbortRef.current.abort();
              const osmController = new AbortController();
              osmOtherFetchAbortRef.current = osmController;
              fetchOsmOtherData({
                otherIds: osmOtherIds,
                extent,
                projection,
                abortSignal: osmController.signal,
              });
            }
          }
        }, wait);
      }

      if (hasRoadVisible && roadWfsLayerRef.current) {
        roadMoveTimerRef.current = setTimeout(() => {
          const view = map.getView();
          const projection = view.getProjection();
          const zoom = view.getZoom?.() || 0;
          if (zoom < ROAD_WFS_MIN_ZOOM) {
            roadWfsLayerRef.current?.setVisible?.(false);
            roadWfsSourceRef.current?.clear?.();
            roadWfsExtentKeyRef.current = "";
            return;
          }
          roadWfsLayerRef.current?.setVisible?.(true);
          const extent = view.calculateExtent(map.getSize());
          const filterText = String(roadFilter || "").trim();
          const applyFilter = filterText && filterText.toUpperCase() !== "INCLUDE";
          const baseExtentKey = getExtentKey(extent, zoom);
          const extentKey = applyFilter ? `${baseExtentKey}|${filterText}` : baseExtentKey;
          if (extentKey && extentKey === roadWfsExtentKeyRef.current) return;
          roadWfsExtentKeyRef.current = extentKey;
          const lowBandwidth = getIsLowBandwidth();
          const maxFeatures = getRoadWfsMaxFeatures(zoom, lowBandwidth);
          if (!maxFeatures) return;
          if (roadWfsAbortRef.current) roadWfsAbortRef.current.abort();
          const controller = new AbortController();
          roadWfsAbortRef.current = controller;
          const cfg = cityConfig[(city || "").toLowerCase()] || {};
          const layerName = cfg.roadLayer;
          if (!layerName) return;
          // Routed through our own server-side cache instead of GeoServer
          // directly — same bbox/filter/maxFeatures the client always
          // computed, just cached for ~3 minutes so repeat/overlapping
          // views (this user panning back, or a different user looking at
          // a similar area) don't each pay a fresh WFS round trip. This was
          // confirmed via real usage telemetry to be the single largest,
          // slowest source of network traffic in the app.
          let url =
            `/api/road-wfs-cache?layer=${encodeURIComponent(layerName)}` +
            `&srsName=${encodeURIComponent(projection.getCode())}` +
            `&bbox=${encodeURIComponent(extent.join(","))}` +
            `&maxFeatures=${maxFeatures}`;
          if (applyFilter) {
            url += `&cqlFilter=${encodeURIComponent(filterText)}`;
          }
          fetch(url, { signal: controller.signal })
            .then(async (res) => {
              if (!res.ok) {
                const payload = await res.json().catch(() => ({}));
                throw new Error(payload?.error || `HTTP ${res.status}`);
              }
              return res.json();
            })
            .then((data) => {
              if (controller.signal.aborted) return;
              if (!roadWfsLayerRef.current) return;
              applyWfsData(roadWfsLayerRef.current, data, projection, "roads", "RoadWFS");
            })
            .catch((err) => {
              if (controller.signal.aborted) return;
              showLayerUnavailableNotice({
                feature: "Road network detail",
                layerName,
                reason: err?.message || "Road network detail could not be loaded right now. You can continue using the map.",
                dedupeKey: `${city}|road-wfs|${layerName}`,
              });
            });
        }, wait);
      } else if (roadWfsLayerRef.current) {
        roadWfsLayerRef.current.setVisible(false);
        roadWfsSourceRef.current?.clear?.();
        roadWfsExtentKeyRef.current = "";
      }
    };
    map.on("moveend", handleMoveEnd);
    return () => {
      map.un("moveend", handleMoveEnd);
      if (amenityMoveTimerRef.current) clearTimeout(amenityMoveTimerRef.current);
      if (otherMoveTimerRef.current) clearTimeout(otherMoveTimerRef.current);
      if (roadMoveTimerRef.current) clearTimeout(roadMoveTimerRef.current);
      if (roadWfsAbortRef.current) roadWfsAbortRef.current.abort();
    };
  }, [mapReady, city]);

  // Live extent sync for the bottom table: report the current viewport
  // (EPSG:4326) up to Dashboard, debounced, so the table can filter itself
  // down to just the roads on screen instead of paging through the whole
  // filtered set. Deliberately its own effect/listener, independent of the
  // layer-visibility-gated handleMoveEnd above (which does nothing at all
  // when no amenity/other/road layer is visible) - the table can be open
  // and in use regardless of which map layers are toggled on.
  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    const map = mapRef.current;
    let timer = null;
    const reportExtent = () => {
      const view = map.getView();
      const size = map.getSize();
      if (!size) return;
      const extent3857 = view.calculateExtent(size);
      const [minLon, minLat] = toLonLat([extent3857[0], extent3857[1]], view.getProjection());
      const [maxLon, maxLat] = toLonLat([extent3857[2], extent3857[3]], view.getProjection());
      const next = [minLon, minLat, maxLon, maxLat];
      onMapExtentChangeRef.current?.(next);
      // Also kept locally so the Legend's own dynamic road-count items can
      // stay extent-aware, the same as the bottom table.
      setLegendExtent(next);
    };
    const handleExtentMoveEnd = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(reportExtent, getIsLowBandwidth() ? 650 : 400);
    };
    reportExtent();
    map.on("moveend", handleExtentMoveEnd);
    return () => {
      if (timer) clearTimeout(timer);
      map.un("moveend", handleExtentMoveEnd);
    };
  }, [mapReady]);

  // Scroll/pinch zoom in OpenLayers anchors on the cursor position, not on
  // whatever road is currently selected/highlighted — so zooming in
  // anywhere other than directly on the selected road can push its whole
  // geometry outside the viewport, even though nothing about the selection
  // itself changed. Detect exactly that: a resolution change (zoom step)
  // that made a road which WAS visible in the previous viewport no longer
  // intersect the new one, and nudge the center (not the zoom level the
  // user just chose) back onto it. Deliberately does nothing for plain
  // panning, and does nothing once the user has already panned away from
  // the selection on purpose (it was already out of view before this zoom
  // step), so it only fixes the specific "zoom just kicked it off-screen"
  // edge case rather than fighting free navigation.
  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    const map = mapRef.current;
    const prevExtentRef = { current: null };
    const prevResolutionRef = { current: null };
    const handleZoomKeepInView = () => {
      const view = map.getView();
      const size = map.getSize();
      const resolution = view.getResolution();
      if (!size || resolution == null) return;
      const currentExtent = view.calculateExtent(size);
      const prevExtent = prevExtentRef.current;
      const prevResolution = prevResolutionRef.current;
      const zoomed = prevResolution != null && Math.abs(resolution - prevResolution) > 1e-9;
      const geom = selectedRoadGeomRef.current;
      if (zoomed && geom && prevExtent) {
        const roadExtent = geom.getExtent();
        const wasVisible = extentsIntersect(prevExtent, roadExtent);
        const stillVisible = extentsIntersect(currentExtent, roadExtent);
        if (wasVisible && !stillVisible) {
          view.animate({ center: getCenter(roadExtent), duration: 300 });
        }
      }
      prevExtentRef.current = currentExtent;
      prevResolutionRef.current = resolution;
    };
    map.on("moveend", handleZoomKeepInView);
    return () => {
      map.un("moveend", handleZoomKeepInView);
    };
  }, [mapReady]);

  // =====================================================
  // GENERIC LAYER FILTERS (WFS)
  // =====================================================
  useEffect(() => {
    const findLayerBySourceParam = (layerName) => {
      const cfg = cityConfig[city.toLowerCase()];
      if (!cfg) return null;

      const normalizedTarget = normalizeLayerName(layerName);
      if (normalizedTarget) {
        const matchesWmsName = (layer) => {
          const src = layer?.getSource?.();
          const params = src?.getParams?.();
          const current = normalizeLayerName(params?.LAYERS);
          return !!current && current === normalizedTarget;
        };

        const specializedMatch = Object.values(specializedLayersRef.current || {}).find(matchesWmsName);
        if (specializedMatch) return specializedMatch;

        const lcluMatch = Object.values(lcluLayersRef.current || {}).find(matchesWmsName);
        if (lcluMatch) return lcluMatch;
      }

      if (cfg.amenities) {
        const amenityId = Object.keys(cfg.amenities).find(
          (key) => cfg.amenities[key] === layerName
        );
        if (amenityId && amenityLayersRef.current[amenityId]) {
          return amenityLayersRef.current[amenityId];
        }
      }

      if (cfg.others) {
        const otherId = Object.keys(cfg.others).find(
          (key) => cfg.others[key] === layerName
        );
        if (otherId && otherLayersRef.current[otherId]) {
          return otherLayersRef.current[otherId];
        }
      }
      return null;
    };

    const prevFilters = lastLayerFiltersRef.current || {};
    const nextFilters = layerFilters || {};
    const allKeys = new Set([
      ...Object.keys(prevFilters),
      ...Object.keys(nextFilters),
    ]);

    allKeys.forEach((layerName) => {
      const nextFilter = nextFilters[layerName];
      const prevFilter = prevFilters[layerName];
      if (nextFilter === prevFilter) return;

      const layer = findLayerBySourceParam(layerName);
      if (!layer) return;
      const source = layer.getSource?.();
      if (!source) return;

      if (typeof source.updateParams === "function") {
        source.updateParams({
          CQL_FILTER: nextFilter || null,
          _t: Date.now(),
        });
        if (nextFilter) layer.setVisible(true);
        return;
      }

      if (typeof source.getUrl === "function" && typeof source.setUrl === "function") {
        let url = source.getUrl();
        if (typeof url !== "string") return;
        if (url.includes("&CQL_FILTER=")) {
          url = url.split("&CQL_FILTER=")[0];
        }
        if (nextFilter) {
          url = `${url}&CQL_FILTER=${encodeURIComponent(nextFilter)}`;
        }
        source.setUrl(url);
        source.refresh();
        if (nextFilter) layer.setVisible(true);
      }
    });

    lastLayerFiltersRef.current = nextFilters;
  }, [layerFilters, city]);

  // =====================================================
  // DRAW MODE (SPATIAL QUERY)
  // =====================================================
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (drawInteractionRef.current) {
      map.removeInteraction(drawInteractionRef.current);
      drawInteractionRef.current = null;
    }
    if (drawLayerRef.current) {
      map.removeLayer(drawLayerRef.current);
      drawLayerRef.current = null;
    }

    if (!drawMode) return;
    lastSpatialExtentRef.current = null;

    const source = new VectorSource();
    const vector = new VectorLayer({
      source: source,
      style: new Style({
        fill: new Fill({
          color: "rgba(255, 255, 255, 0.2)",
        }),
        stroke: new Stroke({
          color: "#ffcc33",
          width: 2,
        }),
        image: new CircleStyle({
          radius: 7,
          fill: new Fill({
            color: "#ffcc33",
          }),
        }),
      }),
    });

    map.addLayer(vector);
    drawLayerRef.current = vector;
    drawingActiveRef.current = true;

    // Geometry function helpers
    const createStar = (points = 5, innerRatio = 0.5) => {
      return (coordinates, geometry) => {
        const [center, last] = coordinates;
        const dx = last[0] - center[0];
        const dy = last[1] - center[1];
        const radius = Math.sqrt(dx * dx + dy * dy);
        const startAngle = Math.atan2(dy, dx);
        const coords = [];
        for (let i = 0; i < points * 2; i++) {
          const r = i % 2 === 0 ? radius : radius * innerRatio;
          const angle = startAngle + (Math.PI * i) / points;
          coords.push([center[0] + r * Math.cos(angle), center[1] + r * Math.sin(angle)]);
        }
        coords.push(coords[0]);
        if (!geometry) {
          geometry = new Polygon([coords]);
        } else {
          geometry.setCoordinates([coords]);
        }
        return geometry;
      };
    };

    // Map drawMode.type to OL Draw config
    let drawType = drawMode.type || "Polygon";
    let geometryFunction = null;

    if (drawType === "Box") {
      drawType = "Circle";
      geometryFunction = createBox();
    } else if (drawType === "Square") {
      drawType = "Circle";
      geometryFunction = createRegularPolygon(4);
    } else if (drawType === "Star") {
      drawType = "Circle";
      geometryFunction = createStar(5, 0.5);
    }

    const draw = new Draw({
      source: source,
      type: drawType,
      geometryFunction: geometryFunction || undefined,
    });

    draw.on("drawend", async (evt) => {
      drawingActiveRef.current = true;
      if (overlayRef.current) {
        try { overlayRef.current.setPosition(undefined); } catch { }
      }
      const feature = evt.feature;
      let geometry = feature.getGeometry();
      if (geometry && typeof geometry.getType === "function" && geometry.getType() === "Circle") {
        const center = geometry.getCenter();
        const radius = geometry.getRadius();
        const segments = 64;
        const coords = [];
        for (let i = 0; i <= segments; i++) {
          const angle = (2 * Math.PI * i) / segments;
          coords.push([center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)]);
        }
        geometry = new Polygon([coords]);
      }
      const format = new WKT();
      const viewProjection = map.getView().getProjection();
      const geometry4326 = geometry.clone().transform(viewProjection, "EPSG:4326");
      const wkt4326 = format.writeGeometry(geometry4326);
      const sridWkt = `SRID=4326;${wkt4326}`;

      const cfg = cityConfig[city.toLowerCase()];
      const isRoadLayer = cfg && drawMode.layer === cfg.roadLayer;

      let typeName = drawMode.layer;
      let baseUrl = isRoadLayer ? `${GEOSERVER_BASE}/Road_Network/wfs` : `${GEOSERVER_BASE}/Amenities/wfs`;

      const filterExpr = `INTERSECTS(geom, ${sridWkt})`;
      const queryUrl = `${baseUrl}?service=WFS&version=1.1.0&request=GetFeature&typeName=${encodeURIComponent(
        typeName
      )}&outputFormat=application/json&CQL_FILTER=${encodeURIComponent(filterExpr)}`;

      // Apply filter directly to the road network WMS and notify parent
      if (isRoadLayer) {
        if (roadNetworkLayerRef.current) {
          applyCqlToTileLayer(roadNetworkLayerRef.current, filterExpr, "Road_Network");
          roadNetworkLayerRef.current.setVisible(true);
        }
        if (typeof onRoadFilterChange === "function") {
          try {
            onRoadFilterChange(filterExpr, "map");
          } catch { }
        }
      }

      try {
        const res = await fetch(queryUrl);
        const data = await res.json();
        const view = map.getView();
        const viewProj = view.getProjection();
        const format = new GeoJSON();
        const features = (data.features || [])
          .map((f) =>
            format.readFeature(f, {
              dataProjection: "EPSG:4326",
              featureProjection: viewProj.getCode(),
            })
          )
          .filter((f) => !!f && !!f.getGeometry && !!f.getGeometry());
        if (features.length > 0) {
          const extentSource = new VectorSource({ features });
          const projectedExtent = extentSource.getExtent();
          const fitExtent = normalizeExtent(projectedExtent, view);
          if (fitExtent) {
            lastSpatialExtentRef.current = fitExtent;
            view.fit(fitExtent, {
              padding: getAutoZoomPadding(false),
              duration: 800,
              maxZoom: isMobileView ? 16 : 18,
            });
          }
        }
        if (onSpatialQueryResults) {
          onSpatialQueryResults(data.features || []);
        }
      } catch (err) {
        console.error("Spatial query error:", err);
      }
      setTimeout(() => { drawingActiveRef.current = false; }, 600);
    });

    map.addInteraction(draw);
    drawInteractionRef.current = draw;

    return () => {
      if (mapRef.current) {
        if (drawInteractionRef.current)
          mapRef.current.removeInteraction(drawInteractionRef.current);
        if (drawLayerRef.current) mapRef.current.removeLayer(drawLayerRef.current);
      }
      drawingActiveRef.current = false;
    };
  }, [drawMode, city]);



  const onLegendPointerDown = (e) => {
    const insideMenu = e.target && e.target.closest && e.target.closest(".ol-layerswitcher");
    if (insideMenu) return;
    e.preventDefault();
    e.stopPropagation();
    // Use the legend container itself as the drag handle if needed, or specific part
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    draggingRef.current = true;
    dragOriginRef.current = {
      el,
      x: e.clientX,
      y: e.clientY,
      left: legendPos.left ?? rect.left,
      top: legendPos.top,
      w: rect.width,
      h: rect.height,
    };
    document.addEventListener("pointermove", onLegendPointerMove);
    document.addEventListener("pointerup", onLegendPointerUp);
    document.addEventListener("pointercancel", onLegendPointerUp);
  };

  // Mutates the DOM directly during the drag instead of calling
  // setLegendPos() on every pointermove — this component's render function
  // is large, so committing React state at mouse-move frequency was
  // forcing a full re-render per pixel of movement, which is what made
  // dragging feel jittery. React state is only committed once, on
  // pointer-up, so layout stays correct after the drag ends.
  const onLegendPointerMove = (e) => {
    if (!draggingRef.current) return;
    const o = dragOriginRef.current;
    const nextLeft = o.left + (e.clientX - o.x);
    const nextTop = o.top + (e.clientY - o.y);
    const maxLeft = Math.max(0, window.innerWidth - o.w);
    const maxTop = Math.max(0, window.innerHeight - o.h);
    const clampedLeft = Math.min(Math.max(0, nextLeft), maxLeft);
    const clampedTop = Math.min(Math.max(0, nextTop), maxTop);
    o.lastLeft = clampedLeft;
    o.lastTop = clampedTop;
    if (o.el) {
      o.el.style.left = `${clampedLeft}px`;
      o.el.style.right = "auto";
      o.el.style.top = `${clampedTop}px`;
    }
  };

  const onLegendPointerUp = () => {
    draggingRef.current = false;
    const o = dragOriginRef.current;
    if (o && o.lastLeft !== undefined) {
      setLegendPos({ left: o.lastLeft, top: o.lastTop });
    }
    document.removeEventListener("pointermove", onLegendPointerMove);
    document.removeEventListener("pointerup", onLegendPointerUp);
    document.removeEventListener("pointercancel", onLegendPointerUp);
  };

  // Road details / patch panel drag — same mechanics as the Legend above. //chainage
  const onRoadPanelPointerDown = (e) => {
    if (e.target && e.target.closest && e.target.closest("button")) return;
    e.preventDefault();
    const el = e.currentTarget.closest(".road-panel");
    if (!el) return;
    const rect = el.getBoundingClientRect();
    roadPanelDraggingRef.current = true;
    roadPanelDragOriginRef.current = {
      el,
      x: e.clientX,
      y: e.clientY,
      left: roadPanelPos.left ?? rect.left,
      top: roadPanelPos.top ?? rect.top,
      w: rect.width,
      h: rect.height,
    };
    document.addEventListener("pointermove", onRoadPanelPointerMove);
    document.addEventListener("pointerup", onRoadPanelPointerUp);
    document.addEventListener("pointercancel", onRoadPanelPointerUp);
  };

  // Same direct-DOM-mutation approach as the Legend drag above — avoids a
  // full MapContainer re-render on every pointermove pixel.
  const onRoadPanelPointerMove = (e) => {
    if (!roadPanelDraggingRef.current) return;
    const o = roadPanelDragOriginRef.current;
    const nextLeft = o.left + (e.clientX - o.x);
    const nextTop = o.top + (e.clientY - o.y);
    const maxLeft = Math.max(0, window.innerWidth - o.w);
    const maxTop = Math.max(0, window.innerHeight - o.h);
    const clampedLeft = Math.min(Math.max(0, nextLeft), maxLeft);
    const clampedTop = Math.min(Math.max(0, nextTop), maxTop);
    o.lastLeft = clampedLeft;
    o.lastTop = clampedTop;
    if (o.el) {
      o.el.style.position = "absolute";
      o.el.style.left = `${clampedLeft}px`;
      o.el.style.top = `${clampedTop}px`;
      o.el.style.right = "auto";
    }
  };

  const onRoadPanelPointerUp = () => {
    roadPanelDraggingRef.current = false;
    const o = roadPanelDragOriginRef.current;
    if (o && o.lastLeft !== undefined) {
      setRoadPanelPos({ left: o.lastLeft, top: o.lastTop });
    }
    document.removeEventListener("pointermove", onRoadPanelPointerMove);
    document.removeEventListener("pointerup", onRoadPanelPointerUp);
    document.removeEventListener("pointercancel", onRoadPanelPointerUp);
  };

  // =====================================================
  // ROAD NAME SEARCH (MAIN ROAD LAYER)
  // =====================================================
  useEffect(() => {
    if (!roadNetworkLayerRef.current) return;

    const source = roadNetworkLayerRef.current.getSource();
    if (!source) return;

    const filterText = String(roadFilter || "").trim();
    if (!filterText || filterText.toUpperCase() === "INCLUDE") {
      applyCqlToTileLayer(roadNetworkLayerRef.current, null, "Road_Network");
      const map = mapRef.current;
      if (map && filteredRoadLayerRef.current) {
        map.removeLayer(filteredRoadLayerRef.current);
        filteredRoadLayerRef.current = null;
        filteredRoadColorRef.current = null;
      }
      // Ensure popup is closed when filter is cleared (e.g. table closed)
      closePopup();
      return;
    }

    applyCqlToTileLayer(roadNetworkLayerRef.current, roadFilter, "Road_Network");
    roadWfsSourceRef.current?.clear?.();
    roadWfsExtentKeyRef.current = "";
    if (mapRef.current?.dispatchEvent) {
      mapRef.current.dispatchEvent({ type: "moveend" });
    }

    if (!tableFilterActive) {
      const map = mapRef.current;
      if (map && filteredRoadLayerRef.current) {
        map.removeLayer(filteredRoadLayerRef.current);
        filteredRoadLayerRef.current = null;
        filteredRoadColorRef.current = null;
      }
      return;
    }

    try {
      const map = mapRef.current;
      if (!map) return;
      const view = map.getView();
      const cfg = cityConfig[city.toLowerCase()] || {};
      const typeName = cfg.roadLayer;
      if (!typeName) return;

      const wfsUrl =
        `${GEOSERVER_BASE}/Road_Network/wfs` +
        `?service=WFS` +
        `&version=1.1.0` +
        `&request=GetFeature` +
        `&typeName=${encodeURIComponent(typeName)}` +
        `&outputFormat=application/json` +
        `&CQL_FILTER=${encodeURIComponent(filterText)}`;

      fetch(wfsUrl)
        .then((res) => res.json())
        .then((data) => {
          const features = (data && data.features) ? data.features : [];
          if (features.length === 0) {
            if (filteredRoadLayerRef.current) {
              map.removeLayer(filteredRoadLayerRef.current);
              filteredRoadLayerRef.current = null;
              filteredRoadColorRef.current = null;
            }
            return;
          }

          if (filteredRoadLayerRef.current) {
            map.removeLayer(filteredRoadLayerRef.current);
            filteredRoadLayerRef.current = null;
          }

          const color = getRandomRoadColor();
          filteredRoadColorRef.current = color;

          const format = new GeoJSON();
          const vectorFeatures = format.readFeatures(data, {
            dataProjection: "EPSG:4326",
            featureProjection: view.getProjection(),
          });
          const source = new VectorSource({ features: vectorFeatures });
          const layer = new VectorLayer({
            source,
            style: new Style({
              stroke: new Stroke({
                color,
                width: 1.5,
              }),
            }),
          });
          layer.setZIndex(95);
          map.addLayer(layer);
          filteredRoadLayerRef.current = layer;
        })
        .catch(() => { });
    } catch { }
  }, [roadFilter, tableFilterActive, city]);

  // Helper function to normalize property names in CQL filter
  const normalizeCqlFilter = (filter) => {
    if (!filter) return "INCLUDE";

    // Define property mappings for case insensitivity
    const propertyMappings = [
      { pattern: /zone[_\s]?no/gi, replacement: "zone_no" },
      { pattern: /\bcus_class\b/gi, replacement: "cus_class" },
      { pattern: /\bcondition\b/gi, replacement: "condition" },
      { pattern: /\bcategory\b/gi, replacement: "category" },
      { pattern: /\bmaterial\b/gi, replacement: "material" },
      { pattern: /\bownership\b/gi, replacement: "ownership" },
    ];

    // Apply the replacements
    let normalizedFilter = filter;
    for (const { pattern, replacement } of propertyMappings) {
      normalizedFilter = normalizedFilter.replace(pattern, replacement);
    }

    return normalizedFilter;
  };

  // =====================================================
  // CORE: APPLY ROAD FILTER TO ACTIVE CLASSIFICATION LAYER
  // =====================================================
  useEffect(() => {
    const layers = roadClassLayersRef.current;
    if (!layers) return;

    const filterLower = (roadFilter || "").toLowerCase();
    const isIdentifier = /gis_id\s*=|road_id\s*=/.test(filterLower);
    const isNoneSelected = !!layerVisibility.roadClassifications?.none;
    const isAnyClassLayerVisible = Object.keys(layers).some(
      key => !!layerVisibility.roadClassifications?.[key] && key !== "none"
    );
    // A specialized network view (e.g. "Roads Near Parks", under the
    // Analysis tab — analysisLayersRef, a completely separate collection
    // from specializedLayersRef despite the similar name) is its own scoped
    // road picture, same idea as a classification layer — selecting a road
    // from it (which sets a truthy roadFilter/baseFilter, same as any other
    // road selection) shouldn't force the *entire* unfiltered road network
    // on top of it. Read the layers' own current visibility rather than
    // re-deriving from layerVisibility state, since that's the same source
    // of truth those layers' own effects already keep in sync.
    const isAnySpecializedLayerVisible =
      Object.values(specializedLayersRef.current).some((layer) => !!layer?.getVisible?.()) ||
      Object.values(analysisLayersRef.current).some((layer) => !!layer?.getVisible?.());

    // Manage base road layer visibility
    if (roadNetworkLayerRef.current) {
      if (isNoneSelected) {
        roadNetworkLayerRef.current.setVisible(false);
      } else if (isAnyClassLayerVisible || isAnySpecializedLayerVisible) {
        // If a classification or specialized layer is active, HIDE the base layer
        roadNetworkLayerRef.current.setVisible(false);
      } else {
        // Otherwise, show it if network.roads is enabled OR if there's a filter
        let shouldShow = !!(layerVisibility?.network?.roads);
        if (roadFilter) shouldShow = true;
        roadNetworkLayerRef.current.setVisible(shouldShow);
      }
    }

    if (roadLabelsLayerRef.current) {
      applyCqlToTileLayer(roadLabelsLayerRef.current, roadFilter || null, "Road_Network");
      const shouldShowLabels =
        !isNoneSelected &&
        !getIsLowBandwidth() &&
        !isAnyClassLayerVisible &&
        !isAnySpecializedLayerVisible &&
        (!!roadNetworkLayerRef.current?.getVisible?.() || !!roadFilter);
      roadLabelsLayerRef.current.setVisible(shouldShowLabels);
    }

    // Classification layers: visibility only follows sidebar toggles
    Object.entries(layers).forEach(([key, layer]) => {
      const source = layer.getSource();
      if (!source) return;

      // ALWAYS update filter params so that if the user toggles the layer
      // via the Legend/LayerSwitcher, it respects the current filter.
      applyCqlToTileLayer(layer, roadFilter || null, "Road_Network");

      const isVisibleByToggle = !!layerVisibility.roadClassifications?.[key];
      let isVisible = !isNoneSelected && isVisibleByToggle;

      if (isVisible && getIsLowBandwidth()) {
        const zoom = mapRef.current?.getView()?.getZoom?.();
        if (Number.isFinite(zoom) && zoom < LOW_BANDWIDTH_OVERLAY_MIN_ZOOM) {
          isVisible = false;
          showFeatureNotice({
            feature: "Road classification layer",
            message: `Zoom in a bit more to load "${layer.get("title") || key}" on your connection.`,
            dedupeKey: `${city}|lowbw-roadclass|${key}`,
            autoDismissMs: 4500,
          });
        }
      }

      layer.setVisible(isVisible);
    });
  }, [roadFilter, layerVisibility]);

  useEffect(() => {
    const showSegmented = !!layerVisibility?.network?.segmentedRoads;
    const showChainage = !!layerVisibility?.network?.chainage;
    const showSewageDiameter = !!layerVisibility?.network?.sewageDiameter;
    const showSewageLength = !!layerVisibility?.network?.sewageLength;

    if (segmentedRoadsLayerRef.current) {
      segmentedRoadsLayerRef.current.setVisible(showSegmented);
      if (showSegmented) {
        const source = segmentedRoadsLayerRef.current.getSource?.();
        if (source?.updateParams) {
          source.updateParams({ _t: Date.now() });
        } else if (source?.refresh) {
          source.refresh();
        }
      }
    }
    if (mode !== "CHAINAGE" && chainageLayerRef.current) {
  chainageLayerRef.current.setVisible(showChainage);

  if (showChainage) {
    const source = chainageLayerRef.current.getSource?.();

    if (source?.updateParams) {
      source.updateParams({ _t: Date.now() });
    } else if (source?.refresh) {
      source.refresh();
    }
  }
}
  }, [layerVisibility, city, selectedRoadToken]);

  useEffect(() => {
    if (streetLayerRef.current) {
      streetLayerRef.current.setVisible(!!streetViewVisible);
    }
  }, [streetViewVisible]);

  useEffect(() => {
    const lowBandwidth = getIsLowBandwidth();
    const cacheTtlMs = lowBandwidth ? 90000 : 30000;
    if (amenityFetchAbortRef.current) amenityFetchAbortRef.current.abort();
    if (osmAmenityFetchAbortRef.current) osmAmenityFetchAbortRef.current.abort();
    if (otherFetchAbortRef.current) otherFetchAbortRef.current.abort();
    if (osmOtherFetchAbortRef.current) osmOtherFetchAbortRef.current.abort();
    const amenityController = new AbortController();
    const osmController = new AbortController();
    const otherController = new AbortController();
    const otherOsmController = new AbortController();
    amenityFetchAbortRef.current = amenityController;
    osmAmenityFetchAbortRef.current = osmController;
    otherFetchAbortRef.current = otherController;
    osmOtherFetchAbortRef.current = otherOsmController;
    const map = mapRef.current;
    const view = map?.getView?.();
    const projection = view?.getProjection?.();
    const extent = map && view ? view.calculateExtent(map.getSize()) : null;
    const zoom = view?.getZoom?.();
    const maxFeatures = getAmenityMaxFeatures(zoom, lowBandwidth);
    const extentKey = extent && zoom !== undefined ? getExtentKey(extent, zoom) : "";

    // Update dynamic specialized layers and their sources
    Object.keys(specializedLayersRef.current).forEach((key) => {
      const layer = specializedLayersRef.current[key];
      const cfg = cityConfig[(city || "").toLowerCase()] || {};
      const specCfg = cfg.specializedNetworks?.[key];
      const isGroup = specCfg && typeof specCfg === "object" && specCfg.options;
      const isVisible = !!layerVisibility?.network?.[key];

      if (layer) {
        layer.setVisible(isVisible);

        if (isVisible && isGroup) {
          const activeOption = layerVisibility?.specializedOptions?.[key];
          const defaultNoneGroup = key === "drainage" || key === "slum";
          const requiresExplicitOption = key === "sewage";
          const wantsNone =
            String(activeOption) === "none" ||
            (defaultNoneGroup && (activeOption === undefined || activeOption === null)) ||
            (requiresExplicitOption && (activeOption === undefined || activeOption === null));

          if (wantsNone) {
            layer.setVisible(false);
            return;
          }

          const optKey = activeOption || Object.keys(specCfg.options)[0];
          const opt = specCfg.options[optKey];
          const newLayerName = normalizeLayerName(typeof opt === "string" ? opt : (opt?.layer || ""));

          const source = layer.getSource();
          if (source && source.getParams().LAYERS !== newLayerName) {
            layer.setSource(
              makeTileWmsSource({
                layerName: newLayerName,
                workspace: getWorkspaceFromLayerName(newLayerName),
                cacheable: true,
              })
            );
          }
        }
      }
    });

    Object.entries(lcluLayersRef.current).forEach(([id, layer]) => {
      let visible = !!layerVisibility?.lclu?.[id];
      if (visible && getIsLowBandwidth()) {
        const zoom = mapRef.current?.getView()?.getZoom?.();
        if (Number.isFinite(zoom) && zoom < LOW_BANDWIDTH_OVERLAY_MIN_ZOOM) {
          visible = false;
          showFeatureNotice({
            feature: "Land use/cover layer",
            message: `Zoom in a bit more to load "${layer.get("title") || id}" on your connection.`,
            dedupeKey: `${city}|lowbw-lclu|${id}`,
            autoDismissMs: 4500,
          });
        }
      }
      layer.setVisible(visible);
      // Opacity is handled by its own dedicated effect below — it must
      // never share a dependency array with this one, which force-
      // refreshes WMS tiles (updateParams({_t: Date.now()})) whenever it
      // reruns. Opacity is a pure client-side canvas property; it doesn't
      // need new tile data, so it must never trigger a network refetch.
      if (visible) {
        const source = layer.getSource?.();
        if (source?.updateParams) {
          source.updateParams({ _t: Date.now() });
        } else if (source?.refresh) {
          source.refresh();
        }
      }
    });

    Object.entries(amenityLayersRef.current).forEach(([id, layer]) => {
      const visible = !!layerVisibility.amenities?.[id];
      if (layer.getVisible() !== visible) {
        if (visible && amenitiesGroupRef.current && !amenitiesGroupRef.current.getVisible()) {
          amenitiesGroupRef.current.setVisible(true);
        }
        layer.setVisible(visible);
      }
      const osmLayer = osmAmenityLayersRef.current?.[id];
      if (osmLayer && osmLayer.getVisible() !== visible) {
        osmLayer.setVisible(visible);
      }
      if (!visible) {
        if (osmLayer?.getSource) {
          osmLayer.getSource().clear();
        }
        if (amenityWfsCountsRef.current[id] !== 0 || osmAmenityCountsRef.current[id] !== 0) {
          const wfsNext = { ...amenityWfsCountsRef.current, [id]: 0 };
          const osmNext = { ...osmAmenityCountsRef.current, [id]: 0 };
          amenityWfsCountsRef.current = wfsNext;
          osmAmenityCountsRef.current = osmNext;
          amenityWfsCountSourceRef.current = {
            ...amenityWfsCountSourceRef.current,
            [id]: null,
          };
          const merged = mergeAmenityCounts(wfsNext, osmNext);
          if (haveCountsChanged(amenityLegendCountsRef.current, merged)) {
            amenityLegendCountsRef.current = merged;
            setAmenityLegendCounts(merged);
          }
        }
      }
      if (visible) {
        const cfg = cityConfig[(city || "").toLowerCase()] || {};
        const layerName = cfg.amenities?.[id];
        if (!layerName) return;
        if (!map || !view || !projection || !extent) return;
        layer.set("extentKey", extentKey);
        fetchWfsLayerData({
          layer,
          layerName,
          projection,
          extent,
          extentKey,
          maxFeatures,
          cacheRef: amenityWfsCacheRef,
          cacheTtlMs,
          abortSignal: amenityController.signal,
          id,
          prefix: "AmenityWFS",
        });
        fetchWfsCount({
          layerName,
          projection,
          extent,
          extentKey,
          cacheRef: amenityWfsCountCacheRef,
          cacheTtlMs,
          abortSignal: amenityController.signal,
          id,
          prefix: "AmenityWFS",
        });
      }
    });

    const visibleAmenityIds = Object.entries(amenityLayersRef.current)
      .filter(([, layer]) => layer.getVisible())
      .map(([id]) => id);
    const osmAmenityIds = visibleAmenityIds.filter(
      (id) => (OSM_AMENITY_FILTERS[id] || []).length > 0
    );
    if (osmAmenityIds.length && extent && projection) {
      const osmExtentKey = `${extentKey}|${osmAmenityIds.slice().sort().join(",")}`;
      osmAmenityExtentKeyRef.current = osmExtentKey;
      fetchOsmAmenityData({
        amenityIds: osmAmenityIds,
        extent,
        projection,
        abortSignal: osmController.signal,
      });
    }

    Object.entries(otherLayersRef.current).forEach(([id, layer]) => {
      const visible = !!layerVisibility.others?.[id];
      if (layer.getVisible() !== visible) {
        if (visible && othersGroupRef.current && !othersGroupRef.current.getVisible()) {
          othersGroupRef.current.setVisible(true);
        }
        layer.setVisible(visible);
      }
      const osmLayer = osmOtherLayersRef.current?.[id];
      if (osmLayer && osmLayer.getVisible() !== visible) {
        osmLayer.setVisible(visible);
      }
      if (!visible) {
        if (osmLayer?.getSource) {
          osmLayer.getSource().clear();
        }
        if (otherWfsCountsRef.current[id] !== 0 || osmOtherCountsRef.current[id] !== 0) {
          const wfsNext = { ...otherWfsCountsRef.current, [id]: 0 };
          const osmNext = { ...osmOtherCountsRef.current, [id]: 0 };
          otherWfsCountsRef.current = wfsNext;
          osmOtherCountsRef.current = osmNext;
          otherWfsCountSourceRef.current = {
            ...otherWfsCountSourceRef.current,
            [id]: null,
          };
          const merged = mergeOtherCounts(wfsNext, osmNext);
          if (haveCountsChanged(otherLegendCountsRef.current, merged)) {
            otherLegendCountsRef.current = merged;
            setOtherLegendCounts(merged);
          }
        }
      }
      if (visible) {
        const cfg = cityConfig[(city || "").toLowerCase()] || {};
        const layerName = cfg.others?.[id];
        if (!layerName) return;
        const map = mapRef.current;
        if (!map) return;
        const view = map.getView();
        const projection = view.getProjection();
        const extent = view.calculateExtent(map.getSize());
        const zoom = view.getZoom?.();
        const maxFeatures = getAmenityMaxFeatures(zoom, lowBandwidth);
        const extentKey = getExtentKey(extent, zoom);
        layer.set("extentKey", extentKey);
        fetchWfsLayerData({
          layer,
          layerName,
          projection,
          extent,
          extentKey,
          maxFeatures,
          cacheRef: otherWfsCacheRef,
          cacheTtlMs,
          abortSignal: otherController.signal,
          id,
          prefix: "OtherWFS",
        });
        fetchWfsCount({
          layerName,
          projection,
          extent,
          extentKey,
          cacheRef: otherWfsCountCacheRef,
          cacheTtlMs,
          abortSignal: otherController.signal,
          id,
          prefix: "OtherWFS",
        });
      }
    });

    const visibleOtherIds = Object.entries(otherLayersRef.current)
      .filter(([, layer]) => layer.getVisible())
      .map(([id]) => id);
    const osmOtherIds = visibleOtherIds.filter((id) => (OSM_OTHER_FILTERS[id] || []).length > 0);
    if (osmOtherIds.length && extent && projection) {
      const osmExtentKey = `${extentKey}|${osmOtherIds.slice().sort().join(",")}`;
      osmOtherExtentKeyRef.current = osmExtentKey;
      fetchOsmOtherData({
        otherIds: osmOtherIds,
        extent,
        projection,
        abortSignal: otherOsmController.signal,
      });
    }
  }, [layerVisibility, city, selectedRoadToken]);

  // Deliberately its own tiny effect, isolated from the big visibility-sync
  // effect above (which force-refreshes WMS tiles via updateParams whenever
  // it reruns). setOpacity() is a pure client-side canvas-compositing
  // property — OpenLayers just re-draws the already-downloaded tile bitmaps
  // at a different alpha, no network request involved — so this must never
  // fire a tile refetch. Previously it did (a shared dependency array), which
  // meant every single drag-tick of the transparency slider re-triggered a
  // full tile reload storm for whichever LCLU layer was active, on top of
  // needlessly rerunning ~200 lines of unrelated amenity/road-classification
  // sync logic per tick.
  useEffect(() => {
    Object.values(lcluLayersRef.current || {}).forEach((layer) => {
      layer.setOpacity(Number.isFinite(lcluOpacity) ? lcluOpacity : 1);
    });
  }, [lcluOpacity]);

  // REMOVED REDUNDANT EFFECT (911-934) THAT CONFLICTED WITH VISIBILITY LOGIC

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const vis = layerVisibility?.analysis || {};
    const keyMap = {
      bankRoad: "atm_bank",
      hospitalRoad: "hospital",
      educationRoad: "education",
      hotelRoad: "hotel",
      parkRoad: "park",
    };
    Object.entries(vis).forEach(([id, enabled]) => {
      const existing = analysisLayersRef.current[id];
      if (enabled && !existing) {
        const amenityKey = keyMap[id];
        if (!amenityKey) return;
        fetch(`/api/road-networks/${city}/road-analysis/${amenityKey}`)
          .then((res) => {
            if (!res.ok) {
              return res.json().then((j) => {
                throw new Error(j?.error || `HTTP ${res.status}`);
              }).catch(() => {
                throw new Error(`HTTP ${res.status}`);
              });
            }
            return res.json();
          })
          .then((geojson) => {
            const features = new GeoJSON().readFeatures(geojson, {
              dataProjection: "EPSG:4326",
              featureProjection: "EPSG:3857",
            });

            const analysisColorMap = {
              bankRoad: "#2563eb",
              hospitalRoad: "#ef4444",
              educationRoad: "#a855f7",
              hotelRoad: "#f59e0b",
              parkRoad: "#10b981",
            };

            const source = new VectorSource({
              features,
            });
            const layer = new VectorLayer({
              title: `Road Analysis: ${id}`,
              visible: true,
              source,
              style: new Style({
                stroke: new Stroke({ color: analysisColorMap[id] || "#ff9800", width: 3 }),
              }),
            });
            layer.setZIndex(65);
            map.addLayer(layer);
            analysisLayersRef.current[id] = layer;

            // ⭐ Pass data to parent for table
            if (onAnalysisDataLoaded) {
              const rows = features.map(f => {
                const props = f.getProperties();
                // Exclude geometry from table data
                const { geometry, ...rest } = props;
                return rest;
              });
              onAnalysisDataLoaded(id, rows);
            }
          })
          .catch((err) => {
            showFeatureNotice({
              feature: "Road analysis",
              dedupeKey: `${city}|road-analysis|${id}`,
            });
          });
      } else if (!enabled && existing) {
        map.removeLayer(existing);
        delete analysisLayersRef.current[id];
        if (onAnalysisDataLoaded) onAnalysisDataLoaded(id, null);
      }
    });
    Object.keys(analysisLayersRef.current).forEach((id) => {
      if (!vis[id]) {
        const layer = analysisLayersRef.current[id];
        map.removeLayer(layer);
        delete analysisLayersRef.current[id];
      }
    });
  }, [layerVisibility.analysis, city]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    Object.values(analysisLayersRef.current).forEach((layer) => {
      map.removeLayer(layer);
    });
    analysisLayersRef.current = {};
  }, [city]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const styleStreetLight = (feature) => {
      const status = String(feature?.get?.("illumination_status") || "").toUpperCase();
      const filters = streetLightFilters || { illuminated: true, nonIlluminated: true, others: true };
      const visible =
        (status === "ILLUMINATED" && filters.illuminated) ||
        (status === "NON_ILLUMINATED" && filters.nonIlluminated) ||
        (!["ILLUMINATED", "NON_ILLUMINATED"].includes(status) && filters.others);
      if (!visible) return null;
      const color =
        status === "ILLUMINATED" ? "#10b981" :
        status === "NON_ILLUMINATED" ? "#ef4444" :
        "#f59e0b";
      return new Style({
        stroke: new Stroke({ color, width: 3.5 }),
      });
    };

    const styleUnderdeveloped = (feature) => {
      const label = String(feature?.get?.("classification") || "").toLowerCase();
      const filters = underdevelopedFilters || { developed: true, underdeveloped: true, nonDeveloped: true };
      const visible =
        (label === "developed" && filters.developed) ||
        (label === "underdeveloped" && filters.underdeveloped) ||
        (label === "non-developed" && filters.nonDeveloped);
      if (!visible) return null;
      const color =
        label === "developed" ? "#10b981" :
        label === "underdeveloped" ? "#f59e0b" :
        "#ef4444";
      return new Style({
        stroke: new Stroke({ color, width: 4 }),
      });
    };

    const syncGeojsonLayer = ({ id, visible, geojson, styleFn, zIndex }) => {
      const existing = dssLayersRef.current[id];
      if (!visible || !geojson?.features?.length) {
        if (existing) existing.setVisible(false);
        return;
      }

      const features = new GeoJSON().readFeatures(geojson, {
        dataProjection: "EPSG:4326",
        featureProjection: map.getView().getProjection(),
      });

      if (existing) {
        existing.getSource?.().clear?.();
        existing.getSource?.().addFeatures?.(features);
        existing.setStyle(styleFn);
        existing.setVisible(true);
        return;
      }

      const layer = new VectorLayer({
        title: `DSS: ${id}`,
        visible: true,
        source: new VectorSource({ features }),
        style: styleFn,
      });
      layer.setZIndex(zIndex);
      map.addLayer(layer);
      dssLayersRef.current[id] = layer;
    };

    syncGeojsonLayer({
      id: "streetLight",
      visible: !!streetLightVisible,
      geojson: streetLightGeojson,
      styleFn: styleStreetLight,
      zIndex: 140,
    });

    syncGeojsonLayer({
      id: "underdeveloped",
      visible: !!underdevelopedVisible,
      geojson: underdevelopedGeojson,
      styleFn: styleUnderdeveloped,
      zIndex: 141,
    });

    const styleEncroachment = (feature) => {
      const zoneNo = String(feature?.get?.("zone_no") || "").trim();
      if (encroachmentZone && zoneNo !== String(encroachmentZone).trim()) return null;
      return new Style({
        stroke: new Stroke({ color: "#7c3aed", width: 4 }),
      });
    };

    syncGeojsonLayer({
      id: "encroachment",
      visible: !!encroachmentVisible,
      geojson: encroachmentGeojson,
      styleFn: styleEncroachment,
      zIndex: 142,
    });
  }, [
    streetLightVisible,
    streetLightGeojson,
    streetLightFilters,
    underdevelopedVisible,
    underdevelopedGeojson,
    underdevelopedFilters,
    encroachmentVisible,
    encroachmentGeojson,
    encroachmentZone,
  ]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    return () => {
      Object.values(dssLayersRef.current).forEach((layer) => {
        try { map.removeLayer(layer); } catch { }
      });
      dssLayersRef.current = {};
    };
  }, [city]);

  // ---------- DSS WMS (foundation patch — GeoServer contract) ----------
  // Exactly one DSS WMS layer at a time, driven by activeDssModule/
  // activeDssLayer from Dashboard. Deliberately not part of
  // the dssLayersRef vector-layer path above (that stays fed by the old
  // /dss page's own GeoJSON fetches) and never added to the GetFeatureInfo
  // candidate list, so it can't intercept normal road clicks.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    if (!activeDssModule || !activeDssLayer) {
      dssWmsLayerRef.current?.setVisible(false);
      return;
    }

    const onMap = dssWmsLayerRef.current && map.getLayers().getArray().includes(dssWmsLayerRef.current);
    if (!onMap) {
      const layer = new TileLayer({
        title: "DSS WMS Layer",
        source: new TileWMS({
          url: GEOSERVER_BASE + "/wms",
          params: {
            LAYERS: activeDssLayer,
            TILED: true,
            FORMAT: "image/png",
            TRANSPARENT: true,
            VERSION: "1.1.1",
          },
          serverType: "geoserver",
          crossOrigin: "anonymous",
        }),
        visible: true,
      });
      // Above the road network tile layer (zIndex 40) so DSS categories are
      // visible, but below the "Road Network Detail" selection layer (45)
      // and well below road labels (50000).
      layer.setZIndex(42);
      map.addLayer(layer);
      dssWmsLayerRef.current = layer;
    } else {
      dssWmsLayerRef.current.getSource().updateParams({
        LAYERS: activeDssLayer,
      });
      dssWmsLayerRef.current.setVisible(true);
    }
  }, [mapReady, city, activeDssModule, activeDssLayer]);

  useEffect(() => {
    const map = mapRef.current;
    return () => {
      if (map && dssWmsLayerRef.current) {
        try { map.removeLayer(dssWmsLayerRef.current); } catch { }
      }
      dssWmsLayerRef.current = null;
    };
  }, [city]);

  // =====================================================
  // LEGEND DRAG HANDLERS
  // =====================================================
  const handleMouseDown = (e) => {
    e.preventDefault();
    draggingRef.current = true;
    dragOriginRef.current = {
      x: e.clientX,
      y: e.clientY,
      left: legendPos.left !== null ? legendPos.left : mapElement.current.offsetWidth - 300, // Approximate fallback
      top: legendPos.top,
    };
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  };

  const handleMouseMove = (e) => {
    if (!draggingRef.current) return;
    const dx = e.clientX - dragOriginRef.current.x;
    const dy = e.clientY - dragOriginRef.current.y;
    setLegendPos({
      left: dragOriginRef.current.left + dx,
      top: dragOriginRef.current.top + dy,
    });
  };

  const handleMouseUp = () => {
    draggingRef.current = false;
    document.removeEventListener("mousemove", handleMouseMove);
    document.removeEventListener("mouseup", handleMouseUp);
  };

  const handleCoordPointerDown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!mapElement.current) return;
    const rect = mapElement.current.getBoundingClientRect();
    const el = e.currentTarget;
    const elRect = el.getBoundingClientRect();
    coordDraggingRef.current = true;
    coordDragOriginRef.current = {
      x: e.clientX,
      y: e.clientY,
      left: elRect.left - rect.left,
      bottom: rect.bottom - elRect.bottom,
      w: elRect.width,
      h: elRect.height,
      containerW: rect.width,
      containerH: rect.height,
    };
    document.addEventListener("pointermove", handleCoordPointerMove);
    document.addEventListener("pointerup", handleCoordPointerUp);
    document.addEventListener("pointercancel", handleCoordPointerUp);
  };

  const handleCoordPointerMove = (e) => {
    if (!coordDraggingRef.current) return;
    const o = coordDragOriginRef.current;
    const dx = e.clientX - o.x;
    const dy = e.clientY - o.y;
    const maxLeft = Math.max(0, o.containerW - o.w);
    const maxBottom = Math.max(0, o.containerH - o.h);
    const nextLeft = Math.min(Math.max(0, o.left + dx), maxLeft);
    const nextBottom = Math.min(Math.max(0, o.bottom - dy), maxBottom);
    setCoordPos({ left: nextLeft, bottom: nextBottom });
  };

  const handleCoordPointerUp = () => {
    coordDraggingRef.current = false;
    document.removeEventListener("pointermove", handleCoordPointerMove);
    document.removeEventListener("pointerup", handleCoordPointerUp);
    document.removeEventListener("pointercancel", handleCoordPointerUp);
  };

  // =====================================================
  // ⭐ NEW: CENTRALIZED MAP HIGHLIGHT RENDERER
  // =====================================================
  const activeRoadIds = useMemo(() => {
    if (isMultiSelectMode) return selectedRoadIds || EMPTY_ARRAY;
    if (selectedRoadId) return [String(selectedRoadId)];
    return EMPTY_ARRAY;
  }, [isMultiSelectMode, selectedRoadIds, selectedRoadId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // 1. Remove existing layer
    if (selectedRoadLayerRef.current) {
      map.removeLayer(selectedRoadLayerRef.current);
      selectedRoadLayerRef.current = null;
    }

    // Chainage's own visualization (chainageLayerRef/segmentedRoadsLayerRef)
    // is the priority over this generic orange/yellow highlight for a
    // single selected road — this only matters when selectedRoadId was
    // already populated before Chainage armed (openChainageForRoadId
    // itself never sets it). Multi-select is exempt: that's the field-task
    // multi-road *patch* selection, whose own visual feedback this same
    // layer provides and which chainage mode is expected to be active for.
    if (mode === "CHAINAGE" && !isMultiSelectMode && activeRoadIds.length > 0) {
      // Chainage's own layer (chainageLayerRef) isn't in setRoadDimming's
      // list, so dimming here only affects the generic road network/class
      // layers underneath it — chainage stays full-opacity and visually
      // wins, and the front-end also renders fewer full-opacity WMS tiles.
      setSelectedRoadGeometry(null);
      setRoadDimming(true);
      refreshRoadWmsLayers();
      if (!drawInteractionRef.current) ensureMapInteractions(map);
      return;
    }

    // 2. Clear out completely if no selections
    if (activeRoadIds.length === 0) {
      setSelectedRoadGeometry(null);
      setRoadDimming(false);
      refreshRoadWmsLayers();
      if (!drawInteractionRef.current) ensureMapInteractions(map);
      return;
    }

    // 3. Find geometries in local cache
    const geometries = activeRoadIds
      .map((id) => clickedGeometriesCacheRef.current.get(String(id)))
      .filter(Boolean);

    // 4. Render layer
    if (geometries.length > 0) {
      const resolution = map.getView()?.getResolution() || 1;
      const features = geometries.map((geom) => {
        const feature = new Feature({ geometry: geom });
        let isFocused = false;
        for (const [id, cachedGeom] of clickedGeometriesCacheRef.current.entries()) {
          if (cachedGeom === geom && String(selectedRoadId) === String(id)) {
            isFocused = true;
            break;
          }
        }
        feature.set("isFocusedHighlight", isFocused);
        return feature;
      });

      const width = computeStrokeWidth(resolution, 2.8);
      const selectedWidth = baseMap === "satellite" ? Math.max(4, width + 1) : Math.max(2, width);

      const selectedSource = new VectorSource({ features });
      const selectedLayer = new VectorLayer({
        source: selectedSource,
        style: (feature) => {
          const isFocused = feature.get("isFocusedHighlight");
          return new Style({
            stroke: new Stroke({
              color: isFocused ? "#FEF601" : "#FF6A00",
              width: isFocused ? selectedWidth + 2 : selectedWidth,
            }),
          });
        },
      });
      // Above the admin zone/ward boundary layers (zIndex ~39970-39985) so
      // a selected road's highlight is never hidden where it crosses a
      // zone or ward line.
      selectedLayer.setZIndex(40000);
      map.addLayer(selectedLayer);
      selectedRoadLayerRef.current = selectedLayer;

      setSelectedRoadGeometry(
        geometries.length === 1
          ? geometries[0]
          : new GeometryCollection(
            geometries.map((geom) => (geom.clone ? geom.clone() : geom))
          )
      );
      setRoadDimming(true);
      refreshRoadWmsLayers();
      if (!drawInteractionRef.current) ensureMapInteractions(map);
    }
  }, [activeRoadIds, selectedRoadId, baseMap, mode, isMultiSelectMode]);

  // =====================================================
  // CANDIDATE ROADS (adjacent-but-not-yet-selected) — middle dimming tier
  // =====================================================
  // Field-task multi-road patch selection: selected roads render bright via
  // the highlight layer above, everything else is dimmed to ROAD_DIM_OPACITY
  // via setRoadDimming — this fills the gap between those two, rendering
  // the adjacent candidate roads (same list already driving the table's
  // pickable pool, see Dashboard.jsx's fetchAndApplyMultiRoadCandidates) at
  // a visibly distinct-but-muted style, so a worker can see what's pickable
  // next without it competing with the actual selection.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return undefined;

    if (candidateRoadLayerRef.current) {
      map.removeLayer(candidateRoadLayerRef.current);
      candidateRoadLayerRef.current = null;
    }

    const ids = (multiSelectCandidateRoadIds || []).filter(Boolean);
    if (!isMultiSelectMode || !cfg1 || ids.length === 0) return undefined;

    let cancelled = false;
    const idList = ids
      .map((id) => (/^-?\d+$/.test(String(id)) ? String(id) : `'${String(id).replace(/'/g, "''")}'`))
      .join(",");
    const cqlFilter = `${cfg1.roadIdField} IN (${idList})`;
    const wfsUrl =
      `${GEOSERVER_BASE}/${cfg1.workspace}/ows?service=WFS&version=1.0.0&request=GetFeature` +
      `&typeName=${encodeURIComponent(cfg1.roadLayer)}` +
      `&outputFormat=application/json` +
      `&CQL_FILTER=${encodeURIComponent(cqlFilter)}`;

    fetch(wfsUrl)
      .then((res) => (res.ok ? res.json() : null))
      .then((geojson) => {
        if (cancelled || !geojson?.features?.length) return;
        const projection = map.getView()?.getProjection();
        const format = new GeoJSON();
        const features = format.readFeatures(geojson, {
          dataProjection: "EPSG:4326",
          featureProjection: projection,
        });
        const candidateLayer = new VectorLayer({
          source: new VectorSource({ features }),
          style: new Style({
            stroke: new Stroke({ color: "#4A90D9", width: 3, lineDash: [4, 3] }),
          }),
        });
        // Below the road network layer (zIndex 30) — a subtle backdrop wash
        // under the actual road linework, not a highlight competing on top
        // of it. The bright selected-road highlight (zIndex 40000) still
        // renders well above both.
        candidateLayer.setZIndex(20);
        map.addLayer(candidateLayer);
        candidateRoadLayerRef.current = candidateLayer;
      })
      .catch(() => {
        // Non-critical visual aid — leave candidates undimmed-but-unhighlighted
        // rather than surfacing an error for a purely cosmetic fetch.
      });

    return () => {
      cancelled = true;
    };
  }, [multiSelectCandidateRoadIds, isMultiSelectMode, cfg1]);

  // Chainage candidate guidance (Stage 1) — same dashed/muted visual
  // language as the table-Multi candidate layer above, but a fully
  // independent layer/ref/state so the two flows never couple. Renders
  // whenever chainageCandidateRoadIds is populated (see
  // fetchChainageCandidates), regardless of the table-Multi flow's state.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return undefined;

    if (chainageCandidateLayerRef.current) {
      map.removeLayer(chainageCandidateLayerRef.current);
      chainageCandidateLayerRef.current = null;
    }

    const ids = (chainageCandidateRoadIds || []).filter(Boolean);
    if (!cfg1 || ids.length === 0) return undefined;

    let cancelled = false;
    // Quote unless the id is a genuine JS number (matches
    // openChainageForRoadId's own `typeof roadId === "number"` check for
    // its single-road CQL filter, which is why that one works correctly).
    // A regex digit-pattern test on the *string* content — what this used
    // to do — misclassifies zero-padded numeric-looking ids (e.g. Kanpur's
    // "093400900001") as safe to leave unquoted; GeoServer then reads that
    // as the bare number 93400900001, silently dropping the leading zero
    // and matching nothing against the real (VARCHAR) column value. That
    // was why candidates showed a correct count but never actually
    // rendered on the map.
    const idList = chainageCandidateRoads
      .map((r) => r.road_id)
      .map((id) => (typeof id === "number" ? String(id) : `'${String(id).replace(/'/g, "''")}'`))
      .join(",");
    const cqlFilter = `${cfg1.roadIdField} IN (${idList})`;
    const wfsUrl =
      `${GEOSERVER_BASE}/${cfg1.workspace}/ows?service=WFS&version=1.0.0&request=GetFeature` +
      `&typeName=${encodeURIComponent(cfg1.roadLayer)}` +
      `&outputFormat=application/json` +
      `&CQL_FILTER=${encodeURIComponent(cqlFilter)}`;

    fetch(wfsUrl)
      .then((res) => (res.ok ? res.json() : null))
      .then((geojson) => {
        if (cancelled || !geojson?.features?.length) return;
        const projection = map.getView()?.getProjection();
        const format = new GeoJSON();
        const features = format.readFeatures(geojson, {
          dataProjection: "EPSG:4326",
          featureProjection: projection,
        });
        // Same stroke width the normal (non-chainage) single-road selection
        // highlight uses (computeStrokeWidth(resolution, 2.8), see the
        // selectedRoadLayerRef effect) — candidates should read as "the
        // same kind of highlight," just a different, contrasting color
        // (blue, dashed) so they're never confused with Road 1's own gold
        // chainage-points line or an actively-picked Road 2.
        const candidateResolution = map.getView()?.getResolution() || 1;
        const candidateWidth = computeStrokeWidth(candidateResolution, 2.8);
        const candidateLayer = new VectorLayer({
          source: new VectorSource({ features }),
          style: new Style({
            stroke: new Stroke({ color: "#2B7FFF", width: candidateWidth, lineDash: [6, 4] }),
          }),
        });
        // Above the road network tile layer (zIndex 40/45) so the highlight
        // is actually visible instead of mostly hidden underneath the road
        // linework — still below Road 1's own solid highlight (40000) and
        // road labels (50000), so it never competes with either.
        candidateLayer.setZIndex(39000);
        map.addLayer(candidateLayer);
        chainageCandidateLayerRef.current = candidateLayer;
      })
      .catch(() => {
        // Non-critical visual aid — leave candidates unhighlighted rather
        // than surfacing an error for a purely cosmetic fetch.
      });

    return () => {
      cancelled = true;
    };
  }, [chainageCandidateRoadIds, chainageCandidateRoads, cfg1]);

  // =====================================================
  // AUTO-ZOOM TO FEATURE BASED ON zoomFilter
  // =====================================================
  useEffect(() => {
    if (!mapRef.current) return;

    const modeJustChanged = prevZoomEffectModeRef.current !== mode;
    prevZoomEffectModeRef.current = mode;

    if (String(zoomFilter || "").trim().toUpperCase() === "INCLUDE") {
      const map = mapRef.current;
      if (selectedRoadLayerRef.current && map) {
        map.removeLayer(selectedRoadLayerRef.current);
        selectedRoadLayerRef.current = null;
      }
      setSelectedRoadGeometry(null);
      setRoadDimming(false);
      return;
    }

    // ⭐ If filter is cleared, return to city default view
    if (!zoomFilter) {
      const map = mapRef.current;
      if (selectedRoadLayerRef.current && map) {
        map.removeLayer(selectedRoadLayerRef.current);
        selectedRoadLayerRef.current = null;
      }
      setSelectedRoadGeometry(null);
      setRoadDimming(false);

      // Redirected chainage links target a specific lat/lon marker —
      // don't snap the view back to the generic city default over it.
      // Same isFieldTaskMode-equivalent gate as the other two spots: a
      // lat/lon pair alone isn't a real field-task redirect without
      // project_id/user_id too.
      const urlParams = new URLSearchParams(location.search);
      const hasUrlTarget =
        urlParams.has("latitude") &&
        urlParams.has("longitude") &&
        !!(urlParams.get("project_id") && urlParams.get("user_id"));
      if (hasUrlTarget && mode === "CHAINAGE") return;

      // Toggling Chainage mode on/off (via Dashboard's in-place mode
      // switch, not a page navigation) re-runs this effect because `mode`
      // is in its dependency array — but if zoomFilter was already empty,
      // there's no filter being "cleared" here, just a UI mode switch, so
      // don't discard whatever pan/zoom the user was already at.
      if (modeJustChanged) return;

      const cityKey = city.toLowerCase();
      const defaultView = cityViews[cityKey] || cityViews.default;
      const view = mapRef.current.getView();

      // Animate back to city center
      view.animate({
        center: defaultView.center,
        zoom: defaultView.zoom,
        duration: 800
      });
      return;
    }

    const map = mapRef.current;
    if (!map) return;
    const view = map.getView();
    const viewProj = view.getProjection();
    const isGeometryFilter = /INTERSECTS\s*\(|DWITHIN\s*\(|BBOX\s*\(/i.test(String(zoomFilter || ""));
    if (isGeometryFilter) {
      const fitExtent = lastSpatialExtentRef.current;
      if (fitExtent) {
        view.fit(fitExtent, {
          padding: getAutoZoomPadding(false),
          duration: 800,
          maxZoom: baseMap === "satellite" ? SATELLITE_MAX_ZOOM : 18,
        });
      }
      return;
    }

    const cfg = cityConfig[city.toLowerCase()] || {};
    if (!cfg.roadLayer) {
      console.warn("⚠️ [AutoZoom] No roadLayer defined in cityConfig");
      return;
    }
    const apiUrl =
      `/api/road-networks/${city}/details?filter=${encodeURIComponent(
        zoomFilter
      )}&include_geom=true`;

    // Selecting a new road (especially in a different zone/ward) before the
    // previous selection's fetch resolves used to leave both requests
    // racing — whichever happened to finish last would silently win and
    // render, even if it was the now-stale selection. Cancel the previous
    // one outright instead.
    if (autoZoomDetailsAbortRef.current) autoZoomDetailsAbortRef.current.abort();
    const detailsController = new AbortController();
    autoZoomDetailsAbortRef.current = detailsController;

    fetch(apiUrl, { signal: detailsController.signal })
      .then((res) => {
        if (!res.ok) {
          throw new Error(`Road details request failed: ${res.status} ${res.statusText}`);
        }
        return res.json();
      })
      .then((payload) => {
        const rows = payload.data || [];
        if (!Array.isArray(rows) || rows.length === 0) {
          console.warn("⚠️ [AutoZoom] No rows found for filter:", zoomFilter);
          return;
        }

        // Determine if this filter is selecting a single road by ID
        const filterLower = (zoomFilter || "").toLowerCase();
        const isIdentifierFilter = /\bgis_id\s*=\s*'[^']+'|\broad_id\s*=\s*'[^']+'/.test(
          filterLower
        );

        // Always remove any previous highlight layer
        if (selectedRoadLayerRef.current) {
          map.removeLayer(selectedRoadLayerRef.current);
          selectedRoadLayerRef.current = null;
        }

        const format = new GeoJSON();
        const features = rows
          .filter((row) => row && row.geom)
          .map((row) =>
            format.readFeature(
              {
                type: "Feature",
                properties: row,
                geometry: row.geom,
              },
              {
                dataProjection: detectDataProjection(row.geom, viewProj),
                featureProjection: viewProj.getCode(),
              }
            )
          )
          .filter((f) => !!f && !!f.getGeometry && !!f.getGeometry());

        if (!features.length) {
          setSelectedRoadGeometry(null);
          console.warn("⚠️ [AutoZoom] No valid geometries for filter:", zoomFilter);
          return;
        }
        const geometries = features
          .map((feature) => feature.getGeometry?.())
          .filter(Boolean);
        setSelectedRoadGeometry(
          geometries.length === 1
            ? geometries[0]
            : geometries.length
              ? new GeometryCollection(geometries.map((geom) => (geom.clone ? geom.clone() : geom)))
              : null
        );

        // Cache all matching geometries for instant rendering later
        features.forEach((f) => {
          const p = f.getProperties();
          const g = f.getGeometry?.();
          if (g) {
            const rId = p.road_id || p.ROAD_ID;
            const gId = p.gis_id || p.GIS_ID;
            if (rId) clickedGeometriesCacheRef.current.set(String(rId), g);
            if (gId) clickedGeometriesCacheRef.current.set(String(gId), g);
          }
        });

        // Chainage takes priority over the regular identify popup — the
        // live click handler already skips showPopup for roads in this
        // mode (modeRef checks a few hundred lines up); this is the same
        // rule applied to the separate zoomFilter-triggered auto-popup,
        // which had no mode check at all.
        if (isIdentifierFilter && features.length > 0 && showPopupRef.current && modeRef.current !== "CHAINAGE") {
          const targetFeature = features[0];
          const geom = targetFeature?.getGeometry?.();
          const popupCoordinate = geom ? getCenter(geom.getExtent()) : view.getCenter();
          const title =
            targetFeature.get("road_name") ||
            rows[0]?.road_name ||
            "Road";
          showPopupRef.current(targetFeature, title, popupCoordinate, true, true, null, false);
        }

        const extentSource = new VectorSource({ features });
        const projectedExtent = extentSource.getExtent();
        const fitExtent = normalizeExtent(projectedExtent, view);

        if (fitExtent) {
          const maxZoom = isMobileView
            ? (isIdentifierFilter ? 18 : 16)
            : (isIdentifierFilter ? 20 : 18);
          const cappedMaxZoom = baseMap === "satellite"
            ? Math.min(maxZoom, SATELLITE_MAX_ZOOM)
            : maxZoom;
          if (map?.updateSize) {
            map.updateSize();
          }
          view.fit(fitExtent, {
            padding: getAutoZoomPadding(isIdentifierFilter),
            duration: 800,
            maxZoom: cappedMaxZoom,
          });
          if (isIdentifierFilter) {
            const center = getCenter(fitExtent);
            if (center && center.every((n) => Number.isFinite(n))) {
              view.animate({
                center,
                duration: 800,
              });
            }
          }
        }
      })
      .catch((err) => {
        if (err?.name === "AbortError") return;
        console.error("❌ [AutoZoom] Error:", err);
      });
    return () => {
      if (autoZoomDetailsAbortRef.current) autoZoomDetailsAbortRef.current.abort();
    };
  }, [zoomFilter, city, isMobileView, baseMap, location.search, mode]);


  //chainage
  const refreshPatchStateAfterCreate = async (roadId, createdPatchId = null) => {
  try {
    const res = await fetch(
      `/api/patches/${city.toLowerCase()}/${roadId}`
    );

    const data = await res.json();

    console.log("PATCH STATE REFRESH:", data);

    if (!data.exists) {
      setCurrentRoadPatchList([]);
      setPatchInfo({ exists: false });
      setPatchChoice(null);
      setShowPatchPanel(false);
      return;
    }

    const currentRoadId = String(roadId);

    const newRoadRows = data.data.map((row) => ({
      ...row,
      road_id: row.road_id || currentRoadId,
    }));

    const currentRoadPatches = buildPatchListFromRows(newRoadRows);

    const rowsWithoutCurrentRoad = allPatchRows.filter(
      (row) => String(row.road_id) !== currentRoadId
    );

    const mergedRows = [...rowsWithoutCurrentRoad, ...newRoadRows];

    setCurrentRoadPatchList(currentRoadPatches);
    setAllPatchRows(mergedRows);

    setPatchInfo({
      ...data,
      data: newRoadRows,
    });

    // Requirement 1: show VIEW PATCHES Yes/No immediately
    setShowPatchPanel(true);

    // Requirement 2: if user already selected Yes, update patch-list/map/table immediately
    if (patchChoice === "yes") {
      const createdPatch = currentRoadPatches.find(
        (patch) => String(patch.patch_id) === String(createdPatchId)
      );

      const createdPatchKey = createdPatch?.key;

      const updatedSelection = createdPatchKey
        ? [...new Set([...selectedPatches, createdPatchKey])]
        : selectedPatches;

      setSelectedPatches(updatedSelection);

      handleShowPatches(updatedSelection, mergedRows);
      updatePatchTableFromSelection(updatedSelection, mergedRows);
    } else {
      // keep Yes/No unselected when user has not chosen Yes yet
      setPatchChoice(null);
    }
  } catch (err) {
    console.error("PATCH STATE REFRESH ERROR:", err);
  }
};
  //chainage
  // Step 1: validate the chosen chainage range, fetch the exact segment
  // geometries it covers (read-only preview, nothing saved yet), highlight
  // them on the map in a distinct color, zoom to them, capture a
  // watermarked snapshot, and open the confirm dialog. Nothing is written
  // to the database until the user clicks Save in that dialog.
  // Accepts explicit (roadId, start, end) so the exact same preview ->
  // confirm -> save pipeline (below, and handleConfirmSavePatch) can be
  // reused for Road 2's own junction-anchored range — calling it with no
  // arguments keeps the original Road 1 behavior (selectedRoad/
  // startChainage/endChainage) unchanged.
  const handleCreateChainageRequest = async (roadIdOverride, startOverride, endOverride) => {
    const roadId = roadIdOverride ?? selectedRoad?.road_id;
    const start = startOverride ?? Number(startChainage);
    const end = endOverride ?? Number(endChainage);

    if (!roadId || !Number.isFinite(start) || !Number.isFinite(end)) {
      alert("Select road and chainage points");
      return;
    }

    if (start >= end) {
      alert("End chainage must be greater than start");
      return;
    }

    const cityParam = city.toLowerCase();

    try {
      const res = await fetch(
        `/api/patch-preview/${cityParam}/${encodeURIComponent(roadId)}?start=${start}&end=${end}`
      );
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || data.message || "Unable to load patch preview");
      }
      if (!data.data?.length) {
        alert("No road segments found in this chainage range.");
        return;
      }

      const map = mapRef.current;
      if (patchPreviewLayerRef.current && map) {
        map.removeLayer(patchPreviewLayerRef.current);
        patchPreviewLayerRef.current = null;
      }

      const format = new GeoJSON();
      const projection = map?.getView()?.getProjection();
      const features = data.data
        .map((row) => {
          if (!row.geojson) return null;
          try {
            return format.readFeature(JSON.parse(row.geojson), {
              dataProjection: "EPSG:4326",
              featureProjection: projection,
            });
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      if (features.length && map) {
        // Start = first coordinate of the first segment, end = last
        // coordinate of the last segment — segments come back from
        // /api/patch-preview already ordered by chainage (start/end query
        // params), so these are the patch's real two endpoints.
        const [startCoord] = getLineEndpoints(features[0].getGeometry());
        const [, endCoord] = getLineEndpoints(features[features.length - 1].getGeometry());
        const markerFeatures = [];
        if (startCoord) {
          const f = new Feature({ geometry: new Point(startCoord) });
          f.setStyle(PATCH_START_MARKER_STYLE);
          markerFeatures.push(f);
        }
        if (endCoord) {
          const f = new Feature({ geometry: new Point(endCoord) });
          f.setStyle(PATCH_END_MARKER_STYLE);
          markerFeatures.push(f);
        }

        const vectorSource = new VectorSource({ features: [...features, ...markerFeatures] });
        const previewLayer = new VectorLayer({
          source: vectorSource,
          style: patchPreviewLayerStyle,
        });
        // Above every WMS overlay tier this app uses (segmented-roads/
        // chainage points both sit around 40000) so the preview can never
        // be masked by whatever else happens to be toggled on underneath
        // it — only road labels (50000) sit higher.
        previewLayer.setZIndex(41000);
        map.addLayer(previewLayer);
        patchPreviewLayerRef.current = previewLayer;

        let extent = features[0].getGeometry().getExtent();
        features.forEach((f) => {
          const e = f.getGeometry().getExtent();
          extent = [
            Math.min(extent[0], e[0]),
            Math.min(extent[1], e[1]),
            Math.max(extent[2], e[2]),
            Math.max(extent[3], e[3]),
          ];
        });
        // Instant (duration 0) — the preview snapshot is captured right
        // after this, no animation to wait out.
        fitPatchPreviewExtent(map, extent);
      }

      // The snapshot only needs to show the patch itself — previewLayer
      // above already carries its own start/end markers and highlighted
      // line. The full "every chainage point on the whole road" layer and
      // the live-picking markers/highlight are for the interactive form,
      // not this still image; left on, their labels for points outside the
      // picked range just clutter a tightly-zoomed snapshot for no reason.
      // Hidden only for the capture, restored right after so the form
      // behind the dialog still looks normal if the user cancels.
      if (chainagePointsLayerRef.current) chainagePointsLayerRef.current.setVisible(false);
      if (chainageLiveMarkerLayerRef.current) chainageLiveMarkerLayerRef.current.setVisible(false);
      if (chainageLivePreviewLayerRef.current) chainageLivePreviewLayerRef.current.setVisible(false);

      const { dataUrl } = await captureMapImageBlob();
      setPatchConfirmImage(dataUrl);
      setPatchConfirmPending({ roadId, start, end });
      setShowPatchConfirm(true);

      if (chainagePointsLayerRef.current) chainagePointsLayerRef.current.setVisible(true);
      if (chainageLiveMarkerLayerRef.current) chainageLiveMarkerLayerRef.current.setVisible(true);
      if (chainageLivePreviewLayerRef.current) chainageLivePreviewLayerRef.current.setVisible(true);
    } catch (err) {
      console.error("PATCH PREVIEW ERROR:", err);
      alert(err.message || "Unable to preview this patch.");
    }
  };

  // The single CREATE button both roads now share. Single-road case is
  // untouched (just calls the plain pipeline above). Two-road case: Start
  // and the free Road 2 value can each legitimately land on either side of
  // their own road's junction value (see chainageRoad1Values/
  // chainageRoad2Values below — the junction is no longer assumed to be
  // one road's max), so both pairs get sorted by magnitude here rather
  // than assuming the picked value is always the smaller or larger one.
  // Road 1's own preview/confirm opens first; handleConfirmSavePatch reads
  // pendingRoad2SaveRef once that's confirmed and continues into Road 2's,
  // so this one press walks through both halves of the patch.
  const handleCreateCombinedChainageRequest = async () => {
    if (!chainageRoad2Id) {
      await handleCreateChainageRequest();
      return;
    }
    if (!chainageJunctionInfo) {
      alert("Still finding the junction between these roads — please wait a moment and try again.");
      return;
    }
    const startPicked = Number(startChainage);
    const junc1 = Number(chainageJunctionInfo.road1Value);
    if (!Number.isFinite(startPicked) || startPicked === junc1) {
      alert("Select a Start Chainage for Road 1.");
      return;
    }
    const freePicked = Number(chainageRoad2FreeValue);
    const junc2 = Number(chainageJunctionInfo.road2Value);
    if (!Number.isFinite(freePicked) || freePicked === junc2) {
      alert("Select an End Chainage for Road 2.");
      return;
    }
    pendingRoad2SaveRef.current = {
      roadId: chainageRoad2Id,
      start: Math.min(freePicked, junc2),
      end: Math.max(freePicked, junc2),
    };
    await handleCreateChainageRequest(chainageRoad1Id, Math.min(startPicked, junc1), Math.max(startPicked, junc1));
  };

  // Step 2: user confirmed in the dialog — now actually write the patch.
  const handleConfirmSavePatch = async () => {
    if (!patchConfirmPending) return;
    const { roadId, start, end } = patchConfirmPending;
    const wasTableOpen = showPatchTable; // captured before refresh may change it
    setPatchConfirmSaving(true);
    let savedOk = false;

    try {
      const payload = {
        city: city.toLowerCase(),
        road_id: roadId,
        startPoint: start,
        endPoint: end,
      };

      const res = await fetch("/api/create-patch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (data.alreadyExists) {
        showFeatureNotice({
          feature: "Chainage",
          message: data.message || "Patch already exists. Please select it from the checkbox list.",
          dedupeKey: `patch-exists|${city}|${roadId}|${Date.now()}`,
          autoDismissMs: 5000,
        });
        await refreshPatchStateAfterCreate(roadId, data.patch_id);
      } else if (!res.ok) {
        throw new Error(data.error || data.message || "Patch creation failed");
      } else {
        showFeatureNotice({
          feature: "Chainage",
          message: `Patch created (ID: ${data.patch_id}, ${data.inserted} segment(s)).`,
          dedupeKey: `patch-created|${city}|${data.patch_id}|${Date.now()}`,
          autoDismissMs: 4500,
        });
        setPatchChoice("yes");
        if (!wasTableOpen) onPatchTableOpenRef.current?.();
        await refreshPatchStateAfterCreate(roadId, data.patch_id);
      }

      setShowCreateChainageForm(false);
      setStartChainage("");
      setEndChainage("");
      savedOk = true;
    } catch (err) {
      console.error("PATCH SAVE ERROR:", err);
      alert(err.message);
      pendingRoad2SaveRef.current = null;
    } finally {
      setPatchConfirmSaving(false);
      setShowPatchConfirm(false);
      setPatchConfirmPending(null);
      setPatchConfirmImage(null);
      if (patchPreviewLayerRef.current && mapRef.current) {
        mapRef.current.removeLayer(patchPreviewLayerRef.current);
        patchPreviewLayerRef.current = null;
      }
    }

    // Road 1's half of a combined two-road patch just finished (saved or
    // already existed) — continue straight into Road 2's own preview/
    // confirm so the whole patch only ever needed the one CREATE press.
    // Runs after the finally block above has fully reset the dialog state,
    // so Road 2's own preview/confirm (opened by this call) isn't
    // immediately torn down behind it. Guarded on roadId matching Road 1
    // specifically so Road 2's own completion a moment from now doesn't
    // try to chain again.
    const pendingRoad2 = pendingRoad2SaveRef.current;
    if (savedOk && pendingRoad2 && String(roadId) === String(chainageRoad1Id)) {
      pendingRoad2SaveRef.current = null;
      await handleCreateChainageRequest(pendingRoad2.roadId, pendingRoad2.start, pendingRoad2.end);
    }
  };

  const handleCancelPatchConfirm = () => {
    pendingRoad2SaveRef.current = null;
    setShowPatchConfirm(false);
    setPatchConfirmPending(null);
    setPatchConfirmImage(null);
    if (patchPreviewLayerRef.current && mapRef.current) {
      mapRef.current.removeLayer(patchPreviewLayerRef.current);
      patchPreviewLayerRef.current = null;
    }
  };

  // ===== Multi-road patch creation (field-task mode) =====
  //chainage
  // Step 1: preview — every selected road's *full* length (start=0,
  // end=a-value-past-any-real-segment-count, so the existing ">start
  // AND<=end" range query on the segments table matches every segment
  // without needing a separate "what's this road's max segment" lookup).
  const FULL_ROAD_END_SENTINEL = 999999;//chainage
  // Multi-road selection itself happens in Dashboard's table (its own
  // Multi/Apply controls, filtered to adjacent-road candidates via
  // /adjacent-roads) — this only takes the finished list of {road_id,
  // road_name} and runs the same preview -> confirm -> save flow the
  // single-road form already uses, just once per road instead of once
  // total. Exposed to Dashboard via the ref (see useImperativeHandle).
  const handleCreateMultiRoadPatchRequest = useCallback(async (roadInfos) => {//chainage
    const roads = Array.isArray(roadInfos) ? roadInfos : [];
    if (roads.length < 2) {
      showFeatureNotice({
        feature: "Chainage",
        message: "Select at least one more connected road before creating a multi-road patch.",
        dedupeKey: `multi-road-too-few|${Date.now()}`,
        autoDismissMs: 4000,
      });
      return;
    }
    setMultiRoadSelection(roads);
    const cityParam = city.toLowerCase();
    try {
      const previews = await Promise.all(
        roads.map((r) =>
          fetch(`/api/patch-preview/${cityParam}/${encodeURIComponent(r.road_id)}?start=0&end=${FULL_ROAD_END_SENTINEL}`)
            .then((res) => (res.ok ? res.json() : { data: [] }))
            .catch(() => ({ data: [] }))
        )
      );

      const map = mapRef.current;
      if (multiRoadPreviewLayerRef.current && map) {
        map.removeLayer(multiRoadPreviewLayerRef.current);
        multiRoadPreviewLayerRef.current = null;
      }

      const format = new GeoJSON();
      const projection = map?.getView()?.getProjection();
      // Kept per-road (not flattened) so junction markers can be placed
      // between each consecutive pair of roads, not just at the overall
      // start/end of the whole multi-road patch.
      const perRoadFeatures = previews.map((payload) =>
        (payload?.data || [])
          .map((row) => {
            if (!row.geojson) return null;
            try {
              return format.readFeature(JSON.parse(row.geojson), {
                dataProjection: "EPSG:4326",
                featureProjection: projection,
              });
            } catch {
              return null;
            }
          })
          .filter(Boolean)
      );
      const allFeatures = perRoadFeatures.flat();

      if (!allFeatures.length) {
        showFeatureNotice({
          feature: "Chainage",
          message: "No road segments found for the selected roads.",
          dedupeKey: `multi-road-no-segments|${Date.now()}`,
          autoDismissMs: 4000,
        });
        return;
      }

      if (map) {
        const roadsWithFeatures = perRoadFeatures.filter((f) => f.length > 0);
        const markerFeatures = [];
        if (roadsWithFeatures.length) {
          const [startCoord] = getLineEndpoints(roadsWithFeatures[0][0].getGeometry());
          const lastRoadFeatures = roadsWithFeatures[roadsWithFeatures.length - 1];
          const [, endCoord] = getLineEndpoints(lastRoadFeatures[lastRoadFeatures.length - 1].getGeometry());
          if (startCoord) {
            const f = new Feature({ geometry: new Point(startCoord) });
            f.setStyle(PATCH_START_MARKER_STYLE);
            markerFeatures.push(f);
          }
          if (endCoord) {
            const f = new Feature({ geometry: new Point(endCoord) });
            f.setStyle(PATCH_END_MARKER_STYLE);
            markerFeatures.push(f);
          }
          // One junction marker between each consecutive pair of roads that
          // both actually returned segments — where two roads' selected
          // stretches meet.
          for (let i = 0; i < roadsWithFeatures.length - 1; i++) {
            const junction = findClosestRoadJunction(roadsWithFeatures[i], roadsWithFeatures[i + 1]);
            if (junction) {
              const f = new Feature({ geometry: new Point(junction) });
              f.setStyle(PATCH_JUNCTION_MARKER_STYLE);
              markerFeatures.push(f);
            }
          }
        }

        const vectorSource = new VectorSource({ features: [...allFeatures, ...markerFeatures] });
        const previewLayer = new VectorLayer({
          source: vectorSource,
          style: patchPreviewLayerStyle,
        });
        previewLayer.setZIndex(41000);
        map.addLayer(previewLayer);
        multiRoadPreviewLayerRef.current = previewLayer;

        let extent = allFeatures[0].getGeometry().getExtent();
        allFeatures.forEach((f) => {
          const e = f.getGeometry().getExtent();
          extent = [
            Math.min(extent[0], e[0]),
            Math.min(extent[1], e[1]),
            Math.max(extent[2], e[2]),
            Math.max(extent[3], e[3]),
          ];
        });
        fitPatchPreviewExtent(map, extent);
      }

      const { dataUrl } = await captureMapImageBlob();
      setMultiRoadConfirmImage(dataUrl);
      setShowMultiRoadConfirm(true);
    } catch (err) {
      console.error("MULTI-ROAD PATCH PREVIEW ERROR:", err);
      showFeatureNotice({
        feature: "Chainage",
        message: err?.message || "Unable to preview this multi-road patch.",
        dedupeKey: `multi-road-preview-error|${Date.now()}`,
        autoDismissMs: 4500,
      });
    }
  }, [city, showFeatureNotice]);//chainage
  handleCreateMultiRoadPatchRequestRef.current = handleCreateMultiRoadPatchRequest; //chainage

  // Step 2: confirmed — same DB write as the single-road flow
  // (/api/create-patch), just called once per selected road. Each call is
  // independent (its own patch_id, tied to that one road), so a partial
  // failure part-way through still leaves the roads before it correctly
  // saved rather than rolling back the whole batch.
  const handleConfirmSaveMultiRoadPatch = useCallback(async () => {//chainage
    setMultiRoadConfirmSaving(true);
    const cityParam = city.toLowerCase();
    const results = { created: 0, alreadyExists: 0, failed: 0 };
    for (const road of multiRoadSelection) {
      try {
        const res = await fetch("/api/create-patch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            city: cityParam,
            road_id: road.road_id,
            startPoint: 0,
            endPoint: FULL_ROAD_END_SENTINEL,
          }),
        });
        const data = await res.json();
        if (data.alreadyExists) results.alreadyExists += 1;
        else if (!res.ok) results.failed += 1;
        else results.created += 1;
      } catch {
        results.failed += 1;
      }
    }

    showFeatureNotice({
      feature: "Chainage",
      message: `Multi-road patch: ${results.created} created, ${results.alreadyExists} already existed, ${results.failed} failed (${multiRoadSelection.length} roads total).`,
      dedupeKey: `multi-road-saved|${Date.now()}`,
      autoDismissMs: 6000,
    });

    if (!showPatchTable) onPatchTableOpenRef.current?.();

    setMultiRoadConfirmSaving(false);
    setShowMultiRoadConfirm(false);
    setMultiRoadConfirmImage(null);
    setMultiRoadSelection([]);
    if (multiRoadPreviewLayerRef.current && mapRef.current) {
      mapRef.current.removeLayer(multiRoadPreviewLayerRef.current);
      multiRoadPreviewLayerRef.current = null;
    }
  }, [multiRoadSelection, city, showFeatureNotice, showPatchTable]);//chainage

  const handleCancelMultiRoadConfirm = useCallback(() => {//chainage
    setShowMultiRoadConfirm(false);
    setMultiRoadConfirmImage(null);
    if (multiRoadPreviewLayerRef.current && mapRef.current) {
      mapRef.current.removeLayer(multiRoadPreviewLayerRef.current);
      multiRoadPreviewLayerRef.current = null;
    }
  }, []);//chainage

  //chainage
  // const handleShowPatches = () => {
  //   if (!patchInfo?.data?.length) return;

  //   // convert DB geom → features
  //   const format = new GeoJSON();

  //   const features = patchInfo.data.map(row =>
  //   format.readFeature(JSON.parse(row.geom), {
  //     dataProjection: "EPSG:4326",
  //     featureProjection: mapRef.current.getView().getProjection(),
  //   })
  // );

  //   const vectorSource = new VectorSource({
  //     features,
  //   });

  //   const vectorLayer = new VectorLayer({
  //     source: vectorSource,
  //     style: new Style({
  //       stroke: new Stroke({
  //         color: "#22c55e",
  //         width: 4,
  //       }),
  //     }),
  //   });

  //   if (patchLayerRef.current) {
  //   mapRef.current.removeLayer(patchLayerRef.current);
  // }

  // mapRef.current.addLayer(vectorLayer);
  // patchLayerRef.current = vectorLayer;
  // };
  //chainage
  const handleShowPatches = (
    patchSelection = selectedPatches,
    rows = allPatchRows
  ) => {
    if (!mapRef.current) return;

    const selectedRows = rows.filter((row) =>
      patchSelection.includes(getPatchKey(row))
    );

    if (patchLayerRef.current) {
      mapRef.current.removeLayer(patchLayerRef.current);
      patchLayerRef.current = null;
    }

    startMarkerSourceRef.current.clear();
    endMarkerSourceRef.current.clear();

    if (!selectedRows.length) {
      setPatchTableData([]);
      setShowPatchTable(false);
      return;
    }

    const format = new GeoJSON();

    const features = selectedRows
      .map((row) => {
        try {
          const feature = format.readFeature(JSON.parse(row.geom), {
            dataProjection: "EPSG:4326",
            featureProjection: mapRef.current.getView().getProjection(),
          });

          feature.set("patch_id", row.patch_id);
          feature.set("road_id", row.road_id);
          feature.set("patch_key", getPatchKey(row));

          return feature;
        } catch (err) {
          console.error("Invalid patch geometry:", row, err);
          return null;
        }
      })
      .filter(Boolean);

    if (!features.length) return;

    const vectorSource = new VectorSource({ features });

    const vectorLayer = new VectorLayer({
      source: vectorSource,
      style: new Style({
        stroke: new Stroke({
          color: "#fc0909",
          width: 4,
        }),
      }),
    });

    vectorLayer.setZIndex(900);

    mapRef.current.addLayer(vectorLayer);
    patchLayerRef.current = vectorLayer;

    updatePatchMarkersFromSource(vectorSource);

    let extent = features[0].getGeometry().getExtent();

    features.forEach((feature) => {
      const e = feature.getGeometry().getExtent();

      extent = [
        Math.min(extent[0], e[0]),
        Math.min(extent[1], e[1]),
        Math.max(extent[2], e[2]),
        Math.max(extent[3], e[3]),
      ];
    });

    const paddingFactor = 0.25;
    const width = extent[2] - extent[0];
    const height = extent[3] - extent[1];

    const finalExtent = [
      extent[0] - width * paddingFactor,
      extent[1] - height * paddingFactor,
      extent[2] + width * paddingFactor,
      extent[3] + height * paddingFactor,
    ];

    mapRef.current.getView().fit(finalExtent, {
      padding: getAutoZoomPadding(false),
      duration: 700,
      maxZoom: 19,
    });

    updatePatchTableFromSelection(patchSelection, rows);
  };
  //chainage
  const handlePatchToggle = (patchKey) => {
    const updatedSelection = selectedPatches.includes(patchKey)
      ? selectedPatches.filter((key) => key !== patchKey)
      : [...selectedPatches, patchKey];

    setSelectedPatches(updatedSelection);

    // Only snapshot on the closed→open transition, not on every checkbox
    // toggle — re-snapshotting while already open would overwrite the
    // correct "before the table opened" state with the wrong one.
    if (updatedSelection.length > 0 && !showPatchTable) {
      onPatchTableOpenRef.current?.();
    }

    handleShowPatches(updatedSelection, allPatchRows);
    updatePatchTableFromSelection(updatedSelection, allPatchRows);
  };
  //chainage
  const handleHidePatches = () => {
    if (patchLayerRef.current) {
      mapRef.current.removeLayer(patchLayerRef.current);
      patchLayerRef.current = null;
    }
    startMarkerSourceRef.current.clear();
    endMarkerSourceRef.current.clear();
  };
  //chainage
  const updatePatchMarkersFromSource = (source) => {
    const startSource = startMarkerSourceRef.current;
    const endSource = endMarkerSourceRef.current;

    startSource.clear();
    endSource.clear();

    const features = source.getFeatures();
    if (!features.length) return;

    const patchGroups = {};

    features.forEach(f => {
      const pid = f.get("patch_id");
      if (!patchGroups[pid]) patchGroups[pid] = [];
      patchGroups[pid].push(f);
    });

    Object.values(patchGroups).forEach(patchFeatures => {

      const startCandidates = {};
      const endCandidates = {};

      patchFeatures.forEach(f => {
        const geom = f.getGeometry();
        if (!geom) return;

        const processCoords = (coords) => {
          const start = coords[0].join(",");
          const end = coords[coords.length - 1].join(",");

          startCandidates[start] = (startCandidates[start] || 0) + 1;
          endCandidates[end] = (endCandidates[end] || 0) + 1;
        };

        if (geom.getType() === "LineString") {
          processCoords(geom.getCoordinates());
        }

        if (geom.getType() === "MultiLineString") {
          geom.getCoordinates().forEach(seg => processCoords(seg));
        }
      });

      let startCoord = null;
      let endCoord = null;

      Object.keys(startCandidates).forEach(c => {
        if (!endCandidates[c]) startCoord = c.split(",").map(Number);
      });

      Object.keys(endCandidates).forEach(c => {
        if (!startCandidates[c]) endCoord = c.split(",").map(Number);
      });

      if (startCoord) {
        startSource.addFeature(new Feature({
          geometry: new Point(startCoord)
        }));
      }

      if (endCoord) {
        endSource.addFeature(new Feature({
          geometry: new Point(endCoord)
        }));
      }

    });
  };
  //chainage
  const fetchPatchTableData = async (patchIds) => {
    try {
      const res = await fetch("/api/patch-segments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({
          city: city.toLowerCase(),
          patchIds,
        }),
      });

      const data = await res.json();

      setPatchTableData(data);
      setShowPatchTable(true);

    } catch (err) {
      console.error("TABLE FETCH ERROR:", err);
    }
  };
  //chainage
  const applyChainageFilter = (filter) => {
    if (!roadLayerRef.current) return;

    const source = roadLayerRef.current.getSource();

    if (!source) return;

    source.updateParams({
      CQL_FILTER: filter,
    });
  };

  // Stage 1 chainage candidate guidance — fetches roads adjacent to
  // `road1Id` (same /adjacent-roads endpoint and ward-scoping Dashboard's
  // table-Multi flow already uses at fetchAndApplyMultiRoadCandidates) and
  // stores them independently of that flow's own state, so the two never
  // couple. `excludeId` lets a just-picked Road 2 be kept out of the
  // candidate pool without a second round trip.
  const fetchChainageCandidates = useCallback(async (road1Id, excludeId) => {
    if (!road1Id) return;
    chainageCandidateFetchAbortRef.current?.abort();
    const controller = new AbortController();
    chainageCandidateFetchAbortRef.current = controller;
    // A purely-cosmetic guidance fetch must never hang the UI waiting on a
    // slow/unavailable backend — bound it and fail quiet (no candidates
    // shown) rather than leaving "connected roads" state stuck loading.
    const timeoutId = setTimeout(() => controller.abort(), 6000);

    const wardNums = (fieldTaskWardList || []).map(Number).filter(Number.isFinite);
    const wardsParam = wardNums.length ? `&wards=${wardNums.join(",")}` : "";
    const cityParam = city.toLowerCase();

    try {
      const res = await fetch(
        `/api/road-networks/${cityParam}/adjacent-roads?road_id=${encodeURIComponent(road1Id)}${wardsParam}`,
        { signal: controller.signal }
      );
      const list = res.ok ? await res.json() : [];
      const rows = (Array.isArray(list) ? list : []).filter(
        (r) => String(r.road_id) !== String(road1Id) && String(r.road_id) !== String(excludeId || "")
      );
      setChainageCandidateRoads(rows);
      const ids = rows.map((r) => String(r.road_id));
      setChainageCandidateRoadIds(ids);
      onChainageCandidateContextChangeRef.current?.({
        active: true,
        road1Id: String(road1Id),
        road2Id: excludeId ? String(excludeId) : null,
        candidateRoadIds: ids,
      });
    } catch (err) {
      // Covers both a genuinely aborted (superseded) request and our own
      // timeout firing — either way, non-critical: leave candidates empty
      // rather than surfacing an error for what's purely a "here's what's
      // connected" aid. Road 1's own panel/data is unaffected either way.
    } finally {
      clearTimeout(timeoutId);
    }
  }, [city, fieldTaskWardList]);

  // Pushes whichever of chainageRoad1CqlRef/chainageRoad2CqlRef are
  // currently set to the shared chainage WMS layer as a single combined
  // filter (one predicate -> used as-is; two -> OR'd together), so the same
  // layer/tile-set renders exactly the roads actually paired right now —
  // O(1) work, no extra GeoServer layer or request beyond the one
  // updateParams() this already had to do for a single road.
  // Retired: this used to turn on the GeoServer "chainage_distance_label"
  // WMS layer, kept alongside the newer client-rendered points/labels
  // (updateChainagePointsLayer) as a fallback. With that vector layer
  // confirmed working for both roads, running both at once was pure
  // regression — GeoServer's own "180.00"-style labels rendered directly on
  // top of this app's plain "180" ones, showing every point twice. Left as
  // a no-op (rather than deleting every call site) so the WMS layer simply
  // never gets turned on; chainageLayerRef itself stays untouched in case
  // GetFeatureInfo click-identify against it is ever wanted again.
  const applyChainageLayerFilter = useCallback(() => {}, []);

  // Fetches + caches one road's full segment set (geometry + segment_id),
  // reused by both the junction lookup and the point/live-marker layers
  // below. Cache key is the road id alone, so calling this again for the
  // same road (e.g. re-opening the create form) is a no-op read, not a
  // re-fetch — same O(1)-after-first-load cost the junction lookup already
  // relied on implicitly.
  const loadChainageSegments = useCallback(async (roadId, cacheRef, signal) => {
    if (!roadId) return [];
    const key = String(roadId);
    if (cacheRef.current.roadId === key) return cacheRef.current.features;
    // Marks this key as the latest request for this cache slot — if a
    // *different* road gets requested against the same cacheRef before this
    // fetch resolves (e.g. Road 1 replaced while its own segment fetch was
    // still in flight), that call overwrites pendingKey, and this one's
    // result is discarded on arrival instead of clobbering the newer road's
    // correct data with a slower, stale response.
    cacheRef.current = { ...cacheRef.current, pendingKey: key };
    try {
      const cityParam = city.toLowerCase();
      const format = new GeoJSON();
      const projection = mapRef.current?.getView()?.getProjection();
      const res = await fetch(
        `/api/patch-preview/${cityParam}/${encodeURIComponent(key)}?start=0&end=999999`,
        { signal }
      );
      if (!res.ok) return [];
      const data = await res.json();
      const features = (data?.data || [])
        .map((row) => {
          if (!row.geojson) return null;
          try {
            // row.geojson is ST_AsGeoJSON(geom) alone — bare geometry, no
            // properties — so readFeature() never sees segment_id on its
            // own; attach it from the row (SELECT * on the same query).
            const feature = format.readFeature(JSON.parse(row.geojson), {
              dataProjection: "EPSG:4326",
              featureProjection: projection,
            });
            feature.set("segment_id", row.segment_id ?? row.segmentid ?? row.seg_id ?? null);
            return feature;
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      if (cacheRef.current.pendingKey === key) {
        cacheRef.current = { roadId: key, features, pendingKey: key };
      }
      return features;
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      return [];
    }
  }, [city]);

  // Rebuilds the readable client-side chainage points/labels for whichever
  // of Road 1/Road 2's segments are currently cached — O(segments) work,
  // no network call (loadChainageSegments already populated the cache).
  const updateChainagePointsLayer = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const road1Features = chainageRoad1Id && chainageRoad1SegmentsRef.current.roadId === String(chainageRoad1Id)
      ? chainageRoad1SegmentsRef.current.features
      : [];
    const road2Features = chainageRoad2Id && chainageRoad2SegmentsRef.current.roadId === String(chainageRoad2Id)
      ? chainageRoad2SegmentsRef.current.features
      : [];
    const points = [];
    const addPoints = (features, roadNum) => {
      features.forEach((f) => {
        const suffix = parseSegmentSuffix(f);
        if (suffix == null) return;
        const [, endCoord] = getLineEndpoints(f.getGeometry());
        if (!endCoord) return;
        const pf = new Feature({ geometry: new Point(endCoord) });
        pf.set("distance", suffix);
        pf.set("road", roadNum);
        points.push(pf);
      });
    };
    addPoints(road1Features, 1);
    addPoints(road2Features, 2);
    if (!chainagePointsLayerRef.current) {
      chainagePointsLayerRef.current = new VectorLayer({
        source: new VectorSource({ features: points }),
        style: chainagePointStyle,
        // No declutter: this used to silently drop overlapping labels near
        // a junction, which is exactly where point density from both roads
        // is highest — real points were disappearing, not just crowding.
        // Every real point stays visible even if a few labels overlap.
      });
      // Above the WMS chainage layer (40000) so these crisp, correctly-sized
      // labels are what's actually visible; below the junction marker
      // (41000) and the live start/end markers (41200) so a locked/picked
      // point's bigger marker always wins over the plain point underneath it.
      chainagePointsLayerRef.current.setZIndex(40200);
      map.addLayer(chainagePointsLayerRef.current);
    } else {
      const source = chainagePointsLayerRef.current.getSource();
      source.clear();
      source.addFeatures(points);
    }
    chainagePointsLayerRef.current.setVisible(points.length > 0);
  }, [chainageRoad1Id, chainageRoad2Id]);

  // Bigger green/red markers at whichever Start/End values are currently
  // picked (any of Road 1's Start/End, Road 2's End) — live feedback the
  // moment a dropdown changes, reusing the same marker styles/colors the
  // real patch-preview flow already uses elsewhere so this reads as "this
  // is where your patch will start/end", not a separate visual language.
  const updateChainageLiveMarkers = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const findCoord = (cacheRef, roadId, value) => {
      if (!roadId || value === "" || value == null) return null;
      if (cacheRef.current.roadId !== String(roadId)) return null;
      const target = Number(value);
      if (!Number.isFinite(target)) return null;
      const match = cacheRef.current.features.find((f) => parseSegmentSuffix(f) === target);
      if (!match) return null;
      const [, endCoord] = getLineEndpoints(match.getGeometry());
      return endCoord || null;
    };
    const features = [];
    const startCoord = findCoord(chainageRoad1SegmentsRef, chainageRoad1Id, startChainage);
    if (startCoord) {
      const f = new Feature({ geometry: new Point(startCoord) });
      f.setStyle(PATCH_START_MARKER_STYLE);
      features.push(f);
    }
    // Road 1's own End is only a live user pick while Road 2 isn't locking
    // it to the junction — once locked, the junction marker already shows
    // that exact point, so a second marker on top would be redundant.
    if (!chainageRoad2Id) {
      const endCoord = findCoord(chainageRoad1SegmentsRef, chainageRoad1Id, endChainage);
      if (endCoord) {
        const f = new Feature({ geometry: new Point(endCoord) });
        f.setStyle(PATCH_END_MARKER_STYLE);
        features.push(f);
      }
    }
    const road2EndCoord = findCoord(chainageRoad2SegmentsRef, chainageRoad2Id, chainageRoad2FreeValue);
    if (road2EndCoord) {
      const f = new Feature({ geometry: new Point(road2EndCoord) });
      f.setStyle(PATCH_END_MARKER_STYLE);
      features.push(f);
    }
    if (!chainageLiveMarkerLayerRef.current) {
      chainageLiveMarkerLayerRef.current = new VectorLayer({ source: new VectorSource({ features }) });
      // Above the point/label layer (40200) and the junction marker (41000)
      // so a live Start/End pick is never masked by either.
      chainageLiveMarkerLayerRef.current.setZIndex(41200);
      map.addLayer(chainageLiveMarkerLayerRef.current);
    } else {
      const source = chainageLiveMarkerLayerRef.current.getSource();
      source.clear();
      source.addFeatures(features);
    }
  }, [chainageRoad1Id, chainageRoad2Id, startChainage, endChainage, chainageRoad2FreeValue]);

  // Runs updateChainageLiveMarkers whenever any of its own inputs change —
  // i.e. every time the user picks a different Start/End value in any of
  // the dropdowns above, the green/red marker(s) move immediately.
  useEffect(() => {
    updateChainageLiveMarkers();
  }, [updateChainageLiveMarkers]);

  // Highlights the actual segments the patch will cover as soon as enough
  // is picked to know a real range — not just the endpoint markers above,
  // the whole line, so it reads as "this is your patch" rather than three
  // separate dots. Same (suffix > lo && suffix <= hi) direction the server
  // itself filters on in /api/patch-preview and /api/create-patch, so this
  // never highlights a stretch the actual save wouldn't also select.
  const updateChainageLivePreview = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const segmentsInRange = (cacheRef, roadId, valueA, valueB) => {
      if (!roadId || cacheRef.current.roadId !== String(roadId)) return [];
      const a = Number(valueA);
      const b = Number(valueB);
      if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return [];
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      return cacheRef.current.features.filter((f) => {
        const suf = parseSegmentSuffix(f);
        return suf != null && suf > lo && suf <= hi;
      });
    };
    const road1End = chainageRoad2Id && chainageJunctionInfo ? chainageJunctionInfo.road1Value : endChainage;
    const segs = [
      ...segmentsInRange(chainageRoad1SegmentsRef, chainageRoad1Id, startChainage, road1End),
      ...(chainageRoad2Id && chainageJunctionInfo
        ? segmentsInRange(chainageRoad2SegmentsRef, chainageRoad2Id, chainageJunctionInfo.road2Value, chainageRoad2FreeValue)
        : []),
    ];
    if (!chainageLivePreviewLayerRef.current) {
      chainageLivePreviewLayerRef.current = new VectorLayer({
        source: new VectorSource({ features: segs }),
        style: patchPreviewLayerStyle,
      });
      // Above the point layer (40200) but below the junction/live-endpoint
      // markers (41000/41200), so the line reads as "under" its own markers.
      chainageLivePreviewLayerRef.current.setZIndex(40800);
      map.addLayer(chainageLivePreviewLayerRef.current);
    } else {
      const source = chainageLivePreviewLayerRef.current.getSource();
      source.clear();
      source.addFeatures(segs);
    }
  }, [chainageRoad1Id, chainageRoad2Id, startChainage, endChainage, chainageRoad2FreeValue, chainageJunctionInfo]);

  useEffect(() => {
    updateChainageLivePreview();
  }, [updateChainageLivePreview]);

  // Removes both layers + clears both segment caches — called whenever the
  // whole chainage panel closes, so nothing stale lingers into the next
  // road opened.
  const clearChainagePointLayers = useCallback(() => {
    const map = mapRef.current;
    if (chainagePointsLayerRef.current && map) {
      map.removeLayer(chainagePointsLayerRef.current);
      chainagePointsLayerRef.current = null;
    }
    if (chainageLiveMarkerLayerRef.current && map) {
      map.removeLayer(chainageLiveMarkerLayerRef.current);
      chainageLiveMarkerLayerRef.current = null;
    }
    if (chainageLivePreviewLayerRef.current && map) {
      map.removeLayer(chainageLivePreviewLayerRef.current);
      chainageLivePreviewLayerRef.current = null;
    }
    chainageRoad1SegmentsRef.current = { roadId: null, features: [] };
    chainageRoad2SegmentsRef.current = { roadId: null, features: [] };
    setChainageRoad1Values([]);
    setChainageRoad2Values([]);
  }, []);

  // Shared by both the legacy roadLayerRef-based identify path and the
  // general "click whatever road layer is already visible on the dashboard"
  // path: given a resolved roadId, fetch patches/chainage data for that one
  // road and open the patch panel — scoped to just that road, never "all
  // roads at once."
  const openChainageForRoadId = useCallback(async (roadId, roadProps, signal) => {
    if (!roadId || !cfg1) return;

    // Field-task redirects load neighboring wards for context (labels
    // visible, so the assigned ward's position relative to them makes
    // sense) but patch creation only belongs to the one ward actually
    // assigned — clicking a road that's purely in a neighbor is a no-op
    // with an explanation, not a silent success. The road dataset is
    // already segmented by ward (one ward_no per road_id), so a real road
    // that continues from the assigned ward into a neighbor is a *separate*
    // row tagged with the assigned ward's own number — this attribute check
    // alone already lets that case through without needing a separate
    // geometry crossing test.
    if (isFieldTaskMode && Number.isFinite(fieldTaskTargetWard)) {
      const roadWardNo = Number(roadProps?.ward_no);
      if (Number.isFinite(roadWardNo) && roadWardNo !== fieldTaskTargetWard) {
        showFeatureNotice({
          feature: "Chainage",
          message: `This road belongs to Ward ${roadWardNo}, outside your assigned Ward ${fieldTaskTargetWard}. Patch creation is only available within your assigned ward.`,
          dedupeKey: `chainage-outside-ward|${roadWardNo}`,
          autoDismissMs: 4500,
        });
        return;
      }
    }

    // Stage 1 chainage candidate guidance — fired here (immediately, in
    // parallel with the patches/chainage/zoom data below), not after that
    // data finishes loading. road1Id/candidates don't depend on any of
    // that data, so waiting for it first was pure added latency stacked on
    // top of an already-multi-request panel open. Road 2 is never opened
    // via this function in this patch — that stays a separate, lighter
    // click/state update (see handleChainageRoadClick).
    const openedRoadId = String(roadProps?.road_id || roadId);
    setChainageRoad1Id(openedRoadId);
    setChainageRoad2Id(null);
    setChainageRoad2Name(null);
    fetchChainageCandidates(openedRoadId);

    // Fresh Road 1 -> Road 2's cached segments/points are stale regardless
    // of whether a Road 2 even existed. Clear the previous road's points
    // immediately (rather than leaving them on screen until the new fetch
    // resolves) and fetch Road 1's own segments here in parallel with
    // everything else below, so the readable chainage points are ready
    // close to when the panel itself is, not after a further round trip
    // once the create form opens.
    chainageRoad2SegmentsRef.current = { roadId: null, features: [] };
    setChainageRoad2Values([]);
    updateChainagePointsLayer();
    loadChainageSegments(openedRoadId, chainageRoad1SegmentsRef, signal)
      .then((features) => {
        setChainageRoad1Values(sortedSegmentValues(features));
        updateChainagePointsLayer();
        updateChainageLiveMarkers();
      })
      .catch(() => {});

    // Redirect marker has done its job of getting the view to the right
    // spot — once the worker has actually picked a road to work on, shrink
    // it to a low-key dot so it stops competing visually with the chainage
    // layer, which is now the priority.
    urlLocationMarkerLayerRef.current?.setStyle(URL_LOCATION_DOT_STYLE);

    const cityParam = city.toLowerCase();
    const roadIdText = String(roadId);
    const cacheKey = `${cityParam}|${roadIdText}`;
    const roadFilter =
      typeof roadId === "number"
        ? `${cfg1.roadIdField}=${roadId}`
        : `${cfg1.roadIdField}='${roadIdText.replace(/'/g, "''")}'`;

    const readRoadFeatures = (geojson, projection) => {
      if (!geojson?.features?.length) return [];
      const format = new GeoJSON();
      return format.readFeatures(geojson, {
        dataProjection: "EPSG:4326",
        featureProjection: projection,
      });
    };
    const fitRoadFeatures = (features) => {
      if (!features.length || !mapRef.current) return;
      let extent = features[0].getGeometry().getExtent();
      features.forEach((f) => {
        const e = f.getGeometry().getExtent();
        extent = [
          Math.min(extent[0], e[0]),
          Math.min(extent[1], e[1]),
          Math.max(extent[2], e[2]),
          Math.max(extent[3], e[3]),
        ];
      });
      const width = extent[2] - extent[0];
      const height = extent[3] - extent[1];
      const paddingFactor = 0.4;
      mapRef.current.getView().fit([
        extent[0] - width * paddingFactor,
        extent[1] - height * paddingFactor,
        extent[2] + width * paddingFactor,
        extent[3] + height * paddingFactor,
      ], {
        padding: getAutoZoomPadding(false),
        duration: 500,
        maxZoom: 18,
      });
    };
    const loadJson = async (requestUrl, featureName) => {
      const response = await fetch(requestUrl, { signal, credentials: "include" });
      const payload = await response.json();
      if (!response.ok) {
        if (showApiUnavailableNotice(payload, featureName)) {
          return { unavailable: true, payload };
        }
        throw new Error(payload?.error || `HTTP ${response.status}`);
      }
      return payload;
    };

    // Entering Chainage for a road supersedes whatever the regular
    // (non-chainage) road-select highlight/zoom flow was doing — that
    // flow's own visualization (selectedRoadLayerRef) isn't what chainage
    // shows anyway (chainageLayerRef/segmentedRoadsLayer are), so an
    // in-flight fetch for it is now pure wasted work competing for the
    // same network/DB capacity chainage needs right now. Cancel it
    // outright rather than letting both race.
    if (autoZoomDetailsAbortRef.current) autoZoomDetailsAbortRef.current.abort();

    setSelectedRoad({
      road_id: roadProps?.road_id || roadId,
      road_name: roadProps?.road_name,
      category: roadProps?.category,
      condition: roadProps?.condition,
    });
    // Table-row highlight only — deliberately not the full onRoadSelected
    // callback (handleRoadSelectedFromMap), which resets baseFilter/zoomFilter
    // in ways that would fight field-task mode's own ward-scoped default
    // filter. This keeps map-click -> table-highlight symmetric with the
    // already-working table-row-click -> map-open-chainage direction,
    // without dragging in the non-field-task selection side effects.
    onFieldTaskRoadHighlightRef.current?.(roadProps?.road_id || roadId);
    setStartChainage("");
    setEndChainage("");
    setChainageList([]);
    setShowCreateChainageForm(false);
    setShowPatchPanel(false);
    setPatchChoice(null);

    try {
      let roadData = chainageRoadDataCacheRef.current.get(cacheKey);
      let zoomFeaturesPromise = null;
      if (!roadData) {
        const projection = mapRef.current?.getView()?.getProjection();
        const wfsUrl =
          `${GEOSERVER_BASE}/${cfg1.workspace}/ows?service=WFS&version=1.0.0&request=GetFeature` +
          `&typeName=${encodeURIComponent(cfg1.roadLayer)}` +
          `&outputFormat=application/json` +
          `&CQL_FILTER=${encodeURIComponent(roadFilter)}`;

        // Only patches + chainage rows gate the panel — the WFS fetch is
        // purely for the "zoom to this road" camera animation, so it's
        // fired in parallel but NOT awaited here. Previously all three were
        // Promise.all'd together, so a slow WFS query (a separate GeoServer
        // round trip) delayed the whole panel from appearing.
        zoomFeaturesPromise = fetch(wfsUrl, { signal })
          .then((zoomRes) => zoomRes.ok ? zoomRes.json() : null)
          .then((zoomGeojson) => readRoadFeatures(zoomGeojson, projection))
          .then((features) => {
            // Looked up by key (not the outer `roadData` closure var, which
            // races against the Promise.all below) so a later cache-hit for
            // this road can re-fit the view without re-fetching WFS geometry.
            const cached = chainageRoadDataCacheRef.current.get(cacheKey);
            if (cached) cached.zoomFeatures = features;
            return features;
          })
          .catch((err) => {
            if (err?.name === "AbortError") throw err;
            return [];
          });

        const [patches, chainageRows] = await Promise.all([
          loadJson(`/api/patches/${cityParam}/${encodeURIComponent(roadIdText)}`, "Chainage patches"),
          loadJson(`/api/chainage/${cityParam}/${encodeURIComponent(roadIdText)}`, "Chainage"),
        ]);

        roadData = { patches, chainageRows };
        chainageRoadDataCacheRef.current.set(cacheKey, roadData);
      }

      if (signal?.aborted) return;

      const patches = roadData.patches;
      if (patches && !patches.unavailable && patches.exists) {
        const newRoadRows = patches.data.map((row) => ({
          ...row,
          road_id: row.road_id || roadIdText,
        }));
        const currentRoadPatches = [];
        const seenCurrent = new Set();

        newRoadRows.forEach((row) => {
          const key = getPatchKey(row);
          if (!seenCurrent.has(key)) {
            seenCurrent.add(key);
            currentRoadPatches.push({
              key,
              patch_id: row.patch_id,
              road_id: row.road_id,
            });
          }
        });

        setCurrentRoadPatchList(currentRoadPatches);
        setAllPatchRows((prevRows) => {
          const rowsWithoutCurrentRoad = prevRows.filter(
            (row) => String(row.road_id) !== roadIdText
          );
          // patchInfo is always kept (exists:true here) so the "View
          // Patches" button can read patchInfo?.exists to enable itself.
          // showPatchPanel now only opens when that button is clicked, not
          // automatically on load.
          setPatchInfo({ ...patches, data: newRoadRows });
          setPatchChoice(null);
          setShowPatchPanel(false);
          return [...rowsWithoutCurrentRoad, ...newRoadRows];
        });
      } else {
        setCurrentRoadPatchList([]);
        // Store exists:false rather than nulling — the "View Patches"
        // button reads patchInfo?.exists to decide whether to gray itself
        // out and show the "no patch yet" message.
        setPatchInfo(patches && !patches.unavailable ? patches : { exists: false });
        setPatchChoice(null);
        setShowPatchPanel(false);
      }

      const chainageRows = Array.isArray(roadData.chainageRows) ? roadData.chainageRows : [];
      const distances = chainageRows
        .map((d) => Number(d.distance))
        .filter((v) => !Number.isNaN(v));
      setChainageList([...new Set(distances)].sort((a, b) => a - b));

      // Zoom-to-road camera animation happens whenever the WFS geometry
      // resolves, without blocking the panel/patch UI above on it. On a
      // cache hit there's no fresh WFS fetch (zoomFeaturesPromise stays
      // null), so re-fit from the geometry cached alongside roadData on the
      // original fetch — otherwise re-clicking an already-viewed road never
      // moves the camera to it.
      if (zoomFeaturesPromise) {
        zoomFeaturesPromise.then((features) => {
          if (!signal?.aborted) fitRoadFeatures(features || []);
        }).catch(() => {});
      } else if (roadData.zoomFeatures) {
        fitRoadFeatures(roadData.zoomFeatures);
      }

      // Road 2 (if any) always got cleared above already — this is always a
      // fresh Road 1, so its own chainage dots are the whole story until/
      // unless a Road 2 gets paired again.
      chainageRoad1CqlRef.current = roadFilter;
      chainageRoad2CqlRef.current = "";
      applyChainageLayerFilter();

    } catch (err) {
      if (err?.name === "AbortError") return;
      showFeatureNotice({
        feature: "Chainage",
        message: "Chainage data could not be loaded for this road. Please try again or select another road.",
        dedupeKey: `${city}|chainage-click`,
      });
    }
  }, [city, cfg1, showApiUnavailableNotice, showFeatureNotice, isFieldTaskMode, fieldTaskTargetWard, fetchChainageCandidates, applyChainageLayerFilter, loadChainageSegments, updateChainagePointsLayer, updateChainageLiveMarkers]);
  openChainageForRoadIdRef.current = openChainageForRoadId; //chainage

  // Stage 2 — junction chainage detection. Fetches both roads' full
  // segment sets (existing /api/patch-preview, start=0/end=999999 — the
  // same call the multi-road preview already makes), finds the closest
  // segment endpoint pair between them, and reads off each road's own
  // chainage value there via parseSegmentSuffix — the exact same unit
  // /api/patch-preview and /api/create-patch already filter/save on, so
  // this never invents a value those endpoints wouldn't recognize.
  const computeChainageJunction = useCallback(async (road1Id, road2Id) => {
    if (!road1Id || !road2Id) return;
    chainageJunctionAbortRef.current?.abort();
    const controller = new AbortController();
    chainageJunctionAbortRef.current = controller;
    setChainageJunctionLoading(true);
    setChainageJunctionError(null);
    setChainageJunctionInfo(null);
    setChainageRoad2ChainageList([]);
    setChainageRoad2FreeValue("");

    const cityParam = city.toLowerCase();

    try {
      // Shared with the point/live-marker layers (loadChainageSegments
      // caches by road id) — Road 1's segments are very likely already
      // cached from the create-form-open fetch by the time Road 2 pairs, so
      // this Promise.all is usually one real fetch (Road 2) plus a cache
      // read, not two fresh round trips.
      const [road1Features, road2Features, road2ChainageRes] = await Promise.all([
        loadChainageSegments(road1Id, chainageRoad1SegmentsRef, controller.signal),
        loadChainageSegments(road2Id, chainageRoad2SegmentsRef, controller.signal),
        fetch(`/api/chainage/${cityParam}/${encodeURIComponent(road2Id)}`, { signal: controller.signal })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
      ]);

      if (controller.signal.aborted) return;

      if (!road1Features.length || !road2Features.length) {
        setChainageJunctionError("Could not load segment geometry for one of the roads.");
        return;
      }

      setChainageRoad1Values(sortedSegmentValues(road1Features));
      setChainageRoad2Values(sortedSegmentValues(road2Features));
      updateChainagePointsLayer();

      const junction = findRoadJunctionDetail(road1Features, road2Features);
      if (!junction || junction.suffixA == null || junction.suffixB == null) {
        setChainageJunctionError("Could not determine a junction chainage point between these roads.");
        return;
      }

      // Fixed roles (Road 1 = free Start -> Junc, Road 2 = Junc -> free
      // End — see the effect that syncs endChainage below and the render
      // code) mean neither road's own min/max needs scanning here anymore:
      // just the two junction values themselves, O(1) beyond the O(n)
      // dedupe+sort already needed to populate Road 2's own dropdown.
      const road2Distances = Array.isArray(road2ChainageRes?.chainageRows)
        ? road2ChainageRes.chainageRows.map((d) => Number(d.distance)).filter(Number.isFinite)
        : [];

      setChainageJunctionInfo({
        road1Value: junction.suffixA,
        road2Value: junction.suffixB,
        point: junction.point,
      });
      setChainageRoad2ChainageList(Array.from(new Set(road2Distances)).sort((a, b) => a - b));

      // Junction marker on the live map — same visual language the
      // multi-road preview already uses for this (PATCH_JUNCTION_MARKER_STYLE).
      const map = mapRef.current;
      if (map) {
        if (chainageJunctionMarkerLayerRef.current) {
          map.removeLayer(chainageJunctionMarkerLayerRef.current);
          chainageJunctionMarkerLayerRef.current = null;
        }
        const markerFeature = new Feature({ geometry: new Point(junction.point) });
        markerFeature.setStyle(PATCH_JUNCTION_MARKER_STYLE);
        const markerLayer = new VectorLayer({ source: new VectorSource({ features: [markerFeature] }) });
        markerLayer.setZIndex(41000);
        map.addLayer(markerLayer);
        chainageJunctionMarkerLayerRef.current = markerLayer;
      }
    } catch (err) {
      if (err?.name === "AbortError") return;
      setChainageJunctionError("Could not compute the junction point for these roads.");
    } finally {
      if (!controller.signal.aborted) setChainageJunctionLoading(false);
    }
  }, [city, loadChainageSegments, updateChainagePointsLayer]);

  // Clears junction state + its map marker — used both when Road 2 is
  // cleared and when the whole chainage panel closes.
  const clearChainageJunction = useCallback(() => {
    chainageJunctionAbortRef.current?.abort();
    setChainageJunctionInfo(null);
    setChainageJunctionLoading(false);
    setChainageJunctionError(null);
    setChainageRoad2ChainageList([]);
    setChainageRoad2FreeValue("");
    const map = mapRef.current;
    if (chainageJunctionMarkerLayerRef.current && map) {
      map.removeLayer(chainageJunctionMarkerLayerRef.current);
      chainageJunctionMarkerLayerRef.current = null;
    }
  }, []);

  // Road 2 cleared -> Road 1 stays, candidates for Road 1 re-fetch (Road 2
  // rejoins the pickable pool).
  const clearChainageRoad2 = useCallback(() => {
    if (!chainageRoad2Id || !chainageRoad1Id) return;
    setChainageRoad2Id(null);
    setChainageRoad2Name(null);
    clearChainageJunction();
    chainageRoad2CqlRef.current = "";
    applyChainageLayerFilter();
    chainageRoad2SegmentsRef.current = { roadId: null, features: [] };
    setChainageRoad2Values([]);
    updateChainagePointsLayer();
    fetchChainageCandidates(chainageRoad1Id);
  }, [chainageRoad1Id, chainageRoad2Id, fetchChainageCandidates, clearChainageJunction, applyChainageLayerFilter, updateChainagePointsLayer]);

  // Stage 1 chainage candidate guidance — the single gatekeeper every
  // CHAINAGE-mode map click now goes through, replacing the three direct
  // openChainageForRoadId(...) calls the click handler used to make.
  // Decides whether a click is "open Road 1", "pair Road 2" (state/visual
  // only — no junction detection or panel changes in this patch), or
  // blocked (already have two roads, or clicked something unconnected).
  const handleChainageRoadClick = useCallback(async (roadId, roadProps, signal) => {
    const clickedId = String(roadProps?.road_id || roadId || "");
    if (!clickedId) return;

    if (!chainageRoad1Id) {
      await openChainageForRoadId(roadId, roadProps, signal);
      return;
    }

    if (clickedId === String(chainageRoad1Id) || (chainageRoad2Id && clickedId === String(chainageRoad2Id))) {
      // Already open (as Road 1 or Road 2) — nothing to do.
      return;
    }

    if (chainageRoad2Id) {
      // Both slots full — ask which to remove instead of just rejecting
      // the click, so this 3rd road can take the freed slot.
      setChainagePendingThirdClick({ roadId, roadProps, signal });
      return;
    }

    if (chainageCandidateRoadIds.includes(clickedId)) {
      const matchedCandidate = chainageCandidateRoads.find((r) => String(r.road_id) === clickedId);
      setChainageRoad2Id(clickedId);
      setChainageRoad2Name(matchedCandidate?.road_name || roadProps?.road_name || null);
      // Same quoting convention as Road 1's own roadFilter (openChainageForRoadId)
      // — these road_id values are frequently zero-padded strings, so an
      // unquoted numeric-looking id would have GeoServer silently strip the
      // leading zeros and match nothing. Adds Road 2's dots to the same
      // shared chainage WMS layer Road 1 is already using (OR'd together in
      // applyChainageLayerFilter), instead of a second layer/request.
      if (cfg1) {
        chainageRoad2CqlRef.current =
          typeof roadId === "number"
            ? `${cfg1.roadIdField}=${roadId}`
            : `${cfg1.roadIdField}='${String(roadId).replace(/'/g, "''")}'`;
        applyChainageLayerFilter();
      }
      // Road 2's own form was already rendering unconditionally once paired
      // (it doesn't check showCreateChainageForm), but Road 1's form only
      // shows after its own separate "Create Patch" click — so pairing
      // Road 2 before ever pressing that button left only Road 2's half of
      // the two-road patch visible. Open Road 1's form here too, so both
      // sides of the same patch appear together the moment they're paired.
      setShowCreateChainageForm(true);
      // Both slots are now full — no more candidates are pickable (only two
      // roads are ever supported), so drop the whole list/highlight layer
      // rather than just removing the one just picked.
      setChainageCandidateRoadIds([]);
      setChainageCandidateRoads([]);
      onChainageCandidateContextChangeRef.current?.({
        active: true,
        road1Id: String(chainageRoad1Id),
        road2Id: clickedId,
        candidateRoadIds: [],
      });
      computeChainageJunction(chainageRoad1Id, clickedId);
      return;
    }

    showFeatureNotice({
      feature: "Chainage",
      message: "Only connected roads can be added. Clear Road 1 to select another road.",
      dedupeKey: `chainage-not-connected|${city}|${Date.now()}`,
      autoDismissMs: 4000,
    });
  }, [chainageRoad1Id, chainageRoad2Id, chainageCandidateRoadIds, chainageCandidateRoads, openChainageForRoadId, showFeatureNotice, city, computeChainageJunction, applyChainageLayerFilter]);
  // Kept current every render — see the declaration comment on
  // handleChainageRoadClickRef for why this one specifically can't be
  // called directly from the [city]-only-registered click handler closure.
  handleChainageRoadClickRef.current = handleChainageRoadClick;

  // Resolves the "3rd road clicked, both slots full" prompt. Keeping this
  // simple and race-free rather than clever: removing Road 1 hands the
  // pending road a full fresh start as the new Road 1 (openChainageForRoadId
  // doesn't depend on any stale candidate state, so this is always
  // correct); removing Road 2 clears it and re-fetches Road 1's candidates,
  // but deliberately does NOT try to auto-pair the pending road afterward —
  // doing that off the freshly-cleared (not-yet-refetched) candidate list
  // would be a race, so it just tells the user to click it again.
  const resolveChainageThirdClick = useCallback(async (removeWhich) => {
    const pending = chainagePendingThirdClick;
    setChainagePendingThirdClick(null);
    if (!pending) return;

    if (removeWhich === "road1") {
      await openChainageForRoadId(pending.roadId, pending.roadProps, pending.signal);
      return;
    }

    if (removeWhich === "road2") {
      clearChainageRoad2();
      showFeatureNotice({
        feature: "Chainage",
        message: `Road 2 cleared. Click ${pending.roadProps?.road_name || pending.roadId} again to pair it, if it's connected to Road 1.`,
        dedupeKey: `chainage-road2-cleared-for-pending|${city}|${Date.now()}`,
        autoDismissMs: 5000,
      });
    }
  }, [chainagePendingThirdClick, openChainageForRoadId, clearChainageRoad2, showFeatureNotice, city]);

  // Chainage "armed" prompt: entering chainage mode no longer loads any
  // heavy layer — it just arms click-to-inspect and tells the user what to
  // do next, GIS "start editing"-style. Dismisses itself after a few
  // seconds, and re-appears each time chainage mode is (re-)armed.
  //
  // Two cases:
  // 1. A road was already selected on the dashboard (selectedRoadId prop,
  //    from the normal click/table flow) before Chainage was armed — auto-
  //    load its chainage/segmented layer immediately instead of making the
  //    user click the same road again, then guide them toward marking a
  //    patch (the actual civil-engineer task) rather than "select a road."
  // 2. Nothing is selected yet — ask for a road, as before.
  useEffect(() => {
    if (!mapReady || mode !== "CHAINAGE") return;

    if (
      selectedRoadId &&
      (!selectedRoad || String(selectedRoad.road_id) !== String(selectedRoadId))
    ) {
      openChainageForRoadId(selectedRoadId, {
        road_id: selectedRoadId,
        road_name: selectedRoadName,
      });
      return; // setSelectedRoad() inside will re-run this effect once loaded
    }

    if (selectedRoad) {
      showFeatureNotice({
        feature: "Chainage",
        message: `Select a Start Chainage and End Chainage point along ${
          selectedRoad.road_name || "the selected road"
        } to mark the patch extent, then click Create.`,
        dedupeKey: `chainage-patch-guide|${city}|${selectedRoad.road_id}|${Date.now()}`,
        autoDismissMs: 6000,
      });
      return;
    }

    showFeatureNotice({
      feature: "Chainage",
      message: "Please select a road on the map to view or create chainage patches.",
      dedupeKey: `chainage-armed|${city}|${Date.now()}`,
      autoDismissMs: 4500,
    });
  }, [
    mapReady,
    mode,
    city,
    selectedRoad,
    selectedRoadId,
    selectedRoadName,
    showFeatureNotice,
    openChainageForRoadId,
  ]);

  //chainage
  useEffect(() => {
    if (!mapReady || mode !== "CHAINAGE") return;

    const params = new URLSearchParams(location.search);

    // Placing the redirect marker is a field-task-only behavior — require
    // the same project_id+user_id presence as isFieldTaskMode, not just
    // mode=CHAINAGE, so a manually-toggled chainage session (or a
    // bookmarked URL with stray lat/lon params) never gets an unexpected
    // marker/view-jump that a real redirect link is meant to own.
    if (!params.get("project_id") || !params.get("user_id")) return;

    const zone = params.get("zone");
    const ward = params.get("ward");
    const lat = parseFloat(params.get("latitude"));
    const lon = parseFloat(params.get("longitude"));
    const view = mapRef.current?.getView();

    if (!isNaN(lat) && !isNaN(lon)) {
  const map = mapRef.current;
  const targetCoord = fromLonLat([lon, lat]);

  // Defensive: under React StrictMode's mount/cleanup/remount cycle, the
  // marker-layer-creation effect can settle after this one runs. Make sure
  // the layer is actually attached to the live map before relying on it.
  if (
    urlLocationMarkerLayerRef.current &&
    !map.getLayers().getArray().includes(urlLocationMarkerLayerRef.current)
  ) {
    map.addLayer(urlLocationMarkerLayerRef.current);
  }

  urlLocationMarkerSourceRef.current.clear();

  urlLocationMarkerSourceRef.current.addFeature(
    new Feature({
      geometry: new Point(targetCoord),
    })
  );

  // This zoom-to-marker is the field-task page's #1 priority and must not
  // wait on anything else. `rendercomplete` only fires once every layer —
  // including the multi-second Road Network/Road Labels loads — has fully
  // finished, which inverts that priority by blocking the one thing meant
  // to happen first behind everything that is allowed to happen later.
  // Animate immediately instead.
  view.animate({
    center: targetCoord,
    zoom: 16,
    duration: 800,
  });
}

    let filterParts = [];

    // zone_no/ward_no are numeric columns in the DB — a quoted non-numeric
    // literal (e.g. the old "Zone N" text hedge) throws a hard SQL error
    // ("invalid input syntax for type integer") that fails the whole
    // request, so only ever push a bare numeric comparison here.
    const zoneNum = Number(zone);
    if (zone && Number.isFinite(zoneNum)) filterParts.push(`zone_no=${zoneNum}`);

    // Roads load for the URL's ward plus whatever wards actually border it
    // (fieldTaskWardList, resolved via /adjacent-wards in Dashboard) rather
    // than the single ward alone — a lone ward with no surrounding roads
    // reads as broken, and the whole zone is unnecessary load. Falls back
    // to the single ward if the adjacency list hasn't resolved yet.
    const wardNums = Array.isArray(fieldTaskWardList) && fieldTaskWardList.length
      ? fieldTaskWardList.map(Number).filter(Number.isFinite)
      : (() => {
          const wardNum = Number(ward);
          return ward && Number.isFinite(wardNum) ? [wardNum] : [];
        })();
    if (wardNums.length === 1) filterParts.push(`ward_no=${wardNums[0]}`);
    else if (wardNums.length > 1) filterParts.push(`ward_no IN (${wardNums.join(",")})`);

    if (filterParts.length > 0) {
      const filter = filterParts.join(" AND ");

      // Only keeps roadLayerRef's own CQL_FILTER in sync for GetFeatureInfo
      // identify purposes — it stays hidden (visible:false, as constructed).
      // The visible, ward-scoped road rendering for field-task mode is
      // roadNetworkLayer/roadLabelsLayer (already CQL-scoped from
      // construction, see the [city]-only effect above); making this layer
      // ALSO visible drew the exact same roads twice, once from each layer.
      applyChainageFilter(filter); // ✅ CORRECT
    }

  }, [mapReady, location.search, mode, fieldTaskWardList]);

  const params = new URLSearchParams(location.search);//chainage
  const projectId = params.get("project_id");//chainage
  const userId = params.get("user_id");//chainage

  const blobToDataUrl = (blob) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Unable to read captured map image"));
      reader.readAsDataURL(blob);
    });
  //chainage
  const handleSubmitProjectPatches = async () => {
  try {
    if (!projectId || !userId) {
      alert("Missing project_id or user_id");
      return;
    }

    if (!selectedPatches.length) {
      alert("Please select at least one patch");
      return;
    }

    const patchIds = getSelectedPatchIdsOnly();
    const roadIds = getSelectedRoadIdsOnly();
    const roadPatchSelections = getSelectedRoadPatchSelections();

    if (!roadIds.length || !patchIds.length) {
      alert("Road ID or Patch ID missing");
      return;
    }

    // 1. Map patches with project/user in your local backend
    const mapRes = await fetch("/api/map-project-patches", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({
        city,
        project_id: Number(projectId),
        projectId: Number(projectId),
        user_id: Number(userId),
        userId: Number(userId),
        roadIds,
        patchIds,
        roadPatchSelections,
      }),
    });

    const mapText = await mapRes.text();

    if (!mapRes.ok) {
      throw new Error(mapText || "Failed to map patches");
    }

    // 2. Fetch grouped patch data from your local backend
    const groupedRes = await fetch("/api/grouped-patches-by-selection", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({
        city,
        project_id: Number(projectId),

        roadIds,
        patchIds,
        roadPatchSelections,
      }),
    });

    const groupedData = await groupedRes.json();

    if (!groupedRes.ok) {
      throw new Error(groupedData?.error || "Failed to fetch grouped patches");
    }

    if (!groupedData.patches || groupedData.patches.length === 0) {
      alert("No patches found");
      return;
    }

    // 3. Final JSON payload for KMC API
    const finalPayload = {
      project_id: Number(projectId),
      user_id: Number(userId),
      // road_ids: roadIds,
      // patch_ids: patchIds,
      // roadPatchSelections,
      patches: groupedData.patches,
    };

    // 4. Send the KMC payload through our backend so the KMC secret stays in
    // server/.env instead of being bundled into public browser JavaScript.
    let imageBlob = finalImageBlobRef.current;
    let imageDataUrl = mapImage;

    if (!imageBlob) {
      const captured = await captureMapImageBlob();
      imageBlob = captured.blob;
      imageDataUrl = captured.dataUrl;
      finalImageBlobRef.current = imageBlob;
      setMapImage(captured.dataUrl);
    }
    if (!imageDataUrl && imageBlob) {
      imageDataUrl = await blobToDataUrl(imageBlob);
    }

    const submitRes = await fetch("/api/kmc/submit-project-patches", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({
        city,
        ...finalPayload,
        imageDataUrl,
        imageFilename: `${city}_project_${projectId}_map.png`,
      }),
    });

    const submitData = await submitRes.json().catch(() => ({}));
    if (!submitRes.ok) {
      throw new Error(submitData?.error || "KMC submit failed");
    }

    alert("Data and map image submitted successfully");

  } catch (err) {
    console.error("FINAL SUBMIT ERROR:", err);
    alert(err.message || "Final submit failed");
  }
};
  //chainage
  const handlePrintMapOnly = () => {
    const map = mapRef.current;
    if (!map) return;

    document.body.classList.add("print-map-only");

    setTimeout(() => {
      map.updateSize();

      setTimeout(() => {
        window.print();

        setTimeout(() => {
          document.body.classList.remove("print-map-only");
          map.updateSize();
        }, 300);
      }, 500);
    }, 300);
  };

  //chainage
  // const openSubmitConfirm = () => {
  //   const map = mapRef.current;

  //   if (!projectId || !userId) {
  //     alert("Missing project_id or user_id");
  //     return;
  //   }

  //   if (!selectedRoad?.road_id) {
  //     alert("Please select road first");
  //     return;
  //   }

  //   if (!selectedPatches.length) {
  //     alert("Please select at least one patch");
  //     return;
  //   }

  //   if (!map) {
  //     setShowSubmitConfirm(true);
  //     return;
  //   }

  //   map.once("rendercomplete", () => {
  //     const canvas = document.createElement("canvas");
  //     const size = map.getSize();

  //     canvas.width = size[0];
  //     canvas.height = size[1];

  //     const context = canvas.getContext("2d");

  //     document
  //       .querySelectorAll(".ol-layer canvas")
  //       .forEach((layerCanvas) => {
  //         if (layerCanvas.width > 0) {
  //           context.drawImage(layerCanvas, 0, 0);
  //         }
  //       });

  //     setMapImage(canvas.toDataURL("image/png"));
  //     setShowSubmitConfirm(true);
  //   });

  //   map.renderSync();
  // };
  const openSubmitConfirm = async () => {
  if (!projectId || !userId) {
    alert("Missing project_id or user_id");
    return;
  }

  if (!selectedPatches.length) {
    alert("Please select at least one patch");
    return;
  }

  const roadIds = getSelectedRoadIdsOnly();

  if (!roadIds.length) {
    alert("Road ID not found for selected patches");
    return;
  }

  try {
    const { blob, dataUrl } = await captureMapImageBlob();

    finalImageBlobRef.current = blob;
    setMapImage(dataUrl);
    setShowSubmitConfirm(true);

  } catch (err) {
    console.error("MAP IMAGE CAPTURE ERROR:", err);

    finalImageBlobRef.current = null;
    setMapImage(null);
    setShowSubmitConfirm(true);
  }

};
  //chainage
  const confirmSubmitProjectPatches = async () => {
    await handleSubmitProjectPatches();
    setShowSubmitConfirm(false);
  };
  //chainage
  const getPatchKey = (row) => {
    return `${row.road_id}__${row.patch_id}`;
  };

  const buildPatchListFromRows = (rows) => {
    const map = new Map();

    rows.forEach((row) => {
      const key = getPatchKey(row);

      if (!map.has(key)) {
        map.set(key, {
          key,
          road_id: row.road_id,
          patch_id: row.patch_id,
        });
      }
    });

    return Array.from(map.values());
  };
  //chainage
  const getPatchIdFromKey = (key) => {
    const value = String(key);
    const index = value.indexOf("__");

    if (index === -1) return value;

    return value.substring(index + 2);
  };
  //chainage
  const normalizePatchTableRow = (row) => {
    return {
      ...row,
      patch_id: row.patch_id ?? "-",
      segment_id: row.segment_id ?? row.segmentid ?? row.seg_id ?? "-",
      zone_name: row.zone_name ?? row.zone_no ?? row.zone ?? "-",
      road_id: row.road_id ?? "-",
      road_name: row.road_name ?? row.name ?? "-",
      condition: row.condition ?? row.road_condition ?? "-",
      material: row.material ?? "-",
      ownership: row.ownership ?? "-",
      yoc: row.yoc ?? row.year_of_construction ?? "-",
      cus: row.cus ?? row.cus_class ?? row.scheme ?? "-",
    };
  };
  //chainage
  const updatePatchTableFromSelection = async (
    selectedKeys,
    rows = allPatchRows
  ) => {
    if (!selectedKeys.length) {
      setPatchTableData([]);
      setShowPatchTable(false);
      return;
    }

    const patchIds = selectedKeys.map(getPatchIdFromKey);

    try {
      const res = await fetch("/api/patch-segments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({
          city: city.toLowerCase(),
          patchIds,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data?.error || "Failed to fetch patch table data");
      }

      const finalRows = Array.isArray(data)
        ? data.map(normalizePatchTableRow)
        : [];

      setPatchTableData(finalRows);
      setShowPatchTable(finalRows.length > 0);
    } catch (err) {
      console.error("TABLE FETCH ERROR:", err);

      // fallback: show whatever local data is available
      const fallbackRows = rows
        .filter((row) => selectedKeys.includes(getPatchKey(row)))
        .map(normalizePatchTableRow);

      setPatchTableData(fallbackRows);
      setShowPatchTable(fallbackRows.length > 0);
    }
  };
  //chainage
  // const getSelectedPatchIdsOnly = () => {
  //   return selectedPatches.map((key) => key.split("__")[1]);
  // };
  //chainage
  const getSelectedPatchIdsOnly = () => {
  return [...new Set(selectedPatches.map((key) => key.split("__")[1]))];
};
//chainage
const getSelectedRoadIdsOnly = () => {
  return [...new Set(selectedPatches.map((key) => key.split("__")[0]))];
};
  //chainage
  const getSelectedRoadPatchSelections = () => {
    return selectedPatches.map((key) => {
      const [road_id, patch_id] = key.split("__");

      return {
        road_id,
        patch_id,
      };
    });
  };

  //chainage
  const captureMapImageBlob = () => {
  return new Promise((resolve, reject) => {
    const map = mapRef.current;

    if (!map) {
      reject(new Error("Map not available"));
      return;
    }

    let settled = false;
    // GeoServer WMS tile responses have been observed taking several
    // seconds each under load; a fresh fit()/zoom onto an extent whose
    // tiles aren't cached yet can leave `rendercomplete` waiting on that
    // whole batch. A confirm-dialog preview doesn't need pixel-perfect
    // basemap/road tiles to be useful, so cap the wait and snapshot
    // whatever's already rendered rather than blocking indefinitely.
    const fallbackTimer = setTimeout(() => {
      // If the user navigated away / closed chainage mode during this 4s
      // wait, the map may already be disposed (setTarget(null)) — calling
      // renderSync() on it throws inside OL's own internals ("Cannot read
      // properties of null (reading 'renderFrame')", the same crash fixed
      // in HomePage.js's addBoundaryLayer). getTargetElement() is null
      // once disposed, so this is skipped rather than crashing; runCapture
      // itself still proceeds to snapshot whatever's already there.
      if (typeof map.getTargetElement === "function" && map.getTargetElement()) {
        map.renderSync();
      }
      runCapture();
    }, 4000);

    const runCapture = async () => {
      if (settled) return;
      settled = true;
      clearTimeout(fallbackTimer);
      try {
        const size = map.getSize();

        if (!size || !size[0] || !size[1]) {
          reject(new Error("Invalid map size"));
          return;
        }

        const canvas = document.createElement("canvas");
        canvas.width = size[0];
        canvas.height = size[1];

        const context = canvas.getContext("2d");

        // white background
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);

        const layerCanvases = map
          .getViewport()
          .querySelectorAll(".ol-layer canvas, canvas.ol-layer");

        layerCanvases.forEach((layerCanvas) => {
          if (!layerCanvas.width || !layerCanvas.height) return;

          const opacity =
            layerCanvas.parentNode?.style?.opacity || layerCanvas.style.opacity;

          context.globalAlpha = opacity === "" || opacity === undefined
            ? 1
            : Number(opacity);

          const transform = layerCanvas.style.transform;
          const matrix = transform.match(/^matrix\(([^\)]*)\)$/);

          if (matrix) {
            const values = matrix[1].split(",").map(Number);
            context.setTransform(
              values[0],
              values[1],
              values[2],
              values[3],
              values[4],
              values[5]
            );
          } else {
            context.setTransform(1, 0, 0, 1, 0, 0);
          }

          context.drawImage(layerCanvas, 0, 0);
        });

        context.setTransform(1, 0, 0, 1, 0, 0);
        context.globalAlpha = 1;

        // RSAC logo bottom-right, falls back to "© RSAC-UP | URIDA" text —
        // reuses the same watermark utility already used by Dashboard's
        // PDF/Excel export, rather than a second implementation here.
        await drawWatermark(canvas, rsacBanner);

        const dataUrl = canvas.toDataURL("image/png");

        canvas.toBlob((blob) => {
          if (!blob) {
            reject(new Error("Map image blob not created"));
            return;
          }

          resolve({
            blob,
            dataUrl,
          });
        }, "image/png");

      } catch (err) {
        reject(err);
      }
    };

    map.once("rendercomplete", runCapture);
    map.renderSync();
  });
};

  // Closes the chainage road panel and undoes everything opening it did —
  // shared by the panel's own ✕ button and Dashboard's toolbar "Clear"
  // button (via closeChainagePanelRef/useImperativeHandle above), so
  // clicking Clear while a road is selected in chainage mode actually
  // drops that selection instead of leaving the panel stranded open.
  const closeChainagePanel = useCallback(() => {
    const closingRoadId = String(selectedRoad?.road_id || "");

    // remove only current road patches from selected patches
    const currentRoadKeys = currentRoadPatchList.map((patch) => patch.key);

    const updatedSelection = selectedPatches.filter((key) => {
      const [roadId] = String(key).split("__");

      return (
        !currentRoadKeys.includes(key) &&
        String(roadId) !== closingRoadId
      );
    });

    setSelectedPatches(updatedSelection);

    // clear current road panel data
    setSelectedRoad(null);
    // Also clear Dashboard's own selectedRoadId (field-task mode) -
    // otherwise the "armed mode" effect below sees selectedRoadId still
    // set with no matching selectedRoad and immediately reopens this same
    // panel via openChainageForRoadId, making the close button a no-op.
    onFieldTaskRoadHighlightRef.current?.(null);
    setPanelMinimized(false);
    setShowCreateChainageForm(false);
    setPatchChoice(null);
    setPatchInfo(null);
    setShowPatchPanel(false);
    setCurrentRoadPatchList([]);

    setStartChainage("");
    setEndChainage("");
    setChainageList([]);

    // hide chainage points
    if (chainageLayerRef.current) {
      // updateParams() alone already triggers a reload; the extra .refresh()
      // that used to follow it forced a second, redundant request even
      // though the layer is set invisible right after anyway.
      chainageLayerRef.current.getSource().updateParams({
        CQL_FILTER: null,
        STYLES: null,
        _t: Date.now(),
      });
      chainageLayerRef.current.setVisible(false);
    }
    chainageRoad1CqlRef.current = "";
    chainageRoad2CqlRef.current = "";
    clearChainagePointLayers();

    // update/hide patch layer and table
    if (updatedSelection.length > 0) {
      handleShowPatches(updatedSelection, allPatchRows);
      updatePatchTableFromSelection(updatedSelection, allPatchRows);
    } else {
      handleHidePatches();
      setPatchTableData([]);
      setShowPatchTable(false);
      setIsTableMinimized(false);
      onPatchTableCloseRef.current?.();
    }

    // Stage 1 chainage candidate guidance — closing the panel (✕, or
    // Dashboard's handleChainageToggle calling this on Chainage-mode exit)
    // clears Road 1/Road 2/candidates and their map layer together, so
    // nothing stale lingers into the next time Chainage is armed.
    chainageCandidateFetchAbortRef.current?.abort();
    setChainageRoad1Id(null);
    setChainageRoad2Id(null);
    setChainageRoad2Name(null);
    setChainageCandidateRoadIds([]);
    setChainageCandidateRoads([]);
    clearChainageJunction();
    if (chainageCandidateLayerRef.current && mapRef.current) {
      mapRef.current.removeLayer(chainageCandidateLayerRef.current);
      chainageCandidateLayerRef.current = null;
    }
    onChainageCandidateContextChangeRef.current?.({
      active: false,
      road1Id: null,
      road2Id: null,
      candidateRoadIds: [],
    });
  }, [selectedRoad, currentRoadPatchList, selectedPatches, allPatchRows, clearChainageJunction, clearChainagePointLayers]);
  closeChainagePanelRef.current = closeChainagePanel;

  // Road 1 cleared while Road 2 exists -> Road 2 is promoted to Road 1
  // (its own chainage/patch data loads via openChainageForRoadId, same as
  // any other "open this road" call) and candidates re-fetch for it.
  const promoteRoad2ToRoad1 = useCallback(async () => {
    if (!chainageRoad2Id) return;
    const promoted = chainageRoad2Id;
    const promotedName = chainageRoad2Name;
    setChainageRoad2Id(null);
    setChainageRoad2Name(null);
    clearChainageJunction();
    await openChainageForRoadId(promoted, { road_id: promoted, road_name: promotedName });
  }, [chainageRoad2Id, chainageRoad2Name, openChainageForRoadId, clearChainageJunction]);

  return (
    <div id="map-root" className="map-container-wrapper" style={{ position: "relative", width: "100%", height: "100%" }}>
      <div
        id="ol-map"
        ref={mapElement}
        className="map-element"
        style={{ width: "100%", height: "100%", background: "#e0e0e0" }} // Added background color for fallback
      />

      {featureNotice && (
        <div className="feature-progress-notice" role="status" aria-live="polite">
          <div className="feature-progress-notice__content">
            <div className="feature-progress-notice__title">{featureNotice.feature}</div>
            <div className="feature-progress-notice__message">{featureNotice.message}</div>
            {featureNotice.layerName && (
              <div className="feature-progress-notice__meta">Layer: {featureNotice.layerName}</div>
            )}
          </div>
          <button
            type="button"
            className="feature-progress-notice__close"
            onClick={() => setFeatureNotice(null)}
            aria-label="Close message"
          >
            x
          </button>
        </div>
      )}

      <MapNavigation
        map={mapReady ? mapRef.current : null}
        isTableOpen={tableHasRows && !tableMinimized}
        restrictedMode={isFieldTaskMode}
        cityBoundaryRingsRef={cityClipRingsRef}
        cityName={getCityDisplayName()}
      />

      {/* Legend Container */}
      <div
        className="map-legend-container"
        style={{
          position: "absolute",
          top: legendPos.top,
          left: legendPos.left !== null ? legendPos.left : "auto",
          right: legendPos.left !== null ? "auto" : 10,
          cursor: "move",
          touchAction: "none",
        }}
        onPointerDown={onLegendPointerDown}
      >
        <MapLegend
          city={city}
          mode={mode}
          hasSelectedChainageRoad={!!selectedRoad}
          layerVisibility={layerVisibility}
          roadFilter={roadFilter}
          onApplyFilter={onRoadFilterChange}
          amenityCounts={amenityLegendCounts}
          otherCounts={otherLegendCounts}
          extent={legendExtent}
          dssLegend={dssLegend}
          zoneBoundaryColor={zoneBoundaryColor}
          wardBoundaryColor={wardBoundaryColor}
          restrictedMode={isFieldTaskMode}
        />
      </div>

      {selectedRoad && (  //chainage
        <div
          className={`road-panel${tableHasRows && !tableMinimized ? " table-open" : ""}`}
          style={
            roadPanelPos.left !== null
              ? { position: "absolute", top: roadPanelPos.top, left: roadPanelPos.left, right: "auto" }
              : undefined
          }
        >
          <div
            className="road-panel-header"
            onPointerDown={onRoadPanelPointerDown}
            style={{ cursor: "move", touchAction: "none" }}
          >
            <div className="road-panel-title">
              <h3>Chainage</h3>
              <span className="road-panel-subtitle">Road Details</span>
            </div>

            <div className="road-panel-actions">
              <button
                className="road-panel-minimize"
                onClick={() => setPanelMinimized(!panelMinimized)}
                title={panelMinimized ? "Maximize" : "Minimize"}
              >
                {panelMinimized ? "⬜" : "➖"}
              </button>

              {/* <button
                className="road-panel-close"
                onClick={() => {
                  setSelectedRoad(null);
                  setPanelMinimized(false);

                  // 🔥 reset chainage layer also
                  if (chainageLayerRef.current) {
                    chainageLayerRef.current.getSource().updateParams({
                      CQL_FILTER: null,
                      _t: Date.now(),
                    });
                    chainageLayerRef.current.getSource().refresh();
                    chainageLayerRef.current.setVisible(false); // optional (better UX)
                  }
                  setPatchChoice(null);
                }}
              >
                ✕
              </button> */}
              <button
  className="road-panel-close"
  onClick={closeChainagePanel}
>
  ✕
</button>
            </div>
          </div>
          {!panelMinimized && (
            <div className="road-panel-body">
              <div className="road-item">
                <span>ID</span>
                <strong>{selectedRoad.road_id}</strong>

              </div>

              <div className="road-item">
                <span>Name</span>
                <strong>{selectedRoad.road_name || "-"}</strong>
              </div>

              <div className="road-item">
                <span>Category</span>
                <span className="badge">{selectedRoad.category}</span>
              </div>

              <div className="road-item">
                <span>Condition</span>
                <span className={`badge ${selectedRoad.condition?.toLowerCase()}`}>
                  {selectedRoad.condition}
                </span>
              </div>

              {/* <div className="road-item">
        <span>Material</span>
        <strong>{selectedRoad.material}</strong>
      </div> */}

              <div className="patch-action-buttons">
                <button
                  className="patch-action-btn patch-action-btn--create"
                  onClick={() => setShowCreateChainageForm((v) => !v)}
                >
                  {showCreateChainageForm ? "Close Create Patch" : "Create Patch"}
                </button>
                <button
                  className={`patch-action-btn patch-action-btn--view${
                    !patchInfo?.exists ? " patch-action-btn--disabled-look" : ""
                  }`}
                  onClick={() => {
                    if (!patchInfo?.exists) {
                      showFeatureNotice({
                        feature: "Chainage",
                        message: "No patch has been created on this road yet. Click Create Patch to add one.",
                        dedupeKey: `chainage-no-patch|${city}|${selectedRoad.road_id}|${Date.now()}`,
                        autoDismissMs: 4500,
                      });
                      return;
                    }
                    if (showPatchPanel) {
                      setShowPatchPanel(false);
                      setPatchChoice(null);
                      handleHidePatches();
                      return;
                    }
                    setShowPatchPanel(true);
                    setPatchChoice("yes");
                    // Mirrors handlePatchToggle's own closed→open snapshot gate
                    // below — only fire once, on the transition into showing
                    // the patch table, not on every click of this button.
                    if (selectedPatches.length > 0 && !showPatchTable) {
                      onPatchTableOpenRef.current?.();
                    }
                    handleShowPatches(selectedPatches, allPatchRows);
                    updatePatchTableFromSelection(selectedPatches, allPatchRows);
                  }}
                >
                  {showPatchPanel ? "Hide Patches" : "View Patches"}
                </button>
              </div>

              {isFieldTaskMode && isMultiSelectModeProp && (
                // Multi-road selection itself happens in the table below
                // (its own Multi/Apply controls) — this is just a pointer so
                // it's obvious why clicking roads on the map has paused.
                <div style={{ fontSize: 12, padding: "8px 10px", background: "rgba(255,255,255,0.5)", borderRadius: 8, marginBottom: 8 }}>
                  Multi-road patch mode is on — select connected roads from the table below, then press Apply.
                </div>
              )}

              {chainageRoad1Id && (
                // Stage 1 chainage candidate guidance status — no junction/
                // save UI yet, just visibility into what's paired and a way
                // to undo a Road 2 pick.
                <div style={{ fontSize: 12, padding: "8px 10px", background: "rgba(255,255,255,0.6)", borderRadius: 8, marginTop: 10, marginBottom: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                  <span>🟧 Road 1: {selectedRoad?.road_name || chainageRoad1Id}</span>
                  {chainageRoad2Id ? (
                    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      🟦 Road 2: {chainageRoad2Name || chainageRoad2Id}
                      <button
                        type="button"
                        onClick={clearChainageRoad2}
                        style={{ fontSize: 11, padding: "1px 8px", borderRadius: 6, border: "1px solid #cbd5e1", background: "#fff", cursor: "pointer" }}
                      >
                        Clear
                      </button>
                    </span>
                  ) : chainageCandidateRoadIds.length > 0 ? (
                    <span>{chainageCandidateRoadIds.length} connected road{chainageCandidateRoadIds.length > 1 ? "s" : ""} available — click one on the map or table to pair it.</span>
                  ) : (
                    <span>No connected roads found for this road.</span>
                  )}
                </div>
              )}

              {showCreateChainageForm && (() => {
                // Fixed roles: Road 1 always contributes the free, user-picked
                // Start of the whole patch; once Road 2 is paired, Road 1's
                // own End locks to the junction — the label never swaps.
                // Values come from chainageRoad1Values (the same segment-
                // suffix data the map's own chainage points are drawn from,
                // not the separate /api/chainage table those used to read
                // from) so the dropdown can never disagree with the map, and
                // the junction is guaranteed to actually be a member of the
                // list instead of a value that table didn't happen to have.
                const endLocked = !!chainageRoad2Id;
                const juncLabel1 = chainageJunctionLoading
                  ? "Finding junction…"
                  : chainageJunctionInfo
                    ? `Junc: ${Number(chainageJunctionInfo.road1Value)}`
                    : chainageJunctionError || "Junction unavailable";
                const juncNum1 = chainageJunctionInfo ? Number(chainageJunctionInfo.road1Value) : null;
                // Road 2's own fields, rendered inline here (not a separate
                // block below) specifically so the ONE combined CREATE
                // button can sit after both roads' fields instead of
                // between them.
                const juncLabel2 = chainageJunctionLoading
                  ? "Finding junction…"
                  : chainageJunctionInfo
                    ? `Junc: ${Number(chainageJunctionInfo.road2Value)}`
                    : chainageJunctionError || "Junction unavailable";
                const juncValue2 = chainageJunctionInfo ? String(chainageJunctionInfo.road2Value) : "";
                const juncNum2 = chainageJunctionInfo ? Number(chainageJunctionInfo.road2Value) : null;
                return (
              <div className="chainage-create-form">
              <div className="chainage-selection">

                <div className="chainage-group">
                  <label>Start Chainage</label>
                  <select
                    value={startChainage}
                    onChange={(e) => setStartChainage(e.target.value)}
                  >
                    <option value="">Select</option>
                    {chainageRoad1Values.map((d) => {
                      // The junction can land at Road 1's min, its max, or
                      // anywhere in the middle of its range — same three
                      // cases Road 2 has to handle, not something specific
                      // to whichever road happens to be "Road 2". Shown in
                      // place, grayed out, rather than filtered by
                      // direction, so every other real value stays pickable
                      // regardless of which side of the road it's on; L/R
                      // marks which side so a mid-range junction (both sides
                      // have real values) isn't ambiguous. A <select> only
                      // ever lets one option be chosen at a time — an L pick
                      // and an R pick are never both "selected" together.
                      const isJunc = endLocked && juncNum1 != null && d === juncNum1;
                      if (isJunc) {
                        return (
                          <option key={`start-${d}`} value={d} disabled>
                            {`Junc: ${Number(d)}`}
                          </option>
                        );
                      }
                      const side = endLocked && juncNum1 != null ? (d > juncNum1 ? " L" : " R") : "";
                      return (
                        <option key={`start-${d}`} value={d}>
                          {`${Number(d)}${side}`}
                        </option>
                      );
                    })}
                  </select>
                </div>

                <div className="chainage-group">
                  <label>{endLocked ? "→ Junc" : "End Chainage"}</label>
                  {endLocked ? (
                    // Once Road 2 is paired, Road 1's end is the junction —
                    // start (free) -> junc (fixed) -> [Road 2's own end,
                    // below] is the three-point patch you described, so this
                    // is no longer a free pick.
                    <select value={endChainage} disabled>
                      <option value={endChainage}>{juncLabel1}</option>
                    </select>
                  ) : (
                    <select
                      value={endChainage}
                      onChange={(e) => setEndChainage(e.target.value)}
                    >
                      <option value="">Select</option>
                      {chainageRoad1Values.map((d) => (
                        <option key={`end-${d}`} value={d}>
                          {Number(d)}
                        </option>
                      ))}
                    </select>
                  )}
                </div>

              </div>

              {chainageRoad2Id && (
                <>
                  <div style={{ fontSize: 12, fontWeight: 700, marginTop: 10, marginBottom: 4 }}>
                    Road 2 Chainage — {chainageRoad2Name || chainageRoad2Id}
                  </div>
                  <div className="chainage-selection" style={{ marginTop: 0, paddingTop: 0, borderTop: "none" }}>
                    <div className="chainage-group">
                      <label>Junc →</label>
                      <select value={juncValue2} disabled>
                        <option value={juncValue2}>{juncLabel2}</option>
                      </select>
                    </div>
                    <div className="chainage-group">
                      <label>End Chainage</label>
                      <select value={chainageRoad2FreeValue} onChange={(e) => setChainageRoad2FreeValue(e.target.value)}>
                        <option value="">Select</option>
                        {chainageRoad2Values.map((d) => {
                          const isJunc = juncNum2 != null && d === juncNum2;
                          if (isJunc) {
                            return (
                              <option key={`r2-${d}`} value={d} disabled>
                                {`Junc: ${Number(d)}`}
                              </option>
                            );
                          }
                          // Road 2's own numbering runs through the
                          // junction, not from it — values on the far side
                          // (continuing away from Road 1) are marked L,
                          // values on the near side (back toward the
                          // junction from Road 2's own start) are marked R,
                          // so it's clear which physical direction each
                          // pick extends before you commit to one.
                          const side = juncNum2 != null && d > juncNum2 ? "L" : "R";
                          return (
                            <option key={`r2-${d}`} value={d}>{`${Number(d)} ${side}`}</option>
                          );
                        })}
                      </select>
                    </div>
                  </div>
                </>
              )}

              <button
                className="chainage-create-btn"
                disabled={
                  !startChainage ||
                  (endLocked
                    ? juncNum1 == null || Number(startChainage) === juncNum1 || (chainageRoad2Id && !chainageRoad2FreeValue)
                    : !endChainage || Number(startChainage) >= Number(endChainage))
                }
                onClick={() => handleCreateCombinedChainageRequest()}
              >
                CREATE
              </button>
              </div>
                );
              })()}

            </div>
          )}
          {showPatchPanel && patchInfo?.exists && (
            <div className="patch-panel">
              {currentRoadPatchList.length > 0 && (
                <div className="patch-list-panel">

                  <div className="patch-list-title">PATCHES</div>

                  <div className="patch-list-body">
                    {currentRoadPatchList.map((patch) => (
                      <label key={patch.key} className="patch-checkbox">
                        <input
                          type="checkbox"
                          checked={selectedPatches.includes(patch.key)}
                          onChange={() => handlePatchToggle(patch.key)}
                        />
                        <span>{patch.patch_id}</span>
                      </label>
                    ))}
                  </div>

                </div>
              )}

            </div>
          )}
        </div>
      )}
      {showPatchTable && patchTableData.length > 0 && (
        <div className={`patch-table-container ${isTableMinimized ? "minimized" : ""}`}>

          <div className="patch-table-header">
            {mode === "CHAINAGE" && projectId && userId && (
        <button
          className="patch-header-submit-btn"
          onClick={openSubmitConfirm}
          disabled={!selectedPatches.length || patchChoice === "no"}
        >
          Submit
        </button>
      )}
            <h4>PATCH INFORMATION</h4>
            <div className="patch-table-actions">
              {/* <button onClick={exportToExcel} title="Export Excel">📊</button> */}
              {/* PRINT BUTTON */}
              <button
                className="patch-print-btn"
                onClick={handlePrintMapOnly}
                title="Print Map"
              >
                🖨
              </button>

              <button
                onClick={() => setIsTableMinimized(prev => !prev)}
                title={isTableMinimized ? "Maximize" : "Minimize"}
              >
                {isTableMinimized ? "▢" : "—"}
              </button>
              <button
                onClick={() => {
                  setShowPatchTable(false);
                  setIsTableMinimized(false);
                  onPatchTableCloseRef.current?.();
                }}
                title="Close patch table"
              >
                ✕
              </button>
            </div>
          </div>


          <div className="patch-table-body">
            <table>
              <thead>
                <tr>
                  <th>Patch ID</th>
                  <th>Segment ID</th>
                  <th>Zone Name</th>
                  <th>Road ID</th>
                  <th>Road Name</th>
                  <th>Condition</th>
                  <th>Material</th>
                  <th>Ownership</th>
                  <th>YOC</th>
                  <th>CUS</th>
                </tr>
              </thead>

              <tbody>
                {Object.entries(
                  patchTableData.reduce((acc, row) => {
                    const roadId = row.road_id || "Unknown Road";

                    if (!acc[roadId]) {
                      acc[roadId] = [];
                    }

                    acc[roadId].push(row);
                    return acc;
                  }, {})
                ).map(([roadId, rows]) => (
                  <React.Fragment key={roadId}>
                    <tr className="road-group-row">
                      <td colSpan="10">
                        Road ID: {roadId}
                        {rows[0]?.road_name ? ` | ${rows[0].road_name}` : ""}
                      </td>
                    </tr>

                    {rows.map((row, i) => (
                      <tr key={`${roadId}-${row.patch_id}-${row.segment_id}-${i}`}>
                        <td>{row.patch_id}</td>
                        <td>{row.segment_id}</td>
                        <td>{row.zone_name}</td>
                        <td>{row.road_id}</td>
                        <td>{row.road_name}</td>
                        <td>{row.condition}</td>
                        <td>{row.material}</td>
                        <td>{row.ownership}</td>
                        <td>{row.yoc}</td>
                        <td>{row.cus}</td>
                      </tr>
                    ))}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>

        </div>
      )}

      {/* The field-task deep link used to be a separate, chrome-less page,
          which is why it needed its own search control here — it now runs
          inside the full Dashboard (same as any other city view), whose own
          toolbar search already covers road-ID lookup and ward-scoping, so
          this duplicate (it was rendering directly on top of the toolbar's
          own search icon) has been removed rather than left hidden. */}

      {/* Stage 1 chainage candidate guidance — 3rd road clicked while Road 1
          and Road 2 are both already set. Asks which to remove instead of
          just rejecting the click. Portaled to <body> for the same
          stacking-context reason as the confirm dialogs below. */}
      {chainagePendingThirdClick && createPortal(
        <div className="submit-confirm-overlay">
          <div className="submit-confirm-box">
            <h3>TWO ROADS ALREADY SELECTED</h3>
            <div className="submit-info">
              <p>
                Only two connected roads can be selected at a time. Choose which one to remove
                so <b>{chainagePendingThirdClick.roadProps?.road_name || chainagePendingThirdClick.roadId}</b> can
                take its place.
              </p>
            </div>
            <div className="submit-confirm-actions">
              <button
                className="cancel-btn"
                onClick={() => resolveChainageThirdClick("road1")}
              >
                Remove Road 1 ({selectedRoad?.road_name || chainageRoad1Id}) — selected first
              </button>
              <button
                className="final-submit-btn"
                onClick={() => resolveChainageThirdClick("road2")}
              >
                Remove Road 2 ({chainageRoad2Name || chainageRoad2Id})
              </button>
            </div>
            <div className="submit-confirm-actions">
              <button
                className="cancel-btn"
                onClick={() => setChainagePendingThirdClick(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Popup overlay is now built imperatively via document.createElement
          (see the map-init effect) and attached directly to popupRef.current
          — not rendered here as JSX. See comment there for why. */}
      {showPatchConfirm && createPortal(
        // Portaled straight to <body> — this dialog used to render inside
        // .map-container-wrapper, which has its own `position:relative;
        // z-index:1`. That ancestor is a stacking context of its own, so no
        // z-index on this overlay could ever outrank siblings outside it
        // (e.g. .bottom-table's z-index:100001) — the road table would sit
        // on top and swallow clicks meant for Save/Cancel whenever both
        // were open at once.
        <div className="submit-confirm-overlay">
          <div className="submit-confirm-box">

            <h3>CONFIRM PATCH</h3>

            <div className="submit-info">
              <p><b>Road:</b> {selectedRoad?.road_name || selectedRoad?.road_id}</p>
              <p><b>Road ID:</b> {patchConfirmPending?.roadId}</p>
              <p><b>Chainage Range:</b> {patchConfirmPending?.start}m to {patchConfirmPending?.end}m</p>
            </div>

            <div className="submit-map-preview">
              {patchConfirmImage ? (
                <img src={patchConfirmImage} alt="Patch Segment Snapshot" />
              ) : (
                <p>Map snapshot not available</p>
              )}
            </div>

            <div className="submit-confirm-actions">
              <button
                className="cancel-btn"
                onClick={handleCancelPatchConfirm}
                disabled={patchConfirmSaving}
              >
                Cancel
              </button>

              <button
                className="final-submit-btn"
                onClick={handleConfirmSavePatch}
                disabled={patchConfirmSaving}
              >
                {patchConfirmSaving ? "Saving..." : "Save"}
              </button>
            </div>

          </div>
        </div>,
        document.body
      )}

      {showMultiRoadConfirm && createPortal(
        <div className="submit-confirm-overlay">
          <div className="submit-confirm-box">

            <h3>CONFIRM MULTI-ROAD PATCH</h3>

            <div className="submit-info">
              <p className="submit-info-roadlist">
                <b>Roads ({multiRoadSelection.length}):</b>
                <span>{multiRoadSelection.map((r) => r.road_name || r.road_id).join(" → ")}</span>
              </p>
              <p>Each road's full length will be added as its own patch.</p>
            </div>

            <div className="submit-map-preview">
              {multiRoadConfirmImage ? (
                <img src={multiRoadConfirmImage} alt="Multi-road Patch Snapshot" />
              ) : (
                <p>Map snapshot not available</p>
              )}
            </div>

            <div className="submit-confirm-actions">
              <button
                className="cancel-btn"
                onClick={handleCancelMultiRoadConfirm}
                disabled={multiRoadConfirmSaving}
              >
                Cancel
              </button>

              <button
                className="final-submit-btn"
                onClick={handleConfirmSaveMultiRoadPatch}
                disabled={multiRoadConfirmSaving}
              >
                {multiRoadConfirmSaving ? "Saving..." : "Save"}
              </button>
            </div>

          </div>
        </div>,
        document.body
      )}

      {showSubmitConfirm && createPortal(
        <div className="submit-confirm-overlay">
          <div className="submit-confirm-box">

            <h3>CONFIRM SITE MAP</h3>

            <div className="submit-info">
              <p><b>Project ID:</b> {projectId}</p>
              <p><b>User ID:</b> {userId}</p>
              <p>
                <b>Selected Road ID:</b>{" "}
                {[
                  ...new Set(
                    allPatchRows
                      .filter((row) => selectedPatches.includes(getPatchKey(row)))
                      .map((row) => row.road_id)
                  ),
                ].join(", ") || "-"}
              </p>
              <p>
                <b>Selected Patches:</b>{" "}
                {selectedPatches
                  .map((key) => {
                    const [road_id, patch_id] = key.split("__");
                    return `${road_id} - ${patch_id}`;
                  })
                  .join(", ") || "-"}
              </p>
            </div>

            <div className="submit-map-preview">
              {mapImage ? (
                <img src={mapImage} alt="Map Snapshot" />
              ) : (
                <p>Map snapshot not available</p>
              )}
            </div>

            <div className="submit-confirm-actions">
              <button
                className="cancel-btn"
                onClick={() => setShowSubmitConfirm(false)}
              >
                Cancel
              </button>

              <button
                className="final-submit-btn"
                onClick={confirmSubmitProjectPatches}
              >
                Submit
              </button>
            </div>

          </div>
        </div>,
        document.body
      )}


    </div>
  );
});

export default MapContainer;
