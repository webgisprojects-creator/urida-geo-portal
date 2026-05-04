// src/pages/Dashboard.jsx
/* Dashboard feature hub: header/menu, sidebar layer toggles, map/toolbar, table, exports, summaries. */
import React, { useState, useEffect, useRef, useCallback } from "react";
import { useLocation } from "react-router-dom";
import { exportToPDF, exportToExcel, exportToKML, captureMapCanvas, drawWatermark } from "../utils/gisExport";
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
const GEOSERVER_BASE = window.location.port === "8060"
  ? `${window.location.protocol}//${window.location.hostname}:8080/geoserver`
  : (process.env.REACT_APP_GEOSERVER_BASE || "/geoserver");

// ⭐ Internal Component for Filter Dropdown
const NUMERIC_COLS = ['yoc', 'row_meter', 'carriage_w', 'length_km'];

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

const FilterDropdown = ({ column, currentFilters, onApply, onClose, position, city, baseFilter, columnFilters, onRangePreview }) => {
  const isNumericCol = NUMERIC_COLS.includes(column.key);
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
  }, [column.key, city, baseFilter, columnFilters]);

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
  const location = useLocation();
  const queryParams = new URLSearchParams(location.search);
  const city = (queryParams.get("city") || "Lucknow").toLowerCase();

  const [showRoadSearch, setShowRoadSearch] = useState(false);
  // const [roadOptions, setRoadOptions] = useState([]);
  const [selectedRoad, setSelectedRoad] = useState("");

  const [roadFilter, setRoadFilter] = useState(""); // ⭐ FILTER FOR WMS LAYER
  const [zoomFilter, setZoomFilter] = useState(""); // ⭐ FILTER FOR AUTO-ZOOM
  const [baseFilter, setBaseFilter] = useState(""); // ⭐ NEW: Base filter from Sidebar/Search
  const [queryVersion, setQueryVersion] = useState(0);

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
    roadClassifications: {},
    specializedOptions: {}, // e.g. { sewage: 'diameter' }
  });
  const [currentPage, setCurrentPage] = useState(1);
  const [recordsPerPage] = useState(100);
  const [isTableMinimized, setIsTableMinimized] = useState(false);
  const [selectedRoadId, setSelectedRoadId] = useState(null);
  const [selectedRoadIds, setSelectedRoadIds] = useState([]);
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);

  // ⭐ NEW: table data state
  const [tableRows, setTableRows] = useState([]);
  const [globalTableMetrics, setGlobalTableMetrics] = useState({ total_roads: 0, total_length_km: 0 });
  const [liveTableMetrics, setLiveTableMetrics] = useState(null);
  const liveMetricsRef = useRef({ requestId: 0, controller: null });
  const liveMetricsTimerRef = useRef(null);
  const [shouldFetchTable, setShouldFetchTable] = useState(true);
  const [columnFilters, setColumnFilters] = useState({});
  const [isLoading, setIsLoading] = useState(false); // ⭐ NEW: Global loading state
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

  const tableColumns = [
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
    if (finalFilter !== roadFilter && lastFilterSourceRef.current !== "map") {
      setZoomFilter(finalFilter);
    }
  }, [baseFilter, columnFilters, queryVersion]); // Removed roadFilter from dependency to avoid loop

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

  const handleColumnFilterChange = (key, selectedValues) => {
    lastFilterSourceRef.current = "table";
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
    const analysisRows = Object.values(analysisResults).flat();

    // Only update if we are NOT using a road filter (search mode)
    // If roadFilter is active, it takes precedence in the other effect
    if (!roadFilter) {
      if (analysisRows.length > 0) {
        setTableRows(analysisRows);
        setCurrentPage(1);
        // Automatically open table if it was closed/empty
        // But respect minimized state if user minimized it?
        // Let's just ensure it shows data.
      } else {
        setTableRows([]);
      }
    }
  }, [analysisResults, roadFilter]);

  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  // ⭐ NEW: Track Road Network Panel visibility
  const [showRoadNetworkPanel, setShowRoadNetworkPanel] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [showChartPanel, setShowChartPanel] = useState(false);
  const [streetViewVisible, setStreetViewVisible] = useState(false);

  const toggleSidebar = () => {
    setIsSidebarOpen((prev) => !prev);
  };

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
    if (group === "roadClassifications") {
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
          next.specializedOptions = {
            ...(prev.specializedOptions || {}),
            [id]: Object.keys(cfg.options)[0],
          };
        }
      }

      return next;
    });
    if (group === "network" && id === "roads") {
      if (checked) {
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

    setIsLoading(true);
    fetch(
      `/api/road-networks/${city}/details?filter=${encodeURIComponent(roadFilter)}`,
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
        setIsLoading(false);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        console.error("Table load error:", err);
        setIsLoading(false);
      });
    return () => controller.abort();
  }, [roadFilter, city, shouldFetchTable, analysisResults]);

  // Pagination calculations
  const indexOfLastRecord = currentPage * recordsPerPage;
  const indexOfFirstRecord = indexOfLastRecord - recordsPerPage;
  const currentRecords = tableRows.slice(indexOfFirstRecord, indexOfLastRecord);
  const totalPages = Math.ceil(tableRows.length / recordsPerPage);

  // Pagination controls
  // const paginate = (pageNumber) => setCurrentPage(pageNumber);
  const goToPreviousPage = () =>
    setCurrentPage((prev) => Math.max(prev - 1, 1));
  const goToNextPage = () =>
    setCurrentPage((prev) => Math.min(prev + 1, totalPages));

  const getRowSelectionId = (row) =>
    row?.road_id ?? null;

  const handleRowClick = (row) => {
    const rowId = row?.road_id ?? null;

    // No-op if clicking the already-selected road in single-select mode
    if (!isMultiSelectMode && rowId != null && String(rowId) === String(selectedRoadId)) return;

    if (isMultiSelectMode) {
      if (!rowId) return;
      setSelectedRoadIds((prev) => {
        const idStr = String(rowId);
        return prev.includes(idStr)
          ? prev.filter((id) => id !== idStr)
          : [...prev, idStr];
      });
      return;
    }

    setSelectedRoadIds([]);
    setSelectedRoadId(row.road_id);
    setSelectedRoad(row.road_name);

    // Zoom map to the selected road
    if (row.road_id) {
      setZoomFilter(`road_id='${row.road_id}'`);
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


  const buildSelectionFilter = useCallback((ids) => {
    if (!ids || ids.length === 0) return "";
    const column = "road_id";
    const quoted = ids.map((id) => `'${String(id).replace(/'/g, "''")}'`).join(",");
    return `${column} IN (${quoted})`;
  }, []);

  const applyMultiSelection = () => {
    if (!selectedRoadIds.length) return;
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
    setSelectedRoadIds([]);
    if (isMultiSelectMode) {
      setSelectedRoadId(null);
      setSelectedRoad("");
    }
  };

  const toggleMultiSelectMode = () => {
    setIsMultiSelectMode((prev) => {
      const next = !prev;
      if (next) {
        if (selectedRoadId !== null && selectedRoadId !== undefined) {
          setSelectedRoadIds([String(selectedRoadId)]);
        }
      } else {
        setSelectedRoadIds([]);
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

  const handleRoadSelectedFromMap = useCallback((road) => {
    if (!road) return;
    let roadId = road.road_id ?? null;
    const gisId = road.gis_id ?? null;
    const roadName = road.road_name ?? null;

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
            setIsLoading(true);
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
                setIsLoading(false);
              })
              .catch((err) => {
                console.error("[handleRoadSelectedFromMap] multi-select fetch failed:", err);
                setIsLoading(false);
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

    setIsDownloading(true);
    try {
      if (action === "print") {
        // Print Map (PNG screenshot with legend overlay + RSAC watermark)
        try {
          const canvas = await captureMapCanvas(mapRef);
          // Apply RSAC watermark (bottom-right, proportional)
          await drawWatermark(canvas, rsacBanner);
          // City + date info label (bottom-left above legend area)
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
          const openedLayers = [
            ...Object.entries(layerVisibility.amenities || {}).filter(([, v]) => v).map(([k]) => `amenity_${k}`),
            ...Object.entries(layerVisibility.others || {}).filter(([, v]) => v).map(([k]) => `other_${k}`),
            ...(overlayVisibility.zoneBoundary ? ["zoneBoundary"] : []),
            ...(overlayVisibility.wardBoundary ? ["wardBoundary"] : []),
          ];
          const layerSuffix = openedLayers.length > 0 ? openedLayers.join("_") : "basemap";
          const fileName = `sitemap_${new Date().toISOString().slice(0, 10)}_${layerSuffix}.png`;
          await new Promise((resolve, reject) => {
            canvas.toBlob((blob) => {
              if (blob) { saveAs(blob, fileName); resolve(); }
              else reject(new Error("Canvas to Blob failed"));
            });
          });
        } catch (err) {
          console.error("Screenshot error:", err);
          alert(`Failed to take screenshot: ${err.message}`);
        }

      } else if (action === "excel") {
        const result = await fetchExportData(false);
        const rows = result?.data;
        if (!rows || rows.length === 0) {
          alert("No data to export. Please adjust your filter and try again.");
          return;
        }
        exportToExcel(rows, city);

      } else if (action === "pdf") {
        const result = await fetchExportData(false);
        const rows = result?.data;
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
          roadFilter,
          columnFilters, // ⭐ NEW: Pass table filters to PDF
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
    } finally {
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
      />

      {isLoading && <div className="top-loading-strip" />}

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
          onMapLoadingChange={setIsLoading} // ⭐ NEW: Map loading prop
        />

        {/* ⭐ TOOLBAR — updated */}
        <MapToolbar
          city={city}
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
            setBaseFilter("");
            setStreetViewVisible(false);
            // setZoomFilter(""); // ⭐ Handled by useEffect
            setColumnFilters({}); // ⭐ Clear column filters
            setTableRows([]); // ⭐ Clear table
            setShowRoadSearch(false);
            setShowRoadNetworkPanel(false); // ⭐ Ensure Road Network panel and its legend are closed
            setLayerFilters({}); // ⭐ Clear generic filters

            // ⭐ NEW: Clear classifications and hide base layer to prevent "full layer" load
            setLayerVisibility(prev => ({
              ...prev,
              roadClassifications: {},
              network: {
                ...prev.network,
                roads: false
              }
            }));
          }}
          onSearch={handleSearchClick}
          onCloseSearch={() => setShowRoadSearch(false)}
          onLatLngSearch={handleLatLngSearch}
          onPlaceSearch={handlePlaceSearch}
          onDataAnalysis={() => setShowChartPanel((prev) => !prev)}
          onQuery={handleQuery}
          onSummary={() => setShowChartPanel((prev) => !prev)} // Re-routed to new consolidated ChartPanel
        />
        {showChartPanel && (
          <ChartPanel
            city={city}
            isOpen={showChartPanel}
            onClose={() => setShowChartPanel(false)}
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
        )}
      </div>

      {/* ⭐ NEW BOTTOM TABLE */}
      {(shouldFetchTable && (baseFilter || Object.keys(columnFilters || {}).length > 0 || tableRows.length > 0)) && (
        <div
          className={`bottom-table ${isTableMinimized ? "minimized" : ""}`}
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
              {/* Inline Export Buttons */}
              <div style={{ display: "flex", gap: "4px", marginLeft: "auto" }}>
                <button
                  title="Export Excel"
                  disabled={isDownloading}
                  onClick={() => handleDownloadAction("excel")}
                  style={{ background: "#16a34a", color: "#fff", border: "none", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}
                >
                  {isDownloading ? <i className="fas fa-spinner fa-spin" style={{ fontSize: 11 }} /> : <i className="fas fa-file-excel" style={{ fontSize: 11 }} />} Excel
                </button>
                <button
                  title="Export PDF with Map"
                  disabled={isDownloading}
                  onClick={() => handleDownloadAction("pdf")}
                  style={{ background: "#dc2626", color: "#fff", border: "none", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}
                >
                  {isDownloading ? <i className="fas fa-spinner fa-spin" style={{ fontSize: 11 }} /> : <i className="fas fa-file-pdf" style={{ fontSize: 11 }} />} PDF
                </button>
                <button
                  title="Export Map Image"
                  disabled={isDownloading}
                  onClick={() => handleDownloadAction("print")}
                  style={{ background: "#2563eb", color: "#fff", border: "none", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}
                >
                  {isDownloading ? <i className="fas fa-spinner fa-spin" style={{ fontSize: 11 }} /> : <i className="fas fa-image" style={{ fontSize: 11 }} />} Print
                </button>
              </div>
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
                  if (restorePrevTableState()) return;

                  // Securely hide the table and reset selection state
                  setShouldFetchTable(false);
                  setTableRows([]);
                  setCurrentPage(1);
                  setColumnFilters({});
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
                  {tableColumns.map((col) => (
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
                          <span className={`filter-icon ${columnFilters[col.key] ? 'active' : ''}`}>
                            ▼
                          </span>
                        )}
                      </div>
                    </th>
                  ))}
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
          // data={tableRows} // Removed
          currentFilters={columnFilters[activeFilterColumn]}
          onApply={(vals) => handleColumnFilterChange(activeFilterColumn, vals)}
          onClose={() => {
            setActiveFilterColumn(null);
            setFilterPosition(null);
          }}
          position={filterPosition}
          city={city}
          baseFilter={baseFilter}
          columnFilters={columnFilters}
          onRangePreview={requestLiveMetrics}
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
