// src/components/MapContainer.jsx
/* OpenLayers map engine: base layers, WMS/WFS overlays, popups, drawing, legend, analysis layers. */
import React, { useEffect, useRef, useState, forwardRef, useImperativeHandle, useMemo, useCallback } from "react";
import "ol/ol.css";

import OLMap from "ol/Map";
import View from "ol/View";
import TileLayer from "ol/layer/Tile";
import ImageLayer from "ol/layer/Image";
import VectorLayer from "ol/layer/Vector";
import LayerGroup from "ol/layer/Group";
import { fromLonLat, toLonLat } from "ol/proj";
import OSM from "ol/source/OSM";
import XYZ from "ol/source/XYZ";
import TileWMS from "ol/source/TileWMS";
import ImageWMS from "ol/source/ImageWMS";
import VectorSource from "ol/source/Vector";
import GeoJSON from "ol/format/GeoJSON";
import Feature from "ol/Feature";
import { getCenter } from "ol/extent";
import { defaults as defaultControls } from "ol/control";
import { Style, Stroke, Fill, Circle as CircleStyle, Icon } from "ol/style";
import Point from "ol/geom/Point";
import GeometryCollection from "ol/geom/GeometryCollection";
import { bbox as bboxStrategy } from "ol/loadingstrategy";
import MapNavigation from "./MapNavigation"; // ⭐ NEW: Google Maps style navigation suite

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

const EMPTY_ARRAY = [];

const GEOSERVER_BASE = window.location.port === "8060"
  ? `${window.location.protocol}//${window.location.hostname}:8080/geoserver`
  : (process.env.REACT_APP_GEOSERVER_BASE || process.env.GEOSERVER_BASE || "/geoserver");

const WARD_ZONE_WMS = `${GEOSERVER_BASE}/Ward_Boundary_New/wms`;
const WARD_ZONE_WFS = `${GEOSERVER_BASE}/wfs`;
const AMENITIES_WMS = `${GEOSERVER_BASE}/Amenities/wms`;
const AMENITIES_WFS = `${GEOSERVER_BASE}/wfs`; // Use Global WFS Endpoint for robustness
const CHAINAGE_WMS = `${GEOSERVER_BASE}/Chainage/wms`;
const STREET_VIEW_WMS = `${GEOSERVER_BASE}/Street_View/wms`;
const ROAD_WMS = `${GEOSERVER_BASE}/Road_Network/wms`;
const ROAD_WFS = `${GEOSERVER_BASE}/Road_Network/wfs`;
const SATELLITE_MAX_ZOOM = 18;
const DEFAULT_MAX_ZOOM = 20;
const ROAD_DIM_OPACITY = 0.6;
const ROAD_WFS_MIN_ZOOM = 14;
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

const getIsLowBandwidth = () => {
  if (typeof navigator === "undefined") return false;
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!conn) return false;
  const effectiveType = String(conn.effectiveType || "").toLowerCase();
  return !!conn.saveData || ["slow-2g", "2g", "3g"].includes(effectiveType);
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

const buildBoundaryLabelSld = (layerName, labelAttr, color) => `
<StyledLayerDescriptor version="1.0.0"
  xmlns="http://www.opengis.net/sld"
  xmlns:ogc="http://www.opengis.net/ogc"
  xmlns:xlink="http://www.w3.org/1999/xlink"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <NamedLayer>
    <Name>${layerName}</Name>
    <UserStyle>
      <FeatureTypeStyle>
        <Rule>
          <PolygonSymbolizer>
            <Fill>
              <CssParameter name="fill">#ffffff</CssParameter>
              <CssParameter name="fill-opacity">0</CssParameter>
            </Fill>
            <Stroke>
              <CssParameter name="stroke">${color}</CssParameter>
              <CssParameter name="stroke-width">2</CssParameter>
              <CssParameter name="stroke-opacity">1</CssParameter>
            </Stroke>
          </PolygonSymbolizer>
          <TextSymbolizer>
            <Label>
              <ogc:PropertyName>${labelAttr}</ogc:PropertyName>
            </Label>
            <Font>
              <CssParameter name="font-family">Arial</CssParameter>
              <CssParameter name="font-size">14</CssParameter>
              <CssParameter name="font-weight">bold</CssParameter>
            </Font>
            <Halo>
              <Radius>2</Radius>
              <Fill>
                <CssParameter name="fill">${color}</CssParameter>
                <CssParameter name="fill-opacity">0.9</CssParameter>
              </Fill>
            </Halo>
            <Fill>
              <CssParameter name="fill">#ffffff</CssParameter>
            </Fill>
          </TextSymbolizer>
        </Rule>
      </FeatureTypeStyle>
    </UserStyle>
  </NamedLayer>
</StyledLayerDescriptor>
`;

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

const buildRoadLabelSld = (layerName, nameAttr, idAttr) => `
<StyledLayerDescriptor version="1.0.0"
  xsi:schemaLocation="http://www.opengis.net/sld StyledLayerDescriptor.xsd"
  xmlns="http://www.opengis.net/sld"
  xmlns:ogc="http://www.opengis.net/ogc"
  xmlns:xlink="http://www.w3.org/1999/xlink"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <NamedLayer>
    <Name>${layerName}</Name>
    <UserStyle>
      <FeatureTypeStyle>
        <Rule>
          <MaxScaleDenominator>10000</MaxScaleDenominator>
          <TextSymbolizer>
            <Label>
              <ogc:PropertyName>${nameAttr}</ogc:PropertyName>
            </Label>
            <Font>
              <CssParameter name="font-family">Arial</CssParameter>
              <CssParameter name="font-size">12</CssParameter>
              <CssParameter name="font-weight">bold</CssParameter>
            </Font>
            <Halo>
              <Radius>2</Radius>
              <Fill>
                <CssParameter name="fill">#000000</CssParameter>
              </Fill>
            </Halo>
            <Fill>
              <CssParameter name="fill">#ffffff</CssParameter>
            </Fill>
            <VendorOption name="conflictResolution">true</VendorOption>
            <VendorOption name="spaceAround">6</VendorOption>
            <VendorOption name="maxDisplacement">20</VendorOption>
          </TextSymbolizer>
        </Rule>
        <Rule>
          <MaxScaleDenominator>5000</MaxScaleDenominator>
          <TextSymbolizer>
            <Label>
              <ogc:PropertyName>${idAttr}</ogc:PropertyName>
            </Label>
            <Font>
              <CssParameter name="font-family">Arial</CssParameter>
              <CssParameter name="font-size">10</CssParameter>
            </Font>
            <Halo>
              <Radius>2</Radius>
              <Fill>
                <CssParameter name="fill">#000000</CssParameter>
              </Fill>
            </Halo>
            <Fill>
              <CssParameter name="fill">#ffffff</CssParameter>
            </Fill>
            <VendorOption name="conflictResolution">true</VendorOption>
            <VendorOption name="spaceAround">4</VendorOption>
            <VendorOption name="maxDisplacement">16</VendorOption>
          </TextSymbolizer>
        </Rule>
      </FeatureTypeStyle>
    </UserStyle>
  </NamedLayer>
</StyledLayerDescriptor>
`;

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
  layerVisibility = {},
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
  tableFilterActive = false,
  layerFilters = {}, // ⭐ NEW
  drawMode = null, // ⭐ NEW
  onSpatialQueryResults, // ⭐ NEW
  onRoadFilterChange, // ⭐ NEW
  onAnalysisDataLoaded, // ⭐ NEW
  onRoadSelected,
  onPopupClosed,
  baseMap, // ⭐ NEW: For adaptive colors
  isSidebarOpen = false,
  tableHasRows = false,
  tableMinimized = false,
  onMapLoadingChange, // ⭐ NEW: Callback for map layer loading state
}, ref) => {
  const mapElement = useRef(null);
  const mapRef = useRef(null);
  const [mapReady, setMapReady] = useState(false);
  const [coordText, setCoordText] = useState("0.0000, 0.0000");
  const [legendPos, setLegendPos] = useState({ top: 10, left: 10 });
  const [coordPos, setCoordPos] = useState({ bottom: 32, left: "50%" });
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
  const showPopupRef = useRef(null);
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
  const selectedRoadLayerRef = useRef(null);
  const filteredRoadLayerRef = useRef(null);
  const filteredRoadColorRef = useRef(null);
  const roadWfsLayerRef = useRef(null);
  const roadWfsSourceRef = useRef(null);
  const roadWfsStyleCacheRef = useRef(new Map());
  const segmentedRoadsLayerRef = useRef(null);
  const chainageLayerRef = useRef(null);
  const specializedLayersRef = useRef({});
  const roadDetailsCacheRef = useRef(new Map());
  const featureInfoCacheRef = useRef(new Map());
  const amenityWfsCacheRef = useRef(new Map());
  const otherWfsCacheRef = useRef(new Map());
  const amenityFetchAbortRef = useRef(null);
  const otherFetchAbortRef = useRef(null);
  const roadWfsAbortRef = useRef(null);
  const amenityMoveTimerRef = useRef(null);
  const otherMoveTimerRef = useRef(null);
  const roadMoveTimerRef = useRef(null);
  const amenityExtentKeyRef = useRef("");
  const otherExtentKeyRef = useRef("");
  const roadWfsExtentKeyRef = useRef("");
  const lastSpatialExtentRef = useRef(null);
  const boundaryExtentCacheRef = useRef({});
  const boundaryFeatureCacheRef = useRef(new Map());
  const boundaryFeaturesRef = useRef({ layerName: "", features: [] });
  const boundaryFetchAbortRef = useRef(null);
  const roadOpacityRef = useRef(new Map());
  const selectedRoadGeomRef = useRef(null);
  const [selectedRoadToken, setSelectedRoadToken] = useState(0);
  const [isMobileView, setIsMobileView] = useState(window.innerWidth <= 768);
  const [isLocating, setIsLocating] = useState(false);

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

  const getAutoZoomPadding = (isIdentifierFilter) => {
    if (isIdentifierFilter) {
      const pad = 12;
      return [pad, pad, pad, pad];
    }

    if (isMobileView) {
      const bottom = tableHasRows ? (tableMinimized ? 90 : 260) : 70;
      return [120, 20, bottom, 20];
    }

    const bottom = tableHasRows ? (tableMinimized ? 90 : 320) : 40;
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
              view.fit(extent, { padding: [40, 40, 40, 40], duration: 450, maxZoom: targetZoom });
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
          view.fit(extent, { padding: [40, 40, 40, 40], duration: 450, maxZoom: targetZoom });
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
        console.error(`${prefix} WFS failed:`, id, err);
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
    if (roadNetworkLayerRef.current) {
      const src = roadNetworkLayerRef.current.getSource?.();
      if (src?.updateParams) {
        src.updateParams({ CQL_FILTER: filterValue, _t: Date.now() });
      } else if (src?.refresh) {
        src.refresh();
      }
    }
    if (roadLabelsLayerRef.current) {
      const src = roadLabelsLayerRef.current.getSource?.();
      if (src?.updateParams) {
        src.updateParams({ CQL_FILTER: filterValue, _t: Date.now() });
      } else if (src?.refresh) {
        src.refresh();
      }
    }
    Object.values(roadClassLayersRef.current || {}).forEach((layer) => {
      const src = layer?.getSource?.();
      if (src?.updateParams) {
        src.updateParams({ CQL_FILTER: filterValue, _t: Date.now() });
      } else if (src?.refresh) {
        src.refresh();
      }
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

  const fetchBoundaryExtent4326 = async (layerName) => {
    if (!layerName) return null;
    const cache =
      boundaryExtentCacheRef.current &&
        typeof boundaryExtentCacheRef.current === "object"
        ? boundaryExtentCacheRef.current
        : {};
    if (cache !== boundaryExtentCacheRef.current) {
      boundaryExtentCacheRef.current = cache;
    }
    const cacheKey = String(layerName);
    if (Object.prototype.hasOwnProperty.call(cache, cacheKey)) {
      return cache[cacheKey];
    }
    try {
      const url = `${WARD_ZONE_WMS}?service=WMS&request=GetCapabilities`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const xmlText = await res.text();
      const doc = new DOMParser().parseFromString(xmlText, "text/xml");
      const layers = Array.from(doc.getElementsByTagName("Layer"));
      const layerNode = layers.find((node) => {
        const nameEl = node.getElementsByTagName("Name")[0];
        return nameEl && nameEl.textContent === layerName;
      });
      if (!layerNode) return null;

      const exGeo = layerNode.getElementsByTagName("EX_GeographicBoundingBox")[0];
      if (exGeo) {
        const west = parseFloat(exGeo.getElementsByTagName("westBoundLongitude")[0]?.textContent);
        const east = parseFloat(exGeo.getElementsByTagName("eastBoundLongitude")[0]?.textContent);
        const south = parseFloat(exGeo.getElementsByTagName("southBoundLatitude")[0]?.textContent);
        const north = parseFloat(exGeo.getElementsByTagName("northBoundLatitude")[0]?.textContent);
        if ([west, south, east, north].every((n) => Number.isFinite(n))) {
          const extent = [west, south, east, north];
          cache[cacheKey] = extent;
          return extent;
        }
      }

      const latLonBox = layerNode.getElementsByTagName("LatLonBoundingBox")[0];
      if (latLonBox) {
        const west = parseFloat(latLonBox.getAttribute("minx"));
        const south = parseFloat(latLonBox.getAttribute("miny"));
        const east = parseFloat(latLonBox.getAttribute("maxx"));
        const north = parseFloat(latLonBox.getAttribute("maxy"));
        if ([west, south, east, north].every((n) => Number.isFinite(n))) {
          const extent = [west, south, east, north];
          cache[cacheKey] = extent;
          return extent;
        }
      }

      const bboxNodes = Array.from(layerNode.getElementsByTagName("BoundingBox"));
      const bbox4326 = bboxNodes.find((node) => {
        const crs = node.getAttribute("CRS") || node.getAttribute("SRS");
        return crs === "EPSG:4326";
      });
      if (bbox4326) {
        const west = parseFloat(bbox4326.getAttribute("minx"));
        const south = parseFloat(bbox4326.getAttribute("miny"));
        const east = parseFloat(bbox4326.getAttribute("maxx"));
        const north = parseFloat(bbox4326.getAttribute("maxy"));
        if ([west, south, east, north].every((n) => Number.isFinite(n))) {
          const extent = [west, south, east, north];
          cache[cacheKey] = extent;
          return extent;
        }
      }
    } catch { }
    return null;
  };

  const fetchBoundaryFeatures = async (layerName, projection) => {
    if (!layerName || !projection) return [];
    const cacheKey = `${layerName}|${projection.getCode()}`;
    const cached = boundaryFeatureCacheRef.current.get(cacheKey);
    if (cached) return cached;
    if (boundaryFetchAbortRef.current) boundaryFetchAbortRef.current.abort();
    const controller = new AbortController();
    boundaryFetchAbortRef.current = controller;
    const url =
      `${WARD_ZONE_WFS}?service=WFS&version=1.1.0&request=GetFeature` +
      `&typeName=${encodeURIComponent(layerName)}` +
      `&outputFormat=application/json` +
      `&srsName=${encodeURIComponent(projection.getCode())}`;
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
      console.error("Boundary WFS failed:", err);
      return [];
    }
  };

  // =====================================================
  // MAP INITIALIZATION
  // =====================================================
  useEffect(() => {
    const cityKey = city.toLowerCase();
    const cfg = cityConfig[cityKey] || {};

    // ---------- BASE MAPS ----------
    // 1️⃣ Create all base layers (migrated from HomePage.js)
    const osmLayer = new TileLayer({
      title: "OpenStreetMap",
      type: "base",
      visible: true,
      maxZoom: 19,
      source: new OSM({
        crossOrigin: "anonymous",
      }),
    });

    const positronLayer = new TileLayer({
      title: "CartoDB Positron",
      type: "base",
      visible: false,
      maxZoom: 23,
      source: new XYZ({
        url: "https://{1-4}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
        crossOrigin: 'anonymous',
      }),
    });

    const satelliteLayer = new TileLayer({
      title: "Satellite",
      type: "base",
      visible: true,
      maxZoom: SATELLITE_MAX_ZOOM,
      source: new XYZ({
        url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        crossOrigin: 'anonymous',
      }),
    });

    const tonerLayer = new TileLayer({
      title: "Toner",
      type: "base",
      visible: false,
      maxZoom: 23,
      source: new XYZ({
        url: "https://stamen-tiles.a.ssl.fastly.net/toner/{z}/{x}/{y}.png",
        attributions:
          'Map tiles by <a href="https://stamen.com">Stamen Design</a>, ' +
          'under <a href="https://creativecommons.org/licenses/by/3.0">CC BY 3.0</a>. ' +
          'Data by <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, ' +
          'under <a href="https://opendatacommons.org/licenses/odbl/">ODbL</a>.',
        crossOrigin: "anonymous",
      }),
    });

    const topoLayer = new TileLayer({
      title: "Topo",
      type: "base",
      visible: false,
      maxZoom: 23,
      source: new XYZ({
        url: "https://{a-c}.tile.opentopomap.org/{z}/{x}/{y}.png",
        attributions:
          'Map data: <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, ' +
          'SRTM | Map style: <a href="https://opentopomap.org">OpenTopoMap</a> ' +
          '(<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)',
        crossOrigin: "anonymous",
      }),
    });

    // ✅ Labels overlay - hidden by default (Managed by Satellite toggle)
    const labelsLayer = new TileLayer({
      title: "Labels (Esri Reference)",
      visible: true,
      maxZoom: SATELLITE_MAX_ZOOM,
      source: new XYZ({
        url: "https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
        attributions: 'Labels &copy; <a href="https://www.esri.com/">Esri</a>',
        crossOrigin: "anonymous",
      }),
    });

    const satelliteWithLabels = new LayerGroup({
      title: "Satellite + Labels",
      type: "base",
      combine: true,
      visible: false,
      layers: [satelliteLayer, labelsLayer],
    });

    const baseMaps = new LayerGroup({
      title: "Base Maps",
      layers: [osmLayer, positronLayer, satelliteWithLabels, tonerLayer, topoLayer],
      fold: "open",
    });

    // ---------- ADMIN LAYERS ----------
    const zoneBoundary = cfg.zoneLayer
      ? new ImageLayer({
        title: "Zone Boundary",
        source: new ImageWMS({
          url: WARD_ZONE_WMS,
          params: {
            LAYERS: cfg.zoneLayer,
            FORMAT: "image/png",
            TRANSPARENT: true,
            TILED: true,
            FORMAT_OPTIONS: "antiAlias:false",
          },
          serverType: "geoserver",
          ratio: 1,
          crossOrigin: "anonymous", // ⭐ Added for screenshot
        }),
      })
      : null;

    const wardBoundary = cfg.wardLayer
      ? new ImageLayer({
        title: "Ward Boundary",
        source: new ImageWMS({
          url: WARD_ZONE_WMS,
          params: {
            LAYERS: cfg.wardLayer,
            FORMAT: "image/png",
            TRANSPARENT: true,
            TILED: true,
            FORMAT_OPTIONS: "antiAlias:false",
          },
          serverType: "geoserver",
          ratio: 1,
          crossOrigin: "anonymous", // ⭐ Added for screenshot
        }),
      })
      : null;

    const applyBoundaryLabelStyle = async (layer, layerName, labelAttr, fallbackColor) => {
      if (!layer || !layerName) return;
      const color = (await fetchLegendColor(layerName)) || fallbackColor;
      const source = layer.getSource();
      if (source?.updateParams) {
        source.updateParams({
          SLD_BODY: buildBoundaryLabelSld(layerName, labelAttr, color),
          _t: Date.now(),
        });
      }
    };

    const applyRoadLabelStyle = (layer, layerName) => {
      if (!layer || !layerName) return;
      const source = layer.getSource();
      if (source?.updateParams) {
        source.updateParams({
          SLD_BODY: buildRoadLabelSld(layerName, "road_name", "road_id"),
          _t: Date.now(),
        });
      }
    };

    if (!getIsLowBandwidth()) {
      const applyBoundaryLabelStyles = async () => {
        await Promise.all([
          applyBoundaryLabelStyle(zoneBoundary, cfg.zoneLayer, "zone_no", "#e11d48"),
          applyBoundaryLabelStyle(wardBoundary, cfg.wardLayer, "ward_no", "#16a34a"),
        ]);
      };
      applyBoundaryLabelStyles();
    }

    const adminLayers = new LayerGroup({
      title: "Administrative Layers",
      layers: [zoneBoundary, wardBoundary].filter(Boolean),
      fold: "open",
    });
    if (zoneBoundary) zoneBoundary.setZIndex(20010);
    if (wardBoundary) wardBoundary.setZIndex(20020);
    adminLayers.setZIndex(20000);

    // ---------- MAIN ROAD NETWORK (SEARCH) ----------
    let roadNetworkLayer = null;
    let roadLabelsLayer = null;
    if (cfg.roadLayer) {
      roadNetworkLayer = new TileLayer({
        title: "Road Network Layer",
        visible: true,
        source: new TileWMS({
          url: ROAD_WMS,
          params: {
            LAYERS: cfg.roadLayer,
            TILED: true,
            FORMAT: "image/png",
            TRANSPARENT: true,
            FORMAT_OPTIONS: "antiAlias:false",
          },
          serverType: "geoserver",
          transition: 0,
          crossOrigin: "anonymous",
        }),
      });
      roadNetworkLayer.setZIndex(40);
      roadLabelsLayer = new TileLayer({
        title: "Road Labels",
        visible: true,
        source: new TileWMS({
          url: ROAD_WMS,
          params: {
            LAYERS: cfg.roadLayer,
            TILED: true,
            FORMAT: "image/png",
            TRANSPARENT: true,
            FORMAT_OPTIONS: "antiAlias:false",
          },
          serverType: "geoserver",
          transition: 0,
          crossOrigin: "anonymous",
        }),
      });
      roadLabelsLayer.setZIndex(60);
    }
    roadNetworkLayerRef.current = roadNetworkLayer;
    roadLabelsLayerRef.current = roadLabelsLayer;

    let roadWfsLayer = null;
    if (cfg.roadLayer) {
      const roadWfsSource = new VectorSource();
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
      segmentedRoadsLayer.setZIndex(44);
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
            FORMAT_OPTIONS: "antiAlias:false",
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
      const wantsNone =
        isGroup &&
        (String(activeOption) === "none" ||
          (defaultNoneGroup && (activeOption === undefined || activeOption === null)));

      let layerName = "";
      if (isGroup) {
        const firstKey = Object.keys(specCfg.options)[0];
        const optKey = wantsNone ? firstKey : (activeOption || firstKey);
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
        source: new TileWMS({
          url: `${GEOSERVER_BASE}/wms`, // Use Global WMS to support cross-workspace layers
          params: {
            LAYERS: normalizedName,
            TILED: true,
            FORMAT: "image/png",
            TRANSPARENT: true,
            FORMAT_OPTIONS: "antiAlias:false",
            _t: Date.now(), // Force source refresh on init
          },
          serverType: "geoserver",
          transition: 0,
          crossOrigin: "anonymous",
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
        source: new TileWMS({
          url: ROAD_WMS,
          params: classParams,
          serverType: "geoserver",
          transition: 0,
          crossOrigin: "anonymous",
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
        source: new TileWMS({
          url: `${GEOSERVER_BASE}/wms`,
          params: {
            LAYERS: normalizedName,
            TILED: true,
            FORMAT: "image/png",
            TRANSPARENT: true,
            _t: Date.now(),
          },
          serverType: "geoserver",
          transition: 0,
          crossOrigin: "anonymous",
        }),
      });
      lcluLayers[id].setZIndex(55);
    });
    lcluLayersRef.current = lcluLayers;

    const amenityLayers = {};
    const isDark = baseMap === "satellite" || baseMap === "toner";
    Object.entries(cfg.amenities || {}).forEach(([id]) => {
      const source = new VectorSource();
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
      const source = new VectorSource();
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
      const source = new VectorSource();
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
      const source = new VectorSource();
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

    const searchAreaSource = new VectorSource();
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

    // ---------- MAP ----------
    const map = new OLMap({
      target: mapElement.current,
      layers: [
        baseMaps,
        adminLayers,
        roadNetworkLayer,
        roadWfsLayer,
        roadLabelsLayer,
        segmentedRoadsLayer,
        chainageLayer,
        ...Object.values(specializedLayers),
        ...Object.values(roadClassLayers),
        ...Object.values(lcluLayers),
        searchAreaLayer,
        amenitiesGroup,
        othersGroup,
        streetLayer,
      ].filter(Boolean),
      view: new View({
        ...(cityViews[cityKey] || cityViews.default),
        maxZoom: baseMap === "satellite" ? SATELLITE_MAX_ZOOM : DEFAULT_MAX_ZOOM,
      }),
      controls: defaultControls({ zoom: true, rotate: false }),
    });

    // ---------- MAP LOADING TRACKER ----------
    if (onMapLoadingChange) {
      let loadingTasks = 0;
      let debounceTimeout = null;
      let forceStopTimeout = null;

      const scheduleForceStop = () => {
        clearTimeout(forceStopTimeout);
        forceStopTimeout = setTimeout(() => {
          loadingTasks = 0;
          onMapLoadingChange(false);
        }, 5000);
      };

      const handleLoadStart = () => {
        if (loadingTasks === 0) {
          clearTimeout(debounceTimeout);
          onMapLoadingChange(true);
        }
        loadingTasks++;
        scheduleForceStop();
      };

      const handleLoadEnd = () => {
        loadingTasks = Math.max(0, loadingTasks - 1);
        if (loadingTasks === 0) {
          clearTimeout(forceStopTimeout);
          clearTimeout(debounceTimeout);
          debounceTimeout = setTimeout(() => {
            if (loadingTasks === 0) onMapLoadingChange(false);
          }, 300);
        }
      };

      map.on("loadstart", handleLoadStart);
      map.on("loadend", handleLoadEnd);
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

    // Create Popup Overlay
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

      // Add visible Amenities
      Object.values(amenityLayersRef.current).forEach(l => {
        if (l.getVisible()) candidates.push({ layer: l, isRoad: false });
      });

      // Add visible Others
      Object.values(otherLayersRef.current).forEach(l => {
        if (l.getVisible()) candidates.push({ layer: l, isRoad: false });
      });

      // Add visible Roads
      const activeClassLayer = Object.values(roadClassLayersRef.current).find(l => l.getVisible());
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
      Object.values(specializedLayersRef.current).forEach((layer) => {
        if (layer.getVisible()) {
          candidates.push({ layer, isRoad: false });
        }
      });

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
                  padding: [50, 50, 50, 50],
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
      setMapReady(false);
    };
  }, [city]);

  const dssLegend = useMemo(() => {
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
    const cityKey = city.toLowerCase();
    const cfg = cityConfig[cityKey] || {};
    const layerName = cfg.wardLayer || cfg.zoneLayer;
    if (!layerName) return;

    let cancelled = false;
    const map = mapRef.current;
    const view = map.getView();

    const fitToBoundary = async () => {
      const extent4326 = await fetchBoundaryExtent4326(layerName);
      if (cancelled || !extent4326) return;
      const min = fromLonLat([extent4326[0], extent4326[1]]);
      const max = fromLonLat([extent4326[2], extent4326[3]]);
      const projected = [min[0], min[1], max[0], max[1]];
      const fitExtent = normalizeExtent(projected, view);
      if (!fitExtent) return;
      view.fit(fitExtent, {
        padding: getAutoZoomPadding(false),
        duration: 800,
        maxZoom: isMobileView ? 12 : 14,
      });
    };

    fitToBoundary();
    return () => {
      cancelled = true;
    };
  }, [mapReady, city, zoomFilter, isMobileView]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    const cityKey = city.toLowerCase();
    const cfg = cityConfig[cityKey] || {};
    const boundaryLayerName = cfg.zoneLayer || cfg.wardLayer;
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
  useEffect(() => { onPopupClosedRef.current = onPopupClosed; }, [onPopupClosed]);
  useEffect(() => { onRoadSelectedRef.current = onRoadSelected; }, [onRoadSelected]);

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
          let url =
            `${ROAD_WFS}?service=WFS&version=1.1.0&request=GetFeature` +
            `&typeName=${encodeURIComponent(layerName)}` +
            `&outputFormat=application/json` +
            `&srsName=${encodeURIComponent(projection.getCode())}` +
            `&bbox=${extent.join(",")},${encodeURIComponent(projection.getCode())}` +
            `&maxFeatures=${maxFeatures}`;
          if (applyFilter) {
            url += `&CQL_FILTER=${encodeURIComponent(filterText)}`;
          }
          fetch(url, { signal: controller.signal })
            .then((res) => res.json())
            .then((data) => {
              if (controller.signal.aborted) return;
              if (!roadWfsLayerRef.current) return;
              applyWfsData(roadWfsLayerRef.current, data, projection, "roads", "RoadWFS");
            })
            .catch((err) => {
              if (controller.signal.aborted) return;
              console.error("RoadWFS failed:", err);
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
      const geoserverBase = window.location.port === "8060"
        ? `${window.location.protocol}//${window.location.hostname}:8080/geoserver`
        : (process.env.REACT_APP_GEOSERVER_BASE || "/geoserver");
      let baseUrl = isRoadLayer ? `${geoserverBase}/Road_Network/wfs` : `${geoserverBase}/Amenities/wfs`;

      const filterExpr = `INTERSECTS(geom, ${sridWkt})`;
      const queryUrl = `${baseUrl}?service=WFS&version=1.1.0&request=GetFeature&typeName=${encodeURIComponent(
        typeName
      )}&outputFormat=application/json&CQL_FILTER=${encodeURIComponent(filterExpr)}`;

      // Apply filter directly to the road network WMS and notify parent
      if (isRoadLayer) {
        if (roadNetworkLayerRef.current) {
          const src = roadNetworkLayerRef.current.getSource();
          src.updateParams({ CQL_FILTER: filterExpr, _t: Date.now() });
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

  const onLegendPointerMove = (e) => {
    if (!draggingRef.current) return;
    const o = dragOriginRef.current;
    const nextLeft = o.left + (e.clientX - o.x);
    const nextTop = o.top + (e.clientY - o.y);
    const maxLeft = Math.max(0, window.innerWidth - o.w);
    const maxTop = Math.max(0, window.innerHeight - o.h);
    const clampedLeft = Math.min(Math.max(0, nextLeft), maxLeft);
    const clampedTop = Math.min(Math.max(0, nextTop), maxTop);
    setLegendPos({ left: clampedLeft, top: clampedTop });
  };

  const onLegendPointerUp = () => {
    draggingRef.current = false;
    document.removeEventListener("pointermove", onLegendPointerMove);
    document.removeEventListener("pointerup", onLegendPointerUp);
    document.removeEventListener("pointercancel", onLegendPointerUp);
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
      source.updateParams({ CQL_FILTER: null, _t: Date.now() });
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

    source.updateParams({
      CQL_FILTER: roadFilter,
      _t: Date.now(),
    });
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

    // Manage base road layer visibility
    if (roadNetworkLayerRef.current) {
      if (isNoneSelected) {
        roadNetworkLayerRef.current.setVisible(false);
      } else if (isAnyClassLayerVisible) {
        // If a classification layer is active, HIDE the base layer
        roadNetworkLayerRef.current.setVisible(false);
      } else {
        // Otherwise, show it if network.roads is enabled OR if there's a filter
        let shouldShow = !!(layerVisibility?.network?.roads);
        if (roadFilter) shouldShow = true;
        roadNetworkLayerRef.current.setVisible(shouldShow);
      }
    }

    if (roadLabelsLayerRef.current) {
      const labelsSource = roadLabelsLayerRef.current.getSource?.();
      if (labelsSource?.updateParams) {
        labelsSource.updateParams({
          CQL_FILTER: roadFilter || null,
          _t: Date.now(),
        });
      }
      const shouldShowLabels =
        !isNoneSelected &&
        !getIsLowBandwidth() &&
        !isAnyClassLayerVisible &&
        (!!roadNetworkLayerRef.current?.getVisible?.() || !!roadFilter);
      roadLabelsLayerRef.current.setVisible(shouldShowLabels);
    }

    // Classification layers: visibility only follows sidebar toggles
    Object.entries(layers).forEach(([key, layer]) => {
      const source = layer.getSource();
      if (!source) return;

      // ALWAYS update filter params so that if the user toggles the layer 
      // via the Legend/LayerSwitcher, it respects the current filter.
      source.updateParams({
        CQL_FILTER: roadFilter || null,
        _t: Date.now(),
      });

      const isVisibleByToggle = !!layerVisibility.roadClassifications?.[key];
      const isVisible = !isNoneSelected && isVisibleByToggle;

      if (isVisible) {
        layer.setVisible(true);
      } else {
        layer.setVisible(false);
      }
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
    if (chainageLayerRef.current) {
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
          const wantsNone =
            String(activeOption) === "none" ||
            (defaultNoneGroup && (activeOption === undefined || activeOption === null));

          if (wantsNone) {
            layer.setVisible(false);
            return;
          }

          const optKey = activeOption || Object.keys(specCfg.options)[0];
          const opt = specCfg.options[optKey];
          const newLayerName = normalizeLayerName(typeof opt === "string" ? opt : (opt?.layer || ""));

          const source = layer.getSource();
          if (source && source.getParams().LAYERS !== newLayerName) {
            source.updateParams({ LAYERS: newLayerName, _t: Date.now() });
          }
        }
      }
    });

    Object.entries(lcluLayersRef.current).forEach(([id, layer]) => {
      const visible = !!layerVisibility?.lclu?.[id];
      layer.setVisible(visible);
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
            console.error(`Road analysis fetch failed for ${id}:`, err);
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
      selectedLayer.setZIndex(100);
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
  }, [activeRoadIds, selectedRoadId, baseMap]);

  // =====================================================
  // AUTO-ZOOM TO FEATURE BASED ON zoomFilter
  // =====================================================
  useEffect(() => {
    if (!mapRef.current) return;

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

    fetch(apiUrl)
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

        if (isIdentifierFilter && features.length > 0 && showPopupRef.current) {
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
      .catch((err) => console.error("❌ [AutoZoom] Error:", err));
  }, [zoomFilter, city, isMobileView, baseMap]);

  return (
    <div id="map-root" className="map-container-wrapper" style={{ position: "relative", width: "100%", height: "100%" }}>
      <div
        id="ol-map"
        ref={mapElement}
        className="map-element"
        style={{ width: "100%", height: "100%", background: "#e0e0e0" }} // Added background color for fallback
      />

      <MapNavigation
        map={mapReady ? mapRef.current : null}
        isTableOpen={tableHasRows && !tableMinimized}
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
          layerVisibility={layerVisibility}
          roadFilter={roadFilter}
          onApplyFilter={onRoadFilterChange}
          amenityCounts={amenityLegendCounts}
          otherCounts={otherLegendCounts}
          dssLegend={dssLegend}
        />
      </div>

      {/* Popup Overlay Structure */}
      <div ref={popupRef} className="ol-popup">
        <a
          href="#"
          ref={popupCloserRef}
          className="ol-popup-closer"
          onClick={(e) => {
            e.preventDefault();
            try { closePopup(); } catch (err) { console.error("Popup close error:", err); }
            return false;
          }}
        ></a>
        <div ref={popupContentRef} className="ol-popup-content"></div>
      </div>
    </div>
  );
});

export default MapContainer;
