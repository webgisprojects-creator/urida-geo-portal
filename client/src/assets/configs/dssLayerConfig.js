// DSS (Decision Support System) GeoServer contract — the single source of
// truth for layer names, native MV/table names, styles, category fields,
// legend colors, and count/column normalization. Map WMS, WFS table,
// search/filter, and legend all read from this file so they can never
// drift into showing different category logic for the same module.
import { cityConfig } from "./cityConfig";

export const DSS_STATUS = {
  READY: "READY",
  LAYER_MISSING: "LAYER_MISSING",
  STYLE_MISSING: "STYLE_MISSING",
  WFS_ERROR: "WFS_ERROR",
  EMPTY_OR_SRID_MISSING: "EMPTY_OR_SRID_MISSING",
  ERROR: "ERROR",
  // Not yet checked against GeoServer this session — distinct from any
  // terminal status above so callers know a live WFS probe is still needed
  // before trusting READY/not-READY.
  UNKNOWN: "UNKNOWN",
};

// lucknow -> Lucknow, shahjahanpur -> Shahjahanpur, etc. Prefers the
// already-correct title case from cityConfig (which also covers names
// that aren't simple capitalization) and falls back to capitalizing the
// first letter for any city not yet present there.
export const cityTitleCase = (city) => {
  const key = String(city || "").trim().toLowerCase();
  const known = cityConfig[key]?.name;
  if (known) return known;
  return key ? key.charAt(0).toUpperCase() + key.slice(1) : "";
};

const cityLower = (city) => String(city || "").trim().toLowerCase();

// Audit-confirmed only — every other city stays LAYER_MISSING for
// Encroachment. Casing is exactly as confirmed (Agra's is capitalized
// differently from the rest); do not "normalize" these strings.
const ENCROACHMENT_LAYERS = {
  agra: "Road_Network:MV_Agra_Encroachment_Summary",
  aligarh: "Road_Network:mv_aligarh_encroachment_summary",
  firozabad: "Road_Network:mv_firozabad_encroachment_summary",
  moradabad: "Road_Network:mv_moradabad_encroachment_summary",
  varanasi: "Road_Network:mv_varanasi_encroachment_summary",
};

const DSS_MODULES = {
  streetLight: {
    label: "Street Light",
    // Native MV behind GeoServer: {city}.mv_{city}_street_light
    nativeTable: (city) => `${cityLower(city)}.mv_${cityLower(city)}_street_light`,
    categoryField: "Street_Light",
    values: ["ILLUMINATED", "NON_ILLUMINATED", "OTHERS"],
    styleName: "Road_Network:MV_Street_Light",
    resolveLayer: (city) => `Road_Network:MV_${cityTitleCase(city)}_Street_Light`,
  },
  underdeveloped: {
    label: "Underdevelopment",
    nativeTable: (city) => `${cityLower(city)}.mv_${cityLower(city)}_underdeveloped_analysis`,
    categoryField: "road_development_category",
    values: ["DEVELOPED_ROAD", "UNDERDEVELOPED_ROADS", "NON_DEVELOPED_ROAD", "NA", "OTHERS"],
    styleName: "Road_Network:MV_underdeveloped_analysis",
    resolveLayer: (city) => `Road_Network:mv_${cityLower(city)}_underdeveloped_analysis`,
  },
  roadMaintenance: {
    label: "Road Maintenance",
    nativeTable: (city) => `${cityLower(city)}.mv_${cityLower(city)}_road_maintenance`,
    categoryField: "maintenance_category",
    values: null, // open-ended — grouped by whatever value actually comes back
    styleName: "Road_Network:MV_road_maintenance",
    resolveLayer: (city) => `Road_Network:mv_${cityLower(city)}_road_maintenance`,
  },
  encroachment: {
    label: "Encroachment",
    nativeTable: (city) => `${cityLower(city)}.mv_${cityLower(city)}_encroachment_summary`,
    categoryField: null,
    values: null,
    // No confirmed SLD in the audit — omit STYLES and let GeoServer's
    // default style render if/when the WMS request succeeds.
    styleName: null,
    resolveLayer: (city) => ENCROACHMENT_LAYERS[cityLower(city)] || null,
  },
};

export const DSS_MODULE_ORDER = ["streetLight", "underdeveloped", "roadMaintenance", "encroachment"];

// Resolves a module's static GeoServer contract for a city — layer/style/
// categoryField/label. Does NOT tell you whether the layer is actually
// published; call checkDssLayerAvailability for that (or, for encroachment,
// check `knownUnavailable`, which is decided by the confirmed-layer
// whitelist alone and needs no network round trip).
export const resolveDssModule = (moduleKey, city) => {
  const mod = DSS_MODULES[moduleKey];
  if (!mod) return null;
  const layer = mod.resolveLayer(city);
  return {
    key: moduleKey,
    label: mod.label,
    categoryField: mod.categoryField,
    values: mod.values,
    styleName: mod.styleName,
    layer,
    nativeTable: mod.nativeTable(city),
    knownUnavailable: moduleKey === "encroachment" ? !layer : false,
  };
};

export const dssPendingToastMessage = (label, city) =>
  `${label} data is in process for ${cityTitleCase(city)}. Please use other DSS features.`;

// ---------------------------------------------------------------------
// GeoServer availability probe
// ---------------------------------------------------------------------
// WFS GetFeature with count=1 is the cheapest way to tell "layer is
// published and queryable" apart from "layer doesn't exist" apart from
// "server/network error" without needing a separate DescribeFeatureType
// round trip. GeoServer's behavior for an unknown typeName is to return an
// XML ServiceExceptionReport even when JSON was requested (it can't format
// JSON for a type it doesn't recognize), so a response that isn't parseable
// JSON is treated as LAYER_MISSING rather than WFS_ERROR — this hasn't been
// verified against a live GeoServer instance in this environment, so treat
// it as a best-effort heuristic, not a guarantee.
export const checkDssLayerAvailability = async (geoserverBase, layerName, { signal, timeoutMs = 6000 } = {}) => {
  if (!geoserverBase || !layerName) return DSS_STATUS.LAYER_MISSING;
  const url =
    `${geoserverBase}/wfs?service=WFS&version=2.0.0&request=GetFeature` +
    `&typeNames=${encodeURIComponent(layerName)}&count=1&outputFormat=application/json`;
  // A slow/non-responding GeoServer layer (as opposed to a fast, clean
  // "unknown layer" error) must not leave the DSS UI waiting indefinitely —
  // bound the wait, and still let a newer click's own abort (superseded)
  // take priority over our own timeout so the caller's silent-abort
  // handling still applies to that case specifically.
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const onExternalAbort = () => timeoutController.abort();
  signal?.addEventListener("abort", onExternalAbort);
  let res;
  try {
    res = await fetch(url, { signal: timeoutController.signal });
  } catch (err) {
    if (signal?.aborted) {
      const abortErr = new Error("Aborted");
      abortErr.name = "AbortError";
      throw abortErr;
    }
    return DSS_STATUS.WFS_ERROR; // includes our own timeout firing
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
  }
  if (!res.ok) return DSS_STATUS.WFS_ERROR;
  let text;
  try {
    text = await res.text();
  } catch {
    return DSS_STATUS.WFS_ERROR;
  }
  const trimmed = (text || "").trim();
  if (!trimmed) return DSS_STATUS.EMPTY_OR_SRID_MISSING;
  if (trimmed.startsWith("<")) {
    // XML response for a GeoJSON request — almost always GeoServer's
    // ServiceExceptionReport for an unpublished/unknown type name.
    return DSS_STATUS.LAYER_MISSING;
  }
  try {
    const data = JSON.parse(trimmed);
    if (!Array.isArray(data?.features)) return DSS_STATUS.WFS_ERROR;
    return DSS_STATUS.READY;
  } catch {
    return DSS_STATUS.WFS_ERROR;
  }
};

// Builds a GeoServer WFS GetFeature URL scoped to the current map viewport
// (EPSG:4326 bbox), used for the DSS table — never fetches a whole city at
// once.
export const buildDssWfsTableUrl = (geoserverBase, layerName, bbox, maxFeatures = 500) => {
  let url =
    `${geoserverBase}/wfs?service=WFS&version=2.0.0&request=GetFeature` +
    `&typeNames=${encodeURIComponent(layerName)}&outputFormat=application/json` +
    `&count=${encodeURIComponent(maxFeatures)}`;
  if (Array.isArray(bbox) && bbox.length === 4 && bbox.every((v) => Number.isFinite(v))) {
    url += `&bbox=${bbox.join(",")},EPSG:4326`;
  }
  return url;
};

// Flattens a GeoServer WFS GeoJSON FeatureCollection's `features` array into
// plain row objects (properties, plus a road_id fallback from the feature
// id) — the single place this shape conversion happens, so the table,
// legend, and column builders all consume the exact same row shape.
export const flattenDssFeatures = (features) =>
  (Array.isArray(features) ? features : []).map((f) => {
    const props = f?.properties || {};
    return { road_id: f?.id ?? "", ...props };
  });

// ---------------------------------------------------------------------
// Legend + count normalization (map/table/legend must all agree)
// ---------------------------------------------------------------------
export const STREET_LIGHT_LEGEND = [
  { key: "illuminated", label: "Illuminated", color: "#10b981" },
  { key: "nonIlluminated", label: "Non-Illuminated", color: "#ef4444" },
  { key: "others", label: "Others", color: "#f59e0b" },
];

// ILLUMINATED must never fall into "others" — match on the exact GeoServer
// value first, and only bucket unrecognized/blank values as others.
export const normalizeStreetLightKey = (rawValue) => {
  const v = String(rawValue ?? "").trim().toUpperCase();
  if (v === "ILLUMINATED") return "illuminated";
  if (v === "NON_ILLUMINATED") return "nonIlluminated";
  return "others";
};

export const UNDERDEVELOPED_LEGEND = [
  { key: "developed", label: "Developed", color: "#10b981" },
  { key: "underdeveloped", label: "Underdeveloped", color: "#f59e0b" },
  { key: "nonDeveloped", label: "Non-Developed", color: "#ef4444" },
  { key: "others", label: "Others/NA", color: "#64748b" },
];

export const normalizeUnderdevelopedKey = (rawValue) => {
  const v = String(rawValue ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (v === "DEVELOPED_ROAD" || v === "DEVELOPED_ROADS" || v === "DEVELOPED") return "developed";
  if (v === "UNDERDEVELOPED_ROADS" || v === "UNDERDEVELOPED_ROAD" || v === "UNDERDEVELOPED") return "underdeveloped";
  if (v === "NON_DEVELOPED_ROAD" || v === "NON_DEVELOPED_ROADS" || v === "NON_DEVELOPED") return "nonDeveloped";
  return "others"; // NA / OTHERS / blank
};

export const ENCROACHMENT_LEGEND = [
  { key: "encroached", label: "Encroached Roads", color: "#7c3aed" },
  { key: "total", label: "Total Roads", color: "#334155" },
];

// Road Maintenance categories are open-ended ("group by actual value"), so
// there's no fixed legend list — colors are assigned deterministically by
// first-seen order out of this safe controlled palette.
export const ROAD_MAINTENANCE_PALETTE = ["#2563eb", "#059669", "#d97706", "#dc2626", "#7c3aed", "#0891b2", "#64748b"];

export const normalizeRoadMaintenanceKey = (rawValue) => {
  const v = String(rawValue ?? "").trim();
  return v || "Unspecified";
};

// Field names for the encroachment summary MV aren't confirmed by the
// audit — probe a short list of plausible boolean/status field names and
// fall back to a total-only count if none are present, rather than
// guessing at a schema.
const ENCROACHMENT_FLAG_FIELDS = ["is_encroached", "encroached", "encroachment_status", "encroachment"];
const ENCROACHMENT_TRUE_VALUES = new Set(["TRUE", "YES", "Y", "1", "ENCROACHED"]);

// Builds legend items (with counts) for the given module from an array of
// flat row objects (GeoServer WFS features already flattened to their
// `properties`, i.e. the exact same row shape the DSS table renders). The
// map WMS layer, the DSS table, and the legend must all derive their
// category grouping from these same normalizers so they can never disagree
// with each other.
export const buildDssLegendCounts = (moduleKey, rows) => {
  const list = Array.isArray(rows) ? rows : [];
  if (moduleKey === "streetLight") {
    const counts = { illuminated: 0, nonIlluminated: 0, others: 0 };
    list.forEach((row) => { counts[normalizeStreetLightKey(row?.[DSS_MODULES.streetLight.categoryField])] += 1; });
    return STREET_LIGHT_LEGEND.map((item) => ({ ...item, count: counts[item.key] || 0 }));
  }
  if (moduleKey === "underdeveloped") {
    const counts = { developed: 0, underdeveloped: 0, nonDeveloped: 0, others: 0 };
    list.forEach((row) => { counts[normalizeUnderdevelopedKey(row?.[DSS_MODULES.underdeveloped.categoryField])] += 1; });
    return UNDERDEVELOPED_LEGEND.map((item) => ({ ...item, count: counts[item.key] || 0 }));
  }
  if (moduleKey === "roadMaintenance") {
    const counts = {};
    const order = [];
    list.forEach((row) => {
      const key = normalizeRoadMaintenanceKey(row?.[DSS_MODULES.roadMaintenance.categoryField]);
      if (!(key in counts)) { counts[key] = 0; order.push(key); }
      counts[key] += 1;
    });
    return order.map((key, i) => ({
      key,
      label: key,
      color: ROAD_MAINTENANCE_PALETTE[i % ROAD_MAINTENANCE_PALETTE.length],
      count: counts[key],
    }));
  }
  if (moduleKey === "encroachment") {
    const total = list.length;
    const foundField = ENCROACHMENT_FLAG_FIELDS.find((k) => list.some((row) => row && k in row));
    if (!foundField) {
      return [{ key: "total", label: "Total Roads", color: "#334155", count: total }];
    }
    let encroached = 0;
    list.forEach((row) => {
      const val = String(row?.[foundField] ?? "").trim().toUpperCase();
      if (ENCROACHMENT_TRUE_VALUES.has(val)) encroached += 1;
    });
    return [
      { key: "encroached", label: "Encroached Roads", color: "#7c3aed", count: encroached },
      { key: "total", label: "Total Roads", color: "#334155", count: total },
    ];
  }
  return [];
};

// ---------------------------------------------------------------------
// Table columns
// ---------------------------------------------------------------------
const DSS_FIXED_COLUMNS = [
  "road_id", "road_name", "zone_no", "zone_name", "ward_no", "ward_name",
  "ownership", "condition", "material", "category",
];

const normalizeForCompare = (v) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, "");

// Some cities' zone/ward "name" columns are just the number restated
// ("Zone3", "Ward 6") rather than a real place name — showing both the
// number and that name column is redundant. Other cities (e.g. Lucknow's
// ward names) carry real, distinct names and both columns are useful. This
// is decided per dataset from the rows actually loaded, not a hardcoded
// per-city table, so it stays correct as data changes.
const isRedundantNameColumn = (rows, numberKey, nameKey, prefix) => {
  const withBoth = rows.filter(
    (r) => r?.[numberKey] != null && r?.[nameKey] != null && String(r[nameKey]).trim() !== ""
  );
  if (!withBoth.length) return false;
  return withBoth.every((r) => {
    const num = normalizeForCompare(r[numberKey]);
    const name = normalizeForCompare(r[nameKey]);
    return name === num || name === `${prefix}${num}`;
  });
};

// Builds the column order for the DSS table from whatever properties are
// actually present on the loaded rows: the fixed road-identity columns
// first (only the ones present, and only the name columns when they carry
// real signal beyond the number), then the active module's own field, then
// anything left over.
export const buildDssColumns = (moduleKey, rows) => {
  const list = Array.isArray(rows) ? rows : [];
  const present = new Set();
  list.forEach((row) => {
    Object.keys(row || {}).forEach((k) => present.add(k));
  });

  if (present.has("zone_name") && present.has("zone_no") && isRedundantNameColumn(list, "zone_no", "zone_name", "zone")) {
    present.delete("zone_name");
  }
  if (present.has("ward_name") && present.has("ward_no") && isRedundantNameColumn(list, "ward_no", "ward_name", "ward")) {
    present.delete("ward_name");
  }

  const moduleField = DSS_MODULES[moduleKey]?.categoryField || null;
  const ordered = [];
  DSS_FIXED_COLUMNS.forEach((k) => {
    if (present.has(k)) { ordered.push(k); present.delete(k); }
  });
  if (moduleField && present.has(moduleField)) {
    ordered.push(moduleField);
    present.delete(moduleField);
  }
  return [...ordered, ...Array.from(present).sort()];
};
