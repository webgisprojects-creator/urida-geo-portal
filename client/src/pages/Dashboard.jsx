// src/pages/Dashboard.jsx
/* Dashboard feature hub: header/menu, sidebar layer toggles, map/toolbar, table, exports, summaries. */
import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { exportToPDF, exportToExcel, exportToKML, captureMapCanvas, drawWatermark } from "../utils/gisExport";
import { getIsLowBandwidth } from "../utils/networkStatus";
import { logEvent } from "../utils/telemetry";
import { saveAs } from "file-saver";

import "../assets/styles/Dashboard.css";
import rsacBanner from "../assets/Login/rsac_banner.png";
import Header from "../components/Header";
import Sidebar from "../components/Sidebar";
import MapContainer from "../components/MapContainer";
import MapToolbar from "../components/MapToolbar";
import Footer from "../components/Footer";
import SummaryTable from "../components/SummaryTable";
import ChartPanel from "../components/ChartPanel";

import { cityConfig } from "../assets/configs/cityConfig.js";
import { getGeoserverBase } from "../utils/geoserverBase";
import { isChainageAvailable } from "../utils/chainageAvailability"; //chainage
const GEOSERVER_BASE = getGeoserverBase();

// ⭐ Internal Component for Filter Dropdown
const NUMERIC_COLS = ['yoc', 'row_meter', 'carriage_w', 'length_km'];

// Keeps the top-loading-strip message short and readable regardless of how
// many things happen to be loading at once — a long comma-joined list of
// layer titles can overflow no matter how generous the CSS truncation is,
// so cap it at two names and summarize the rest instead of ellipsis-cutting
// mid-word.
function formatLoadingMessage(labels) {
  const list = (labels || []).filter(Boolean);
  if (!list.length) return "Loading, please wait…";
  if (list.length === 1) return `Loading ${list[0]}, please wait…`;
  if (list.length === 2) return `Loading ${list[0]} and ${list[1]}, please wait…`;
  return `Loading ${list[0]}, ${list[1]} and ${list.length - 2} more, please wait…`;
}

const RangeSlider = ({ col, min, max, value, onChange }) => {
  const [lo, setLo] = React.useState(value?.[0] ?? min);
  const [hi, setHi] = React.useState(value?.[1] ?? max);
  const range = max - min || 1;
  const loPercent = ((lo - min) / range) * 100;
  const hiPercent = ((hi - min) / range) * 100;
  const trackRef = React.useRef(null);
  const debounceRef = React.useRef(null);

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const toValue = (clientX) => {
    const r = trackRef.current?.getBoundingClientRect();
    if (!r) return min;
    const ratio = (clientX - r.left) / r.width;
    return clamp(min + ratio * range, min, max);
  };

  const dragging = React.useRef(null);
  const onMouseDown = (which) => (e) => {
    e.preventDefault();
    dragging.current = which;
    const move = (ev) => {
      const v = toValue(ev.clientX);
      if (dragging.current === 'lo') setLo(clamp(Number(v.toFixed(2)), min, hi));
      else setHi(clamp(Number(v.toFixed(2)), lo, max));
    };
    const up = () => { dragging.current = null; window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  // Debounced onChange — don't emit on every pixel drag
  React.useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onChange([lo, hi]), 150);
    return () => clearTimeout(debounceRef.current);
  }, [lo, hi]);

  const handleLoInput = (e) => {
    const v = Number(e.target.value);
    if (Number.isFinite(v)) setLo(clamp(v, min, hi));
  };
  const handleHiInput = (e) => {
    const v = Number(e.target.value);
    if (Number.isFinite(v)) setHi(clamp(v, lo, max));
  };

  const inputStyle = { width: 60, padding: '3px 6px', borderRadius: 4, border: '1px solid #cbd5e1', fontSize: 12, textAlign: 'center', fontWeight: 600, color: '#1e40af' };
  const trackStyle = { position: 'relative', height: 6, borderRadius: 4, background: '#e2e8f0', margin: '10px 8px', cursor: 'pointer' };
  const fillStyle = { position: 'absolute', height: '100%', left: `${loPercent}%`, width: `${hiPercent - loPercent}%`, background: '#3b82f6', borderRadius: 4 };
  const handleStyle = (pct) => ({
    position: 'absolute', top: '50%', left: `${pct}%`,
    transform: 'translate(-50%, -50%)',
    width: 18, height: 18, borderRadius: '50%',
    background: 'white', border: '2px solid #3b82f6',
    boxShadow: '0 1px 4px rgba(0,0,0,0.2)', cursor: 'grab',
  });

  return (
    <div style={{ padding: '12px 8px 4px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <input type="number" value={lo} onChange={handleLoInput} step="0.01" style={inputStyle} />
        <span style={{ fontSize: 11, color: '#1e40af', fontWeight: 600 }}>{col.label}</span>
        <input type="number" value={hi} onChange={handleHiInput} step="0.01" style={inputStyle} />
      </div>
      <div ref={trackRef} style={trackStyle}>
        <div style={fillStyle} />
        <div style={handleStyle(loPercent)} onMouseDown={onMouseDown('lo')} />
        <div style={handleStyle(hiPercent)} onMouseDown={onMouseDown('hi')} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#64748b', marginTop: 4 }}>
        <span>Min: {min}</span><span>Max: {max}</span>
      </div>
    </div>
  );
};

const FilterDropdown = ({ column, currentFilters, onApply, onClose, position, city, baseFilter, columnFilters, onRangePreview, datasetKind, localRows }) => {
  const isSpecialized = datasetKind === "specialized";
  const isNumericCol = !isSpecialized && NUMERIC_COLS.includes(column.key);
  const [selected, setSelected] = useState(currentFilters || []);
  const [distinctValues, setDistinctValues] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [rangeValue, setRangeValue] = useState(null); // [lo, hi] for numeric

  const sortDistinctValues = (values) => {
    if (isNumericCol) return values; // skip sort for numeric — only need min/max
    return values.slice().sort((a, b) => {
      const aNum = Number(a);
      const bNum = Number(b);
      const aIsNum = Number.isFinite(aNum);
      const bIsNum = Number.isFinite(bNum);
      if (aIsNum && bIsNum) return aNum - bNum;
      if (aIsNum) return -1;
      if (bIsNum) return 1;
      return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
    });
  };

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    if (isSpecialized) {
      const rows = Array.isArray(localRows) ? localRows : [];
      const uniq = new Set();
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const v = row[column.key];
        if (v === null || v === undefined || v === "") continue;
        uniq.add(String(v));
      }
      const values = sortDistinctValues(Array.from(uniq));
      if (active) {
        setDistinctValues(values);
        setLoading(false);
      }
      return () => {
        active = false;
      };
    }

    const otherFilters = { ...columnFilters };
    delete otherFilters[column.key];

    const colParts = Object.entries(otherFilters).map(([colKey, vals]) => {
      if (!vals) return null;
      if (vals?.type === "range") return vals.cql;
      if (vals.length === 0) return null;
      const numericColumns = ["road_id", "yoc", "row_meter", "carriage_w", "length_km"];
      const isNum = numericColumns.includes(colKey);
      if (isNum) {
        return `${colKey} IN (${vals.map(v => String(v)).join(",")})`;
      } else {
        return `${colKey} IN (${vals.map(v => `'${String(v).replace(/'/g, "''")}'`).join(",")})`;
      }
    }).filter(Boolean);

    const parts = [];
    if (baseFilter && baseFilter !== "INCLUDE") parts.push(baseFilter);
    if (colParts.length > 0) parts.push(colParts.join(" AND "));
    const filterStr = parts.join(" AND ");

    const url = `/api/road-networks/${city}/distinct/${column.key}?filter=${encodeURIComponent(filterStr)}${isNumericCol ? "&numeric=true" : ""}`;

    fetch(url)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(data => {
        if (active) {
          if (data.error) { setError(data.error); setLoading(false); return; }
          const raw = (Array.isArray(data) ? data : [])
            .filter(v => v !== null && v !== undefined && v !== "");

          if (isNumericCol) {
            const nums = raw.map(Number).filter(Number.isFinite);
            const minV = nums.length ? Math.min(...nums) : 0;
            const maxV = nums.length ? Math.max(...nums) : 0;
            setDistinctValues([minV, maxV]);
            setRangeValue([minV, maxV]);
          } else {
            const valid = raw.map(v => {
              if (["row_meter", "carriage_w", "length_km"].includes(column.key)) return Number(v).toFixed(2);
              return String(v);
            });
            setDistinctValues(sortDistinctValues(valid));
          }
          setLoading(false);
        }
      })
      .catch(err => {
        console.error("Error fetching distinct values:", err);
        if (active) { setError(err.message); setLoading(false); }
      });

    return () => { active = false; };
  }, [column.key, city, baseFilter, columnFilters, isSpecialized, localRows]);

  const filteredValues = isNumericCol ? [] : distinctValues.filter(val =>
    val.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const toggleValue = (val) => {
    setSelected((prev) =>
      prev.includes(val) ? prev.filter((v) => v !== val) : [...prev, val]
    );
  };

  // Numeric min/max from stored [min,max] pair
  const numMin = isNumericCol && distinctValues.length === 2 ? Number(distinctValues[0]) : 0;
  const numMax = isNumericCol && distinctValues.length === 2 ? Number(distinctValues[1]) : 0;

  const buildCombinedFilter = (range) => {
    const otherFilters = { ...columnFilters };
    delete otherFilters[column.key];

    const colParts = Object.entries(otherFilters).map(([colKey, vals]) => {
      if (!vals) return null;
      if (vals?.type === "range") return vals.cql;
      if (vals.length === 0) return null;
      const numericColumns = ["road_id", "yoc", "row_meter", "carriage_w", "length_km"];
      const isNum = numericColumns.includes(colKey);
      if (isNum) {
        return `${colKey} IN (${vals.map(v => String(v)).join(",")})`;
      }
      return `${colKey} IN (${vals.map(v => `'${String(v).replace(/'/g, "''")}'`).join(",")})`;
    }).filter(Boolean);

    const parts = [];
    if (baseFilter && baseFilter !== "INCLUDE") parts.push(baseFilter);
    if (colParts.length > 0) parts.push(colParts.join(" AND "));
    if (range && Number.isFinite(range[0]) && Number.isFinite(range[1])) {
      parts.push(`${column.key} >= ${range[0]} AND ${column.key} <= ${range[1]}`);
    }
    return parts.join(" AND ");
  };

  return (
    <div
      className="filter-dropdown"
      style={{
        position: "fixed",
        zIndex: 100002,
        top: position.top,
        bottom: position.bottom,
        left: position.left,
        maxHeight: position.maxHeight ? `${position.maxHeight}px` : "300px",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "white",
        boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
        borderRadius: "8px",
        border: "1px solid #e2e8f0",
        minWidth: "220px",
        maxWidth: "240px",
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {!isNumericCol && (
        <div style={{ padding: "8px", borderBottom: "1px solid #eee" }}>
          <input
            type="text"
            placeholder={`Search ${column.label}...`}
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            style={{ width: "100%", padding: "4px", borderRadius: 4, border: "1px solid #e2e8f0" }}
            autoFocus
          />
        </div>
      )}

      <div style={{ overflowY: isNumericCol ? "hidden" : "auto", flex: 1, padding: isNumericCol ? 0 : "8px" }}>
        {loading ? (
          <div style={{ padding: "12px", color: "#666", fontSize: 13 }}>Loading...</div>
        ) : error ? (
          <div style={{ padding: "8px", color: "red", fontSize: 12 }}>Error: {error}</div>
        ) : isNumericCol ? (
          <RangeSlider
            col={column}
            min={numMin}
            max={numMax}
            value={rangeValue || [numMin, numMax]}
            onChange={(nextRange) => {
              setRangeValue(nextRange);
              if (onRangePreview) {
                onRangePreview(buildCombinedFilter(nextRange));
              }
            }}
          />
        ) : filteredValues.length > 0 ? (
          <>
            <label style={{ display: "block", marginBottom: "6px", cursor: "pointer", fontSize: 13, fontWeight: 600, color: "#3b82f6", borderBottom: "1px solid #e2e8f0", paddingBottom: 4 }}>
              <input
                type="checkbox"
                checked={selected.length === filteredValues.length && filteredValues.length > 0}
                onChange={() => {
                  if (selected.length === filteredValues.length) {
                    setSelected([]);
                  } else {
                    setSelected([...filteredValues]);
                  }
                }}
              />{" "}
              {selected.length === filteredValues.length ? "Deselect All" : "Select All"}
              <span style={{ fontSize: 11, color: "#94a3b8", marginLeft: 6 }}>({filteredValues.length})</span>
            </label>
            {filteredValues.map((val) => (
              <label key={val} style={{ display: "block", marginBottom: "4px", cursor: "pointer", fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={selected.includes(val)}
                  onChange={() => toggleValue(val)}
                />{" "}
                {val}
              </label>
            ))}
          </>
        ) : (
          <div style={{ padding: "8px", color: "#999", fontSize: 13 }}>No options found</div>
        )}
      </div>

      <div className="filter-actions" style={{ borderTop: "1px solid #e2e8f0", padding: "8px", display: "flex", justifyContent: "space-between", background: "#fff", borderRadius: "0 0 8px 8px", gap: 6 }}>
        <button
          className="filter-btn clear-btn"
          style={{ flex: 1, padding: "5px 8px", background: "transparent", border: "1px solid #cbd5e1", borderRadius: 6, cursor: "pointer", fontSize: 12, color: "#475569" }}
          onClick={() => {
            setSelected([]);
            setRangeValue(numMin !== numMax ? [numMin, numMax] : null);
            onApply([]);
            if (onRangePreview) onRangePreview("");
            onClose();
          }}
        >
          Clear
        </button>
        <button
          className="filter-btn apply-btn"
          style={{ flex: 1, padding: "5px 8px", background: "#3b82f6", color: "white", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600 }}
          onClick={() => {
            if (isNumericCol && rangeValue) {
              const [lo, hi] = rangeValue;
              if (Number.isFinite(lo) && Number.isFinite(hi)) {
                onApply(`${column.key} >= ${lo} AND ${column.key} <= ${hi}`);
              } else {
                onApply([]);
              }
            } else {
              onApply(selected);
            }
            if (onRangePreview) onRangePreview("");
            onClose();
          }}
        >
          Apply
        </button>
      </div>
    </div>
  );
};

const DashboardPage = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const queryParams = new URLSearchParams(location.search);
  const city = (queryParams.get("city") || "Lucknow").toLowerCase();

  // A field-task deep link (KMC/iGile redirect) carries project_id/user_id
  // alongside mode=CHAINAGE — a plain manual "Chainage" button click never
  // has these. This is what distinguishes "someone was sent here to work on
  // one specific patch" from "a logged-in user is browsing Chainage mode
  // normally," which is why the whole restricted-chrome/scoped-data mode
  // below hangs off this specific combination, not just `mode` alone.
  const urlProjectId = queryParams.get("project_id");
  const urlUserId = queryParams.get("user_id");
  const urlZone = queryParams.get("zone");
  const urlWard = queryParams.get("ward");
  const urlTaskTitle = queryParams.get("title");
  const isFieldTaskMode =
    queryParams.get("mode") === "CHAINAGE" && !!(urlProjectId && urlUserId);

  useEffect(() => {
    logEvent("dashboard_opened", { city });
  }, [city]);

  const [showRoadSearch, setShowRoadSearch] = useState(false);
  // const [roadOptions, setRoadOptions] = useState([]);
  const [selectedRoad, setSelectedRoad] = useState("");

  // Shared by roadFilter/baseFilter's initial state just below — field-task
  // deep links need this value available synchronously on the very first
  // render, not one tick later via the "combine filters" effect further
  // down. roadFilter in particular is read directly by MapContainer's own
  // effects (the WFS hit-test fetch, the road layer's CQL) — if it started
  // at "" and only got the real value a render later, those effects fired
  // at least once fully unfiltered (a real, observed burst of "every road
  // in the city" requests) before catching up.
  const computeFieldTaskZoneWardFilter = () => {
    const params = new URLSearchParams(location.search);
    if (params.get("mode") !== "CHAINAGE") return "";
    const rawZone = params.get("zone");
    const rawWard = params.get("ward");
    const zoneNum = rawZone ? Number(rawZone) : NaN;
    const wardNum = rawWard ? Number(rawWard) : NaN;
    const parts = [];
    if (Number.isFinite(zoneNum)) parts.push(`zone_no=${zoneNum}`);
    if (Number.isFinite(wardNum)) parts.push(`ward_no=${wardNum}`);
    return parts.length ? parts.join(" AND ") : "";
  };
  const [roadFilter, setRoadFilter] = useState(computeFieldTaskZoneWardFilter); // ⭐ FILTER FOR WMS LAYER
  const [zoomFilter, setZoomFilter] = useState(""); // ⭐ FILTER FOR AUTO-ZOOM
  // Field-task deep links seed the road table/road-layer filter straight
  // from the URL's zone/ward on first render — without this, the table's
  // own data-fetch effect (driven entirely by baseFilter/roadFilter) has no
  // idea a specific zone/ward was requested and would load/export the
  // whole city's ~30k roads instead of the one patch task's area.
  const [baseFilter, setBaseFilter] = useState(computeFieldTaskZoneWardFilter); // ⭐ NEW: Base filter from Sidebar/Search
  // Starts as just the URL's own ward (fast, matches the initial baseFilter
  // above) then widens once /adjacent-wards resolves — loading roads for
  // the assigned ward plus whichever wards actually border it keeps the
  // "reduce load" goal while still showing a sensible working area instead
  // of a single ward isolated with no surrounding context.
  const [fieldTaskWardList, setFieldTaskWardList] = useState(() =>
    isFieldTaskMode && urlWard ? [String(urlWard)] : []
  );
  useEffect(() => {
    if (!isFieldTaskMode || !urlZone || !urlWard) return;
    let cancelled = false;
    fetch(
      `/api/road-networks/${city}/adjacent-wards?zone=${encodeURIComponent(urlZone)}&ward=${encodeURIComponent(urlWard)}`
    )
      .then((res) => (res.ok ? res.json() : []))
      .then((rows) => {
        if (cancelled) return;
        const wards = Array.isArray(rows)
          ? [...new Set(rows.map((r) => String(r.ward_no)).filter(Boolean))]
          : [];
        if (wards.length) setFieldTaskWardList(wards);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isFieldTaskMode, city, urlZone, urlWard]);
  // Recomputed whenever fieldTaskWardList changes (single ward → widened
  // adjacency list) so both the "still untouched default" zoom-guard below
  // and the effect that pushes this into baseFilter stay in sync through
  // that transition.
  const fieldTaskDefaultFilter = isFieldTaskMode
    ? (() => {
        const zoneNum = urlZone ? Number(urlZone) : NaN;
        const parts = [];
        if (Number.isFinite(zoneNum)) parts.push(`zone_no=${zoneNum}`);
        const wardNums = fieldTaskWardList.map(Number).filter(Number.isFinite);
        if (wardNums.length === 1) parts.push(`ward_no=${wardNums[0]}`);
        else if (wardNums.length > 1) parts.push(`ward_no IN (${wardNums.join(",")})`);
        return parts.length ? parts.join(" AND ") : null;
      })()
    : null;
  useEffect(() => {
    if (!isFieldTaskMode || !fieldTaskDefaultFilter) return;
    setBaseFilter(fieldTaskDefaultFilter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldTaskDefaultFilter, isFieldTaskMode]);
  const [queryVersion, setQueryVersion] = useState(0);
  const [showChainage, setShowChainage] = useState(false); //chainage
  // In-place Chainage mode toggle — replaces navigating to a separate
  // /chainage page. "/chainage" deep links (e.g. from the mobile field-task
  // app) redirect here with ?mode=CHAINAGE preserved, so this also picks
  // that up on load. //chainage
  const [mode, setMode] = useState(() =>
    new URLSearchParams(location.search).get("mode") === "CHAINAGE" ? "CHAINAGE" : "DASHBOARD"
  ); //chainage
  const handleChainageToggle = () => {
    setMode((m) => {
      if (m === "CHAINAGE") return "DASHBOARD";
      if (!hasVisibleRoadLayer) {
        mapRef.current?.showFeatureNotice?.({
          feature: "Chainage",
          message: "Please open a road layer first — patch creation only works on a road layer.",
          dedupeKey: `chainage-no-road-layer|${city}|${Date.now()}`,
          autoDismissMs: 4500,
        });
        return m;
      }
      return "CHAINAGE";
    });
  }; //chainage

  // ⭐ NEW: Generic Layer Filters (for Attribute Query)
  const [layerFilters, setLayerFilters] = useState({});

  // ⭐ NEW: Draw Mode State (for Spatial Query)
  const [drawMode, setDrawMode] = useState(null); // { layer: "...", type: "Polygon" }

  // ⭐ Lifted state for LayerSwitcher target to ensure it exists before Map uses it
  const mapRef = useRef(null);
  const [baseMap, setBaseMap] = useState("osm");
  const [overlayVisibility, setOverlayVisibility] = useState({
    zoneBoundary: true,
    wardBoundary: true,
  });
  const [layerVisibility, setLayerVisibility] = useState({
    network: {}, // Roads OFF by default per user request
    amenities: {},
    others: {},
    lclu: {},
    roadClassifications: {},
    specializedOptions: {}, // e.g. { sewage: 'diameter' }
  });
  // Chainage/patch creation only makes sense once some road layer is on the
  // map — it needs a road to click. Covers the main Road Network toggle, any
  // road-classification (category) layer, and the "INCLUDE" sentinel
  // baseFilter uses when roads are shown via a filter/summary-chart click. //chainage
  const hasVisibleRoadLayer =
    !!layerVisibility?.network?.roads ||
    Object.values(layerVisibility?.roadClassifications || {}).some(Boolean) ||
    baseFilter === "INCLUDE" ||
    (!!roadFilter && roadFilter.trim() !== ""); //chainage
  const [currentPage, setCurrentPage] = useState(1);
  // Field-task/KMC deep-link sessions (the "redirection page") get a
  // smaller page size - that flow is used on phones in the field, where a
  // 100-row page is unwieldy. The normal dashboard table keeps 100.
  const recordsPerPage = isFieldTaskMode ? 25 : 100;
  // Live extent sync: [minLon, minLat, maxLon, maxLat] of the map's current
  // viewport, reported (debounced) by MapContainer via onMapExtentChange.
  const [mapExtent, setMapExtent] = useState(null);
  const handleMapExtentChange = useCallback((extent) => {
    setMapExtent((prev) => {
      if (prev && prev.length === 4 && extent.every((v, i) => Math.abs(v - prev[i]) < 1e-6)) {
        return prev;
      }
      return extent;
    });
  }, []);
  const [isTableMinimized, setIsTableMinimized] = useState(false);
  const [selectedRoadId, setSelectedRoadId] = useState(null);
  const [selectedRoadIds, setSelectedRoadIds] = useState([]);
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);

  const normalizeLayerName = (value) => String(value || "").replace(/\s*:\s*/g, ":").trim();

  // ⭐ NEW: table data state
  const [tableDataset, setTableDataset] = useState({
    kind: "roads",
    title: "Road Network",
    networkId: null,
    option: null,
    layerName: null,
    columns: null,
  });
  const [tableRows, setTableRows] = useState([]);
  const [globalTableMetrics, setGlobalTableMetrics] = useState({ total_roads: 0, total_length_km: 0 });
  const [liveTableMetrics, setLiveTableMetrics] = useState(null);
  const liveMetricsRef = useRef({ requestId: 0, controller: null });
  const liveMetricsTimerRef = useRef(null);
  const [shouldFetchTable, setShouldFetchTable] = useState(true);
  const [columnFilters, setColumnFilters] = useState({});
  const [specializedAllRows, setSpecializedAllRows] = useState([]);
  const [specializedColumnFilters, setSpecializedColumnFilters] = useState({});
  const [isLoading, setIsLoading] = useState(false); // ⭐ NEW: Global loading state
  const [loadingLabels, setLoadingLabels] = useState([]); // Friendly names of whatever's currently loading
  // Reference-counted loading registry: any number of independent things
  // (map tiles/layers, table fetches, future features) can be loading at
  // once — each keeps its own key so one finishing early doesn't hide the
  // indicator while another is still in flight. To show a spinner/loading
  // strip for a new feature, just call beginLoading('myKey', 'Friendly
  // label') / endLoading('myKey') around it; no other wiring needed.
  const loadingRegistryRef = useRef(new Map());
  const loadingStartedAtRef = useRef(new Map());
  const recomputeLoading = useCallback(() => {
    const labels = Array.from(new Set(loadingRegistryRef.current.values()));
    setLoadingLabels(labels);
    setIsLoading(labels.length > 0);
  }, []);
  const beginLoading = useCallback((key, label) => {
    loadingRegistryRef.current.set(key, label || "Loading");
    loadingStartedAtRef.current.set(key, performance.now());
    // "map" is logged with per-layer detail by mapLoadingTracker.js already
    // — logging it again here would just be a redundant, less-detailed
    // duplicate of the same event.
    if (key !== "map") logEvent("table_load_start", { key, label });
    recomputeLoading();
  }, [recomputeLoading]);
  const endLoading = useCallback((key) => {
    loadingRegistryRef.current.delete(key);
    const startedAt = loadingStartedAtRef.current.get(key);
    loadingStartedAtRef.current.delete(key);
    if (key !== "map" && startedAt !== undefined) {
      logEvent("table_load_end", { key, durationMs: Math.round(performance.now() - startedAt) });
    }
    recomputeLoading();
  }, [recomputeLoading]);
  const handleMapLoadingChange = useCallback((loading, labels) => {
    if (loading) beginLoading("map", (labels && labels.length ? labels : ["map"]).join(", "));
    else endLoading("map");
  }, [beginLoading, endLoading]);
  const [isDownloading, setIsDownloading] = useState(false); // ⭐ Download in progress
  const [activeFilterColumn, setActiveFilterColumn] = useState(null);
  const [filterPosition, setFilterPosition] = useState(null);
  const prevTableStateRef = useRef(null);
  const lastStableStateRef = useRef(null);
  const mapFilterActiveRef = useRef(false);
  const lastFilterSourceRef = useRef(null);
  const tableFetchIdRef = useRef(0);
  const capturePrevState = useCallback(() => {
    const map =
      mapRef.current?.instance || mapRef.current?.map || mapRef.current;
    const view = map?.getView ? map.getView() : null;
    return {
      baseFilter,
      columnFilters,
      roadFilter,
      zoomFilter,
      tableRows,
      currentPage,
      selectedRoad,
      selectedRoadId,
      selectedRoadIds,
      isMultiSelectMode,
      layerVisibility,
      mapView: view
        ? {
          center: view.getCenter(),
          zoom: view.getZoom(),
          rotation: view.getRotation(),
        }
        : null,
    };
  }, [
    baseFilter,
    columnFilters,
    roadFilter,
    zoomFilter,
    tableRows,
    currentPage,
    selectedRoad,
    selectedRoadId,
    selectedRoadIds,
    isMultiSelectMode,
    layerVisibility,
  ]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = () => {
      setActiveFilterColumn(null);
      setFilterPosition(null);
    };
    window.addEventListener("click", handleClickOutside);
    return () => window.removeEventListener("click", handleClickOutside);
  }, []);

  const roadTableColumns = [
    { label: "Road Id", key: "road_id" },
    { label: "Zone No.", key: "zone_no", filterable: true },
    { label: "Zone Name", key: "zone_name" },
    { label: "Ward No.", key: "ward_no", filterable: true },
    { label: "Ward Name", key: "ward_name" },
    { label: "Ownership", key: "ownership", filterable: true },
    { label: "Road Name", key: "road_name" },
    { label: "Condition", key: "condition", filterable: true },
    { label: "Category", key: "category", filterable: true },
    { label: "Material", key: "material", filterable: true },
    { label: "Years Of Constructions", key: "yoc", filterable: true },
    { label: "Scheme", key: "cus_class", filterable: true },
    { label: "Row(m)", key: "row_meter", filterable: true },
    { label: "Carriage Way", key: "carriage_w", filterable: true },
    { label: "Length (km)", key: "length_km", filterable: true },
  ];

  const formatGenericColumnLabel = (value) =>
    String(value || "")
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());

  const genericTableColumns = useMemo(() => {
    if (tableDataset.kind !== "specialized") return [];

    const payloadColumns = Array.isArray(tableDataset.columns) ? tableDataset.columns : null;
    const hidden = new Set(["geometry", "geom", "gid", "id"]);

    const baseKeys = (payloadColumns && payloadColumns.length > 0)
      ? payloadColumns.filter((k) => k && !hidden.has(String(k).toLowerCase()))
      : (() => {
        const keys = new Set();
        (tableRows || []).slice(0, 50).forEach((row) => {
          if (!row || typeof row !== "object") return;
          Object.keys(row).forEach((k) => {
            if (!k) return;
            if (hidden.has(String(k).toLowerCase())) return;
            keys.add(k);
          });
        });
        return Array.from(keys);
      })();

    const order = Array.isArray(tableDataset.columnOrder) ? tableDataset.columnOrder : null;
    const labelMap =
      tableDataset.columnLabelMap && typeof tableDataset.columnLabelMap === "object"
        ? tableDataset.columnLabelMap
        : null;
    if (order && order.length > 0) {
      const present = new Set(baseKeys);
      const ordered = order.filter((k) => present.has(k));
      const remaining = baseKeys.filter((k) => !ordered.includes(k));
      const finalKeys = [...ordered, ...remaining];
      return finalKeys.map((key) => ({
        label: (labelMap && labelMap[key]) ? labelMap[key] : formatGenericColumnLabel(key),
        key,
        filterable: true,
      }));
    }

    return baseKeys.map((key) => ({ label: formatGenericColumnLabel(key), key, filterable: true }));
  }, [tableDataset.kind, tableDataset.columns, tableDataset.columnOrder, tableDataset.columnLabelMap, tableRows]);

  const tableColumns = tableDataset.kind === "specialized" ? genericTableColumns : roadTableColumns;

  // ⭐ NEW: Combine Base Filter + Column Filters
  useEffect(() => {
    // 1. Build CQL from column filters
    const colParts = Object.entries(columnFilters).map(([colKey, vals]) => {
      if (!vals) return null;
      if (vals?.type === "range") return vals.cql;
      if (vals.length === 0) return null;

      const numericColumns = ["road_id", "yoc", "row_meter", "carriage_w", "length_km"];
      const isNumeric = numericColumns.includes(colKey);

      if (isNumeric) {
        const inClause = vals.map(v => String(v)).join(",");
        return `${colKey} IN (${inClause})`;
      } else {
        const inClause = vals.map(v => `'${String(v).replace(/'/g, "''")}'`).join(",");
        return `${colKey} IN (${inClause})`;
      }
    }).filter(Boolean);

    const colCql = colParts.length > 0 ? colParts.join(" AND ") : "";

    // 2. Combine with Base Filter
    const parts = [];
    if (baseFilter) parts.push(baseFilter);
    if (colCql) parts.push(colCql);

    const finalFilter = parts.join(" AND ");

    setRoadFilter(finalFilter);

    // Sync zoom filter if main filter changes (except when clicking rows which handles zoom separately)
    // Note: We check if finalFilter differs to avoid loops, though setRoadFilter does that too.
    const isUntouchedFieldTaskDefault =
      fieldTaskDefaultFilter &&
      finalFilter === fieldTaskDefaultFilter &&
      lastFilterSourceRef.current === null;
    if (finalFilter !== roadFilter && lastFilterSourceRef.current !== "map" && !isUntouchedFieldTaskDefault) {
      setZoomFilter(finalFilter);
    }
  }, [baseFilter, columnFilters, queryVersion, fieldTaskDefaultFilter]); // Removed roadFilter from dependency to avoid loop

  const requestLiveMetrics = useCallback((filterExpr) => {
    if (liveMetricsTimerRef.current) {
      clearTimeout(liveMetricsTimerRef.current);
    }
    if (!filterExpr || !String(filterExpr).trim()) {
      if (liveMetricsRef.current.controller) {
        liveMetricsRef.current.controller.abort();
        liveMetricsRef.current.controller = null;
      }
      setLiveTableMetrics(null);
      return;
    }
    liveMetricsTimerRef.current = setTimeout(() => {
      if (liveMetricsRef.current.controller) {
        liveMetricsRef.current.controller.abort();
      }
      const controller = new AbortController();
      const requestId = liveMetricsRef.current.requestId + 1;
      liveMetricsRef.current = { requestId, controller };
      fetch(`/api/road-networks/${city}/details?filter=${encodeURIComponent(filterExpr)}&page=1&limit=1`, { signal: controller.signal })
        .then((res) => res.json())
        .then((data) => {
          if (controller.signal.aborted) return;
          if (requestId !== liveMetricsRef.current.requestId) return;
          setLiveTableMetrics({
            total_roads: data.total || 0,
            total_length_km: data.total_length_km || 0
          });
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          console.error("Live metrics error:", err);
        });
    }, 300);
  }, [city]);

  useEffect(() => {
    if (!activeFilterColumn) {
      setLiveTableMetrics(null);
    }
  }, [activeFilterColumn]);

  useEffect(() => {
    setLiveTableMetrics(null);
  }, [roadFilter]);

  useEffect(() => () => {
    if (liveMetricsTimerRef.current) clearTimeout(liveMetricsTimerRef.current);
    if (liveMetricsRef.current.controller) liveMetricsRef.current.controller.abort();
  }, []);

  const applySpecializedFilters = useCallback((rows, filters) => {
    const src = Array.isArray(rows) ? rows : [];
    const entries = Object.entries(filters || {}).filter(([, v]) => Array.isArray(v) && v.length > 0);
    if (entries.length === 0) return src;

    return src.filter((row) => {
      if (!row || typeof row !== "object") return false;
      for (const [colKey, vals] of entries) {
        const cell = row[colKey];
        const cellStr = cell === null || cell === undefined ? "" : String(cell);
        if (!vals.map(String).includes(cellStr)) return false;
      }
      return true;
    });
  }, []);

  const specializedLayerNameRef = useRef(null);
  const buildSpecializedCqlFilter = useCallback((filters) => {
    const entries = Object.entries(filters || {}).filter(([, v]) => Array.isArray(v) && v.length > 0);
    if (!entries.length) return "";
    const numericRe = /^-?\d+(?:\.\d+)?$/;
    return entries
      .map(([key, vals]) => {
        const parts = vals.map((v) => String(v).trim()).filter(Boolean);
        if (!parts.length) return null;
        const isNumeric = parts.every((v) => numericRe.test(v));
        if (isNumeric) return `${key} IN (${parts.join(",")})`;
        const quoted = parts.map((v) => `'${v.replace(/'/g, "''")}'`).join(",");
        return `${key} IN (${quoted})`;
      })
      .filter(Boolean)
      .join(" AND ");
  }, []);

  useEffect(() => {
    if (tableDataset.kind !== "specialized") {
      const prevLayer = specializedLayerNameRef.current;
      if (prevLayer) {
        setLayerFilters((prev) => {
          const next = { ...prev };
          delete next[prevLayer];
          return next;
        });
        specializedLayerNameRef.current = null;
      }
      return;
    }

    const layerName = normalizeLayerName(tableDataset.layerName);
    if (!layerName) return;

    const prevLayer = specializedLayerNameRef.current;
    if (prevLayer && prevLayer !== layerName) {
      setLayerFilters((prev) => {
        const next = { ...prev };
        delete next[prevLayer];
        return next;
      });
    }
    specializedLayerNameRef.current = layerName;

    const cql = buildSpecializedCqlFilter(specializedColumnFilters);
    setLayerFilters((prev) => {
      const next = { ...prev };
      if (cql) next[layerName] = cql;
      else delete next[layerName];
      return next;
    });

    const networkId = tableDataset.networkId;
    if (networkId) {
      setLayerVisibility((prev) => {
        const next = { ...prev };
        next.network = { ...(prev.network || {}), [networkId]: true };
        if (tableDataset.option) {
          next.specializedOptions = {
            ...(prev.specializedOptions || {}),
            [networkId]: tableDataset.option,
          };
        }
        return next;
      });
    }
  }, [
    tableDataset.kind,
    tableDataset.layerName,
    tableDataset.networkId,
    tableDataset.option,
    specializedColumnFilters,
    buildSpecializedCqlFilter,
  ]);

  const handleColumnFilterChange = (key, selectedValues) => {
    if (tableDataset.kind === "specialized") {
      const newFilters = { ...specializedColumnFilters };
      if (Array.isArray(selectedValues) && selectedValues.length > 0) {
        newFilters[key] = selectedValues.map(String);
      } else {
        delete newFilters[key];
      }
      setSpecializedColumnFilters(newFilters);
      const nextRows = applySpecializedFilters(specializedAllRows, newFilters);
      setTableRows(nextRows);
      setGlobalTableMetrics({ total_roads: nextRows.length, total_length_km: 0 });
      setCurrentPage(1);
      setActiveFilterColumn(null);
      setFilterPosition(null);
      setShouldFetchTable(true);
      setIsTableMinimized(false);
      return;
    }

    lastFilterSourceRef.current = "table";
    setTableDataset({ kind: "roads", title: "Road Network", networkId: null, option: null, layerName: null });
    const newFilters = { ...columnFilters };
    const isRangeFilter = typeof selectedValues === "string" && selectedValues.includes(">=");
    if (selectedValues && selectedValues.length > 0) {
      newFilters[key] = isRangeFilter
        ? { type: "range", cql: selectedValues }
        : selectedValues;
    } else {
      delete newFilters[key];
    }
    if (Object.keys(columnFilters).length === 0 && Object.keys(newFilters).length > 0 && !prevTableStateRef.current) {
      prevTableStateRef.current = capturePrevState();
    }
    if (Object.keys(newFilters).length === 0) {
      prevTableStateRef.current = null;
    }
    setColumnFilters(newFilters);
    setLiveTableMetrics(null);
    if (Object.keys(newFilters).length > 0) {
      setLayerVisibility((prev) => ({
        ...prev,
        roadClassifications: {},
        network: {
          ...prev.network,
          roads: true
        }
      }));
    }
    setActiveFilterColumn(null); // Close dropdown
    setFilterPosition(null);
    setShouldFetchTable(true);
    setIsTableMinimized(false);
  };

  useEffect(() => {
    if (!mapFilterActiveRef.current) {
      lastStableStateRef.current = capturePrevState();
    }
  }, [capturePrevState]);

  // ⭐ NEW: Store analysis results per layer
  const [analysisResults, setAnalysisResults] = useState({});

  const handleAnalysisDataLoaded = (id, data) => {
    setAnalysisResults(prev => {
      const next = { ...prev };
      if (data) {
        next[id] = data;
      } else {
        delete next[id];
      }
      return next;
    });
  };

  // ⭐ NEW: Effect to update tableRows when analysisResults change
  useEffect(() => {
    if (tableDataset.kind === "specialized") return;

    const analysisRows = Object.values(analysisResults).flat();

    // Only update if we are NOT using a road filter (search mode)
    // If roadFilter is active, it takes precedence in the other effect
    if (!roadFilter) {
      if (analysisRows.length > 0) {
        setTableDataset({ kind: "analysis", title: "Analysis", networkId: null, option: null, layerName: null });
        setTableRows(analysisRows);
        setCurrentPage(1);
      } else {
        if (tableDataset.kind === "analysis") {
          setTableRows([]);
        }
      }
    }
  }, [analysisResults, roadFilter, tableDataset.kind]);

  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  // ⭐ NEW: Track Road Network Panel visibility
  const [showRoadNetworkPanel, setShowRoadNetworkPanel] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [showChartPanel, setShowChartPanel] = useState(false);
  // Minimize keeps the panel mounted (filters/zones/layers preserved) but
  // visually hidden; only an explicit Close actually resets everything.
  const [chartPanelMinimized, setChartPanelMinimized] = useState(false);
  const handleChartPanelToggle = () => {
    logEvent("chart_panel_toggle", { wasOpen: showChartPanel, wasMinimized: chartPanelMinimized });
    setShowChartPanel((prev) => {
      if (prev && chartPanelMinimized) {
        setChartPanelMinimized(false); // was minimized — restore, don't close
        return true;
      }
      if (prev) return false; // was open — toolbar click closes it fully
      setChartPanelMinimized(false);
      return true; // was closed — open fresh
    });
  };
  const [streetViewVisible, setStreetViewVisible] = useState(false);

  const toggleSidebar = () => {
    setIsSidebarOpen((prev) => {
      logEvent("sidebar_toggle", { opening: !prev });
      return !prev;
    });
  };

  const loadSpecializedNetworkTable = useCallback(
    async (networkId, optionKey) => {
      const cityKey = String(city || "").toLowerCase();
      const cfg = cityConfig[cityKey] || {};
      const specCfg = cfg.specializedNetworks?.[networkId];
      const isGroup = specCfg && typeof specCfg === "object" && specCfg.options;

      if (!isGroup) return;

      if (!optionKey || String(optionKey) === "none") {
        if (tableDataset.kind === "specialized" && tableDataset.networkId === networkId) {
          setTableRows([]);
          setCurrentPage(1);
          setTableDataset({ kind: "roads", title: "Road Network", networkId: null, option: null, layerName: null });
        }
        return;
      }

      const opt = specCfg.options?.[optionKey];
      const layerName = normalizeLayerName(typeof opt === "string" ? opt : (opt?.layer || ""));
      const optLabel = typeof opt === "string" ? optionKey : (opt?.label || optionKey);
      if (!layerName) return;

      setSelectedRoadId(null);
      setSelectedRoadIds([]);
      setIsMultiSelectMode(false);
      setSelectedRoad("");
      setActiveFilterColumn(null);
      setFilterPosition(null);
      setColumnFilters({});
      setSpecializedColumnFilters({});
      setSpecializedAllRows([]);
      setTableRows([]);
      setGlobalTableMetrics({ total_roads: 0, total_length_km: 0 });
      setCurrentPage(1);
      setTableDataset({
        kind: "specialized",
        title: `${specCfg.label || formatGenericColumnLabel(networkId)} (${optLabel})`,
        networkId,
        option: optionKey,
        layerName,
        columns: null,
      });
      setShouldFetchTable(true);
      setIsTableMinimized(false);

      beginLoading("specializedTable", specCfg.label || formatGenericColumnLabel(networkId));
      try {
        const pageLimit = getIsLowBandwidth() ? 500 : 2000;
        const url = `/api/road-networks/${cityKey}/specialized-details?network=${encodeURIComponent(
          networkId
        )}&option=${encodeURIComponent(optionKey)}&layer=${encodeURIComponent(layerName)}&page=1&limit=${pageLimit}`;
        const res = await fetch(url);
        const payload = await res.json();
        if (!res.ok) throw new Error(payload?.error || `HTTP ${res.status}`);

        const rows = payload?.data || [];

        setTableDataset({
          kind: "specialized",
          title: `${specCfg.label || formatGenericColumnLabel(networkId)} (${optLabel})`,
          networkId,
          option: optionKey,
          layerName,
          columns: payload?.columns || null,
        });
        setSpecializedAllRows(rows);
        setTableRows(rows);
        setGlobalTableMetrics({ total_roads: payload?.total || rows.length, total_length_km: 0 });
        setCurrentPage(1);
        setShouldFetchTable(true);
        setIsTableMinimized(false);
      } catch (err) {
        console.error("Specialized network table load error:", err);
      } finally {
        endLoading("specializedTable");
      }
    },
    [city, tableDataset.kind, tableDataset.networkId]
  );

  const handleLayerToggle = (group, id, checked, option = null) => {
    console.log(
      "[Sidebar] Layer toggle",
      "city:",
      city,
      "group:",
      group,
      "id:",
      id,
      "checked:",
      checked,
      "option:",
      option
    );
    logEvent("layer_toggle", { group, id, checked, option });
    if (group === "roadClassifications") {
      if (id === "none") {
        setLayerVisibility((prev) => ({
          ...prev,
          roadClassifications: { none: true },
        }));
        lastFilterSourceRef.current = null;
        mapFilterActiveRef.current = false;
        prevTableStateRef.current = null;
        setBaseFilter("");
        setColumnFilters({});
        setRoadFilter("");
        setZoomFilter("");
        setSelectedRoad("");
        setSelectedRoadId(null);
        setSelectedRoadIds([]);
        setIsMultiSelectMode(false);
        setIsTableMinimized(true);
        setCurrentPage(1);
        setShowRoadNetworkPanel(false);
        setShouldFetchTable(false);
        return;
      }

      setLayerVisibility((prev) => ({
        ...prev,
        roadClassifications: checked ? { [id]: true } : {},
      }));
      return;
    }
    // Only clear road table state when toggling a non-network layer ON
    // AND the road network layer is NOT currently active.
    // If roads are already visible, amenity/others/analysis toggles must NOT
    // destroy the road table data or filters.
    if (checked && group !== "network" && !layerVisibility.network?.roads) {
      lastFilterSourceRef.current = null;
      mapFilterActiveRef.current = false;
      prevTableStateRef.current = null;
      setBaseFilter("");
      setColumnFilters({});
      setZoomFilter("");
      setSelectedRoad("");
      setSelectedRoadId(null);
      setTableRows([]);
      setCurrentPage(1);
    }
    setLayerVisibility((prev) => {
      const next = {
        ...prev,
        [group]: {
          ...(prev[group] || {}),
          [id]: checked,
        },
      };

      if (option && group === "network") {
        next.specializedOptions = {
          ...(prev.specializedOptions || {}),
          [id]: option,
        };
      } else if (checked && group === "network" && !prev.specializedOptions?.[id]) {
        // Set default option if turning on for the first time
        const cfg = cityConfig[city.toLowerCase()]?.specializedNetworks?.[id];
        if (cfg && cfg.options) {
          const defaultOpt = id === "slum" ? "none" : Object.keys(cfg.options)[0];
          next.specializedOptions = {
            ...(prev.specializedOptions || {}),
            [id]: defaultOpt,
          };
        }
      }

      return next;
    });
    if (group === "network" && id === "slum" && checked) {
      if (option) {
        loadSpecializedNetworkTable(id, option);
      }
    }

    if (group === "network" && id === "roads") {
      if (checked) {
        setTableDataset({ kind: "roads", title: "Road Network", networkId: null, option: null, layerName: null });
        // Road layer turned ON → restore table
        setIsTableMinimized(false);
        setShouldFetchTable(true);
        setBaseFilter("INCLUDE");
        setShowRoadNetworkPanel(false);
      } else {
        // Road layer turned OFF → minimize table only, preserve data
        // setTableRows([]) is intentionally NOT called here.
        // Only the × close button may destroy table data.
        setIsTableMinimized(true);
        setBaseFilter("");
        setShowRoadNetworkPanel(false);
      }
    }
  };

  const handleSearchClick = () => {
    const cfg = cityConfig[city.toLowerCase()];
    if (!cfg || !(cfg.roadSearchEnabled || cfg.roadLayer)) {
      alert("Road search is not enabled for this city.");
      return;
    }
    setShowRoadSearch(true);
  };

  const handleLatLngSearch = (coords) => {
    if (!coords) return;
    mapRef.current?.zoomToLatLng?.(coords.lat, coords.lng);
  };

  const handlePlaceSearch = (place) => {
    if (!place) return;
    mapRef.current?.zoomToPlace?.(place);
  };

  // ⭐ LOAD ROAD NAMES FOR SEARCH
  useEffect(() => {
    if (!showRoadSearch) return;

    const cfg = cityConfig[city.toLowerCase()];
    if (!cfg) return;
    const typeName =
      cfg.roadLayer ||
      `Road_Network:${city.charAt(0).toUpperCase() + city.slice(1).toLowerCase()
      }_Road_Network`;
    const wfsUrl = `${GEOSERVER_BASE}/wfs?service=WFS&version=1.1.0&request=GetFeature&typeName=${encodeURIComponent(
      typeName
    )}&propertyName=road_name&outputFormat=application/json`;

    fetch(wfsUrl)
      .then((res) => res.json())
      .then((data) => {
        const names = (data.features || [])
          .map((f) => f.properties?.road_name)
          .filter(Boolean);

        // const unique = Array.from(new Set(names)).sort();
        // setRoadOptions(unique);
      })
      .catch((err) => console.error("Error loading road names:", err));
  }, [showRoadSearch, city]);

  useEffect(() => {
    if (tableDataset.kind !== "roads") return;

    console.log("Table filter effect triggered. roadFilter:", roadFilter);

    if (!roadFilter || roadFilter.trim() === "") {
      console.log("No filter provided, clearing table");
      tableFetchIdRef.current += 1;
      // ⭐ Only clear if no analysis results are present
      if (Object.keys(analysisResults).length === 0) {
        setTableRows([]);
        setCurrentPage(1); // Reset to first page
      }
      return;
    }

    // Skip table fetch for spatial filters (INTERSECTS)
    // The MapContainer handles spatial query results directly via handleSpatialQueryResults
    if (roadFilter.includes("INTERSECTS")) {
      console.log("Skipping table fetch for spatial filter (handled by MapContainer)");
      return;
    }

    if (!shouldFetchTable) {
      console.log("Skipping table fetch as shouldFetchTable is false");
      setTableRows([]);
      return;
    }

    console.log("Fetching table data with filter:", roadFilter);

    const fetchId = tableFetchIdRef.current + 1;
    tableFetchIdRef.current = fetchId;
    const controller = new AbortController();

    beginLoading("roadTable", "Road Network data");
    // Explicit limit (server defaults to 1000 rows when omitted) so a
    // detected slow connection pulls a smaller first batch instead of the
    // full 1000-row page every time the filter changes.
    const roadTableLimit = getIsLowBandwidth() ? 300 : 1000;
    // Live extent sync: whenever the table is open, only ask for roads
    // actually within the current map viewport instead of the whole
    // filtered set - MapContainer reports this (debounced) via
    // onMapExtentChange, so this effect re-fetches as the user pans/zooms.
    const bboxParam = mapExtent ? `&bbox=${encodeURIComponent(mapExtent.join(","))}` : "";
    // A road click typically also pans/zooms the map, which changes
    // mapExtent and re-triggers this same fetch - guarantee the just-
    // clicked/selected road is always in the result (even if its exact
    // geometry sits just outside the computed bbox) by OR-ing it into the
    // server-side filter directly, in the same query. Without this, that
    // second fetch's plain bbox filter can race the separate "missing road"
    // prepend-fetch below and silently drop the road (and its table
    // highlight) right after a click.
    const includeRoadIdParam = (!isMultiSelectMode && selectedRoadId)
      ? `&includeRoadId=${encodeURIComponent(selectedRoadId)}`
      : "";
    fetch(
      `/api/road-networks/${city}/details?filter=${encodeURIComponent(roadFilter)}&limit=${roadTableLimit}${bboxParam}${includeRoadIdParam}`,
      { signal: controller.signal }
    )
      .then((res) => res.json())
      .then((data) => {
        if (fetchId !== tableFetchIdRef.current) return;
        console.log("Table data received:", data);
        setTableRows(data.data || []);
        setGlobalTableMetrics({
          total_roads: data.total || (data.data || []).length,
          total_length_km: data.total_length_km || 0
        });
        endLoading("roadTable");
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        console.error("Table load error:", err);
        endLoading("roadTable");
      });
    return () => controller.abort();
  }, [roadFilter, city, shouldFetchTable, analysisResults, mapExtent, selectedRoadId, isMultiSelectMode]);

  // Pagination calculations
  const indexOfLastRecord = currentPage * recordsPerPage;
  const indexOfFirstRecord = indexOfLastRecord - recordsPerPage;
  const currentRecords = tableRows.slice(indexOfFirstRecord, indexOfLastRecord);
  const totalPages = Math.ceil(tableRows.length / recordsPerPage);

  // Pagination controls
  // const paginate = (pageNumber) => setCurrentPage(pageNumber);
  const goToPreviousPage = () => {
    logEvent("table_page_change", { direction: "previous" });
    setCurrentPage((prev) => Math.max(prev - 1, 1));
  };
  const goToNextPage = () => {
    logEvent("table_page_change", { direction: "next" });
    setCurrentPage((prev) => Math.min(prev + 1, totalPages));
  };

  const getRowSelectionId = (row) =>
    row?.road_id ??
    row?.roadId ??
    row?.roadid ??
    row?.ROAD_ID ??
    null;

  // Field-task mode's multi-road patch selection: fetches roads adjacent to
  // every currently-selected road and narrows the table's own filter down
  // to exactly (selection + candidates) — so picking the next road for the
  // patch only ever means picking from what's already visible in the
  // table, never browsing the whole ward. Growing the selection re-runs
  // this with the new, larger set, which is what makes the candidate pool
  // expand road-by-road along the connected chain instead of staying fixed
  // to the first road's own neighbors.
  const fetchAndApplyMultiRoadCandidates = async (selectedIds) => {
    const wardNums = (fieldTaskWardList || []).map(Number).filter(Number.isFinite);
    const wardsParam = wardNums.length ? `&wards=${wardNums.join(",")}` : "";
    try {
      const results = await Promise.all(
        selectedIds.map((id) =>
          fetch(`/api/road-networks/${city}/adjacent-roads?road_id=${encodeURIComponent(id)}${wardsParam}`)
            .then((res) => (res.ok ? res.json() : []))
            .catch(() => [])
        )
      );
      const candidateIds = new Set(selectedIds.map(String));
      results.forEach((list) => {
        (Array.isArray(list) ? list : []).forEach((r) => candidateIds.add(String(r.road_id)));
      });
      const filter = buildSelectionFilter([...candidateIds]);
      lastFilterSourceRef.current = "table";
      setBaseFilter(filter);
      setQueryVersion((v) => v + 1);
    } catch {
      // Leave the table on whatever filter it already had — worst case the
      // candidate pool just doesn't narrow further this round.
    }
  };

  const handleRowClick = (row) => {
    const rowId = getRowSelectionId(row);

    // No-op if clicking the already-selected road in single-select mode
    if (!isMultiSelectMode && rowId != null && String(rowId) === String(selectedRoadId)) return;

    if (isMultiSelectMode) {
      if (!rowId) return;
      setSelectedRoadIds((prev) => {
        const idStr = String(rowId);
        const next = prev.includes(idStr)
          ? prev.filter((id) => id !== idStr)
          : [...prev, idStr];
        if (isFieldTaskMode && next.length) {
          fetchAndApplyMultiRoadCandidates(next);
        }
        return next;
      });
      return;
    }

    setSelectedRoadIds([]);
    setSelectedRoadId(rowId);
    setSelectedRoad(row?.road_name ?? row?.roadName ?? row?.roadname ?? "");

    // Zoom map to the selected road
    if (rowId != null && rowId !== "") {
      const idStr = String(rowId);
      const isNumeric = /^-?\d+(?:\.\d+)?$/.test(idStr);
      setZoomFilter(isNumeric ? `road_id=${idStr}` : `road_id='${idStr.replace(/'/g, "''")}'`);
    }

    // Field-task mode: table selection opens the same chainage panel a map
    // click would — someone working through the table shouldn't also have
    // to go find and click the road on the map.
    if (isFieldTaskMode && rowId != null && rowId !== "") {
      mapRef.current?.openChainageForRoadId?.(rowId, row);
    }

    // The selected row is highlighted via CSS.
  };

  const restorePrevTableState = () => {
    const isMapSelection =
      mapFilterActiveRef.current ||
      /gis_id\s*=|INTERSECTS\(/i.test(
        String(baseFilter || "")
      );
    const prev = isMapSelection
      ? prevTableStateRef.current ||
      lastStableStateRef.current
      : prevTableStateRef.current;
    if (prev) {
      setBaseFilter(prev.baseFilter);
      setColumnFilters(prev.columnFilters);
      setRoadFilter(prev.roadFilter);
      setZoomFilter(prev.zoomFilter);
      setTableRows(prev.tableRows);
      setCurrentPage(prev.currentPage);
      setSelectedRoad(prev.selectedRoad);
      setSelectedRoadId(prev.selectedRoadId);
      setSelectedRoadIds(prev.selectedRoadIds || []);
      setIsMultiSelectMode(!!prev.isMultiSelectMode);
      setLayerVisibility(prev.layerVisibility);
      setShouldFetchTable(true);
      mapFilterActiveRef.current = false;
      if (prev.mapView) {
        const map =
          mapRef.current?.instance ||
          mapRef.current?.map ||
          mapRef.current;
        const view = map?.getView ? map.getView() : null;
        if (view) {
          view.setCenter(prev.mapView.center);
          view.setZoom(prev.mapView.zoom);
          view.setRotation(prev.mapView.rotation);
        }
      }
      if (mapRef.current?.clearPopup) {
        mapRef.current.clearPopup();
      }
      prevTableStateRef.current = null;
      lastStableStateRef.current = null;
      return true;
    }
    return false;
  };

  // Table-state stacking around the chainage patch table: reuses the same
  // snapshot/restore mechanism as the road-detail table's Back/Close flow
  // above, just triggered from the patch table's own open/close instead. //chainage
  const handlePatchTableOpen = () => {
    prevTableStateRef.current = capturePrevState();
  }; //chainage
  const handlePatchTableClose = () => {
    restorePrevTableState();
  }; //chainage


  const buildSelectionFilter = useCallback((ids) => {
    if (!ids || ids.length === 0) return "";
    const column = "road_id";
    const values = ids.map((id) => String(id).trim()).filter(Boolean);
    const isNumeric = values.length > 0 && values.every((v) => /^-?\d+(?:\.\d+)?$/.test(v));
    const list = isNumeric
      ? values.join(",")
      : values.map((v) => `'${v.replace(/'/g, "''")}'`).join(",");
    return `${column} IN (${list})`;
  }, []);

  const applyMultiSelection = () => {
    if (!selectedRoadIds.length) return;

    if (isFieldTaskMode) {
      // Multi-road patch creation — hand the selected roads to
      // MapContainer's existing preview -> confirm -> save flow (the same
      // one the single-road Create Patch form uses) instead of just
      // filtering the table/map to show them.
      if (selectedRoadIds.length < 2) {
        mapRef.current?.showFeatureNotice?.({
          feature: "Chainage",
          message: "Select at least one more connected road before creating a multi-road patch.",
          dedupeKey: `multi-road-too-few|${Date.now()}`,
          autoDismissMs: 4000,
        });
        return;
      }
      const roadInfos = selectedRoadIds.map((id) => {
        const row = tableRows.find((r) => String(getRowSelectionId(r)) === String(id));
        return { road_id: id, road_name: row?.road_name || row?.roadName || row?.roadname || id };
      });
      mapRef.current?.createMultiRoadPatch?.(roadInfos);
      return;
    }

    if (!prevTableStateRef.current) {
      prevTableStateRef.current = capturePrevState();
    }
    const filter = buildSelectionFilter(selectedRoadIds);
    lastFilterSourceRef.current = "table";
    setBaseFilter(filter);
    setZoomFilter(filter);
    setSelectedRoadId(null);
    setSelectedRoad("");
    setCurrentPage(1);
    setIsTableMinimized(false);
    setShouldFetchTable(true);
  };

  const clearMultiSelection = () => {
    if (isFieldTaskMode) {
      // Drop back to the normal ward-scoped view (target ward + neighbors)
      // instead of the generic "no filter"/"INCLUDE" reset, which would
      // otherwise lose the field-task scope entirely.
      setSelectedRoadIds([]);
      setBaseFilter(fieldTaskDefaultFilter || "");
      setQueryVersion((v) => v + 1);
      if (isMultiSelectMode) {
        setSelectedRoadId(null);
        setSelectedRoad("");
      }
      return;
    }
    if (
      lastFilterSourceRef.current === "table" &&
      /road_id\s+in\s*\(/i.test(String(baseFilter || ""))
    ) {
      if (restorePrevTableState()) return;
      setBaseFilter(layerVisibility?.network?.roads ? "INCLUDE" : "");
      setZoomFilter("");
    }
    setSelectedRoadIds([]);
    if (isMultiSelectMode) {
      setSelectedRoadId(null);
      setSelectedRoad("");
    }
  };

  const toggleMultiSelectMode = () => {
    if (tableDataset.kind !== "roads") return;
    setIsMultiSelectMode((prev) => {
      const next = !prev;
      if (next) {
        if (selectedRoadId !== null && selectedRoadId !== undefined) {
          const seedId = String(selectedRoadId);
          setSelectedRoadIds([seedId]);
          if (isFieldTaskMode) {
            // Narrow the table to the seed road + whatever's actually
            // connected to it — same "adjacent, not everything" principle
            // as the ward scoping, just at road granularity.
            fetchAndApplyMultiRoadCandidates([seedId]);
          }
        } else if (isFieldTaskMode) {
          mapRef.current?.showFeatureNotice?.({
            feature: "Chainage",
            message: "Select a road first, then turn on Multi to add connected roads to the same patch.",
            dedupeKey: `multi-road-no-selection|${Date.now()}`,
            autoDismissMs: 4000,
          });
        }
      } else {
        setSelectedRoadIds([]);
        if (isFieldTaskMode) {
          setBaseFilter(fieldTaskDefaultFilter || "");
          setQueryVersion((v) => v + 1);
        }
      }
      return next;
    });
  };

  const inferClassificationKey = (filterText) => {
    const lower = String(filterText || "").toLowerCase();
    if (lower.includes("condition")) return "condition";
    if (lower.includes("category")) return "category";
    if (lower.includes("material")) return "material";
    if (lower.includes("ownership")) return "ownership";
    if (lower.includes("cus_class")) return "cus";
    if (lower.includes("zone_no")) return "zone";
    if (lower.includes("ward_no")) return "ward";
    return null;
  };

  const handleRoadFilterChange = (filter, source) => {
    setTableDataset({ kind: "roads", title: "Road Network", networkId: null, option: null, layerName: null });
    lastFilterSourceRef.current = source || null;
    if (mapRef.current?.applyRoadFilterImmediate) {
      mapRef.current.applyRoadFilterImmediate(filter);
    }
    const filterText = String(filter || "");
    const isMapFilter =
      source === "map" || /gis_id\s*=|INTERSECTS\(/i.test(filterText);
    if (!isMapFilter) {
      const cfg = cityConfig[city.toLowerCase()] || {};
      const inferred = inferClassificationKey(filterText);
      if (inferred && cfg.roadClassifications?.[inferred]) {
        handleClassificationChange(inferred);
      }
    }
    if (!filter) {
      prevTableStateRef.current = null;
      mapFilterActiveRef.current = false;
      lastFilterSourceRef.current = null;
      setBaseFilter(filter);
      return;
    }
    if (isMapFilter && !prevTableStateRef.current) {
      mapFilterActiveRef.current = true;
      prevTableStateRef.current =
        lastStableStateRef.current || capturePrevState();
    }
    setBaseFilter(filter);
  };

  const handlePopupClosed = () => {
    // Simply clear the road selection and zoom — do NOT restore or refetch table data.
    // The table should remain as-is with the current filter/pagination intact.
    setZoomFilter("");
    setSelectedRoad("");
    setSelectedRoadId(null);
    setSelectedRoadIds([]);
    setIsMultiSelectMode(false);
    setIsTableMinimized(false);
  };

  // ⭐ NEW: Robust pagination and missing road sync
  useEffect(() => {
    // Only run if we actually have data and an active single-road selection
    if (tableRows.length === 0 || !selectedRoadId || isMultiSelectMode) return;

    const idx = tableRows.findIndex(r => String(r.road_id) === String(selectedRoadId));
    if (idx >= 0) {
      const expectedPage = Math.floor(idx / recordsPerPage) + 1;
      if (currentPage !== expectedPage) {
        console.log("[Auto-Pagination] Jumping to page:", expectedPage);
        setCurrentPage(expectedPage);
      }
    } else {
      // Road is selected but not in current 1000 rows. Fetch and prepend!
      console.log("[Auto-Pagination] Road not in current table, fetching it from server...");
      const filter = `road_id='${selectedRoadId}'`;
      fetch(`/api/road-networks/${city}/details?filter=${encodeURIComponent(filter)}`)
        .then(res => res.json())
        .then(data => {
          if (data && data.data && data.data.length > 0) {
            const fetchedRoad = data.data[0];
            setTableRows(prev => {
              if (prev.some(r => String(r.road_id) === String(fetchedRoad.road_id))) return prev;
              return [fetchedRoad, ...prev];
            });
            setCurrentPage(1);
          }
        })
        .catch(err => console.error("[Auto-Pagination] Failed to fetch missing road:", err));
    }
  }, [tableRows, selectedRoadId, isMultiSelectMode, recordsPerPage, city, currentPage]);

  // Table-row-highlight-only counterpart to handleRoadSelectedFromMap, used
  // specifically by field-task mode's chainage click flow (openChainageForRoadId)
  // instead of the full callback above, since that one resets baseFilter/
  // zoomFilter in ways that would fight field-task's own ward-scoped default
  // filter. Mirrors the table's own selection state so clicking a road on the
  // map highlights the same row a table click on that road would.
  //
  // Passing null clears the highlight - this is required, not optional: the
  // road-panel's own close (X) button only clears MapContainer's local
  // selectedRoad state, but this component's own "armed mode" effect
  // re-opens the panel automatically whenever selectedRoadId (this state)
  // is still set and doesn't match the current selectedRoad. Without
  // clearing selectedRoadId here too, closing the panel via X immediately
  // reopens it.
  const handleFieldTaskRoadHighlight = useCallback((roadId) => {
    setSelectedRoadId(roadId == null ? null : String(roadId));
  }, []);

  const handleRoadSelectedFromMap = useCallback((road) => {
    if (!road) return;
    let roadId = road.road_id ?? null;
    const gisId = road.gis_id ?? null;
    const roadName = road.road_name ?? null;
    logEvent("road_selected_on_map", { roadId, gisId });

    console.log("[handleRoadSelectedFromMap] received:", JSON.stringify(road), "roadId:", roadId, "gisId:", gisId, "tableRows:", tableRows.length);

    // If road_id not provided by the map feature, try to find it from the loaded table data
    if (!roadId && tableRows.length > 0) {
      let match = null;
      if (gisId != null) {
        match = tableRows.find(r => String(r.gis_id) === String(gisId));
      }
      if (!match && roadName) {
        match = tableRows.find(r => String(r.road_name).toLowerCase() === String(roadName).toLowerCase());
      }
      if (match) {
        roadId = match.road_id;
        console.log("[handleRoadSelectedFromMap] resolved road_id from table:", roadId);
      }
    }

    // Ensure table opens up if it was closed
    setShouldFetchTable(true);
    setIsTableMinimized(false);

    // No-op if clicking the same road that is already selected
    if (!isMultiSelectMode && roadId != null && String(roadId) === String(selectedRoadId)) {
      if (!baseFilter) setBaseFilter("INCLUDE");
      return;
    }

    if (!baseFilter) {
      setBaseFilter("INCLUDE");
    }

    if (isMultiSelectMode) {
      if (!roadId) return;
      const idStr = String(roadId);

      setSelectedRoadIds((prev) => {
        const isTogglingOff = prev.includes(idStr);
        const next = isTogglingOff
          ? prev.filter((id) => id !== idStr)
          : [...prev, idStr];

        // Update focus (selectedRoadId)
        if (isTogglingOff) {
          if (String(selectedRoadId) === idStr) {
            setSelectedRoadId(next.length > 0 ? next[next.length - 1] : null);
          }
        } else {
          setSelectedRoadId(idStr);
        }

        setSelectedRoad(
          next.length === 1 && road.road_name
            ? road.road_name
            : next.length
              ? "Multiple roads"
              : ""
        );
        setCurrentPage(1);

        setTableRows((currentRows) => {
          const selected = [];
          const unselected = [];
          currentRows.forEach((r) => {
            if (next.includes(String(r.road_id))) {
              selected.push(r);
            } else {
              unselected.push(r);
            }
          });
          return [...selected, ...unselected];
        });

        // 🟢 Conditional Fetching: Only if toggling ON and road is missing from tableRows
        if (!isTogglingOff && roadId != null) {
          const alreadyInTable = tableRows.some((r) => String(r.road_id) === idStr);
          if (!alreadyInTable) {
            const filter = roadId ? `road_id='${roadId}'` : `gis_id='${gisId}'`;
            beginLoading("roadDetailFetch", "Road details");
            fetch(`/api/road-networks/${city}/details?filter=${encodeURIComponent(filter)}`)
              .then((res) => res.json())
              .then((data) => {
                if (data && data.data && data.data.length > 0) {
                  const fetchedRoad = data.data[0];
                  setTableRows((prev) => {
                    if (prev.some((r) => String(r.road_id) === String(fetchedRoad.road_id))) {
                      return prev;
                    }
                    return [fetchedRoad, ...prev];
                  });
                }
                endLoading("roadDetailFetch");
              })
              .catch((err) => {
                console.error("[handleRoadSelectedFromMap] multi-select fetch failed:", err);
                endLoading("roadDetailFetch");
              });
          }
        }

        return next;
      });

      return;
    }

    // Single-select: highlight in table, zoom on map
    setIsMultiSelectMode(false);
    setSelectedRoadIds([]);
    setSelectedRoadId(roadId);
    if (road.road_name) {
      setSelectedRoad(road.road_name);
    }

    // Set zoom filter for map animation
    const zf = roadId ? `road_id='${roadId}'` : gisId ? `gis_id='${gisId}'` : "";
    if (zf) setZoomFilter(zf);

  }, [buildSelectionFilter, handleRoadFilterChange, isMultiSelectMode, selectedRoadId, tableRows, recordsPerPage, city]);

  // ⭐ ADDED: Handle zoom to filter for road network selections
  const handleZoomToFilter = (filter) => {
    setZoomFilter(filter);
  };

  // ⭐ ADDED: Handle classification layer switch from Toolbar
  const handleClassificationChange = (classificationKey) => {
    console.log("Switching classification to:", classificationKey);
    setLayerVisibility((prev) => {
      // If null, we want NO classification layers (just base road)
      if (!classificationKey) {
        return {
          ...prev,
          roadClassifications: {}
        };
      }

      // Otherwise, enable ONLY the selected one
      return {
        ...prev,
        roadClassifications: {
          [classificationKey]: true
        }
      };
    });
  };

  const handleBaseMapChange = (selectedBaseMap) => {
    logEvent("basemap_switch", { from: baseMap, to: selectedBaseMap });
    const map =
      mapRef.current?.instance || mapRef.current?.map || mapRef.current;
    if (!map || typeof map.getLayers !== "function") {
      setBaseMap(selectedBaseMap);
      return;
    }

    const baseGroup = map
      .getLayers()
      .getArray()
      .find((layer) => layer?.get?.("title") === "Base Maps");
    const baseLayers = baseGroup?.getLayers?.()?.getArray?.() || map
      .getLayers()
      .getArray()
      .filter((layer) => layer?.get?.("type") === "base");

    baseLayers.forEach((layer) => layer?.setVisible?.(false));

    baseLayers.forEach((layer) => {
      const title = layer?.get?.("title");
      if (selectedBaseMap === "osm" && title === "OpenStreetMap") {
        layer.setVisible(true);
      } else if (selectedBaseMap === "satellite" && title === "Satellite + Labels") {
        layer.setVisible(true);
      } else if (selectedBaseMap === "positron" && title === "CartoDB Positron") {
        layer.setVisible(true);
      } else if (selectedBaseMap === "toner" && title === "Toner") {
        layer.setVisible(true);
      } else if (selectedBaseMap === "topo" && title === "Topo") {
        layer.setVisible(true);
      }
    });

    if (baseGroup?.setVisible) baseGroup.setVisible(true);
    map.renderSync?.();
    setBaseMap(selectedBaseMap);
  };

  const handleOverlayToggle = (key) => {
    setOverlayVisibility((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      const map =
        mapRef.current?.instance || mapRef.current?.map || mapRef.current;
      if (!map || typeof map.getLayers !== "function") return next;

      const adminGroup = map
        .getLayers()
        .getArray()
        .find((layer) => layer?.get?.("title") === "Administrative Layers");
      const targetLayer = adminGroup
        ?.getLayers?.()
        ?.getArray?.()
        ?.find((layer) => {
          const title = layer?.get?.("title");
          if (key === "zoneBoundary") return title === "Zone Boundary";
          if (key === "wardBoundary") return title === "Ward Boundary";
          return false;
        });

      if (targetLayer?.setVisible) {
        targetLayer.setVisible(next[key]);
        map.renderSync?.();
      }

      return next;
    });
  };

  useEffect(() => {
    if (!mapRef.current) return;
    const timer = setTimeout(() => {
      handleBaseMapChange(baseMap);
    }, 0);
    return () => clearTimeout(timer);
  }, [city, baseMap]);

  useEffect(() => {
    const map =
      mapRef.current?.instance || mapRef.current?.map || mapRef.current;
    if (!map || typeof map.getLayers !== "function") return;

    const adminGroup = map
      .getLayers()
      .getArray()
      .find((layer) => layer?.get?.("title") === "Administrative Layers");
    const layers = adminGroup?.getLayers?.()?.getArray?.() || [];

    layers.forEach((layer) => {
      const title = layer?.get?.("title");
      if (title === "Zone Boundary") {
        layer.setVisible(overlayVisibility.zoneBoundary !== false);
      } else if (title === "Ward Boundary") {
        layer.setVisible(overlayVisibility.wardBoundary !== false);
      }
    });
    map.renderSync?.();
  }, [overlayVisibility, city]);

  const handleQuery = (queryData) => {
    console.log("Dashboard received query:", queryData);

    if (queryData.type === "attribute") {
      // Check if it's the road layer
      const cfg = cityConfig[city.toLowerCase()];
      if (cfg && queryData.layer === cfg.roadLayer) {
        setTableDataset({ kind: "roads", title: "Road Network", networkId: null, option: null, layerName: null });
        setBaseFilter(queryData.filter);
        setQueryVersion((prev) => prev + 1);
        setShouldFetchTable(true);
        setIsTableMinimized(false);
        setCurrentPage(1);
        // setZoomFilter(queryData.filter); // Handled by useEffect

        // ⭐ NEW: Switch classification layer based on attribute
        const attr = queryData.attribute;
        let classKey = null;
        if (attr === "category") classKey = "category";
        else if (attr === "condition") classKey = "condition";
        else if (attr === "material") classKey = "material";
        else if (attr === "ownership") classKey = "ownership";
        else if (attr === "cus_class") classKey = "cus";

        if (classKey) {
          handleClassificationChange(classKey);
        }
      } else {
        // For other layers, update generic filters
        setLayerFilters((prev) => ({
          ...prev,
          [queryData.layer]: queryData.filter,
        }));
      }
    } else if (queryData.type === "draw") {
      // Enable draw mode in MapContainer
      setDrawMode({
        layer: queryData.layer,
        type: queryData.shape,
      });
    }
  };

  // ⭐ ADDED: Handle Spatial Query Results from MapContainer
  const handleSpatialQueryResults = (features) => {
    console.log("Spatial query results:", features);
    const cfg = cityConfig[city.toLowerCase()];
    const isRoadLayer = drawMode && drawMode.layer === cfg.roadLayer;

    if (isRoadLayer) {
      setTableDataset({ kind: "roads", title: "Road Network", networkId: null, option: null, layerName: null });
      // Normalize property keys to lowercase to avoid case-sensitivity issues (e.g., Length_km vs length_km)
      const rows = features.map(f => {
        const props = f.values_ || f.properties || {};
        const normalized = {};
        Object.keys(props).forEach(key => {
          normalized[key.toLowerCase()] = props[key];
        });
        return normalized;
      });
      setTableRows(rows);
      setIsTableMinimized(false);
      setShouldFetchTable(true);
    } else {
      alert(`Found ${features.length} features.`);
    }

    setDrawMode(null);
  };

  // ─── Helper: fetch full road data from backend ───────────────────────────
  const fetchExportData = async (includeGeom = false) => {
    const url = `/api/road-networks/${city}/details?filter=${encodeURIComponent(
      roadFilter && roadFilter !== "INCLUDE" ? roadFilter : ""
    )}${includeGeom ? "&include_geom=true" : ""}&limit=0`;
    const res = await fetch(url);
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(errText || `HTTP ${res.status}`);
    }
    return await res.json(); // { data: [...], total, page, limit }
  };

  // ⭐ Handle Download Actions — delegates to gisExport utility
  const handleDownloadAction = async (action) => {
    console.log("Download action triggered:", action);
    const downloadStartedAt = performance.now();
    logEvent("download_start", { action });

    setIsDownloading(true);
    try {
      if (action === "print") {
        try {
          const canvas = await captureMapCanvas(mapRef);
          await drawWatermark(canvas, rsacBanner);
          const ctx = canvas.getContext("2d");
          const fontSize = Math.max(11, Math.round(canvas.width * 0.013));
          ctx.save();
          ctx.font = `bold ${fontSize}px Arial, sans-serif`;
          ctx.fillStyle = "rgba(255,255,255,0.85)";
          ctx.strokeStyle = "rgba(0,0,0,0.5)";
          ctx.lineWidth = 3;
          const label = `${city.toUpperCase()} Nagar Nigam  |  ${new Date().toLocaleDateString("en-IN")}`;
          ctx.strokeText(label, 12, canvas.height - 10);
          ctx.fillText(label, 12, canvas.height - 10);
          ctx.restore();
          const dataUrl = canvas.toDataURL("image/png");
          const w = window.open("", "_blank");
          if (!w) {
            throw new Error("Popup blocked. Please allow popups to print.");
          }
          w.document.open();
          w.document.write(`
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Print Map</title>
    <style>
      html, body { margin: 0; padding: 0; }
      img { width: 100%; height: auto; display: block; }
      @page { margin: 10mm; }
    </style>
  </head>
  <body>
    <img id="print-img" src="${dataUrl}" alt="Map" />
    <script>
      const img = document.getElementById('print-img');
      img.onload = () => { window.focus(); window.print(); };
      window.onafterprint = () => { window.close(); };
    </script>
  </body>
</html>
          `);
          w.document.close();
        } catch (err) {
          console.error("Screenshot error:", err);
          alert(`Failed to print: ${err.message}`);
        }

      } else if (action === "excel") {
        let rows = [];
        if (tableDataset.kind === "roads") {
          const result = await fetchExportData(false);
          rows = result?.data || [];
        } else {
          rows = Array.isArray(tableRows) ? tableRows : [];
        }
        if (!rows || rows.length === 0) {
          alert("No data to export. Please adjust your filter and try again.");
          return;
        }
        exportToExcel(rows, city, { title: tableDataset.title || "table_data" });

      } else if (action === "pdf") {
        let rows = [];
        if (tableDataset.kind === "roads") {
          const result = await fetchExportData(false);
          rows = result?.data || [];
        } else {
          rows = Array.isArray(tableRows) ? tableRows : [];
        }
        if (!rows || rows.length === 0) {
          alert("No data to export. Please adjust your filter and try again.");
          return;
        }
        await exportToPDF({
          mapRef,
          rows,
          city,
          watermarkSrc: rsacBanner,
          layerVisibility,
          overlayVisibility,
          roadFilter: tableDataset.kind === "roads" ? roadFilter : "",
          columnFilters: tableDataset.kind === "roads" ? columnFilters : specializedColumnFilters,
          title: tableDataset.title || (tableDataset.kind === "roads" ? "Road Attribute Table" : "Table Export"),
        });

      } else if (action === "kml") {
        const result = await fetchExportData(true); // include_geom=true
        const rows = result?.data;
        if (!rows || rows.length === 0) {
          alert("No data to export. Please adjust your filter and try again.");
          return;
        }
        const { skippedCount } = exportToKML(rows, city);
        if (skippedCount > 0) {
          alert(`KML exported. Note: ${skippedCount} road${skippedCount > 1 ? "s" : ""} had no geometry and were skipped.`);
        }
      }
    } catch (err) {
      console.error("Download error:", err);
      alert(`Export failed: ${err.message}`);
      logEvent("download_error", { action, message: err.message });
    } finally {
      logEvent("download_end", { action, durationMs: Math.round(performance.now() - downloadStartedAt) });
      setIsDownloading(false);
    }
  };



  return (
    <div
      className="dashboard-page"
      style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}
    >
      <Header
        city={city}
        onMenuClick={toggleSidebar}
        onSearchClick={handleSearchClick}
        onDownloadAction={handleDownloadAction}
        isDownloading={isDownloading}
        hideBack={isFieldTaskMode}
        hideHamburger={isFieldTaskMode}
        hideDownload={isFieldTaskMode}
        isFieldTaskMode={isFieldTaskMode}
        fieldTaskLabel={isFieldTaskMode ? urlTaskTitle || null : null}
        kmcUserId={isFieldTaskMode ? urlUserId : null}
      />

      {isLoading && (
        <div className="top-loading-strip">
          <span className="top-loading-strip-message">
            <span className="top-loading-strip-spinner" aria-hidden="true" />
            {formatLoadingMessage(loadingLabels)}
          </span>
        </div>
      )}

      {isSidebarOpen && (
        <Sidebar
          isOpen={isSidebarOpen}
          onClose={() => {
            setIsSidebarOpen(false);
          }}
          city={city}
          onLayerToggle={handleLayerToggle}
          layerVisibility={layerVisibility}
          tableVisible={tableRows.length > 0 && !isTableMinimized}
          tableMinimized={isTableMinimized}
          tableHasRows={tableRows.length > 0}
          drainageController={{
            setLayerVisibility,
            tableDataset,
            setIsLoading: (v) => (v ? beginLoading("drainFilter", "Drain data") : endLoading("drainFilter")),
            setSelectedRoadId,
            setSelectedRoadIds,
            setIsMultiSelectMode,
            setSelectedRoad,
            setActiveFilterColumn,
            setFilterPosition,
            setColumnFilters,
            setSpecializedColumnFilters,
            setSpecializedAllRows,
            setTableRows,
            setGlobalTableMetrics,
            setCurrentPage,
            setTableDataset,
            setShouldFetchTable,
            setIsTableMinimized,
          }}
        />
      )}

      <div
        style={{
          flex: 1,
          position: "relative",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* <div style={{ flex: 1, position: "relative" }}> */}
        {/* ⭐ MAP WITH FILTER + ZOOM */}
        <MapContainer
          ref={mapRef}
          city={city}
          mode={mode} //chainage
          baseMap={baseMap} // ⭐ Passed for adaptive colors
          layerVisibility={layerVisibility}
          streetViewVisible={streetViewVisible}
          selectedRoadName={selectedRoad}
          roadFilter={roadFilter}
          zoomFilter={zoomFilter} // ⭐ Passed for auto-zoom
          selectedRoadId={selectedRoadId} // Add this
          selectedRoadIds={selectedRoadIds} // ⭐ ADDED for multi-select highlights
          isMultiSelectMode={isMultiSelectMode} // ⭐ ADDED for multi-select highlights
          tableFilterActive={Object.keys(columnFilters || {}).length > 0}
          isSidebarOpen={isSidebarOpen}
          tableHasRows={tableRows.length > 0}
          tableMinimized={isTableMinimized}
          onRoadFilterChange={handleRoadFilterChange}
          layerFilters={layerFilters} // ⭐ NEW
          drawMode={drawMode} // ⭐ NEW
          onSpatialQueryResults={handleSpatialQueryResults} // ⭐ NEW
          onAnalysisDataLoaded={handleAnalysisDataLoaded} // ⭐ NEW
          onRoadSelected={handleRoadSelectedFromMap}
          onPopupClosed={handlePopupClosed}
          onMapLoadingChange={handleMapLoadingChange} // ⭐ NEW: Map loading prop
          showChainage={showChainage} //chainage
          onPatchTableOpen={handlePatchTableOpen} //chainage
          onPatchTableClose={handlePatchTableClose} //chainage
          onFieldTaskRoadHighlight={handleFieldTaskRoadHighlight} //chainage
          onMapExtentChange={handleMapExtentChange}
          fieldTaskWardList={isFieldTaskMode ? fieldTaskWardList : null} //chainage
          isMultiSelectModeProp={isMultiSelectMode} //chainage
        />

        {/* ⭐ TOOLBAR — updated */}
        <MapToolbar
          city={city}
          mapRef={mapRef}
          restrictedMode={isFieldTaskMode}
          lockedZone={isFieldTaskMode ? urlZone : null}
          lockedWardList={isFieldTaskMode ? fieldTaskWardList : null}
          primaryWard={isFieldTaskMode ? urlWard : null}
          onChainageToggle={handleChainageToggle} //chainage
          chainageActive={mode === "CHAINAGE"} //chainage
          chainageDisabled={!hasVisibleRoadLayer || !isChainageAvailable(city)} //chainage
          showRoadNetworkPanel={showRoadNetworkPanel} // ⭐ Pass state
          onToggleRoadNetworkPanel={setShowRoadNetworkPanel} // ⭐ Pass setter
          baseMap={baseMap}
          overlayVisibility={overlayVisibility}
          roadNetworkVisible={!!layerVisibility?.network?.roads}
          onBaseMapChange={handleBaseMapChange}
          onOverlayToggle={handleOverlayToggle}
          onRoadNetworkToggle={(checked) => handleLayerToggle("network", "roads", checked)}
          streetViewVisible={streetViewVisible}
          onStreetViewToggle={setStreetViewVisible}
          onDssRoad={() => navigate(`/dss?city=${encodeURIComponent(city)}`)}
          onRoadSelected={(road) => {
            console.log("Road selected:", road);
            setSelectedRoad(road);
          }}
          onApplyRoadFilter={(filter) => {
            console.log("APPLY FILTER:", filter);
            lastFilterSourceRef.current = "toolbar";
            if (mapRef.current?.applyRoadFilterImmediate) {
              mapRef.current.applyRoadFilterImmediate(filter);
            }
            const cfg = cityConfig[city.toLowerCase()] || {};
            const inferred = inferClassificationKey(filter);
            if (inferred && cfg.roadClassifications?.[inferred]) {
              handleClassificationChange(inferred);
            }
            setShouldFetchTable(true);
            setBaseFilter(filter);
            setIsTableMinimized(false);
            setCurrentPage(1);
          }}
          onZoomToFilter={handleZoomToFilter} // ⭐ ADDED: Pass zoom handler
          onClassificationChange={handleClassificationChange} // ⭐ ADDED: Pass classification handler
          onClear={() => {
            console.log("Clearing road selection");
            setSelectedRoad("");
            // Field-task mode: "Clear" undoes a category/condition/etc.
            // drill-down, not the whole redirect scope — resetting to ""
            // dropped the ward filter entirely, which hid the road layer
            // and let the view fall back toward the full zone/city instead
            // of staying on the assigned ward + its neighbors.
            setBaseFilter(isFieldTaskMode ? fieldTaskDefaultFilter || "" : "");
            setStreetViewVisible(false);
            // setZoomFilter(""); // ⭐ Handled by useEffect
            setColumnFilters({}); // ⭐ Clear column filters
            if (isFieldTaskMode) {
              // Table should keep showing the ward-scoped rows, not go
              // blank — if baseFilter ends up the same value as before (no
              // drill-down was active), the combine-filters effect wouldn't
              // otherwise re-run and refetch on its own.
              setQueryVersion((v) => v + 1);
            } else {
              setTableRows([]); // ⭐ Clear table
            }
            setShowRoadSearch(false);
            setShowRoadNetworkPanel(false); // ⭐ Ensure Road Network panel and its legend are closed
            setLayerFilters({}); // ⭐ Clear generic filters

            // ⭐ NEW: Clear classifications and hide base layer to prevent "full layer" load
            setLayerVisibility(prev => ({
              ...prev,
              roadClassifications: {},
              network: {
                ...prev.network,
                roads: isFieldTaskMode ? true : false
              }
            }));
          }}
          onSearch={handleSearchClick}
          onCloseSearch={() => setShowRoadSearch(false)}
          onLatLngSearch={handleLatLngSearch}
          onPlaceSearch={handlePlaceSearch}
          onDataAnalysis={handleChartPanelToggle}
          onQuery={handleQuery}
          onSummary={handleChartPanelToggle} // Re-routed to new consolidated ChartPanel
        />


        {showChartPanel && (
          <div style={chartPanelMinimized ? { display: "none" } : undefined}>
          <ChartPanel
            city={city}
            isOpen={!chartPanelMinimized}
            tableOpen={tableRows.length > 0 && !isTableMinimized}
            onClose={() => {
              setShowChartPanel(false);
              setChartPanelMinimized(false);
            }}
            onMinimize={() => setChartPanelMinimized(true)}
            panelSide="left"
            onChartClick={(col, val) => {
              if (val) {
                handleColumnFilterChange(col, [val]);
              } else {
                handleColumnFilterChange(col, []);
              }
            }}
            onFilterChange={(filter) => {
              if (!filter) {
                setBaseFilter("");
                setTableRows([]);
                setShouldFetchTable(false);
              } else {
                setShouldFetchTable(true);
                setBaseFilter(filter);
                setIsTableMinimized(false);
                setCurrentPage(1);
              }
            }}
            onClassificationChange={handleClassificationChange}
            roadWmsSource={mapRef.current?.getRoadWmsSource?.()}
          />
          </div>
        )}
      </div>

      {/* ⭐ NEW BOTTOM TABLE */}
      {(shouldFetchTable && (
        tableDataset.kind === "specialized" ||
        baseFilter ||
        Object.keys(columnFilters || {}).length > 0 ||
        tableRows.length > 0
      )) && (
        <div
          className={`bottom-table ${isTableMinimized ? "minimized" : ""} ${isFieldTaskMode ? "field-task-table" : ""}`}
        >
          {/* ADD PAGINATION CONTROLS HERE */}
          {/* Simplified Pagination Controls */}
          <div
            className="pagination-controls"
            style={{
              order: 0,
              borderTop: isTableMinimized ? "none" : "1px solid rgba(0,0,0,0.1)",
              borderBottom: "1px solid rgba(0,0,0,0.1)",
            }}
          >
            <div className="pagination-info" style={{ display: "flex", alignItems: "center", gap: "15px" }}>
              <span>
                Showing {indexOfFirstRecord + 1} to{" "}
                {Math.min(indexOfLastRecord, tableRows.length)} of{" "}
                {tableRows.length} entries
              </span>
              <div style={{
                background: "rgba(74, 144, 226, 0.1)",
                padding: "4px 12px",
                borderRadius: "12px",
                border: "1px solid rgba(74, 144, 226, 0.3)",
                color: "#2c3e50",
                fontWeight: "bold",
                fontSize: "13px",
                display: "flex",
                gap: "10px"
              }}>
                <span title="Total number of currently filtered roads">
                  <i className="fas fa-road" style={{ marginRight: "4px", color: "#4a90e2" }}></i>
                  {(liveTableMetrics?.total_roads ?? globalTableMetrics.total_roads) || tableRows.length} Roads
                </span>
                <span style={{ color: "rgba(0,0,0,0.2)" }}>|</span>
                <span title="Total length of currently filtered roads">
                  <i className="fas fa-ruler-horizontal" style={{ marginRight: "4px", color: "#4a90e2" }}></i>
                  {((liveTableMetrics?.total_length_km ?? globalTableMetrics.total_length_km) > 0
                    ? Number(liveTableMetrics?.total_length_km ?? globalTableMetrics.total_length_km).toFixed(2)
                    : tableRows.reduce((sum, r) => sum + (Number(r.length_km) || 0), 0).toFixed(2))} km
                </span>
              </div>
              {/* Active Filter Badge + Clear All */}
              {Object.keys(columnFilters).length > 0 && (
                <div style={{
                  background: "rgba(239, 68, 68, 0.1)",
                  padding: "4px 10px",
                  borderRadius: "12px",
                  border: "1px solid rgba(239, 68, 68, 0.3)",
                  color: "#dc2626",
                  fontWeight: "bold",
                  fontSize: "12px",
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  cursor: "pointer",
                }} onClick={() => {
                  setColumnFilters({});
                  setShouldFetchTable(true);
                }} title="Click to clear all column filters">
                  <i className="fas fa-filter" style={{ fontSize: 11 }}></i>
                  {Object.keys(columnFilters).length} filter{Object.keys(columnFilters).length > 1 ? 's' : ''} active
                  <span style={{ marginLeft: 2, fontSize: 14 }}>×</span>
                </div>
              )}
              {/* Inline Export Buttons — hidden entirely for field-task
                  redirects (KMC/iGile), not just disabled, per that mode's
                  restricted toolbar. */}
              {!isFieldTaskMode && (
              <div style={{ display: "flex", gap: "4px", marginLeft: "auto" }}>
                <button
                  title="Export Excel"
                  disabled={isDownloading}
                  onClick={() => {
                    handleDownloadAction("excel");
                  }}
                  style={{ background: "#16a34a", color: "#fff", border: "none", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}
                >
                  {isDownloading ? <i className="fas fa-spinner fa-spin" style={{ fontSize: 11 }} /> : <i className="fas fa-file-excel" style={{ fontSize: 11 }} />} Excel
                </button>
                <button
                  title="Export PDF with Map"
                  disabled={isDownloading}
                  onClick={() => {
                    handleDownloadAction("pdf");
                  }}
                  style={{ background: "#dc2626", color: "#fff", border: "none", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}
                >
                  {isDownloading ? <i className="fas fa-spinner fa-spin" style={{ fontSize: 11 }} /> : <i className="fas fa-file-pdf" style={{ fontSize: 11 }} />} PDF
                </button>
                <button
                  title="Export Map Image"
                  disabled={isDownloading}
                  onClick={() => {
                    handleDownloadAction("print");
                  }}
                  style={{ background: "#2563eb", color: "#fff", border: "none", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}
                >
                  {isDownloading ? <i className="fas fa-spinner fa-spin" style={{ fontSize: 11 }} /> : <i className="fas fa-image" style={{ fontSize: 11 }} />} Print
                </button>
              </div>
              )}
            </div>
            <div className="pagination-buttons">
              <button
                onClick={goToPreviousPage}
                disabled={currentPage === 1}
                className="pagination-btn"
              >
                Previous
              </button>

              <span className="page-numbers">
                Page {currentPage} of {totalPages}
              </span>

              <button
                onClick={goToNextPage}
                disabled={currentPage === totalPages}
                className="pagination-btn"
              >
                Next
              </button>
            </div>
            {/* Close Button */}
            <div className="table-controls">
              <button
                className="table-back-btn"
                disabled={!prevTableStateRef.current && !lastStableStateRef.current}
                onClick={() => {
                  restorePrevTableState();
                }}
              >
                Back
              </button>
              <button
                className="table-multi-btn"
                onClick={toggleMultiSelectMode}
              >
                {isMultiSelectMode ? "Single" : "Multi"}
              </button>
              <button
                className="table-apply-btn"
                disabled={!selectedRoadIds.length}
                onClick={applyMultiSelection}
              >
                Apply
              </button>
              <button
                className="table-clear-btn"
                disabled={!selectedRoadIds.length}
                onClick={clearMultiSelection}
              >
                Clear
              </button>
              <button
                className="table-maximize-btn"
                // Add this debugging line to your maximize button onClick
                onClick={() => {
                  console.log(
                    "Current isTableMinimized:",
                    isTableMinimized
                  );
                  setIsTableMinimized(!isTableMinimized);
                }}
              >
                {isTableMinimized ? "▲" : "▼"}
              </button>
              <button
                className="table-close-btn"
                onClick={() => {
                  if (mode === "CHAINAGE") {
                    mapRef.current?.showFeatureNotice?.({
                      feature: "Chainage",
                      message: "Please switch off Chainage mode before closing this table.",
                      dedupeKey: `chainage-table-close-blocked|${city}|${Date.now()}`,
                      autoDismissMs: 4500,
                    });
                    return;
                  }
                  if (restorePrevTableState()) return;

                  // Securely hide the table and reset selection state
                  setShouldFetchTable(false);
                  setTableRows([]);
                  setCurrentPage(1);
                  setColumnFilters({});
                  setSpecializedColumnFilters({});
                  setZoomFilter("");
                  setSelectedRoad("");
                  setSelectedRoadId(null);
                  setSelectedRoadIds([]);
                  setIsMultiSelectMode(false);
                  mapFilterActiveRef.current = false;
                  lastStableStateRef.current = null;

                  // Restore road filter to include all roads
                  if (layerVisibility?.network?.roads) {
                    setBaseFilter("INCLUDE");
                  } else {
                    setBaseFilter("");
                  }

                  if (mapRef.current?.clearPopup) {
                    mapRef.current.clearPopup();
                  }
                  setLayerVisibility((prevState) => ({
                    ...prevState,
                    roadClassifications: {},
                  }));
                }}
              >
                ×
              </button>
            </div>
          </div>

          <div className="table-wrapper" style={{
            order: 1,
            maxHeight: isTableMinimized ? "35px" : "none",
            overflow: isTableMinimized ? "hidden" : "auto"
          }}>
            <table>
              <thead>
                <tr>
                  {isMultiSelectMode && (
                    <th>Select</th>
                  )}
                  {tableColumns.map((col) => {
                    const activeFilters = tableDataset.kind === "specialized" ? specializedColumnFilters : columnFilters;
                    return (
                      <th key={col.key}>
                        <div
                          className={`column-header ${col.filterable ? 'filterable' : ''}`}
                          onClick={(e) => {
                            if (!col.filterable) return;
                            e.stopPropagation();
                            if (activeFilterColumn === col.key) {
                              setActiveFilterColumn(null);
                              setFilterPosition(null);
                            } else {
                              const rect = e.currentTarget.getBoundingClientRect();
                            const viewportHeight = window.innerHeight;
                            const spaceBelow = viewportHeight - rect.bottom;
                            const spaceAbove = rect.top;
                            const dropdownHeight = 300;
                            const dropdownWidth = 220;

                            // Horizontal: anchor left unless it would overflow right edge
                            const spaceRight = window.innerWidth - rect.left;
                            const left = spaceRight < dropdownWidth
                              ? rect.right - dropdownWidth
                              : rect.left;

                            const isNumeric = NUMERIC_COLS.includes(col.key);
                            let pos = { left: Math.max(0, left) };

                            // Vertical: place above if more space there
                            if (spaceBelow < dropdownHeight && spaceAbove > spaceBelow) {
                              pos.bottom = viewportHeight - rect.top;
                              pos.maxHeight = isNumeric ? 280 : Math.min(250, spaceAbove - 20);
                            } else {
                              pos.top = rect.bottom;
                              pos.maxHeight = isNumeric ? 280 : Math.min(250, spaceBelow - 20);
                            }

                            setFilterPosition(pos);
                            setActiveFilterColumn(col.key);
                          }
                        }}
                      >
                          {col.label}
                          {col.filterable && (
                            <span className={`filter-icon ${activeFilters[col.key] ? 'active' : ''}`}>
                              ▼
                            </span>
                          )}
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {currentRecords.length === 0 ? (
                  <tr>
                    <td colSpan={tableColumns.length + (isMultiSelectMode ? 1 : 0)}>
                      No results found
                    </td>
                  </tr>
                ) : (
                  currentRecords.map((row, i) => (
                    <tr
                      key={indexOfFirstRecord + i}
                      onClick={() => handleRowClick(row)}
                      className={
                        (isMultiSelectMode
                          ? selectedRoadIds.includes(String(getRowSelectionId(row)))
                          : (selectedRoadId != null &&
                            String(selectedRoadId) === String(row.road_id)))
                          ? "selected-row"
                          : ""
                      }
                      style={{ cursor: "pointer" }}
                    >
                      {isMultiSelectMode && (
                        <td>
                          <input
                            type="checkbox"
                            checked={selectedRoadIds.includes(String(getRowSelectionId(row)))}
                            onClick={(e) => e.stopPropagation()}
                            onChange={() => handleRowClick(row)}
                          />
                        </td>
                      )}
                      {tableColumns.map((col) => (
                        <td key={col.key}>
                          {["row_meter", "carriage_w", "length_km"].includes(col.key) &&
                            row[col.key] !== null &&
                            row[col.key] !== undefined
                            ? Number(row[col.key]).toFixed(2)
                            : row[col.key]}
                        </td>
                      ))}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ⭐ FILTER DROPDOWN PORTAL (Fixed Position) */}
      {activeFilterColumn && filterPosition && (
        <FilterDropdown
          column={tableColumns.find(c => c.key === activeFilterColumn)}
          currentFilters={(tableDataset.kind === "specialized" ? specializedColumnFilters : columnFilters)[activeFilterColumn]}
          onApply={(vals) => handleColumnFilterChange(activeFilterColumn, vals)}
          onClose={() => {
            setActiveFilterColumn(null);
            setFilterPosition(null);
          }}
          position={filterPosition}
          city={city}
          baseFilter={tableDataset.kind === "specialized" ? "" : baseFilter}
          columnFilters={tableDataset.kind === "specialized" ? specializedColumnFilters : columnFilters}
          onRangePreview={tableDataset.kind === "specialized" ? null : requestLiveMetrics}
          datasetKind={tableDataset.kind}
          localRows={tableDataset.kind === "specialized" ? specializedAllRows : null}
        />
      )}
      {/*
      // ROLLBACK OPTION: Kept old SummaryTable intact per user request. Uncomment to restore legacy view.
      showSummary && (
        <SummaryTable
          city={city}
          onClose={() => {
            setShowSummary(false);
            setBaseFilter("");
            setLayerVisibility({
              amenities: {}, others: {}, roadClassifications: {}, network: {}, analysis: {}
            });
          }}
          onApplyFilter={async (filter, fetchTable = true) => {
            if (!filter || String(filter).trim() === "") {
              lastFilterSourceRef.current = null;
              setBaseFilter("");
              setTableRows([]);
              setCurrentPage(1);
              setSelectedRoad("");
              setSelectedRoadId(null);
              setShouldFetchTable(true);
              return;
            }
            lastFilterSourceRef.current = "summary";
            setShouldFetchTable(fetchTable);
            setBaseFilter(filter);
            if (fetchTable) {
              setIsTableMinimized(false);
              setCurrentPage(1);
            }
          }}
          onClassificationChange={handleClassificationChange}
        />
      )
      */}
      <Footer />
    </div>
  );
};

export default DashboardPage;
