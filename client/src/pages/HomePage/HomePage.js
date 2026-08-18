/* Home landing with statewide map overview and per-city summary panels. */
import React, {
  useEffect,
  useState,
  useRef,
  useCallback,
  useMemo,
} from "react";
import styles from "./HomePage.Module.css";
import Footer from "../../components/Footer";
import "ol/ol.css";

import Map from "ol/Map";
import View from "ol/View";
import TileLayer from "ol/layer/Tile";
import LayerGroup from "ol/layer/Group";
import ImageLayer from "ol/layer/Image";
import VectorLayer from "ol/layer/Vector";
import XYZ from "ol/source/XYZ";
import TileWMS from "ol/source/TileWMS";
import ImageWMS from "ol/source/ImageWMS";
import VectorSource from "ol/source/Vector";
import { bbox as bboxStrategy } from "ol/loadingstrategy";
import GeoJSON from "ol/format/GeoJSON";
import { Style, Fill, Stroke } from "ol/style";
import Overlay from "ol/Overlay";
import { getCenter, buffer as bufferExtent, getWidth, getHeight } from "ol/extent";
import { fromLonLat, toLonLat, transformExtent } from "ol/proj";
// removed proj4 usage to avoid dependency; relying on default projections
import { defaults as defaultControls } from "ol/control";
// Enable reprojection for WMS layers
import "ol/ol.css";
import "ol-layerswitcher/dist/ol-layerswitcher.css";
import { useNavigate } from "react-router-dom";
import logo from "../../assets/NN_Logo/download.png";
import HomeMapLegend from "../../components/HomeMapLegend";
import { attachInvertedMask, extractClipRings } from "../../utils/mapClip";
import { attachBasemapErrorNotifier } from "../../utils/basemapHealth";
import { getGeoserverBase } from "../../utils/geoserverBase";
import { cityConfig } from "../../assets/configs/cityConfig";

/* ====================== CONFIG ====================== */

const GEOSERVER_BASE = getGeoserverBase();
const TILE_CACHE_BASE = (process.env.REACT_APP_TILE_CACHE_BASE || "").replace(/\/$/, "");
// Every base layer here is clipped to the whole state (see UP_BOUNDARY_LAYER
// below) — the tile proxy masks and caches this server-side once per tile,
// reused across every user, rather than each browser redoing the same clip.
const getCachedTileUrl = (style, boundary) =>
  `${TILE_CACHE_BASE}/api/tiles/${style}/{z}/{x}/{y}.png` +
  (boundary ? `?boundary=${encodeURIComponent(boundary)}` : "");
const applyTileTemplate = (template, z, x, y) =>
  template.replace("{z}", z).replace("{x}", x).replace("{y}", y);
const UP_BOUNDARY_LAYER = "Ward_38:Up_District";
const makeCachedXyzSource = ({ style, fallbackUrl, attributions, maxZoom, boundary }) =>
  new XYZ({
    url: getCachedTileUrl(style, boundary),
    cacheSize: 1024,
    // OL's own built-in tile cross-fade (ms) - was disabled (0), which made
    // every new tile pop in abruptly. A short fade gives a noticeably more
    // "premium" feel while panning/zooming at effectively no extra cost
    // (cached tiles resolve instantly and the fade is barely visible then;
    // it only shows up on genuine network fetches).
    transition: 300,
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
// Phase 2 uses the same GeoServer; override with REACT_APP_PHASE2_GEOSERVER_BASE if it diverges.
const PHASE2_GEOSERVER_BASE =
  process.env.REACT_APP_PHASE2_GEOSERVER_BASE || GEOSERVER_BASE;

/** City -> center fallback (when WFS is empty/unavailable) */
const CITY_CENTER = {
  agra: fromLonLat([78.0081, 27.1767]),
  aligarh: fromLonLat([78.088, 27.8974]),
  ayodhya: fromLonLat([82.1944, 26.7999]),
  bareilly: fromLonLat([79.4304, 28.367]),
  firozabad: fromLonLat([78.3949, 27.1591]),
  ghaziabad: fromLonLat([77.4538, 28.6692]),
  gorakhpur: fromLonLat([83.3732, 26.7606]),
  jhansi: fromLonLat([78.5685, 25.4484]),
  kanpur: fromLonLat([80.3319, 26.4499]),
  lucknow: fromLonLat([80.9462, 26.8467]),
  mathura: fromLonLat([77.6737, 27.4924]),
  meerut: fromLonLat([77.7064, 28.9845]),
  moradabad: fromLonLat([78.7768, 28.8386]),
  prayagraj: fromLonLat([81.8463, 25.4358]),
  saharanpur: fromLonLat([77.546, 29.9679]),
  shahjahanpur: fromLonLat([79.912, 27.8804]),
  varanasi: fromLonLat([83.0076, 25.3176]),
};

const UP_CENTER = fromLonLat([80.5, 27.25]);
// Matches the `upExtent` bbox already used throughout this file for `.fit()`
// calls — reused here as a hard pan/zoom limit so the statewide map never
// requests or renders basemap tiles outside Uttar Pradesh.
const UP_EXTENT_3857 = [
  ...fromLonLat([77.0, 23.5]),
  ...fromLonLat([84.5, 31.0]),
];
const HOME_SUMMARY_CACHE_KEY = "homeSummaryCache";
const HOME_SUMMARY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes – refresh frequently so stale zeros don't persist

/** WFS boundary per city (workspace:layer names)
 *  Use your actual names from GeoServer; these match your legacy scheme.
 */
const BOUNDARY_WFS = {
  agra: { ws: "Ward_38", layer: "All_Boundaries", name: "Agra" },
  aligarh: { ws: "Ward_38", layer: "All_Boundaries", name: "Aligarh" },
  ayodhya: { ws: "Ward_38", layer: "All_Boundaries", name: "Ayodhya" },
  bareilly: { ws: "Ward_38", layer: "All_Boundaries", name: "Bareilly" },
  firozabad: { ws: "Ward_38", layer: "All_Boundaries", name: "Firozabad" },
  ghaziabad: { ws: "Ward_38", layer: "All_Boundaries", name: "Ghaziabad" },
  gorakhpur: { ws: "Ward_38", layer: "All_Boundaries", name: "Gorakhpur" },
  jhansi: { ws: "Ward_38", layer: "All_Boundaries", name: "Jhansi" },
  kanpur: { ws: "Ward_38", layer: "All_Boundaries", name: "Kanpur" },
  lucknow: { ws: "Ward_38", layer: "All_Boundaries", name: "Lucknow" },
  mathura: { ws: "Ward_38", layer: "All_Boundaries", name: "Mathura" },
  meerut: { ws: "Ward_38", layer: "All_Boundaries", name: "Meerut" },
  moradabad: { ws: "Ward_38", layer: "All_Boundaries", name: "Moradabad" },
  prayagraj: { ws: "Ward_38", layer: "All_Boundaries", name: "Prayagraj" },
  saharanpur: { ws: "Ward_38", layer: "All_Boundaries", name: "Saharanpur" },
  shahjahanpur: {
    ws: "Ward_38",
    layer: "All_Boundaries",
    name: "Shahjahanpur",
  },
  varanasi: { ws: "Ward_38", layer: "All_Boundaries", name: "Varanasi" },
};

const CITY_BOUNDARY_COLORS = {
  agra: "#e74c3c",
  aligarh: "#8e44ad",
  ayodhya: "#f39c12",
  bareilly: "#16a085",
  firozabad: "#d35400",
  ghaziabad: "#2c3e50",
  gorakhpur: "#27ae60",
  jhansi: "#c0392b",
  kanpur: "#2980b9",
  lucknow: "#9b59b6",
  mathura: "#1abc9c",
  meerut: "#34495e",
  moradabad: "#e67e22",
  prayagraj: "#7f8c8d",
  saharanpur: "#2ecc71",
  shahjahanpur: "#c2185b",
  varanasi: "#6c5ce7",
};

// GeoServer PostGIS data has typos in the Name field.
// This map corrects WFS feature names → the app's city keys.
const WFS_NAME_MAP = {
  varansi: "varanasi", // typo in DB: missing 'a'
  shaharanpur: "saharanpur", // typo in DB: 'Shah' should be 'Sah'
  shahajahanpur: "shahjahanpur", // typo in DB: extra 'ha'
};

/** Normalize a WFS feature Name to the app's lowercase city key */
const normalizeWfsName = (raw) => {
  const lower = (raw || "").toLowerCase();
  return WFS_NAME_MAP[lower] || lower;
};

const CITY_OVERLAY_OFFSET = {
  agra: [60, -40],
  aligarh: [50, -35],
  ayodhya: [55, -35],
  bareilly: [40, -35],
  firozabad: [50, -45],
  ghaziabad: [40, -40],
  gorakhpur: [45, -45],
  jhansi: [40, -35],
  kanpur: [55, -40],
  lucknow: [60, -45],
  mathura: [40, -35],
  meerut: [45, -35],
  moradabad: [45, -40],
  prayagraj: [50, -35],
  saharanpur: [40, -45],
  shahjahanpur: [45, -35],
  varanasi: [50, -45],
};

const getOverlayOffset = (city) => {
  const base = CITY_OVERLAY_OFFSET[city] || [0, 0];
  const cityCoord = CITY_CENTER[city];
  if (!cityCoord) return base;
  const dx = cityCoord[0] - UP_CENTER[0];
  const dy = cityCoord[1] - UP_CENTER[1];
  const mag = Math.hypot(dx, dy) || 1;
  const outward = 210;
  const radial = [
    Math.round((dx / mag) * outward),
    Math.round((dy / mag) * outward),
  ];
  return [base[0] + radial[0], base[1] + radial[1]];
};

const AMENITY_LABELS = {
  atm_bank: "ATM/Bank",
  bus_stop: "Bus Stop",
  education: "Education",
  hospital: "Hospital",
  hotel: "Hotel",
  park: "Park",
  petrol_pump: "Petrol Pump",
  post_office: "Post Office",
};

/** Above-10m WMS per city (workspace fixed; layer varies) */
// Use the correct case for the workspace name.  GeoServer layer names are case sensitive.
const ABOVE10M_WS = "Above_10m";
const ABOVE10M_LAYER = {
  agra: "Agra",
  aligarh: "Aligarh",
  ayodhya: "Ayodhya",
  bareilly: "Bareilly",
  firozabad: "Firozabad",
  ghaziabad: "Ghaziabad",
  gorakhpur: "Gorakhpur",
  jhansi: "Jhansi",
  kanpur: "Kanpur",
  lucknow: "Lucknow",
  mathura: "Mathura",
  meerut: "Meerut",
  moradabad: "Moradabad",
  prayagraj: "Prayagraj",
  saharanpur: "Saharanpur",
  shahjahanpur: "Shahjahanpur",
  varanasi: "Varanasi",
};

const ABOVE10M_VECTOR_STYLE = new Style({
  stroke: new Stroke({
    color: "#10b981",
    width: 3,
  }),
});

/** CM-Grid & GPR (fill with your real layer names per city/phase) */
const CM_GRID_WORKSPACE = "All_CM_Grid";

const CM_GRID_WMS = {
  agra: {
    Phase1: { ws: "Phase_1", layer: "Agra_Phase_1" },
    Phase2: { ws: "Phase_2", layer: "Agra_Phase_2" },
    Phase3: { ws: "Phase_3", layer: "Agra_Phase_3" },
  },
  aligarh: {
    Phase1: { ws: "Phase_1", layer: "Aligarh_Phase_1" },
    Phase2: { ws: "Phase_2", layer: "Aligarh_Phase_2" },
    Phase3: { ws: "Phase_3", layer: "Aligarh_Phase_3" },
  },
  ayodhya: {
    Phase1: { ws: "Phase_1", layer: "Ayodhya_Phase_1" },
    Phase2: { ws: "Phase_2", layer: "Ayodhya_Phase_2" },
    Phase3: { ws: "Phase_3", layer: "Ayodhya_Phase_3" },
  },
  bareilly: {
    Phase1: { ws: "Phase_1", layer: "Bareilly_Phase_1" },
    Phase2: { ws: "Phase_2", layer: "Bareilly_Phase_2" },
    Phase3: { ws: "Phase_3", layer: "Bareilly_Phase_3" },
  },
  firozabad: {
    Phase1: { ws: "Phase_1", layer: "Firozabad_Phase_1" },
    Phase2: { ws: "Phase_2", layer: "Firozabad_Phase_2" },
    Phase3: { ws: "Phase_3", layer: "Firozabad_Phase_3" },
  },
  ghaziabad: {
    Phase1: { ws: "Phase_1", layer: "Ghaziabad_Phase_1" },
    Phase2: { ws: "Phase_2", layer: "Ghaziabad_Phase_2" },
    Phase3: { ws: "Phase_3", layer: "Ghaziabad_Phase_3" },
  },
  gorakhpur: {
    Phase1: { ws: "Phase_1", layer: "Gorakhpur_Phase_1" },
    Phase2: { ws: "Phase_2", layer: "Gorakhpur_Phase_2" },
    Phase3: { ws: "Phase_3", layer: "Gorakhpur_Phase_3" },
  },
  jhansi: {
    Phase1: { ws: "Phase_1", layer: "Jhansi_Phase_1" },
    Phase2: { ws: "Phase_2", layer: "Jhansi_Phase_2" },
    Phase3: { ws: "Phase_3", layer: "Jhansi_Phase_3" },
  },
  kanpur: {
    Phase1: { ws: "Phase_1", layer: "Kanpur_Phase_1" },
    Phase2: { ws: "Phase_2", layer: "Kanpur_Phase_2" },
    Phase3: { ws: "Phase_3", layer: "Kanpur_Phase_3" },
  },
  lucknow: {
    Phase1: { ws: "Phase_1", layer: "Lucknow_Phase_1" },
    Phase2: { ws: "Phase_2", layer: "Lucknow_Phase_2" },
    Phase3: { ws: "Phase_3", layer: "Lucknow_Phase_3" },
    GPR: { ws: "GPR_Layer", layer: "GPR_Data" },
  },
  mathura: {
    Phase1: { ws: "Phase_1", layer: "Mathura_Phase_1" },
    Phase2: { ws: "Phase_2", layer: "Mathura_Phase_2" },
    Phase3: { ws: "Phase_3", layer: "Mathura_Phase_3" },
  },
  meerut: {
    Phase1: { ws: "Phase_1", layer: "Meerut_Phase_1" },
    Phase2: { ws: "Phase_2", layer: "Meerut_Phase_2" },
    Phase3: { ws: "Phase_3", layer: "Meerut_Phase_3" },
  },
  moradabad: {
    Phase1: { ws: "Phase_1", layer: "Moradabad_Phase_1" },
    Phase2: { ws: "Phase_2", layer: "Moradabad_Phase_2" },
    Phase3: { ws: "Phase_3", layer: "Moradabad_Phase_3" },
  },
  prayagraj: {
    Phase1: { ws: "Phase_1", layer: "Prayagraj_Phase_1" },
    Phase2: { ws: "Phase_2", layer: "Prayagraj_Phase_2" },
    Phase3: { ws: "Phase_3", layer: "Prayagraj_Phase_3" },
  },
  saharanpur: {
    Phase1: { ws: "Phase_1", layer: "Saharanpur_Phase_1" },
    Phase2: { ws: "Phase_2", layer: "Saharanpur_Phase_2" },
    Phase3: { ws: "Phase_3", layer: "Saharanpur_Phase_3" },
  },
  shahjahanpur: {
    Phase1: { ws: "Phase_1", layer: "Shahjahanpur_Phase_1" },
    Phase2: { ws: "Phase_2", layer: "Shahjahanpur_Phase_2" },
    Phase3: { ws: "Phase_3", layer: "Shahjahanpur_Phase_3" },
  },
  varanasi: {
    Phase1: { ws: "Phase_1", layer: "Varanasi_Phase_1" },
    Phase2: { ws: "Phase_2", layer: "Varanasi_Phase_2" },
    Phase3: { ws: "Phase_3", layer: "Varanasi_Phase_3" },
  },
  // add others as needed
};

const resolveCmGridEntry = (entry) => {
  if (!entry) return null;

  const isCmGridPhase = /^Phase_[123]$/.test(entry.ws || "");
  const workspace = isCmGridPhase ? CM_GRID_WORKSPACE : entry.ws;

  return {
    ...entry,
    workspace,
    style: entry.style || (isCmGridPhase ? entry.ws : ""),
    layerName: `${workspace}:${entry.layer}`,
    baseUrl:
      !isCmGridPhase && entry.ws === "Phase_2"
        ? PHASE2_GEOSERVER_BASE
        : GEOSERVER_BASE,
  };
};

const CM_GRID_MENU_OPTIONS = [
  
  { value: "Phase1", label: "Phase 1", unavailableLabel: "Phase 1" },
  { value: "Phase2", label: "Phase 2", unavailableLabel: "Phase 2" },
  { value: "Phase3", label: "Phase 3", unavailableLabel: "Phase 3" },
];

// === City card data (same as old home.js) ===
const cityCardData = {
  default: [
    { title: "Total Road Count", content: "Total: 337881" },
    { title: "Total Road Length", content: "41348.63 km" },
    { title: "Total Above 10m Road Count", content: "10496" },
    { title: "Total Above 10m Road Length", content: "5174.21 km" },
  ],
  Agra: [
    { title: "Road Count", content: "Total: 18167" },
    { title: "Road Length", content: "2591.49 km" },
    { title: "Above 10m Road Count", content: "771" },
    { title: "Above 10m Road Length", content: "314.2 km" },
  ],
  Aligarh: [
    { title: "Road Count", content: "Total: 14690" },
    { title: "Road Length", content: "1980.01 km" },
    { title: "Above 10m Road Count", content: "388" },
    { title: "Above 10m Road Length", content: "199.05 km" },
  ],
  Ayodhya: [
    { title: "Road Count", content: "Total: 10549" },
    { title: "Road Length", content: "1178.98 km" },
    { title: "Above 10m Road Count", content: "278" },
    { title: "Above 10m Road Length", content: "149.21 km" },
  ],
  Bareilly: [
    { title: "Road Count", content: "Total: 15800" },
    { title: "Road Length", content: "1621.63 km" },
    { title: "Above 10m Road Count", content: "453" },
    { title: "Above 10m Road Length", content: "160 km" },
  ],
  Firozabad: [
    { title: "Road Count", content: "Total: 6053" },
    { title: "Road Length", content: "809.04 km" },
    { title: "Above 10m Road Count", content: "92" },
    { title: "Above 10m Road Length", content: "54.28 km" },
  ],
  Ghaziabad: [
    { title: "Road Count", content: "Total: 19128" },
    { title: "Road Length", content: "2774.13 km" },
    { title: "Above 10m Road Count", content: "767" },
    { title: "Above 10m Road Length", content: "387.18 km" },
  ],
  Gorakhpur: [
    { title: "Road Count", content: "Total: 16121" },
    { title: "Road Length", content: "2136.17 km" },
    { title: "Above 10m Road Count", content: "585" },
    { title: "Above 10m Road Length", content: "286.14 km" },
  ],
  Jhansi: [
    { title: "Road Count", content: "Total: 10845" },
    { title: "Road Length", content: "1810.17 km" },
    { title: "Above 10m Road Count", content: "298" },
    { title: "Above 10m Road Length", content: "154.98 km" },
  ],
  Kanpur: [
    { title: "Road Count", content: "Total: 23017" },
    { title: "Road Length", content: "3776.6 km" },
    { title: "Above 10m Road Count", content: "347" },
    { title: "Above 10m Road Length", content: "302.96 km" },
  ],
  Lucknow: [
    { title: "Road Count", content: "Total: 82354" },
    { title: "Road Length", content: "9480.73 km" },
    { title: "Above 10m Road Count", content: "2872" },
    { title: "Above 10m Road Length", content: "1404.53 km" },
  ],
  Prayagraj: [
    { title: "Road Count", content: "Total:16046" },
    { title: "Road Length", content: "3089.39 km" },
    { title: "Above 10m Road Count", content: "1026" },
    { title: "Above 10m Road Length", content: "557.35 km" },
  ],
  Mathura: [
    { title: "Road Count", content: "Total: 12970" },
    { title: "Road Length", content: "712.39 km" },
    { title: "Above 10m Road Count", content: "285" },
    { title: "Above 10m Road Length", content: "207.37 km" },
  ],
  Meerut: [
    { title: "Road Count", content: "Total: 19282" },
    { title: "Road Length", content: "2947.2 km" },
    { title: "Above 10m Road Count", content: "637" },
    { title: "Above 10m Road Length", content: "353.49 km" },
  ],
  Moradabad: [
    { title: "Road Count", content: "Total: 8331" },
    { title: "Road Length", content: "1129.45 km" },
    { title: "Above 10m Road Count", content: "545" },
    { title: "Above 10m Road Length", content: "205.4 km" },
  ],
  Saharanpur: [
    { title: "Road Count", content: "Total: 9811" },
    { title: "Road Length", content: "1399.36 km" },
    { title: "Above 10m Road Count", content: "310" },
    { title: "Above 10m Road Length", content: "143.23 km" },
  ],
  Shahjahanpur: [
    { title: "Road Count", content: "Total: 6558" },
    { title: "Road Length", content: "623.98 km" },
    { title: "Above 10m Road Count ", content: "182" },
    { title: "Above 10m Road Length", content: "115.47 km" },
  ],
  Varanasi: [
    { title: "Road Count", content: "Total: 30226" },
    { title: "Road Length", content: "2272.63 km" },
    { title: "Above 10m Road Count", content: "701" },
    { title: "Above 10m Road Length", content: "276.51 km" },
  ],
};

/* ====================== COMPONENT ====================== */

export default function HomePage() {
  const navigate = useNavigate();
  const mapRef = useRef(null);
  // addBoundaryLayer awaits fitViewToCityBoundary, which can itself poll
  // for up to ~5s waiting on WFS boundary data. If the user picks another
  // city (or the component unmounts) before that resolves, the stale
  // call's eventual `map.renderSync()` was firing against a map whose
  // internal render state OpenLayers had already torn down/replaced —
  // "Cannot read properties of null (reading 'renderFrame')" inside OL's
  // own rAF-deferred Map.renderFrame_, reproducible just by switching
  // cities before the previous selection's boundary finished loading.
  // Only the most recently started call is allowed to touch the map
  // afterward.
  const boundaryLayerRequestRef = useRef(0);
  // Flattened UP-district coordinate rings, read every render frame by the
  // base-layer clip listeners below — null/empty renders unclipped.
  const upClipRingsRef = useRef(null);
  const boundaryRef = useRef(null);
  const above10mRef = useRef(null);
  const cmGridRef = useRef(null);
  const cityOverlaysRef = useRef({});
  const boundaryExtentCacheRef = useRef({});
  const profileMenuRef = useRef(null);
  const profileBtnRef = useRef(null);
  const phaseMenuRef = useRef(null);
  const homeSummaryRef = useRef(null);
  const buildOverlayHtmlRef = useRef(null);
  const selectedCityRef = useRef(""); // tracked in map handlers to suppress hover when a city is selected
  const baseLayerSourcesRef = useRef({}); // style key -> XYZ source, for swapping the mask boundary below
  const baseLayerBoundaryRef = useRef(null);

  const [selectedCity, setSelectedCity] = useState("");
  const [selectedPhases, setSelectedPhases] = useState([]);
  const [phaseMenuOpen, setPhaseMenuOpen] = useState(false);
  const [cmGridNotice, setCmGridNotice] = useState(null);
  // const [cityData] = useState(null);
  // const [isLoading] = useState(false);
  // const [error] = useState(null);
  // const [currentBasemap, setCurrentBasemap] = useState("osm");
  // const [showLabels, setShowLabels] = useState(false);
  // const [showBoundary, setShowBoundary] = useState(true);
  // const [showAbove10m, setShowAbove10m] = useState(false);
  // const [showCmGrid, setShowCmGrid] = useState(false);
  // const [showGpr, setShowGpr] = useState(false);

  const [cards, setCards] = useState(cityCardData.default);
  const [baseMap, setBaseMap] = useState("osm");
  const [controlsVisible, setControlsVisible] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [loggedInUser] = useState(
    () => localStorage.getItem("authUser") || "User",
  );
  const [loggedInRole] = useState(
    () => String(localStorage.getItem("authRole") || "").toLowerCase(),
  );
  // A "city-based" login (session.user.city set server-side) is locked to
  // its own city - no switching, no pan-out to the state view. Only trust
  // it if it matches a city we actually know how to render.
  const [loggedInCity] = useState(
    () => String(localStorage.getItem("authCity") || "").trim().toLowerCase(),
  );
  const isCityScopedUser = Boolean(loggedInCity && BOUNDARY_WFS[loggedInCity]);
  const [homeSummary, setHomeSummary] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [layerVisibility, setLayerVisibility] = useState({
    upDistrict: true,
    upBoundary: true,
    cmGrid: true,
  });
  const [legendMinimized, setLegendMinimized] = useState(false);
  // Basemap-outage toast (see utils/basemapHealth.js) — auto-dismisses.
  const [basemapNotice, setBasemapNotice] = useState(null);
  useEffect(() => {
    if (!basemapNotice) return;
    const timer = setTimeout(() => setBasemapNotice(null), 12000);
    return () => clearTimeout(timer);
  }, [basemapNotice]);

  const isMobileView = window.innerWidth <= 767;
  // On desktop the sidebar is ~215px wide — give it left padding so zoom fits in the visible map area
  const mapPadding = isMobileView ? [140, 16, 140, 16] : [60, 60, 80, 230];
  const upMaxZoom = isMobileView ? 7 : 8;
  const cityBuffer = isMobileView ? 30000 : 20000;
  const cityMaxZoom = isMobileView ? 12 : 13;
  const [showCityOverlays, setShowCityOverlays] = useState(!isMobileView);

  useEffect(() => {
    if (isMobileView) {
      setShowCityOverlays(false);
    }
  }, [isMobileView, selectedCity]);

  const getCityDisplayName = useCallback((cityKey) => {
    if (!cityKey) return "this city";
    return cityConfig[cityKey]?.name || cityKey.charAt(0).toUpperCase() + cityKey.slice(1);
  }, []);

  const phaseOptions = useMemo(() => {
    if (!selectedCity) return CM_GRID_MENU_OPTIONS;
    const cityLayers = CM_GRID_WMS[selectedCity] || {};
    const options = CM_GRID_MENU_OPTIONS.map((option) => ({
      ...option,
      available: option.kind === "header" || Boolean(resolveCmGridEntry(cityLayers[option.value])),
    }));

    if (cityLayers.GPR) {
      options.push({
        value: "GPR",
        label: "GPR Layer",
        unavailableLabel: "GPR layer",
        available: Boolean(resolveCmGridEntry(cityLayers.GPR)),
      });
    }

    return options;
  }, [selectedCity]);

  const selectedPhaseLabel = "CM-Grid Roads";

  useEffect(() => {
    if (!phaseMenuOpen) return undefined;
    const handlePointerDown = (event) => {
      if (!phaseMenuRef.current?.contains(event.target)) {
        setPhaseMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [phaseMenuOpen]);

  const getCmGridLayers = useCallback(
    () => cmGridRef.current?.getLayers?.().getArray?.().filter(Boolean) || [],
    [],
  );

  // ✅ Toggle Overlay Layers
  const getBasemapBoundaryForCity = useCallback((cityKey) => {
    const key = String(cityKey || "").toLowerCase();
    const cfg = cityConfig[key];
    return (cfg && (cfg.zoneLayer || cfg.wardLayer)) || UP_BOUNDARY_LAYER;
  }, []);

  const updateBaseLayerBoundary = useCallback((cityKey) => {
    const sources = baseLayerSourcesRef.current;
    if (!sources || Object.keys(sources).length === 0) return;

    const targetBoundary = getBasemapBoundaryForCity(cityKey);
    if (baseLayerBoundaryRef.current === targetBoundary) return;
    baseLayerBoundaryRef.current = targetBoundary;

    Object.entries(sources).forEach(([style, source]) => {
      if (!source?.setUrl) return;
      source.setUrl(getCachedTileUrl(style, targetBoundary));
    });
  }, [getBasemapBoundaryForCity]);

  const toggleLayer = (key) => {
    setLayerVisibility((prev) => {
      const newState = { ...prev, [key]: !prev[key] };
      const isVisible = newState[key];

      if (key === "upDistrict" && mapRef.current?.upDistrictLayer) {
        mapRef.current.upDistrictLayer.setVisible(isVisible);
      }
      if (key === "upBoundary") {
        if (mapRef.current?.upBoundaryLayer) {
          mapRef.current.upBoundaryLayer.setVisible(isVisible);
        }
      }
      if (key === "above10m" && above10mRef.current) {
        above10mRef.current.setVisible(isVisible);
      }
      if (key === "cmGrid" && cmGridRef.current) {
        cmGridRef.current.setVisible(isVisible);
      }

      return newState;
    });
  };

  // ✅ Base map visibility toggle (manual control, no LayerSwitcher)
  const handleBaseMapChange = (selectedBaseMap) => {
    const map =
      mapRef.current?.instance || mapRef.current?.map || mapRef.current;
    if (!map || typeof map.getLayers !== "function") return;

    // Grab all map layers
    const layers = map.getLayers().getArray();

    // Hide all base layers first
    layers.forEach((layer) => {
      const title = layer.get("title");
      if (
        [
          "OpenStreetMap",
          "Satellite",
          "CartoDB Positron",
          "Toner",
          "Topo",
        ].includes(title)
      ) {
        layer.setVisible(false);
      }
      if (title === "Labels (Esri Reference)") {
        layer.setVisible(false);
      }
    });

    // Turn on the chosen one
    layers.forEach((layer) => {
      const title = layer.get("title");

      if (selectedBaseMap === "osm" && title === "OpenStreetMap") {
        layer.setVisible(true);
      } else if (selectedBaseMap === "satellite" && title === "Satellite") {
        layer.setVisible(true);
        // Auto-turn on labels
        const labels = layers.find(
          (l) => l.get("title") === "Labels (Esri Reference)",
        );
        if (labels) labels.setVisible(true);
      } else if (
        selectedBaseMap === "positron" &&
        title === "CartoDB Positron"
      ) {
        layer.setVisible(true);
      } else if (selectedBaseMap === "toner" && title === "Toner") {
        layer.setVisible(true);
      } else if (selectedBaseMap === "topo" && title === "Topo") {
        layer.setVisible(true);
      }
    });

    setBaseMap(selectedBaseMap);
  };

  /* ------------ INIT MAP + LAYER SWITCHER ------------ */
  useEffect(() => {
    // reset city + clear any stored one - except for a city-scoped login,
    // which is always locked to its own city and never starts at the state
    // view (that lock is applied once the map is ready, further below).
    if (!isCityScopedUser) {
      setSelectedCity("");
      localStorage.removeItem("selectedCity");
    }

    // 1️⃣ Create all base layers first
    const osmLayer = new TileLayer({
      title: "OpenStreetMap",
      type: "base",
      visible: true, // ✅ Show by default
      preload: 1,
      maxZoom: 19,
      source: makeCachedXyzSource({
        style: "osm",
        boundary: UP_BOUNDARY_LAYER,
        fallbackUrl: "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
        attributions:
          'Map data &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19,
      }),
    });

    const positronLayer = new TileLayer({
      title: "CartoDB Positron",
      visible: false,
      preload: 1,
      maxZoom: 20,
      source: makeCachedXyzSource({
        style: "positron",
        boundary: UP_BOUNDARY_LAYER,
        fallbackUrl: "https://1.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
        attributions:
          'Map tiles by <a href="https://carto.com/attributions">CARTO</a>, Data by <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 20,
      }),
    });

    const satelliteLayer = new TileLayer({
      title: "Satellite",
      visible: false,
      preload: 1,
      maxZoom: 18,
      source: makeCachedXyzSource({
        style: "satellite",
        boundary: UP_BOUNDARY_LAYER,
        fallbackUrl: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        attributions: 'Tiles &copy; <a href="https://www.esri.com/">Esri</a>',
        maxZoom: 18,
      }),
    });

    const tonerLayer = new TileLayer({
      title: "Toner",
      visible: false,
      preload: 1,
      maxZoom: 20,
      source: makeCachedXyzSource({
        style: "toner",
        boundary: UP_BOUNDARY_LAYER,
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
      visible: false,
      preload: 1,
      maxZoom: 17,
      source: makeCachedXyzSource({
        style: "topo",
        boundary: UP_BOUNDARY_LAYER,
        fallbackUrl: "https://a.tile.opentopomap.org/{z}/{x}/{y}.png",
        attributions:
          'Map data: <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, ' +
          'SRTM | Map style: <a href="https://opentopomap.org">OpenTopoMap</a> ' +
          '(<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)',
        maxZoom: 17,
      }),
    });

    // ✅ Labels overlay - hidden by default
    const labelsLayer = new TileLayer({
      title: "Labels (Esri Reference)",
      visible: false,
      preload: 1,
      maxZoom: 18,
      source: makeCachedXyzSource({
        style: "labels",
        boundary: UP_BOUNDARY_LAYER,
        fallbackUrl: "https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
        attributions: 'Labels &copy; <a href="https://www.esri.com/">Esri</a>',
        maxZoom: 18,
      }),
    });

    baseLayerSourcesRef.current = {
      osm: osmLayer.getSource(),
      positron: positronLayer.getSource(),
      satellite: satelliteLayer.getSource(),
      toner: tonerLayer.getSource(),
      topo: topoLayer.getSource(),
      labels: labelsLayer.getSource(),
    };
    baseLayerBoundaryRef.current = UP_BOUNDARY_LAYER;

    // Basemap outage detection: a burst of tile errors on any style
    // triggers one probe of the tile proxy to classify the failure
    // (deployment network blocking the provider vs the provider's own
    // outage) and tells the user the right story. See utils/basemapHealth.js.
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
        (reason, message) => setBasemapNotice({ displayName, reason, message })
      );
    });

    // "Tinted window" mask — a permanent, instantly-applied translucent
    // "glass" fill painted over everywhere *outside* the UP boundary. Not a
    // second image/tile layer of any kind (a single static raster looks
    // fine zoomed out but turns into unreadable blown-up pixels/text the
    // moment a user zooms into a city - confirmed live, reverted). Just a
    // soft, permanent translucency so the cut-off doesn't look like a blank
    // void, while the real in-boundary map stays the fast, high-priority,
    // fully-detailed layer it always was. Costs zero network requests: pure
    // canvas drawing reusing geometry already fetched for the boundary
    // layer below.
    const maskLayer = new VectorLayer({
      title: "Focus Mask",
      source: new VectorSource(),
    });
    maskLayer.setZIndex(8);

    // 2️⃣ Initialize map *after* layers exist
    const map = new Map({
      target: "map",
      layers: [
        osmLayer,
        positronLayer,
        satelliteLayer,
        tonerLayer,
        topoLayer,
        labelsLayer,
        maskLayer,
      ],
      view: new View({
        projection: "EPSG:3857",
        center: fromLonLat([80.9462, 26.8467]),
        zoom: 8,
        minZoom: isMobileView ? 6 : 7,
        maxZoom: isMobileView ? 18 : 20,
        extent: UP_EXTENT_3857,
        // constrainOnlyCenter avoids forcing extra zoom-in just because the
        // viewport aspect ratio doesn't match the extent's — see the same
        // note in MapContainer.jsx's per-city view restriction.
        constrainOnlyCenter: true,
        // Same reasoning as MapContainer.jsx's View: avoids OpenLayers'
        // own default fill (shows as stark black) for any area with no
        // rendered tile yet.
        background: "#e5e7eb",
      }),
      controls: defaultControls({
        attribution: true,
        zoom: true,
        rotate: true,
      }),
    });

    // 3️⃣ Store references
    mapRef.current = {
      instance: map,
      layers: {
        osm: osmLayer,
        positron: positronLayer,
        satellite: satelliteLayer,
        toner: tonerLayer,
        topo: topoLayer,
        labels: labelsLayer,
      },
      highlightLayer: null,
    };

    /**
     * makeWmsSource — unified, performance-optimised TileWMS factory.
     * Applies to EVERY WMS layer on the home page:
     *  • antiAlias:false → GeoServer skips pixel interpolation
     *  • TILED:true → requests match GeoWebCache tile grid → cache hits
     *  • VERSION 1.3.0 → modern axis ordering
     *  • imageSmoothing:false set on the layer (not source)
     * Using TileWMS splits the view into 256x256 cacheable chunks, eliminating freezing.
     */
    const makeWmsSource = (url, layerName, extraParams = {}) =>
      new TileWMS({
        url,
        params: {
          LAYERS: layerName,
          FORMAT: "image/png",
          VERSION: "1.3.0",
          TRANSPARENT: true,
          TILED: true,
          FORMAT_OPTIONS: "antiAlias:false;dpi:90",
          STYLES: "",
          ...extraParams,
        },
        serverType: "geoserver",
        crossOrigin: "anonymous",
        wrapX: false,
      });

    // Keep the old name as an alias so existing call-sites still compile
    const createWMSSource = (url, layerName, extra) =>
      makeWmsSource(url, layerName, extra);

    // 4️⃣ UP District layer (visible by default) — carries both the
    // district boundary lines AND their name labels (GeoServer-styled into
    // one image). Kept above every other overlay this page can show
    // (highlight/Above10m/CM-Grid, up to zIndex 900) so district names are
    // never hidden behind a data layer, matching the same "labels always on
    // top" rule applied to Dashboard's own label layers.
    const upDistrictLayer = new TileLayer({
      title: "UP District Boundaries",
      source: createWMSSource(
        `${GEOSERVER_BASE}/Ward_38/wms`,
        "Ward_38:Up_District",
      ),
      visible: true,
      opacity: 1.0, // full opacity — GeoServer style controls the look
      imageSmoothing: false,
      zIndex: 9000,
    });

    // 5️⃣  UP City Boundary — WFS VectorLayer (unique colors per city, hover-ready)
    const upBoundarySource = new VectorSource({
      url: `${GEOSERVER_BASE}/Ward_38/ows?service=WFS&version=2.0.0&request=GetFeature&typeName=Ward_38:All_Boundaries&outputFormat=application/json`,
      format: new GeoJSON({ featureProjection: "EPSG:3857" }),
    });

    const upBoundaryLayer = new VectorLayer({
      title: "UP Nagar Nigam Boundary",
      source: upBoundarySource,
      style: (feature) => {
        const name = normalizeWfsName(feature.get("Name"));
        const color = CITY_BOUNDARY_COLORS[name] || "#2f6fd6";
        return new Style({
          fill: new Fill({ color: color + "18" }), // ~10% fill — needed for interior hit detection
          stroke: new Stroke({ color, width: 2.5 }),
        });
      },
      visible: true,
      zIndex: 7,
    });

    // ✅ Add layers to the map
    map.addLayer(upDistrictLayer);
    map.addLayer(upBoundaryLayer);

    // Dim everywhere outside the real UP boundary shape (not just its
    // bounding box) via a single tint overlay, rather than hard-clipping
    // the base layers away to nothing out there — upClipRingsRef starts
    // null and is populated shortly after by the district-boundary WFS
    // fetch below, so the map simply renders untinted until then.
    attachInvertedMask(maskLayer, map, upClipRingsRef, "rgba(120,120,120,0.28)");
    fetch(
      `${GEOSERVER_BASE}/Ward_38/ows?service=WFS&version=2.0.0&request=GetFeature` +
      `&typeName=Ward_38:Up_District&outputFormat=application/json`
    )
      .then((res) => (res.ok ? res.json() : null))
      .then((geojson) => {
        if (!geojson) return;
        const features = new GeoJSON({ featureProjection: "EPSG:3857" }).readFeatures(geojson);
        upClipRingsRef.current = extractClipRings(features);
        map.render();
      })
      .catch(() => {
        // Non-fatal — the state map just stays unclipped (bbox-restricted
        // only, from the View's own extent) if this fetch fails.
      });

    // ✅ Store references
    mapRef.current = {
      ...mapRef.current,
      upDistrictLayer,
      upBoundaryLayer,
    };

    // ✅ Desktop hover popup — reuses the same city-overlay popup as the dropdown selection
    if (!isMobileView) {
      const hoverEl = document.createElement("div");
      hoverEl.className = "city-overlay";
      hoverEl.style.cssText =
        "display:none;pointer-events:none;min-width:200px;max-width:260px;max-height:70vh;overflow-y:auto;";

      const hoverOl = new Overlay({
        element: hoverEl,
        positioning: "bottom-left",
        offset: [14, -14],
        autoPan: false,
        stopEvent: false,
      });
      map.addOverlay(hoverOl);
      mapRef.current.hoverOverlay = hoverOl;
      mapRef.current.hoverEl = hoverEl;

      // 6️⃣ Distinct Hover for Roads (Tooltip)
      const roadHoverEl = document.createElement("div");
      roadHoverEl.className = "road-hover-tooltip";
      roadHoverEl.style.cssText =
        "display:none; pointer-events:none; padding:6px 10px; background:rgba(0,0,0,0.8); color:#fff; font-size:11px; border-radius:4px; white-space:nowrap; z-index:1000;";
      const roadHoverOl = new Overlay({
        element: roadHoverEl,
        positioning: "bottom-center",
        offset: [0, -10],
        autoPan: false,
        stopEvent: false,
      });
      map.addOverlay(roadHoverOl);
      mapRef.current.roadHoverOverlay = roadHoverOl;
      mapRef.current.roadHoverEl = roadHoverEl;

      let wmsHoverTimeout = null;
      let lastHovered = null;

      // Temporary layer for highlighted road geometry
      const highlightSource = new VectorSource();
      const highlightLayer = new VectorLayer({
        title: "Highlighted Road",
        source: highlightSource,
        style: new Style({
          stroke: new Stroke({
            color: "#ffcc33",
            width: 5,
          }),
        }),
        zIndex: 900,
      });
      map.addLayer(highlightLayer);
      mapRef.current.highlightLayer = highlightLayer;

      map.on("pointermove", (evt) => {
        if (evt.dragging) return;

        // ⛔ Suppress city boundary hover popup when a city is already selected
        if (selectedCityRef.current) {
          if (mapRef.current.hoverEl)
            mapRef.current.hoverEl.style.display = "none";

          const above10mFeature = map.forEachFeatureAtPixel(
            evt.pixel,
            (feature, layer) =>
              layer === mapRef.current.above10mRef?.current ? feature : null,
            {
              hitTolerance: 6,
              layerFilter: (layer) => layer === mapRef.current.above10mRef?.current,
            },
          );
          if (above10mFeature) {
            const props = above10mFeature.getProperties?.() || {};
            const roadName = props.road_name || "Unnamed Road";
            const condition = props.condition || "Unknown Condition";
            if (mapRef.current.roadHoverEl) {
              mapRef.current.roadHoverEl.innerHTML = `<strong>${roadName}</strong><br/><span style="color:#aaa;">Condition: <span style="color:#fff">${condition}</span></span>`;
              mapRef.current.roadHoverEl.style.display = "";
              mapRef.current.roadHoverOverlay.setPosition(evt.coordinate);
            }
            mapRef.current.highlightLayer?.getSource().clear();
            const cloned = above10mFeature.clone();
            cloned.setStyle(undefined);
            mapRef.current.highlightLayer?.getSource().addFeature(cloned);
            const targetEl = map.getTargetElement?.();
            if (targetEl?.style) targetEl.style.cursor = "pointer";
            return;
          }

          // --- ADD WMS HOVER TOOLTIP FOR ROADS ---
          const candidates = getCmGridLayers().filter((layer) => layer.getVisible());

          if (candidates.length === 0) {
            if (mapRef.current.roadHoverEl)
              mapRef.current.roadHoverEl.style.display = "none";
            mapRef.current.highlightLayer?.getSource().clear();
            const targetEl = map.getTargetElement?.();
            if (targetEl?.style) targetEl.style.cursor = "";
            return;
          }

          if (wmsHoverTimeout) clearTimeout(wmsHoverTimeout);

          // Fast hover for simple tooltip
          wmsHoverTimeout = setTimeout(async () => {
            let foundFeature = false;
            for (const layer of candidates) {
              const source = layer.getSource();
              if (typeof source.getFeatureInfoUrl !== "function") continue;

              const url = source.getFeatureInfoUrl(
                evt.coordinate,
                map.getView().getResolution(),
                map.getView().getProjection(),
                { INFO_FORMAT: "application/json", FEATURE_COUNT: 1 },
              );

              if (url) {
                try {
                  const res = await fetch(url);
                  const data = await res.json();
                  if (data && data.features && data.features.length > 0) {
                    const props = data.features[0].properties;
                    const nameKey = Object.keys(props).find(
                      (k) => k.toLowerCase() === "road_name",
                    );
                    const conditionKey = Object.keys(props).find(
                      (k) => k.toLowerCase() === "condition",
                    );

                    const roadName = nameKey ? props[nameKey] : "Unnamed Road";
                    const condition = conditionKey
                      ? props[conditionKey]
                      : "Unknown Condition";

                    if (mapRef.current.roadHoverEl) {
                      mapRef.current.roadHoverEl.innerHTML = `<strong>${roadName}</strong><br/><span style="color:#aaa;">Condition: <span style="color:#fff">${condition}</span></span>`;
                      mapRef.current.roadHoverEl.style.display = "";
                      mapRef.current.roadHoverOverlay.setPosition(
                        evt.coordinate,
                      );
                    }

                    // --- ADDED: Highlight the road on hover ---
                    if (data.features[0].geometry) {
                      const geojsonFormat = new GeoJSON();
                      const olFeature = geojsonFormat.readFeature(
                        data.features[0],
                      );
                      mapRef.current.highlightLayer?.getSource().clear(); // Clear previous hover highlight
                      mapRef.current.highlightLayer
                        ?.getSource()
                        .addFeature(olFeature);
                    }

                    const targetEl = map.getTargetElement?.();
                    if (targetEl?.style) targetEl.style.cursor = "pointer";
                    foundFeature = true;
                    break;
                  }
                } catch (e) {
                  // Ignores standard fetch issues for WMS hover
                }
              }
            }

            if (!foundFeature) {
              if (mapRef.current.roadHoverEl)
                mapRef.current.roadHoverEl.style.display = "none";
              // --- ADDED: Clear highlight when not hovering a road ---
              mapRef.current.highlightLayer?.getSource().clear();
              const targetEl = map.getTargetElement?.();
              if (targetEl?.style) targetEl.style.cursor = "";
            }
          }, 150); // fast hover timeout

          return;
        }

        let cityName = null;

        map.forEachFeatureAtPixel(
          evt.pixel,
          (feature, layer) => {
            if (layer !== mapRef.current.upBoundaryLayer) return;
            cityName = normalizeWfsName(feature.get("Name"));
            return true;
          },
          { layerFilter: (l) => l === mapRef.current.upBoundaryLayer },
        );

        if (cityName) {
          if (cityName !== lastHovered) {
            const summary = homeSummaryRef.current;
            const buildHtml = buildOverlayHtmlRef.current;
            if (summary && buildHtml) {
              const data = summary.perCity?.[cityName];
              if (data) {
                hoverEl.innerHTML = buildHtml(cityName, data, false, true); // Pass true for isHover to keep it compact
                hoverEl.style.display = "";
                lastHovered = cityName;
              }
            }
          }

          // Quadrant-aware positioning — flip popup so it never goes off-screen
          if (hoverEl.style.display !== "none") {
            const [mapW, mapH] = map.getSize();
            const [px, py] = evt.pixel;
            const nearRight = px > mapW * 0.55;
            const nearTop = py < mapH * 0.45;

            // positioning = which corner of the popup element anchors to the coordinate
            const positioning = `${nearTop ? "top" : "bottom"}-${nearRight ? "right" : "left"}`;
            const offsetX = nearRight ? -16 : 16;
            const offsetY = nearTop ? 16 : -16;

            hoverOl.setPositioning(positioning);
            hoverOl.setOffset([offsetX, offsetY]);
            hoverOl.setPosition(evt.coordinate);
          }
        } else {
          hoverEl.style.display = "none";
          hoverOl.setPosition(undefined);
          lastHovered = null;
        }

        const targetEl = map.getTargetElement?.();
        if (targetEl?.style) targetEl.style.cursor = cityName ? "pointer" : "";
      });
    }

    // ✅ Click on city boundary → same as selecting from dropdown (desktop + mobile)
    map.on("singleclick", async (evt) => {
      let clickedCity = null;

      if (!selectedCityRef.current) {
        map.forEachFeatureAtPixel(
          evt.pixel,
          (feature, layer) => {
            if (layer !== mapRef.current.upBoundaryLayer) return;
            clickedCity = normalizeWfsName(feature.get("Name"));
            return true;
          },
          { layerFilter: (l) => l === mapRef.current.upBoundaryLayer },
        );

        if (clickedCity && mapRef.current.handleCitySelectFn) {
          // Hide hover popups immediately
          if (mapRef.current.hoverEl)
            mapRef.current.hoverEl.style.display = "none";
          if (mapRef.current.roadHoverEl)
            mapRef.current.roadHoverEl.style.display = "none";
          mapRef.current.hoverOverlay?.setPosition(undefined);
          mapRef.current.roadHoverOverlay?.setPosition(undefined);

          mapRef.current.handleCitySelectFn(clickedCity);
        }
        return;
      }

      // If a city is selected, handle road clicking
      const clickedAbove10mFeature = map.forEachFeatureAtPixel(
        evt.pixel,
        (feature, layer) =>
          layer === mapRef.current.above10mRef?.current ? feature : null,
        {
          hitTolerance: 8,
          layerFilter: (layer) => layer === mapRef.current.above10mRef?.current,
        },
      );
      if (clickedAbove10mFeature) {
        if (mapRef.current.roadHoverEl)
          mapRef.current.roadHoverEl.style.display = "none";
        mapRef.current.highlightLayer?.getSource().clear();
        mapRef.current.highlightLayer?.getSource().addFeature(clickedAbove10mFeature.clone());

        const geom = clickedAbove10mFeature.getGeometry?.();
        if (geom) {
          const padding =
            window.innerWidth < 768 ? [40, 40, 200, 40] : [80, 80, 80, 380];
          map.getView().fit(geom.getExtent(), { padding, duration: 650, maxZoom: 18 });
        }

        const props = clickedAbove10mFeature.getProperties?.() || {};
        const [lng, lat] = toLonLat(evt.coordinate);
        const streetViewUrl = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}`;
        const escapeHtml = (value) =>
          String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
        const formatLabel = (label) =>
          label.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        const renderRoadRow = (key) => {
          const value = props[key];
          if (value === null || value === undefined || value === "") return "";
          const display =
            typeof value === "number" && key.includes("length")
              ? `${value.toFixed(3)} km`
              : value;
          return `<div style="display:grid; grid-template-columns: 92px minmax(0,1fr); gap:10px; margin-bottom:6px; align-items:start;">
            <span style="color:#64748b; font-size:11px; font-weight:600;">${formatLabel(key)}</span>
            <span style="color:#0f172a; font-size:12px; font-weight:700; word-break:break-word;">${escapeHtml(display)}</span>
          </div>`;
        };
        const title = props.road_name || "Road";
        const html = `<div style="min-width:260px; max-width:340px; padding:14px; background:#fff; border-radius:10px; box-shadow:0 10px 30px rgba(15,23,42,0.25); pointer-events:auto; position:relative;">
          <button onclick="document.dispatchEvent(new CustomEvent('closeRoadPopup'))" style="position:absolute; right:8px; top:8px; background:#e2e8f0; border:none; border-radius:50%; width:26px; height:26px; display:flex; align-items:center; justify-content:center; cursor:pointer; color:#475569; font-size:14px;">
            <i class="fas fa-times"></i>
          </button>
          <h4 style="margin:0 28px 10px 0; border-bottom:2px solid #2563eb; padding-bottom:8px; color:#1e3a8a; font-size:15px;">
            <i class="fas fa-road" style="margin-right:6px;"></i>${escapeHtml(title)}
          </h4>
          <div style="display:flex; flex-direction:column; gap:0; max-height:260px; overflow-y:auto; padding-right:2px;">
            ${[
              "road_id",
              "zone_name",
              "ward_name",
              "ownership",
              "condition",
              "category",
              "material",
              "row_meter",
              "carriage_w",
              "length_km",
              "yoc",
            ].map(renderRoadRow).join("")}
          </div>
          <a href="${streetViewUrl}" target="_blank" rel="noopener noreferrer" style="display:block; margin-top:10px; padding:7px 10px; background:#0f172a; color:#fff; border-radius:5px; text-decoration:none; font-size:12px; text-align:center; font-weight:700;">
            Open Street View
          </a>
        </div>`;

        if (mapRef.current.hoverEl) {
          mapRef.current.hoverEl.innerHTML = html;
          mapRef.current.hoverEl.style.display = "";
          // OL's Overlay has no setOptions()/setAutoPan() - autoPan can only
          // be set at construction (this overlay was built with
          // autoPan:false). A call to the non-existent setOptions() here
          // used to throw synchronously, crashing this whole click handler
          // before it ever reached setPosition below - so this popup never
          // actually displayed on any road click, on any city.
          mapRef.current.hoverOverlay.setPosition(geom ? getCenter(geom.getExtent()) : evt.coordinate);
          mapRef.current.hoverOverlay.setPositioning("bottom-center");
          mapRef.current.hoverOverlay.setOffset([0, -15]);
        }
        return;
      }

      const candidates = [];
      if (
        mapRef.current.above10mRef?.current &&
        mapRef.current.above10mRef.current.getVisible()
      ) {
        candidates.push({
          layer: mapRef.current.above10mRef.current,
          isPhase2: false,
        });
      }
      getCmGridLayers().filter((layer) => layer.getVisible()).forEach((layer) => {
        const sourceUrl = layer.getSource().getUrls?.()?.[0] || layer.getSource().getUrl?.() || "";
        candidates.push({
          layer,
          isPhase2: PHASE2_GEOSERVER_BASE !== GEOSERVER_BASE && sourceUrl.includes(PHASE2_GEOSERVER_BASE),
        });
      });

      if (candidates.length === 0) return;

      // Hide road hover tooltip since we are displaying the huge click popup
      if (mapRef.current.roadHoverEl)
        mapRef.current.roadHoverEl.style.display = "none";

      // Clear previous highlights
      mapRef.current.highlightLayer?.getSource().clear();
      // Reset opacity
      candidates.forEach((c) => c.layer.setOpacity(1));

      for (const { layer, isPhase2 } of candidates) {
        const source = layer.getSource();
        if (typeof source.getFeatureInfoUrl !== "function") continue;

        // Construct WFS GetFeature request using the WMS LAYERS parameter to identify the workspace:layer
        const params = source.getParams();
        const layerName = params.LAYERS;
        if (!layerName) continue;

        // ✅ LIVE DATA: Use our backend API (all_db) instead of GeoServer WFS
        // This means road data is always up-to-date with the latest survey data.
        const lonLatClick = toLonLat(evt.coordinate); // Convert EPSG:3857 → [lon, lat]
        const clickApiUrl = `/api/${selectedCityRef.current}/roads/click?lon=${lonLatClick[0]}&lat=${lonLatClick[1]}&buffer=0.0003`;

        try {
          // Show loading state in popup
          if (mapRef.current.hoverEl) {
            mapRef.current.hoverEl.innerHTML = `<div class="${styles["road-popup"] || ""}" style="padding:16px; font-size:13px; background:#fff; border-radius:8px; box-shadow:0 8px 24px rgba(0,0,0,0.15); font-weight: 500; color: #334155;">
            <i class="fas fa-spinner fa-spin" style="margin-right:8px; color:#2f6fd6;"></i> Loading road details...
          </div>`;
            mapRef.current.hoverEl.style.display = "";
            // See the other call site above - OL's Overlay has no
            // setOptions()/setAutoPan(); this used to throw and crash the
            // handler before the loading state ever displayed.
            mapRef.current.hoverOverlay.setPosition(evt.coordinate);
            mapRef.current.hoverOverlay.setPositioning("bottom-center");
            mapRef.current.hoverOverlay.setOffset([0, -15]);
          }

          const res = await fetch(clickApiUrl);
          const data = await res.json();

          if (data && data.features && data.features.length > 0) {
            const featureData = data.features[0];
            const props = featureData.properties;

            // Read GeoJSON feature — geometry is in EPSG:4326, transform to map's EPSG:3857
            const geojsonFormat = new GeoJSON();
            const olFeature = geojsonFormat.readFeature(featureData, {
              dataProjection: "EPSG:4326",
              featureProjection: "EPSG:3857",
            });

            // 1. Highlight the road geometry
            mapRef.current.highlightLayer?.getSource().clear();
            mapRef.current.highlightLayer?.getSource().addFeature(olFeature);

            // 2. Dim active WMS layers
            candidates.forEach((c) => c.layer.setOpacity(0.4));

            // 3. Pan and zoom to the road extent
            const geom = olFeature.getGeometry();
            if (geom) {
              const padding =
                window.innerWidth < 768 ? [40, 40, 200, 40] : [80, 80, 80, 380];
              map
                .getView()
                .fit(geom.getExtent(), { padding, duration: 800, maxZoom: 18 });
            }

            // 4. Fetch OSM name in parallel (fire-and-forget, then update popup)
            let osmRoadName = "Checking OpenStreetMap...";
            fetch(
              `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lonLatClick[1]}&lon=${lonLatClick[0]}&zoom=18&addressdetails=1`,
              {
                headers: { "User-Agent": "URIDA_GIS/1.0" },
              },
            )
              .then((r) => r.json())
              .then((osmData) => {
                if (osmData?.address) {
                  osmRoadName =
                    osmData.address.road ||
                    osmData.address.pedestrian ||
                    osmData.address.path ||
                    "Name Not in OSM";
                } else {
                  osmRoadName = "Name Not in OSM";
                }
              })
              .catch(() => {
                osmRoadName = "OSM Unavailable";
              });

            // 5. DB road name from our own table
            const dbRoadName = props.road_name || "Unnamed in DB";

            // 6. Build popup HTML
            const renderRow = (label, val) => {
              if (val === null || val === "" || val === undefined) return "";
              const cleanLabel = label
                .replace(/_/g, " ")
                .replace(/\b\w/g, (c) => c.toUpperCase());
              let display = val;
              if (typeof val === "number" && label.includes("length"))
                display = val.toFixed(3) + " km";
              return `<div style="margin-bottom:7px; display:flex; justify-content:space-between; align-items:flex-start; gap:16px;">
              <span style="color:#64748b; font-size:11px; flex-shrink:0; padding-top:2px;">${cleanLabel}</span>
              <span style="color:#0f172a; text-align:right; font-weight:600; word-break:break-word; white-space:pre-wrap; font-size:12px;">${display}</span>
            </div>`;
            };

            const priorityKeys = [
              "road_code",
              "road_id",
              "zone_name",
              "ward_name",
              "ownership",
              "length_km",
              "condition",
              "row_meter",
              "material",
              "type",
            ];
            const skipKeys = ["fid", "road_name"];

            let html = `<div style="padding:16px; font-size:12px; background:#fff; border-radius:10px; box-shadow:0 10px 30px rgba(0,0,0,0.25); max-width:340px; pointer-events:auto; position:relative;">
            <button onclick="document.dispatchEvent(new CustomEvent('closeRoadPopup'))" style="position:absolute; right:8px; top:8px; background:#e2e8f0; border:none; border-radius:50%; width:26px; height:26px; display:flex; align-items:center; justify-content:center; cursor:pointer; color:#475569; font-size:14px;">
              <i class="fas fa-times"></i>
            </button>
            <div style="margin-bottom:12px; padding-bottom:10px; border-bottom:2px solid #e2e8f0; padding-right:20px;">
              <strong style="color:#1e3a8a; font-size:15px; display:block; margin-bottom:4px; word-break:break-word;">
                <i class="fas fa-road" style="margin-right:6px;"></i>${dbRoadName}
              </strong>
              <div style="font-size:11px; color:#64748b; margin-bottom:8px;">
                <span style="background:#f1f5f9; padding:3px 6px; border-radius:4px; font-weight:600;">📊 DB Record (All_DB · Live)</span>
              </div>
              <strong id="road-popup-osm-name" style="color:#059669; font-size:13px; display:block; margin-bottom:4px; word-break:break-word;">
                <i class="fas fa-map-marker-alt" style="margin-right:6px;"></i>${osmRoadName}
              </strong>
              <div style="font-size:11px; color:#64748b;">
                <span style="background:#ecfdf5; padding:3px 6px; border-radius:4px; font-weight:600; color:#065f46;">🗺 OSM / Google</span>
              </div>
            </div>`;

            priorityKeys.forEach((pk) => {
              if (
                props[pk] !== undefined &&
                props[pk] !== null &&
                props[pk] !== ""
              )
                html += renderRow(pk, props[pk]);
            });
            html += `<div style="height:1px; background:#f1f5f9; margin:8px 0;"></div>`;
            for (const [k, v] of Object.entries(props)) {
              if (skipKeys.includes(k) || priorityKeys.includes(k)) continue;
              html += renderRow(k, v);
            }
            html += `</div>`;

            if (mapRef.current.hoverEl) {
              mapRef.current.hoverEl.innerHTML = html;
              const centerCoord = geom
                ? getCenter(geom.getExtent())
                : evt.coordinate;
              mapRef.current.hoverOverlay.setPosition(centerCoord);

              // Update OSM name in popup after it resolves
              setTimeout(() => {
                const osmEl = document.getElementById("road-popup-osm-name");
                if (osmEl)
                  osmEl.innerHTML = `<i class="fas fa-map-marker-alt" style="margin-right:6px;"></i>${osmRoadName || "Checking..."}`;
              }, 3000);
            }

            return; // Stop after first match
          }
        } catch (e) {
          console.error("Error fetching road from DB API:", e);
        }
      }

      // If clicked empty space, clear everything
      mapRef.current.highlightLayer?.getSource().clear();
      candidates.forEach((c) => c.layer.setOpacity(1));
      if (mapRef.current.hoverEl) mapRef.current.hoverEl.style.display = "none";
      mapRef.current.hoverOverlay?.setPosition(undefined);
    });

    // ✅ Fit UP extent after map initializes - skipped for a city-scoped
    // login, which locks onto its own city moments later anyway; letting
    // this run first only causes a pointless state-wide flash and can even
    // race the city fit that follows (this animation finishing last would
    // silently override the correct, restricted city view).
    if (!isCityScopedUser) {
      map.once("postrender", function () {
        const upExtent = [77.0, 23.5, 84.5, 31.0]; // [minX, minY, maxX, maxY]
        const minCoord = fromLonLat([upExtent[0], upExtent[1]]);
        const maxCoord = fromLonLat([upExtent[2], upExtent[3]]);
        map.getView().fit([minCoord[0], minCoord[1], maxCoord[0], maxCoord[1]], {
          padding: mapPadding,
          duration: 1000,
          maxZoom: upMaxZoom,
        });
      });
    }

    // ✅ Force refresh of WMS layers once map is ready
    map.once("rendercomplete", () => {
      const { upDistrictLayer, upBoundaryLayer } = mapRef.current;
      [upDistrictLayer, upBoundaryLayer].forEach((layer) => {
        if (layer && layer.getSource && layer.getSource().updateParams) {
          layer.getSource().updateParams({ time: new Date().getTime() });
        }
      });
    });

    // ✅ Force OSM basemap active by default
    handleBaseMapChange("osm");

    // Cards will populate once homeSummary resolves (API or cache)
    // Do NOT set stale static cards here — wait for the real data

    // ✅ Back button (browser) handling – return to HomePage, not Login
    const handlePopState = (event) => {
      // A city-scoped login can't reach the state view even via the
      // browser's own back button.
      if (isCityScopedUser) {
        event.preventDefault();
        window.history.pushState(null, "", "/home");
        return;
      }
      setSelectedCity("");
      setLayerVisibility((prev) => ({ ...prev, upDistrict: true }));
      mapRef.current?.upDistrictLayer?.setVisible(true);
      localStorage.removeItem("selectedCity");
      setCards(cityCardData.default);

      const mapInstance =
        mapRef.current?.instance || mapRef.current?.map || mapRef.current;
      if (mapInstance) {
        // Remove city overlays
        removeLayer(boundaryRef);
        removeLayer(above10mRef);
        removeLayer(cmGridRef);

        // Fit back to UP extent
        const upExtent = [77.0, 23.5, 84.5, 31.0];
        const minCoord = fromLonLat([upExtent[0], upExtent[1]]);
        const maxCoord = fromLonLat([upExtent[2], upExtent[3]]);
        mapInstance
          .getView()
          .fit([minCoord[0], minCoord[1], maxCoord[0], maxCoord[1]], {
            padding: [50, 50, 50, 50],
            duration: 800,
            maxZoom: 8,
          });
      }

      // prevent going to login route
      event.preventDefault();
      window.history.pushState(null, "", "/home");
    };

    window.addEventListener("popstate", handlePopState);

    // ✅ Custom event listener for closing the road popup from inside the HTML string
    const handleCloseRoadPopup = () => {
      // 1. Clear highlight layer
      if (mapRef.current.highlightLayer) {
        mapRef.current.highlightLayer.getSource().clear();
      }
      // 2. Clear hover display
      if (mapRef.current.hoverEl) {
        mapRef.current.hoverEl.style.display = "none";
      }
      if (mapRef.current.hoverOverlay) {
        mapRef.current.hoverOverlay.setPosition(undefined);
      }
      // 3. Reset opacity on WMS layers
      if (mapRef.current.above10mRef?.current)
        mapRef.current.above10mRef.current.setOpacity(1);
      getCmGridLayers().forEach((layer) => layer.setOpacity(1));

      // 4. Zoom map back to fit the current city bounds
      if (selectedCityRef.current && mapRef.current.fitViewToCityBoundaryFn) {
        mapRef.current.fitViewToCityBoundaryFn(selectedCityRef.current);
      }
    };
    document.addEventListener("closeRoadPopup", handleCloseRoadPopup);

    // ✅ Cleanup
    return () => {
      window.removeEventListener("popstate", handlePopState);
      document.removeEventListener("closeRoadPopup", handleCloseRoadPopup);
      map.setTarget(undefined);
    };
  }, []);

  // Basemap tiles are masked server-side to a boundary shape (see
  // getMaskedTile in tiles.js) so every browser doesn't redraw the same
  // clip on every frame — but every base layer here was hardcoded to
  // UP_BOUNDARY_LAYER (the whole state) *always*, even once a user has
  // zoomed into a single city. That meant the tile+boundary combination at
  // city-level zoom (11+) was never covered by the cache warmer, which only
  // pre-warms the whole-state boundary up to zoom 10 (deeper would be
  // combinatorially unaffordable) — so every tile at exactly the zoom level
  // most users actually look at was a guaranteed cold miss, on top of
  // masking against a far more complex polygon (all districts vs. one
  // city). Once a city is selected, switch every base layer's mask to that
  // city's own zone/ward boundary — the *same* boundary value the cache
  // warmer already pre-warms at zoom 11-16 for the Dashboard, so this
  // reuses an already-warm cache instead of needing any new warming work.
  useEffect(() => {
    updateBaseLayerBoundary(selectedCity);
  }, [selectedCity, updateBaseLayerBoundary]);

  // removed debug panel and instrumentation code

  // Focus on the GeoServer layer when the component mounts - skipped for a
  // city-scoped login, which locks onto its own city moments later anyway;
  // this reset otherwise races that city fit (both fire ~1000ms after
  // mount) and can silently win, leaving the view at the wide state extent.
  useEffect(() => {
    if (!mapRef.current || isCityScopedUser) return;

    const initializeMapView = () => {
      const map =
        mapRef.current?.instance || mapRef.current?.map || mapRef.current;
      if (!map) return;

      // Ensure base layers are visible
      const baseLayers = map
        .getLayers()
        .getArray()
        .filter((layer) => layer.get("type") === "base");
      baseLayers.forEach((layer) => {
        if (layer.get("title") === "OpenStreetMap") {
          layer.setVisible(true);
        } else {
          layer.setVisible(false);
        }
      });

      const upBoundaryLayer = mapRef.current.upBoundaryLayer;
      if (upBoundaryLayer) {
        upBoundaryLayer.setVisible(layerVisibility.upBoundary);
        const source = upBoundaryLayer.getSource();
        if (source && source.updateParams) {
          source.updateParams({
            time: new Date().getTime(),
          });
        }
      }

      // Set initial view to show UP state
      const upExtent = [77.0, 23.5, 84.5, 31.0]; // [minX, minY, maxX, maxY]
      const minCoord = fromLonLat([upExtent[0], upExtent[1]]);
      const maxCoord = fromLonLat([upExtent[2], upExtent[3]]);

      map.getView().fit([minCoord[0], minCoord[1], maxCoord[0], maxCoord[1]], {
        padding: mapPadding,
        duration: 1000,
        maxZoom: upMaxZoom,
      });

      // Force a render update
      map.updateSize();
      map.renderSync();
    };

    // Initial setup with a small delay
    const timer = setTimeout(initializeMapView, 1000);

    // Also try to initialize when the map is ready
    const map =
      mapRef.current?.instance || mapRef.current?.map || mapRef.current;
    if (map) {
      map.once("postrender", initializeMapView);
    }

    return () => {
      clearTimeout(timer);
      if (map) {
        map.un("postrender", initializeMapView);
      }
    };
  }, []); // Run once on component mount

  useEffect(() => {
    const handleClickOutside = (event) => {
      const menu = profileMenuRef.current;
      const btn = profileBtnRef.current;
      if (!menu || !btn) return;
      if (menu.contains(event.target) || btn.contains(event.target)) return;
      setProfileMenuOpen(false);
    };
    window.addEventListener("mousedown", handleClickOutside);
    return () => window.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    let isMounted = true;
    const loadSummary = async () => {
      try {
        const cached =
          localStorage.getItem(HOME_SUMMARY_CACHE_KEY) ||
          sessionStorage.getItem(HOME_SUMMARY_CACHE_KEY);

        // Stale-while-revalidate: show cached data instantly, then fetch silently for updates
        if (cached) {
          const parsed = JSON.parse(cached);
          if (
            parsed?.ts &&
            Date.now() - parsed.ts < HOME_SUMMARY_CACHE_TTL_MS &&
            parsed?.data
          ) {
            if (isMounted) {
              setHomeSummary(parsed.data);
              homeSummaryRef.current = parsed.data;
              setSummaryLoading(false);
            }
          }
        }

        // Always revalidate in background so numbers stay fresh
        const res = await fetch("/api/home/summary");
        if (!res.ok) throw new Error("Failed to load home summary");
        const data = await res.json();
        const payload = JSON.stringify({ ts: Date.now(), data });
        localStorage.setItem(HOME_SUMMARY_CACHE_KEY, payload);
        sessionStorage.setItem(HOME_SUMMARY_CACHE_KEY, payload);
        if (isMounted) {
          setHomeSummary(data);
          homeSummaryRef.current = data;
        }
      } catch (err) {
        if (isMounted) setHomeSummary(null);
      } finally {
        if (isMounted) setSummaryLoading(false);
      }
    };
    loadSummary();
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!homeSummary) return;
    const cityKey = selectedCity || null;
    console.log("Selected:", selectedCity);
    const source = cityKey
      ? homeSummary.perCity?.[cityKey]
      : homeSummary.upTotals;
    if (!source) return;

    // Helper: format number with locale separators
    const n = (v) => Number(v ?? 0).toLocaleString();
    const km = (v) =>
      Number(v ?? 0).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });

    const nextCards = [
      {
        title: "Total Roads",
        content: n(source.total_roads ?? source.totalRoads),
        subtitle: "All registered roads",
        icon: "fas fa-road",
        color: "#FFFBEB", // amber-50 pastel bg
        textColor: "#78350F", // amber-900 dark text
        iconBg: "#F59E0B", // amber-400
        iconColor: "#fff",
        accentColor: "#F59E0B",
      },
      {
        title: "Nagar Nigam Roads",
        content: n(
          source.ownership_municipal_count ?? source.ownershipMunicipalCount,
        ),
        subtitle: "Municipal corporation",
        icon: "fas fa-city",
        color: "#FDF4FF", // purple-50 pastel
        textColor: "#6B21A8", // purple-800
        iconBg: "#A855F7", // purple-400
        iconColor: "#fff",
        accentColor: "#A855F7",
      },
      {
        title: "Total Length",
        content: `${km(source.total_length_km ?? source.totalLengthKm)} km`,
        subtitle: "Combined road network",
        icon: "fas fa-ruler-horizontal",
        color: "#FFF7ED", // orange-50 pastel
        textColor: "#9A3412", // orange-800
        iconBg: "#F97316", // orange-400
        iconColor: "#fff",
        accentColor: "#F97316",
      },
      {
        title: "Nagar Nigam Length",
        content: `${km(source.ownership_municipal_length_km ?? source.ownershipMunicipalLengthKm)} km`,
        subtitle: "Municipal network length",
        icon: "fas fa-route",
        color: "#FFF1F2", // rose-50 pastel
        textColor: "#9F1239", // rose-800
        iconBg: "#F43F5E", // rose-400
        iconColor: "#fff",
        accentColor: "#F43F5E",
      },
      {
        title: "Above 10m Roads",
        content: n(source.above10m_count ?? source.above10mCount),
        subtitle: "Wide roads (ROW > 10m)",
        icon: "fas fa-align-justify",
        color: "#ECFDF5", // emerald-50 pastel
        textColor: "#065F46", // emerald-900
        iconBg: "#10B981", // emerald-400
        iconColor: "#fff",
        accentColor: "#10B981",
      },
      {
        title: "Above 10m Length",
        content: `${km(source.above10m_length_km ?? source.above10mLengthKm)} km`,
        subtitle: "Wide road total length",
        icon: "fas fa-arrows-alt-h",
        color: "#F0FDFA", // teal-50 pastel
        textColor: "#134E4A", // teal-900
        iconBg: "#14B8A6", // teal-400
        iconColor: "#fff",
        accentColor: "#14B8A6",
      },
    ];
    setCards(nextCards);
  }, [homeSummary, selectedCity]);

  const formatNumber = useCallback(
    (value, digits = 0) =>
      Number(value || 0).toLocaleString(undefined, {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }),
    [],
  );

  const formatCityLabel = useCallback(
    (cityKey) =>
      cityKey ? cityKey.charAt(0).toUpperCase() + cityKey.slice(1) : "",
    [],
  );

  const buildOverlayHtml = useCallback(
    (cityKey, data, includeClose = false, isHover = false) => {
      const total = Number(data.total_roads || 0);
      const lengthKm = Number(data.total_length_km || 0);
      const good = Number(data.good_count || 0);
      const moderate = Number(data.moderate_count || 0);
      const poor = Number(data.poor_count || 0);
      const known = good + moderate + poor;
      const poorPct = known ? Math.round((poor / known) * 100) : 0;
      const abovePct = total
        ? Math.round((Number(data.above10m_count || 0) / total) * 100)
        : 0;
      const municipal = Number(data.ownership_municipal_count || 0);
      const municipalLengthKm = Number(data.ownership_municipal_length_km || 0);
      const pwd = Number(data.ownership_pwd_count || 0);
      const ownershipKnown = municipal + pwd;
      const muniPct = ownershipKnown
        ? Math.round((municipal / ownershipKnown) * 100)
        : 0;
      const pwdPct = ownershipKnown
        ? Math.round((pwd / ownershipKnown) * 100)
        : 0;
      const municipalGood = Number(data.municipal_good_count || 0);
      const municipalModerate = Number(data.municipal_moderate_count || 0);
      const municipalPoor = Number(data.municipal_poor_count || 0);
      const municipalKnown = municipalGood + municipalModerate + municipalPoor;
      const municipalGoodPct = municipalKnown
        ? Math.round((municipalGood / municipalKnown) * 100)
        : 0;
      const municipalModeratePct = municipalKnown
        ? Math.round((municipalModerate / municipalKnown) * 100)
        : 0;
      const municipalPoorPct = municipalKnown
        ? Math.max(0, 100 - municipalGoodPct - municipalModeratePct)
        : 0;
      const municipalPie = municipalKnown
        ? `conic-gradient(#2ecc71 0 ${municipalGoodPct}%, #f1c40f ${municipalGoodPct}% ${municipalGoodPct + municipalModeratePct}%, #e74c3c ${municipalGoodPct + municipalModeratePct}% 100%)`
        : "conic-gradient(#dcdcdc 0 100%)";
      const bitumen = Number(data.material_bitumen_count || 0);
      const cc = Number(data.material_cc_count || 0);
      const interlocking = Number(data.material_interlocking_count || 0);
      const kachcha = Number(data.material_kachcha_count || 0);
      const materialKnown = bitumen + cc + interlocking + kachcha;
      const bitumenPct = materialKnown
        ? Math.round((bitumen / materialKnown) * 100)
        : 0;
      const ccPct = materialKnown ? Math.round((cc / materialKnown) * 100) : 0;
      const interlockingPct = materialKnown
        ? Math.round((interlocking / materialKnown) * 100)
        : 0;
      const kachchaPct = materialKnown
        ? Math.round((kachcha / materialKnown) * 100)
        : 0;
      const coveragePct = total ? Math.round((known / total) * 100) : 0;
      const amenities = data.amenities || {};
      const amenityHtml = Object.keys(AMENITY_LABELS)
        .map(
          (key) =>
            `<div class="amenity-row"><span>${AMENITY_LABELS[key]}</span><span>${formatNumber(amenities[key] || 0)}</span></div>`,
        )
        .join("");
      const closeHtml = includeClose
        ? `<button class="city-overlay-close" type="button">Close</button>`
        : "";
      const summaryHtml = `
      ${closeHtml}
      <div class="city-overlay-title">${formatCityLabel(cityKey)}</div>
      <div class="city-overlay-metric">Roads: ${formatNumber(total)}</div>
      <div class="city-overlay-metric">Length: ${formatNumber(lengthKm, 2)} km</div>
      <div class="city-overlay-metric">Nagar Nigam: ${formatNumber(municipal)}</div>
      <div class="city-overlay-metric">Nagar Nigam Length: ${formatNumber(municipalLengthKm, 2)} km</div>
    `;
      const detailHtml = `
      <div class="city-overlay-bar">
        <div class="bar-label">Poor</div>
        <div class="bar-track"><div class="bar-fill bar-poor" style="width:${poorPct}%"></div></div>
        <div class="bar-value">${poorPct}%</div>
      </div>
      <div class="city-overlay-bar">
        <div class="bar-label">Above 10m</div>
        <div class="bar-track"><div class="bar-fill bar-10m" style="width:${abovePct}%"></div></div>
        <div class="bar-value">${abovePct}%</div>
      </div>
      <div class="city-overlay-section">
        <div class="city-overlay-subtitle">Ownership</div>
        <div class="city-overlay-bar">
          <div class="bar-label">Nagar Nigam</div>
          <div class="bar-track"><div class="bar-fill bar-muni" style="width:${muniPct}%"></div></div>
          <div class="bar-value">${muniPct}%</div>
        </div>
        <div class="city-overlay-bar">
          <div class="bar-label">PWD</div>
          <div class="bar-track"><div class="bar-fill bar-pwd" style="width:${pwdPct}%"></div></div>
          <div class="bar-value">${pwdPct}%</div>
        </div>
      </div>
      <div class="city-overlay-section">
        <div class="city-overlay-subtitle">Nagar Nigam Condition</div>
        <div class="city-overlay-pie" style="background:${municipalPie}">
          <div class="city-overlay-pie-hole"></div>
        </div>
        <div class="city-overlay-legend">
          <span class="legend-item"><span class="legend-dot legend-good"></span>Good ${municipalGoodPct}%</span>
          <span class="legend-item"><span class="legend-dot legend-moderate"></span>Moderate ${municipalModeratePct}%</span>
          <span class="legend-item"><span class="legend-dot legend-poor"></span>Poor ${municipalPoorPct}%</span>
        </div>
      </div>
      <div class="city-overlay-section">
        <div class="city-overlay-subtitle">Material</div>
        <div class="city-overlay-bar">
          <div class="bar-label">Interlocking</div>
          <div class="bar-track"><div class="bar-fill bar-interlocking" style="width:${interlockingPct}%"></div></div>
          <div class="bar-value">${interlockingPct}%</div>
        </div>
        <div class="city-overlay-bar">
          <div class="bar-label">Bitumen</div>
          <div class="bar-track"><div class="bar-fill bar-bitumen" style="width:${bitumenPct}%"></div></div>
          <div class="bar-value">${bitumenPct}%</div>
        </div>
        <div class="city-overlay-bar">
          <div class="bar-label">CC</div>
          <div class="bar-track"><div class="bar-fill bar-cc" style="width:${ccPct}%"></div></div>
          <div class="bar-value">${ccPct}%</div>
        </div>
        <div class="city-overlay-bar">
          <div class="bar-label">Kachcha</div>
          <div class="bar-track"><div class="bar-fill bar-kachcha" style="width:${kachchaPct}%"></div></div>
          <div class="bar-value">${kachchaPct}%</div>
        </div>
      </div>
      <div class="city-overlay-section">
        <div class="city-overlay-subtitle">Amenities</div>
        <div class="city-overlay-amenities">${amenityHtml}</div>
      </div>
      <div class="city-overlay-coverage">Condition coverage: ${coveragePct}%</div>
    `;
      return isHover ? summaryHtml : `${summaryHtml}${detailHtml}`;
    },
    [formatNumber, formatCityLabel],
  );

  // Keep build HTML in sync
  useEffect(() => {
    buildOverlayHtmlRef.current = buildOverlayHtml;
  }, [buildOverlayHtml]);
  // Keep handleCitySelect and fit bounds in sync for WFS and click events
  useEffect(() => {
    if (mapRef.current) {
      mapRef.current.handleCitySelectFn = handleCitySelect;
      mapRef.current.fitViewToCityBoundaryFn = fitViewToCityBoundary;
      mapRef.current.above10mRef = above10mRef;
      mapRef.current.cmGridRef = cmGridRef;
    }
  });

  // Keep selectedCityRef in sync so hover handler never shows popup when a city is already active
  useEffect(() => {
    selectedCityRef.current = selectedCity;
  });

  // City-scoped login: lock onto the user's own city once, as soon as the
  // UP boundary WFS data (used to fit/restrict the view to the exact city
  // extent) is actually loaded - not on a blind delay, since calling the
  // lock before that data arrives silently falls back to a rough
  // center+zoom guess that skips the pan/zoom restriction entirely. A
  // dedicated effect (rather than an OL event listener registered inside
  // the map-init effect) is used deliberately - under React.StrictMode's
  // dev-only double-invoke, a listener registered by the throwaway first
  // mount can end up firing after that mount's own cleanup. Guard state is
  // kept in a variable local to this effect invocation (not a ref, which
  // would persist across the phantom/real double-invoke and could get
  // permanently stuck "done" by a phantom run that never truly completed) -
  // the `cancelled` flag set in cleanup is what makes the phantom mount's
  // in-flight listeners inert, and each invocation gets a fresh `locked`.
  useEffect(() => {
    if (!isCityScopedUser) return;
    let cancelled = false;
    let locked = false;
    let fallbackTimer = null;
    const source = mapRef.current?.upBoundaryLayer?.getSource?.();

    const tryLock = () => {
      if (cancelled || locked) return;
      const map = mapRef.current?.instance || mapRef.current?.map || mapRef.current;
      if (!map) {
        requestAnimationFrame(tryLock);
        return;
      }
      // WFS data alone isn't enough - handleCitySelect ends in
      // map.renderSync(), which throws if OL's internal frame state isn't
      // populated yet (map.getSize() being truthy doesn't guarantee this).
      // Forcing a render and waiting for the "postrender" it produces is
      // the one reliable signal that renderSync() is now safe to call. Set
      // the guard eagerly (not inside the callback) so a second trigger
      // (e.g. the fallback timer firing close behind featuresloadend)
      // can't register a second listener and double-fire the lock.
      locked = true;
      map.once("postrender", () => {
        if (cancelled) return;
        mapRef.current?.handleCitySelectFn?.(loggedInCity);
      });
      map.render();
    };

    // getState() can trivially report "ready" before the source's WFS load
    // has even been triggered (its default strategy only starts loading
    // once something actually asks it to render) - that's a false positive
    // if taken alone, so also require real feature data to already exist.
    if (source && source.getState() === "ready" && source.getFeatures().length > 0) {
      tryLock();
      return () => {
        cancelled = true;
      };
    }

    if (source) {
      source.once("featuresloadend", tryLock);
      // Safety net in case the load errors or the event is missed for any
      // reason - don't leave the user stuck on the unrestricted state view.
      fallbackTimer = setTimeout(tryLock, 5000);
      return () => {
        cancelled = true;
        source.un("featuresloadend", tryLock);
        clearTimeout(fallbackTimer);
      };
    }

    // Map not built yet (shouldn't normally happen, since this effect runs
    // after the map-init effect) - fall back to a short delayed retry.
    fallbackTimer = setTimeout(tryLock, 1200);
    return () => {
      cancelled = true;
      clearTimeout(fallbackTimer);
    };
  }, [isCityScopedUser, loggedInCity]);

  const mobileOverlayHtml = useMemo(() => {
    if (!homeSummary || !selectedCity) return "";
    return buildOverlayHtml(
      selectedCity,
      homeSummary.perCity?.[selectedCity] || {},
    );
  }, [homeSummary, selectedCity, buildOverlayHtml]);

  useEffect(() => {
    const map = mapRef.current?.instance;
    if (!map || !homeSummary || !selectedCity) return;
    if (isMobileView) {
      const existing = cityOverlaysRef.current;
      Object.values(existing).forEach((item) => {
        map.removeOverlay(item.overlay);
      });
      cityOverlaysRef.current = {};
      return;
    }
    const existing = cityOverlaysRef.current;
    Object.values(existing).forEach((item) => {
      map.removeOverlay(item.overlay);
    });
    cityOverlaysRef.current = {};
    const city = selectedCity;
    const element = document.createElement("div");
    element.className = "city-overlay";
    const [offsetX, offsetY] = getOverlayOffset(city);
    element.dataset.offsetX = `${offsetX}`;
    element.dataset.offsetY = `${offsetY}`;
    const overlay = new Overlay({
      element,
      position: CITY_CENTER[city],
      positioning: "center-center",
      offset: [offsetX, offsetY],
      stopEvent: true,
    });
    const handleOverlayClick = (event) => {
      const target = event.target;
      if (target && target.closest && target.closest(".city-overlay-close")) {
        setShowCityOverlays(false);
      } else {
        handleCitySelect(city);
      }
    };
    const handlePointerDown = (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      event.preventDefault();
      const startX = event.clientX;
      const startY = event.clientY;
      const [baseX, baseY] = overlay.getOffset() || [0, 0];
      element.classList.add("dragging");

      const handlePointerMove = (moveEvent) => {
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        const nextOffset = [baseX + dx, baseY + dy];
        overlay.setOffset(nextOffset);
        element.dataset.offsetX = `${nextOffset[0]}`;
        element.dataset.offsetY = `${nextOffset[1]}`;
      };

      const handlePointerUp = () => {
        element.classList.remove("dragging");
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
    };
    element.addEventListener("pointerdown", handlePointerDown);
    element.addEventListener("click", handleOverlayClick);
    map.addOverlay(overlay);
    cityOverlaysRef.current[city] = {
      overlay,
      element,
      handlePointerDown,
      handleOverlayClick,
    };
    return () => {
      Object.values(cityOverlaysRef.current).forEach((item) => {
        if (item.element && item.handlePointerDown) {
          item.element.removeEventListener(
            "pointerdown",
            item.handlePointerDown,
          );
        }
        if (item.element && item.handleOverlayClick) {
          item.element.removeEventListener("click", item.handleOverlayClick);
        }
        map.removeOverlay(item.overlay);
      });
      cityOverlaysRef.current = {};
    };
  }, [homeSummary, selectedCity]);

  useEffect(() => {
    if (!homeSummary || !selectedCity) return;
    Object.entries(cityOverlaysRef.current).forEach(([city, item]) => {
      // Pin active city overlay to left edge, beneath zoom controls
      item.element.className = `city-overlay active`;
      item.element.style.position = "absolute";
      item.element.style.top = "140px";
      item.element.style.left = "20px";
      item.element.style.right = "auto"; // allow width to grow naturally
      item.element.style.transform = "none";

      item.element.innerHTML = buildOverlayHtml(
        city,
        homeSummary.perCity?.[city] || {},
      );
    });
  }, [homeSummary, selectedCity, buildOverlayHtml]);

  /* ----------------- UTILITIES ----------------- */
  const removeLayer = (ref) => {
    const map =
      mapRef.current?.instance || mapRef.current?.map || mapRef.current;
    if (ref.current && map && typeof map.removeLayer === "function") {
      map.removeLayer(ref.current);
      ref.current = null;
    }
  };

  // eslint-disable-next-line no-unused-vars
  const fitOrCenter = (extent, city) => {
    const view = mapRef.current.getView();
    const valid =
      extent &&
      extent.length === 4 &&
      extent.every((n) => Number.isFinite(n)) &&
      extent[0] < extent[2] &&
      extent[1] < extent[3];

    if (valid) {
      view.fit(extent, { duration: 600, padding: [40, 40, 40, 40] });
    } else {
      const fallback = CITY_CENTER[city] || [81.0, 26.8];
      view.animate({ center: fallback, zoom: 14, duration: 800 });
    }
  };

  // Once a city is selected, pan/zoom should stay within that city — the
  // only way back to the state-wide view is the dropdown, not scrolling out
  // far enough. OL bakes an extent constraint into the View at construction
  // time (no setter on a live view), so this replaces the view in place,
  // carrying over the current center/zoom/rotation, same pattern already
  // used for this on the per-city Dashboard.
  const restrictViewToExtent = useCallback((map, extent, fitPadding) => {
    const view = map.getView();
    const padding = Math.max(getWidth(extent), getHeight(extent)) * 0.15;
    const restrictedExtent = bufferExtent(extent, padding);

    // constrainOnlyCenter alone stops panning away from the city but does
    // nothing to the zoom/resolution itself — a user could still scroll out
    // numerically and see a mostly-blank view (center pinned to the city,
    // but zoomed out far enough to show a much wider, unloaded area). Work
    // out what zoom fit() would land on for this extent given the current
    // viewport size, and use that as minZoom so scrolling out simply stops
    // once the whole city is already visible.
    const size = map.getSize();
    let minZoom = view.getMinZoom();
    if (size) {
      // getResolutionForExtent has no padding param — shrink the box it
      // fits into ourselves so this lines up with what fit({padding}) will
      // actually compute, not a same tighter zoom.
      const [top = 0, right = 0, bottom = 0, left = 0] = fitPadding || [];
      const paddedSize = [
        Math.max(1, size[0] - left - right),
        Math.max(1, size[1] - top - bottom),
      ];
      const resolution = view.getResolutionForExtent(extent, paddedSize);
      const fitZoom = view.getZoomForResolution(resolution);
      // A little slack so the exact fitted view doesn't sit right at the
      // limit (which can make the very first zoom-out tick feel like it
      // does nothing due to floating point/OL's own snapping).
      if (Number.isFinite(fitZoom)) minZoom = Math.max(0, fitZoom - 0.25);
    }

    const restrictedView = new View({
      projection: view.getProjection(),
      center: view.getCenter(),
      zoom: view.getZoom(),
      rotation: view.getRotation(),
      minZoom,
      maxZoom: view.getMaxZoom(),
      extent: restrictedExtent,
      // Only the center is constrained (not the whole viewport) so a city
      // with an aspect ratio that doesn't match the screen doesn't get
      // silently forced to a tighter zoom than fit() itself chose.
      constrainOnlyCenter: true,
    });
    map.setView(restrictedView);
    return restrictedView;
  }, []);

  const fitViewToCityBoundary = useCallback(
    (city) =>
      new Promise((resolve) => {
        const map =
          mapRef.current?.instance || mapRef.current?.map || mapRef.current;
        if (!map || !city) {
          resolve();
          return;
        }
        const entry = BOUNDARY_WFS[city];
        const view = map.getView();

        const fallback = () => {
          const cityCenter = CITY_CENTER[city] || fromLonLat([80.8, 26.8]);
          view.animate({
            center: cityCenter,
            zoom: isMobileView ? 10 : 11,
            duration: 800,
          });
          resolve();
        };

        // The UP boundary WFS layer can still be mid-fetch (or not yet
        // asked to load anything at all - its source only actually starts
        // loading once the layer is asked to render for an extent) at the
        // exact moment this runs, especially right after mount. Rather than
        // silently falling back to a rough center+zoom (which also skips
        // the pan/zoom restriction below), retry for a few seconds so a
        // slow/late load still ends up with the precise, restricted view.
        let attempts = 0;
        const maxAttempts = 20; // ~5s at 250ms apart, plus event-driven retries
        const tryFit = () => {
          const layer = mapRef.current?.upBoundaryLayer;
          const source = layer?.getSource?.();
          if (source && entry) {
            const features = source.getFeatures();
            const feat = features.find(
              (f) => normalizeWfsName(f.get("Name")) === city,
            );
            if (feat) {
              const extent = feat.getGeometry().getExtent();
              const restrictedView = restrictViewToExtent(map, extent, mapPadding);
              restrictedView.fit(extent, {
                padding: mapPadding,
                duration: 800,
                maxZoom: cityMaxZoom,
              });
              resolve();
              return;
            }
            if (source.getState() === "loading") {
              source.once("featuresloadend", tryFit);
              return;
            }
          }
          attempts += 1;
          if (attempts >= maxAttempts) {
            fallback();
            return;
          }
          setTimeout(tryFit, 250);
        };
        tryFit();
      }),
    [isMobileView, mapPadding, cityMaxZoom, restrictViewToExtent],
  );

  /* ----------------- LAYERS ----------------- */

  // Boundary via WFS (so we can fit the boundary exactly)

  const addBoundaryLayer = async (city) => {
    if (!mapRef.current) return;
    const requestId = ++boundaryLayerRequestRef.current;

    const map =
      mapRef.current?.instance || mapRef.current?.map || mapRef.current;
    const { upDistrictLayer, upBoundaryLayer } = mapRef.current;

    if (upDistrictLayer) {
      // A specific city's own boundary makes the whole-state outline
      // redundant - only show upDistrict when no city is selected.
      upDistrictLayer.setVisible(!city);
    }

    if (upBoundaryLayer) {
      upBoundaryLayer.setVisible(layerVisibility.upBoundary);
    }

    // Hide detailed road layers temporarily to reset map state
    if (mapRef.current.above10mRef) removeLayer(mapRef.current.above10mRef);
    if (mapRef.current.cmGridRef) removeLayer(mapRef.current.cmGridRef);

    // Hide popups
    if (mapRef.current.hoverEl) mapRef.current.hoverEl.style.display = "none";
    if (mapRef.current.hoverOverlay)
      mapRef.current.hoverOverlay.setPosition(undefined);
    if (mapRef.current.highlightLayer)
      mapRef.current.highlightLayer.getSource().clear();

    if (!city) {
      // Undo the per-city pan/zoom restriction (if any) — going back to
      // the state-wide view needs a view that isn't still boxed into
      // whichever city was previously selected.
      const currentView = map.getView();
      const unrestrictedView = new View({
        projection: currentView.getProjection(),
        center: currentView.getCenter(),
        zoom: currentView.getZoom(),
        rotation: currentView.getRotation(),
        minZoom: currentView.getMinZoom(),
        maxZoom: currentView.getMaxZoom(),
      });
      map.setView(unrestrictedView);

      const upExtent = [77.0, 23.5, 84.5, 31.0];
      const minCoord = fromLonLat([upExtent[0], upExtent[1]]);
      const maxCoord = fromLonLat([upExtent[2], upExtent[3]]);

      unrestrictedView.fit([minCoord[0], minCoord[1], maxCoord[0], maxCoord[1]], {
        padding: mapPadding,
        duration: 1000,
        maxZoom: upMaxZoom,
      });
    } else {
      await fitViewToCityBoundary(city);
    }
    // A newer city selection (or unmount) may have started while the
    // await above was pending — only the most recent call may still touch
    // the map. getTargetElement() is OpenLayers' own way of reporting
    // whether this Map instance is still attached to the DOM (null once
    // disposed/setTarget(null)); the request-id check catches the more
    // common case of "still mounted, but a different city was picked
    // since this call started."
    if (
      boundaryLayerRequestRef.current === requestId &&
      map &&
      typeof map.getTargetElement === "function" &&
      map.getTargetElement()
    ) {
      map.renderSync(); // ✅ Force OpenLayers to redraw with WMS layers
    }
  };

  // Above 10m roads from live DB-backed GeoJSON, not the static GeoServer WMS.
  const addAbove10mLayer = (city) => {
    removeLayer(above10mRef);
    if (!ABOVE10M_LAYER[city]) return;

    const format = new GeoJSON();
    const source = new VectorSource({
      strategy: bboxStrategy,
      loader: async (extent, resolution, projection, success, failure) => {
        const extent4326 = transformExtent(extent, projection, "EPSG:4326");
        const url =
          `/api/${encodeURIComponent(city)}/roads/above10m/geojson` +
          `?bbox=${extent4326.map((n) => n.toFixed(6)).join(",")}`;
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`Above 10m request failed: ${res.status}`);
          const geojson = await res.json();
          const features = format.readFeatures(geojson, {
            dataProjection: "EPSG:4326",
            featureProjection: projection,
          });
          source.addFeatures(features);
          if (typeof success === "function") success(features);
        } catch (err) {
          source.removeLoadedExtent(extent);
          if (typeof failure === "function") failure();
        }
      },
    });

    const layer = new VectorLayer({
      title: `${city.toUpperCase()} Above 10m`,
      source,
      style: ABOVE10M_VECTOR_STYLE,
      visible: true,
      zIndex: 500,
    });

    setLayerVisibility((prev) => ({ ...prev, above10m: true }));

    const map =
      mapRef.current?.instance || mapRef.current?.map || mapRef.current;
    if (map && typeof map.addLayer === "function") {
      map.addLayer(layer);
    }
    above10mRef.current = layer;
  };

  // CM-Grid / GPR WMS
  const addCmGridLayer = (city, phases) => {
    removeLayer(cmGridRef);
    const layers = (Array.isArray(phases) ? phases : [phases])
      .map((phase, index) => {
        const entry = resolveCmGridEntry(CM_GRID_WMS[city]?.[phase]);
        if (!entry) return null;
        return new TileLayer({
          title: `${city.toUpperCase()} ${phase}`,
          opacity: 1,
          zIndex: 600 + index,
          source: new TileWMS({ url: `${entry.baseUrl}/${entry.workspace}/wms`, params: { LAYERS: entry.layerName, FORMAT: "image/png", VERSION: "1.3.0", TRANSPARENT: true, TILED: true, FORMAT_OPTIONS: "antiAlias:false", ...(entry.style ? { STYLES: entry.style } : {}) }, serverType: "geoserver", crossOrigin: "anonymous", wrapX: false }),
          visible: true,
          imageSmoothing: false,
        });
      })
      .filter(Boolean);
    if (layers.length === 0) return;
    const group = new LayerGroup({ layers, visible: true, zIndex: 600 });
    setLayerVisibility((prev) => ({ ...prev, cmGrid: true }));
    const map = mapRef.current?.instance || mapRef.current?.map || mapRef.current;
    if (map && typeof map.addLayer === "function") map.addLayer(group);
    cmGridRef.current = group;
  };

  /* ----------------- EVENTS ----------------- */

  const handleCityChange = async (e) => {
    const city = e.target.value;
    await handleCitySelect(city);
  };

  // Shared logic for both dropdown select and map click
  const handleCitySelect = async (city) => {
    // A city-scoped login can never switch to another city or back to the
    // state view, regardless of which UI path tried to trigger it.
    if (isCityScopedUser && city !== loggedInCity) return;
    setSelectedCity(city);
    setShowCityOverlays(isMobileView ? false : true);
    updateBaseLayerBoundary(city);

    // Once a specific city is chosen, the whole-state outline (upDistrict)
    // is redundant with that city's own boundary - showing both looked like
    // two competing/duplicate boundaries in the legend. Hide it while a
    // city is selected, restore it on "back to state" (city === "").
    setLayerVisibility((prev) => ({ ...prev, upDistrict: !city }));
    mapRef.current?.upDistrictLayer?.setVisible(!city);

    if (city) localStorage.setItem("selectedCity", city);
    else localStorage.removeItem("selectedCity");

    await addBoundaryLayer(city);
    if (!homeSummary) {
      setCards(cityCardData[city] || cityCardData.default);
    }

    const map =
      mapRef.current?.instance || mapRef.current?.map || mapRef.current;
    if (!map) return;

    const view = map.getView();
    setSelectedPhases([]);

    if (!city) {
      removeLayer(boundaryRef);
      removeLayer(above10mRef);
      removeLayer(cmGridRef);

      const upExtent = [77.0, 23.5, 84.5, 31.0];
      const minCoord = fromLonLat([upExtent[0], upExtent[1]]);
      const maxCoord = fromLonLat([upExtent[2], upExtent[3]]);
      view.fit([minCoord[0], minCoord[1], maxCoord[0], maxCoord[1]], {
        padding: mapPadding,
        duration: 600,
        maxZoom: upMaxZoom,
      });

      handleReturnHome();
      return;
    }

    addAbove10mLayer(city);
  };

  const showCmGridUnavailableNotice = useCallback((option) => {
    const cityName = getCityDisplayName(selectedCity);
    const phaseName = option?.unavailableLabel || option?.label || "This data";
    setCmGridNotice({
      feature: "CM-Grid data",
      message: `${phaseName} data is not available for ${cityName}. You can continue using the available CM-Grid phases or other map tools.`,
      noticeId: `${selectedCity}|${option?.value || "missing"}|${Date.now()}`,
    });
  }, [getCityDisplayName, selectedCity]);

  useEffect(() => {
    if (!cmGridNotice) return undefined;
    const timer = setTimeout(() => setCmGridNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [cmGridNotice]);

  const handlePhaseChange = (phase, option) => {
    if (!phase || option?.kind === "header") return;
    if (option?.available === false) {
      showCmGridUnavailableNotice(option);
      return;
    }
    const next = selectedPhases.includes(phase)
      ? selectedPhases.filter((value) => value !== phase)
      : [...selectedPhases, phase];
    setSelectedPhases(next);
    setCmGridNotice(null);
    if (next.length > 0) addCmGridLayer(selectedCity, next);
    else removeLayer(cmGridRef);
  };

  const handleDashboardClick = () => {
    const c = selectedCity;
    console.log("Dashboard clicked, selected city:", c);
    if (!c) {
      console.log("No city selected, cannot navigate to dashboard");
      return;
    }

    console.log(`Navigating to dashboard with city: ${c}`);
    // Navigate to Dashboard page with city name as parameter
    navigate(`/dashboard?city=${encodeURIComponent(c)}`);

    // Clear city selection after navigation
    localStorage.removeItem("selectedCity");
  };

  const handleAdminBack = useCallback(() => {
    navigate("/admin");
  }, [navigate]);

  const handleLogout = () => {
    fetch("/api/auth/logout", { method: "POST", credentials: "include" }).catch(() => {});
    localStorage.removeItem("authUser");
    localStorage.removeItem("authRole");
    localStorage.removeItem("authCity");
    window.location.href = "/";
  };
  // ✅ Return to HomePage without logging out
  const handleReturnHome = () => {
    window.location.href = "/home"; // stays logged in
  };

  const activeLegendLayers = useMemo(() => {
    const arr = [];
    if (layerVisibility.upDistrict) {
      arr.push({
        layerName: "Ward_38:Up_District",
        label: "UP District Boundary",
      });
    }
    if (layerVisibility.upBoundary) {
      if (!selectedCity) {
        const manualItems = Object.keys(BOUNDARY_WFS).map((city) => ({
          label: `${city.charAt(0).toUpperCase() + city.slice(1)} Nagar Nigam`,
          color: CITY_BOUNDARY_COLORS[city] || "#2f6fd6",
          name: city,
        }));
        arr.push({
          layerName: "manual_up_boundaries",
          label: "UP Nagar Nigam Boundary",
          isManual: true,
          items: manualItems,
        });
      } else if (BOUNDARY_WFS[selectedCity]) {
        arr.push({
          layerName: `manual_${selectedCity}_boundary`,
          label: `${selectedCity.charAt(0).toUpperCase() + selectedCity.slice(1)} Boundary`,
          isManual: true,
          items: [
            {
              label: `${selectedCity.charAt(0).toUpperCase() + selectedCity.slice(1)} Nagar Nigam`,
              color: CITY_BOUNDARY_COLORS[selectedCity] || "#2f6fd6",
              name: selectedCity,
            },
          ],
        });
      }
    }
    if (
      layerVisibility.above10m &&
      selectedCity &&
      ABOVE10M_LAYER[selectedCity]
    ) {
      arr.push({
        layerName: `${ABOVE10M_WS}:${ABOVE10M_LAYER[selectedCity]}`,
        label: "Roads > 10m ROW",
        baseUrl: GEOSERVER_BASE,
      });
    }
    if (layerVisibility.cmGrid && selectedCity) {
      selectedPhases.forEach((phase) => {
        const entry = resolveCmGridEntry(CM_GRID_WMS[selectedCity]?.[phase]);
        if (!entry) return;
        arr.push({
          layerName: entry.layerName,
          label: phase === "GPR" ? "GPR Priority" : `${phaseOptions.find((option) => option.value === phase)?.label || phase} Progress`,
          baseUrl: entry.baseUrl,
          style: entry.style,
        });
      });
    }
    return arr;
  }, [layerVisibility, phaseOptions, selectedCity, selectedPhases]);

  /* ----------------- RENDER ----------------- */

  return (
    <>
      {/* SIDEBAR */}
      <div
        className={`sidebar ${showCityOverlays && isMobileView ? "sidebar-popup" : ""}`}
        id="sidebar"
      >
        <div className="logo-container">
          <img src={logo} alt="Logo" className="logo" />
          <div className="logo-text">URBAN ROAD DIRECTORY</div>
        </div>

        <div className="sidebar-item">
          {isCityScopedUser ? (
            <div className="select-field select-field--locked" aria-disabled="true">
              {loggedInCity.charAt(0).toUpperCase() + loggedInCity.slice(1)}
            </div>
          ) : (
            <select
              id="nagarNigamSelect"
              className="select-field"
              value={selectedCity}
              onChange={handleCityChange}
            >
              <option value="">Select Nagar Nigam</option>
              {Object.keys(CITY_CENTER).map((city) => (
                <option key={city} value={city}>
                  {city.charAt(0).toUpperCase() + city.slice(1)}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="separator" />
        {/* ═══ Cards Section ═══ */}
        <div className="cards-section">
          <div className="cards-title">
            {selectedCity
              ? `${selectedCity.charAt(0).toUpperCase() + selectedCity.slice(1)} Statistics`
              : "UP State Statistics"}
          </div>
          <div className="cards-container">
            {summaryLoading
              ? [0, 1, 2, 3, 4, 5].map((i) => (
                  <div className="stat-card stat-card--skeleton" key={i}>
                    <div className="stat-card__icon-wrap skeleton-pulse" />
                    <div
                      className="stat-card__value skeleton-pulse"
                      style={{ height: 22, marginTop: 6, borderRadius: 4 }}
                    />
                    <div
                      className="stat-card__label skeleton-pulse"
                      style={{
                        height: 13,
                        marginTop: 6,
                        width: "70%",
                        borderRadius: 3,
                      }}
                    />
                  </div>
                ))
              : cards.map((card, idx) => (
                  <div
                    className="stat-card"
                    key={idx}
                    style={{
                      background: card.color || "#f9f9f9",
                      color: card.textColor || "#1a1a1a",
                      "--card-accent": card.accentColor || "#999",
                    }}
                  >
                    <div
                      className="stat-card__icon-wrap"
                      style={{
                        background: card.iconBg || card.accentColor || "#999",
                        color: card.iconColor || "#fff",
                      }}
                    >
                      <i className={card.icon || "fas fa-chart-bar"} />
                    </div>
                    <div
                      className={`stat-card__value ${card.title.includes("Length") ? "stat-card__value--length" : ""}`}
                    >
                      {card.content}
                    </div>
                    <div className="stat-card__label">{card.title}</div>
                    {card.subtitle && (
                      <div className="stat-card__subtitle">{card.subtitle}</div>
                    )}
                  </div>
                ))}
          </div>
        </div>

        {loggedInRole === "admin" && !selectedCity && (
          <div className="sidebar-item sidebar-item--admin-back">
            <button className="admin-back-button" onClick={handleAdminBack}>
              <i className="fas fa-arrow-left" /> Back to Admin Panel
            </button>
          </div>
        )}

        <div className="button-container" id="buttonContainer">
          {selectedCity && (
            <>
              <div className="button-and-select-container">
                <button className="action-button" onClick={handleDashboardClick}>
                  Dashboard
                </button>

                <div
                  className="phase-menu"
                  ref={phaseMenuRef}
                >
                  <button
                    type="button"
                    id="roadSelector"
                    className="phase-menu__button"
                    onClick={() => setPhaseMenuOpen((open) => !open)}
                    aria-haspopup="listbox"
                    aria-expanded={phaseMenuOpen}
                  >
                    <span>{selectedPhaseLabel}</span>
                    <i className="fas fa-chevron-down" aria-hidden="true" />
                  </button>

                  {phaseMenuOpen && (
                    <div className="phase-menu__list" role="listbox">
                      {phaseOptions.map((option) => {
                        const isSelected = selectedPhases.includes(option.value);
                        const isDisabled = option.available === false;
                        if (option.kind === "header") {
                          return <div key={option.label} className="phase-menu__option phase-menu__option--header">{option.label}</div>;
                        }
                        return (
                          <button key={option.value} type="button" className={["phase-menu__option", isSelected ? "phase-menu__option--selected" : "", isDisabled ? "phase-menu__option--disabled" : ""].filter(Boolean).join(" ")} role="menuitemcheckbox" aria-checked={isSelected} aria-disabled={isDisabled} onClick={() => handlePhaseChange(option.value, option)}>
                            <span className="phase-menu__option-main"><input type="checkbox" className="phase-menu__checkbox" checked={isSelected} readOnly tabIndex={-1} disabled={isDisabled} /><span>{option.label}</span></span>
                            {isDisabled && <span className="phase-menu__option-note">Not available</span>}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

              {loggedInRole === "admin" && (
                <div style={{ width: "100%", display: "flex", justifyContent: "center" }}>
                  <button className="admin-back-button" onClick={handleAdminBack}>
                    <i className="fas fa-arrow-left" /> Back to Admin Panel
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* MAP */}
      <div
        id="map"
        className={[
          showCityOverlays ? "map-overlay-visible" : "map-overlay-hidden",
          selectedCity ? "city-selected" : "",
        ]
          .join(" ")
          .trim()}
      />

      {cmGridNotice && (
        <div className="feature-progress-notice" role="status" aria-live="polite">
          <div className="feature-progress-notice__content">
            <div className="feature-progress-notice__title">
              {cmGridNotice.feature}
            </div>
            <div className="feature-progress-notice__message">
              {cmGridNotice.message}
            </div>
          </div>
          <button
            type="button"
            className="feature-progress-notice__close"
            onClick={() => setCmGridNotice(null)}
            aria-label="Close message"
          >
            x
          </button>
        </div>
      )}

      {basemapNotice && (
        <div className="feature-progress-notice" role="status" aria-live="polite">
          <div className="feature-progress-notice__content">
            <div className="feature-progress-notice__title">
              {basemapNotice.displayName} basemap unavailable
            </div>
            <div className="feature-progress-notice__message">
              {basemapNotice.message}
            </div>
          </div>
          <button
            type="button"
            className="feature-progress-notice__close"
            onClick={() => setBasemapNotice(null)}
            aria-label="Close message"
          >
            x
          </button>
        </div>
      )}

      {/* Back to State button - never shown for a city-scoped login */}
      {selectedCity && !isCityScopedUser && (
        <button
          className={styles["map-reset-btn"] || "map-reset-btn"}
          onClick={() => {
            setSelectedCity("");
            setSelectedPhases([]);
            setLayerVisibility((prev) => ({ ...prev, upDistrict: true }));
            mapRef.current?.upDistrictLayer?.setVisible(true);
            localStorage.removeItem("selectedCity");
            setCards(cityCardData.default);
            if (mapRef.current?.instance) {
              removeLayer(boundaryRef);
              removeLayer(above10mRef);
              removeLayer(cmGridRef);
              if (mapRef.current.hoverEl)
                mapRef.current.hoverEl.style.display = "none";
              if (mapRef.current.highlightLayer)
                mapRef.current.highlightLayer.getSource().clear();

              const upExtent = [77.0, 23.5, 84.5, 31.0];
              const minCoord = fromLonLat([upExtent[0], upExtent[1]]);
              const maxCoord = fromLonLat([upExtent[2], upExtent[3]]);
              mapRef.current.instance
                .getView()
                .fit([minCoord[0], minCoord[1], maxCoord[0], maxCoord[1]], {
                  padding: [50, 50, 50, 50],
                  duration: 800,
                  maxZoom: 8,
                });
            }
          }}
        >
          <i className="fas fa-arrow-left"></i> Back to UP State Map
        </button>
      )}

      {isMobileView && showCityOverlays && mobileOverlayHtml && (
        <div
          className="mobile-stats-panel"
          dangerouslySetInnerHTML={{ __html: mobileOverlayHtml }}
        />
      )}
      {isMobileView && selectedCity && (
        <button
          className="overlay-toggle"
          onClick={() => setShowCityOverlays((value) => !value)}
        >
          {showCityOverlays ? "Hide Stats" : "Show Stats"}
        </button>
      )}

      {/* Elegant Layer Legend Panel - Visible statewide or citywide when layers are active */}
      <HomeMapLegend layers={activeLegendLayers} />

      {/* ✅ Floating map controls — Profile above Basemap/Layers */}
      <div className="map-controls-container">
        {/* Profile button (top) */}
        <div style={{ position: "relative" }}>
          <button
            className="map-btn profile-btn"
            title="Profile / Logout"
            ref={profileBtnRef}
            onClick={() => {
              setProfileMenuOpen((open) => !open);
              setControlsVisible(false);
            }}
          >
            <i className="fas fa-user-circle" />
          </button>
          {profileMenuOpen && (
            <div
              id="hp-profile-menu"
              ref={profileMenuRef}
              className="profile-dropdown"
            >
              <div className="profile-dropdown-header">
                <i
                  className="fas fa-user-circle"
                  style={{ fontSize: 28, color: "#3b82f6" }}
                />
                <span
                  style={{
                    fontWeight: 700,
                    fontSize: 13,
                    textTransform: "capitalize",
                  }}
                >
                  {loggedInUser}
                </span>
              </div>
              <div className="profile-dropdown-item" onClick={handleLogout}>
                <i className="fas fa-sign-out-alt" />
                Logout
              </div>
            </div>
          )}
        </div>

        {/* Basemap + Overlay Layers button */}
        <div style={{ position: "relative" }}>
          <button
            className="map-btn"
            onClick={() => {
              setControlsVisible((v) => !v);
              setProfileMenuOpen(false);
            }}
            title="Basemap &amp; Layers"
          >
            <i className="fas fa-layer-group" />
          </button>
          {controlsVisible && (
            <div className="controls-panel">
              <div className="controls-panel-header">
                <i
                  className="fas fa-map"
                  style={{ color: "#3b82f6", marginRight: 6 }}
                />
                Base Maps
              </div>
              {/* Modern basemap card grid */}
              <div className="basemap-card-grid">
                {[
                  {
                    value: "osm",
                    label: "OSM",
                    icon: "fas fa-map",
                    color: "#e8f5e9",
                  },
                  {
                    value: "satellite",
                    label: "Satellite",
                    icon: "fas fa-satellite",
                    color: "#e3f2fd",
                  },
                  {
                    value: "positron",
                    label: "Positron",
                    icon: "fas fa-circle",
                    color: "#fce4ec",
                  },
                  {
                    value: "topo",
                    label: "Topo",
                    icon: "fas fa-mountain",
                    color: "#fff3e0",
                  },
                  {
                    value: "toner",
                    label: "Toner",
                    icon: "fas fa-adjust",
                    color: "#f3e5f5",
                  },
                ].map(({ value, label, icon, color }) => (
                  <button
                    key={value}
                    className={`basemap-card ${baseMap === value ? "basemap-card--active" : ""}`}
                    style={{ "--bm-color": color }}
                    onClick={() => handleBaseMapChange(value)}
                  >
                    <span className="basemap-card__icon">
                      <i className={icon} />
                    </span>
                    <span className="basemap-card__label">{label}</span>
                    {baseMap === value && (
                      <span className="basemap-card__check">
                        <i className="fas fa-check-circle" />
                      </span>
                    )}
                  </button>
                ))}
              </div>

              <div className="controls-panel-divider" />

              <div
                className="controls-panel-header"
                style={{ marginBottom: 8 }}
              >
                <i
                  className="fas fa-layer-group"
                  style={{ color: "#3b82f6", marginRight: 6 }}
                />
                Overlay Layers
              </div>
              <div className="layer-controls">
                {[
                  { key: "upDistrict", label: "UP District", alwaysShow: true },
                  {
                    key: "upBoundary",
                    label: "UP Nagar Nigam Boundary",
                    alwaysShow: true,
                  },
                  {
                    key: "above10m",
                    label: "Above 10m Roads",
                    alwaysShow: false,
                    show: !!selectedCity,
                    disabled: !above10mRef.current,
                  },
                  {
                    key: "cmGrid",
                    label: "CM-Grid Roads",
                    alwaysShow: false,
                    show: selectedPhases.length > 0,
                    disabled: !cmGridRef.current,
                  },
                ]
                  .filter((l) => l.alwaysShow || l.show)
                  .map(({ key, label, disabled }) => (
                    <label key={key} className="layer-toggle-row">
                      <span className="layer-toggle-label">{label}</span>
                      <span
                        className={`layer-toggle-switch ${layerVisibility[key] ? "layer-toggle-switch--on" : ""} ${disabled ? "layer-toggle-switch--disabled" : ""}`}
                        onClick={() => !disabled && toggleLayer(key)}
                        role="switch"
                        aria-checked={layerVisibility[key]}
                      >
                        <span className="layer-toggle-knob" />
                      </span>
                    </label>
                  ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <Footer />
    </>
  );
}
