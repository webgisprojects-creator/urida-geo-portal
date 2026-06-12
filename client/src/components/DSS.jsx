import React, { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import "../assets/styles/Dashboard.css";
import Header from "./Header";
import MapContainer from "./MapContainer";
import Footer from "./Footer";
import { captureMapCanvas, drawWatermark, exportToExcel, exportToPDF } from "../utils/gisExport";
import streetLightImage from "../assets/images/Street_light.JPG";
import underdevelopedImage from "../assets/images/Underdeveloped_zones.JPG";
import roadMaintenanceImage from "../assets/images/road.png";
import encroachmentImage from "../assets/images/Encroachment.JPG";

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
      if (dragging.current === "lo") setLo(clamp(Number(v.toFixed(2)), min, hi));
      else setHi(clamp(Number(v.toFixed(2)), lo, max));
    };
    const up = () => {
      dragging.current = null;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  React.useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onChange([lo, hi]), 150);
    return () => clearTimeout(debounceRef.current);
  }, [lo, hi, onChange]);

  React.useEffect(() => {
    setLo(value?.[0] ?? min);
    setHi(value?.[1] ?? max);
  }, [value, min, max]);

  const handleLoInput = (e) => {
    const v = Number(e.target.value);
    if (Number.isFinite(v)) setLo(clamp(v, min, hi));
  };
  const handleHiInput = (e) => {
    const v = Number(e.target.value);
    if (Number.isFinite(v)) setHi(clamp(v, lo, max));
  };

  const inputStyle = {
    width: 60,
    padding: "3px 6px",
    borderRadius: 4,
    border: "1px solid #cbd5e1",
    fontSize: 12,
    textAlign: "center",
    fontWeight: 600,
    color: "#1e40af",
  };
  const trackStyle = {
    position: "relative",
    height: 6,
    borderRadius: 4,
    background: "#e2e8f0",
    margin: "10px 8px",
    cursor: "pointer",
  };
  const fillStyle = {
    position: "absolute",
    height: "100%",
    left: `${loPercent}%`,
    width: `${hiPercent - loPercent}%`,
    background: "#3b82f6",
    borderRadius: 4,
  };
  const handleStyle = (pct) => ({
    position: "absolute",
    top: "50%",
    left: `${pct}%`,
    transform: "translate(-50%, -50%)",
    width: 18,
    height: 18,
    borderRadius: "50%",
    background: "white",
    border: "2px solid #3b82f6",
    boxShadow: "0 1px 4px rgba(0,0,0,0.2)",
    cursor: "grab",
  });

  return (
    <div style={{ padding: "12px 8px 4px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <input type="number" value={lo} onChange={handleLoInput} step="0.01" style={inputStyle} />
        <span style={{ fontSize: 11, color: "#1e40af", fontWeight: 600 }}>{col.label}</span>
        <input type="number" value={hi} onChange={handleHiInput} step="0.01" style={inputStyle} />
      </div>
      <div ref={trackRef} style={trackStyle}>
        <div style={fillStyle} />
        <div style={handleStyle(loPercent)} onMouseDown={onMouseDown("lo")} />
        <div style={handleStyle(hiPercent)} onMouseDown={onMouseDown("hi")} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#64748b", marginTop: 4 }}>
        <span>Min: {min}</span>
        <span>Max: {max}</span>
      </div>
    </div>
  );
};

const FilterDropdown = ({ column, currentFilters, onApply, onClose, position, localRows }) => {
  const [selected, setSelected] = useState(Array.isArray(currentFilters) ? currentFilters : []);
  const [distinctValues, setDistinctValues] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [rangeValue, setRangeValue] = useState(null);
  const [numBounds, setNumBounds] = useState(null);

  const isNumericCol = useMemo(() => {
    const rows = Array.isArray(localRows) ? localRows : [];
    const values = [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const v = row[column.key];
      if (v === null || v === undefined || v === "") continue;
      const n = Number(v);
      if (!Number.isFinite(n)) return false;
      values.push(n);
      if (values.length >= 60) break;
    }
    return values.length > 0;
  }, [column.key, localRows]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    const rows = Array.isArray(localRows) ? localRows : [];
    if (isNumericCol) {
      const nums = [];
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const v = row[column.key];
        if (v === null || v === undefined || v === "") continue;
        const n = Number(v);
        if (Number.isFinite(n)) nums.push(n);
      }
      const minV = nums.length ? Math.min(...nums) : 0;
      const maxV = nums.length ? Math.max(...nums) : 0;
      if (active) {
        setNumBounds([minV, maxV]);
        setRangeValue([minV, maxV]);
        setDistinctValues([minV, maxV]);
        setLoading(false);
      }
      return () => {
        active = false;
      };
    }

    const uniq = new Set();
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const v = row[column.key];
      if (v === null || v === undefined || v === "") continue;
      uniq.add(String(v));
    }
    const values = Array.from(uniq).sort((a, b) =>
      String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" })
    );
    if (active) {
      setDistinctValues(values);
      setLoading(false);
    }
    return () => {
      active = false;
    };
  }, [column.key, localRows, isNumericCol]);

  const filteredValues = useMemo(() => {
    if (isNumericCol) return [];
    return distinctValues.filter((val) => val.toLowerCase().includes(String(searchTerm || "").toLowerCase()));
  }, [distinctValues, searchTerm, isNumericCol]);

  const toggleValue = (val) => {
    setSelected((prev) => (prev.includes(val) ? prev.filter((v) => v !== val) : [...prev, val]));
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
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{ width: "100%", padding: "4px", borderRadius: 4, border: "1px solid #e2e8f0" }}
            autoFocus
          />
        </div>
      )}

      <div style={{ overflowY: isNumericCol ? "hidden" : "auto", flex: 1, padding: isNumericCol ? 0 : "8px" }}>
        {loading ? (
          <div style={{ padding: "12px", color: "#666", fontSize: 13 }}>Loading...</div>
        ) : isNumericCol ? (
          <RangeSlider
            col={column}
            min={Number(numBounds?.[0] ?? 0)}
            max={Number(numBounds?.[1] ?? 0)}
            value={rangeValue || numBounds || [0, 0]}
            onChange={(nextRange) => setRangeValue(nextRange)}
          />
        ) : filteredValues.length > 0 ? (
          <>
            <label
              style={{
                display: "block",
                marginBottom: "6px",
                cursor: "pointer",
                fontSize: 13,
                fontWeight: 600,
                color: "#3b82f6",
                borderBottom: "1px solid #e2e8f0",
                paddingBottom: 4,
              }}
            >
              <input
                type="checkbox"
                checked={selected.length === filteredValues.length && filteredValues.length > 0}
                onChange={() => {
                  if (selected.length === filteredValues.length) setSelected([]);
                  else setSelected([...filteredValues]);
                }}
              />{" "}
              {selected.length === filteredValues.length ? "Deselect All" : "Select All"}
              <span style={{ fontSize: 11, color: "#94a3b8", marginLeft: 6 }}>({filteredValues.length})</span>
            </label>
            {filteredValues.map((val) => (
              <label key={val} style={{ display: "block", marginBottom: "4px", cursor: "pointer", fontSize: 13 }}>
                <input type="checkbox" checked={selected.includes(val)} onChange={() => toggleValue(val)} /> {val}
              </label>
            ))}
          </>
        ) : (
          <div style={{ padding: "8px", color: "#999", fontSize: 13 }}>No options found</div>
        )}
      </div>

      <div
        className="filter-actions"
        style={{
          borderTop: "1px solid #e2e8f0",
          padding: "8px",
          display: "flex",
          justifyContent: "space-between",
          background: "#fff",
          borderRadius: "0 0 8px 8px",
          gap: 6,
        }}
      >
        <button
          className="filter-btn clear-btn"
          style={{
            flex: 1,
            padding: "5px 8px",
            background: "transparent",
            border: "1px solid #cbd5e1",
            borderRadius: 6,
            cursor: "pointer",
            fontSize: 12,
            color: "#475569",
          }}
          onClick={() => {
            setSelected([]);
            if (numBounds) setRangeValue([numBounds[0], numBounds[1]]);
            onApply([]);
            onClose();
          }}
        >
          Clear
        </button>
        <button
          className="filter-btn apply-btn"
          style={{
            flex: 1,
            padding: "5px 8px",
            background: "#3b82f6",
            color: "white",
            border: "none",
            borderRadius: 6,
            cursor: "pointer",
            fontSize: 12,
            fontWeight: 600,
          }}
          onClick={() => {
            if (isNumericCol && rangeValue) {
              onApply({ type: "range", lo: rangeValue[0], hi: rangeValue[1] });
            } else {
              onApply(selected);
            }
            onClose();
          }}
        >
          Apply
        </button>
      </div>
    </div>
  );
};

const DSS = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const mapRef = useRef(null);
  const queryParams = new URLSearchParams(location.search);
  const cityParam = queryParams.get("city") || "lucknow";
  const city = String(cityParam || "lucknow").toLowerCase().trim();
  const backTarget = `/dashboard?city=${encodeURIComponent(city)}`;
  const [baseMap, setBaseMap] = useState("osm");
  const [controlsVisible, setControlsVisible] = useState(false);
  const layerVisibility = {};
  const buildStreetLightCounts = (geojson) => {
    const counts = { illuminated: 0, nonIlluminated: 0, others: 0, total: 0 };
    const features = Array.isArray(geojson?.features) ? geojson.features : [];
    features.forEach((feature) => {
      const status = String(feature?.properties?.illumination_status || "").toUpperCase();
      if (status === "ILLUMINATED") counts.illuminated += 1;
      else if (status === "NON_ILLUMINATED") counts.nonIlluminated += 1;
      else counts.others += 1;
      counts.total += 1;
    });
    return counts;
  };
  const buildUnderdevelopedCounts = (geojson) => {
    const counts = { developed: 0, underdeveloped: 0, nonDeveloped: 0, total: 0 };
    const features = Array.isArray(geojson?.features) ? geojson.features : [];
    features.forEach((feature) => {
      const label = String(feature?.properties?.classification || "").toLowerCase();
      if (label === "developed") counts.developed += 1;
      else if (label === "underdeveloped") counts.underdeveloped += 1;
      else if (label === "non-developed") counts.nonDeveloped += 1;
      counts.total += 1;
    });
    return counts;
  };
  const buildEncroachmentTotals = (zones) => {
    const rows = Array.isArray(zones) ? zones : [];
    const totals = rows.reduce(
      (acc, row) => {
        acc.totalRoads += Number(row?.total_roads) || 0;
        acc.encroachedRoads += Number(row?.encroached_roads) || 0;
        return acc;
      },
      { totalRoads: 0, encroachedRoads: 0 }
    );
    const encroachmentPercentage =
      totals.totalRoads > 0 ? (totals.encroachedRoads * 100) / totals.totalRoads : 0;
    return { ...totals, encroachmentPercentage };
  };
  const handleUnauthorized = (res) => {
    if (res?.status === 401) {
      navigate("/");
      return true;
    }
    return false;
  };
  const [streetLightVisible, setStreetLightVisible] = useState(false);
  const [streetLightGeojson, setStreetLightGeojson] = useState(null);
  const [streetLightCounts, setStreetLightCounts] = useState(null);
  const [streetLightFilters, setStreetLightFilters] = useState({
    illuminated: true,
    nonIlluminated: true,
    others: true,
  });
  const [underdevelopedVisible, setUnderdevelopedVisible] = useState(false);
  const [underdevelopedGeojson, setUnderdevelopedGeojson] = useState(null);
  const [underdevelopedCounts, setUnderdevelopedCounts] = useState(null);
  const [underdevelopedFilters, setUnderdevelopedFilters] = useState({
    developed: true,
    underdeveloped: true,
    nonDeveloped: true,
  });
  const [encroachmentVisible, setEncroachmentVisible] = useState(false);
  const [encroachmentLoading, setEncroachmentLoading] = useState(false);
  const [encroachmentGeojson, setEncroachmentGeojson] = useState(null);
  const [encroachmentSummary, setEncroachmentSummary] = useState([]);
  const [encroachmentOwnershipCode, setEncroachmentOwnershipCode] = useState("");
  const [selectedEncroachmentZone, setSelectedEncroachmentZone] = useState("");
  const [encroachmentError, setEncroachmentError] = useState("");
  const [selectedFeature, setSelectedFeature] = useState("");
  const lastFeatureRef = useRef("");
  const [infoOpen, setInfoOpen] = useState(false);
  const [tableRows, setTableRows] = useState([]);
  const [specializedAllRows, setSpecializedAllRows] = useState([]);
  const [tableTitle, setTableTitle] = useState("");
  const [isTableMinimized, setIsTableMinimized] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 100;
  const [isDownloading, setIsDownloading] = useState(false);

  const [activeFilterColumn, setActiveFilterColumn] = useState(null);
  const [filterPosition, setFilterPosition] = useState(null);
  const [columnFilters, setColumnFilters] = useState({});

  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);
  const [selectedRoadIds, setSelectedRoadIds] = useState([]);
  const [selectedRoadId, setSelectedRoadId] = useState(null);
  const [appliedSelectionIds, setAppliedSelectionIds] = useState([]);
  const prevTableStateRef = useRef(null);
  const lastStableStateRef = useRef(null);
  const infoConfig = {
    streetLight: { label: "Street Light", src: streetLightImage },
    underdeveloped: { label: "Underdeveloped Zones", src: underdevelopedImage },
    roadMaintenance: { label: "Road Maintenance", src: roadMaintenanceImage },
    encroachment: { label: "Encroachment", src: encroachmentImage },
  };
  const activeInfo = selectedFeature ? infoConfig[selectedFeature] : null;
  const selectFeature = (featureKey) => {
    lastFeatureRef.current = featureKey;
    setSelectedFeature(featureKey);
  };

  const tableColumns = useMemo(() => {
    const hidden = new Set(["geom", "geometry", "the_geom", "bbox", "wkt"]);
    const sample = Array.isArray(tableRows) ? tableRows.slice(0, 80) : [];
    const keys = new Set();
    sample.forEach((r) => {
      if (!r || typeof r !== "object") return;
      Object.keys(r).forEach((k) => {
        const key = String(k || "");
        if (!key) return;
        if (hidden.has(key.toLowerCase())) return;
        keys.add(key);
      });
    });
    return Array.from(keys).map((key) => ({
      key,
      label: String(key).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      filterable: true,
    }));
  }, [tableRows]);

  const getRowSelectionId = (row, fallbackIdx = null) => {
    if (!row || typeof row !== "object") return fallbackIdx != null ? String(fallbackIdx) : "";
    const candidates = ["road_id", "gis_id", "gid", "objectid", "fid", "id", "__row_id"];
    for (const key of candidates) {
      const v = row[key];
      if (v !== null && v !== undefined && String(v).trim() !== "") return String(v);
    }
    return fallbackIdx != null ? String(fallbackIdx) : "";
  };

  const normalizeRows = (rows) => {
    const input = Array.isArray(rows) ? rows : [];
    return input.map((r, idx) => {
      const obj = r && typeof r === "object" ? r : {};
      if (Object.prototype.hasOwnProperty.call(obj, "__row_id")) return obj;
      return { ...obj, __row_id: getRowSelectionId(obj, idx) || String(idx) };
    });
  };

  const applyFiltersToRows = (rows, filters, selectionIds, extraPredicate) => {
    const list = Array.isArray(rows) ? rows : [];
    const activeFilters = filters && typeof filters === "object" ? filters : {};
    const activeEntries = Object.entries(activeFilters).filter(([, v]) => {
      if (!v) return false;
      if (Array.isArray(v)) return v.length > 0;
      if (v?.type === "range") return Number.isFinite(Number(v.lo)) && Number.isFinite(Number(v.hi));
      return false;
    });
    const selectionSet = Array.isArray(selectionIds) && selectionIds.length ? new Set(selectionIds.map(String)) : null;

    return list.filter((row, idx) => {
      if (selectionSet) {
        const rid = getRowSelectionId(row, idx);
        if (!selectionSet.has(String(rid))) return false;
      }

      for (const [colKey, vals] of activeEntries) {
        const raw = row?.[colKey];
        if (vals?.type === "range") {
          const n = Number(raw);
          if (!Number.isFinite(n)) return false;
          if (n < Number(vals.lo) || n > Number(vals.hi)) return false;
        } else {
          const str = raw === null || raw === undefined ? "" : String(raw);
          if (!vals.map(String).includes(str)) return false;
        }
      }

      if (typeof extraPredicate === "function") {
        return !!extraPredicate(row, idx);
      }
      return true;
    });
  };

  useEffect(() => {
    const featureKey = selectedFeature;

    const resetTableState = () => {
      setSpecializedAllRows([]);
      setTableRows([]);
      setTableTitle("");
      setColumnFilters({});
      setSelectedRoadId(null);
      setSelectedRoadIds([]);
      setAppliedSelectionIds([]);
      setIsMultiSelectMode(false);
      setActiveFilterColumn(null);
      setFilterPosition(null);
      setCurrentPage(1);
      prevTableStateRef.current = null;
      lastStableStateRef.current = null;
    };

    if (!featureKey) {
      resetTableState();
      return;
    }

    if (featureKey === "streetLight" && streetLightVisible && streetLightGeojson?.features) {
      const rows = normalizeRows(streetLightGeojson.features.map((f) => f?.properties || {}).filter(Boolean));
      setTableTitle("Street Light");
      setSpecializedAllRows(rows);
      setColumnFilters({});
      setSelectedRoadId(null);
      setSelectedRoadIds([]);
      setAppliedSelectionIds([]);
      setIsMultiSelectMode(false);
      setActiveFilterColumn(null);
      setFilterPosition(null);
      setIsTableMinimized(false);
      setCurrentPage(1);
      return;
    }

    if (featureKey === "underdeveloped" && underdevelopedVisible && underdevelopedGeojson?.features) {
      const rows = normalizeRows(underdevelopedGeojson.features.map((f) => f?.properties || {}).filter(Boolean));
      setTableTitle("Underdeveloped Zones");
      setSpecializedAllRows(rows);
      setColumnFilters({});
      setSelectedRoadId(null);
      setSelectedRoadIds([]);
      setAppliedSelectionIds([]);
      setIsMultiSelectMode(false);
      setActiveFilterColumn(null);
      setFilterPosition(null);
      setIsTableMinimized(false);
      setCurrentPage(1);
      return;
    }

    if (featureKey === "encroachment" && encroachmentVisible && encroachmentGeojson?.features) {
      const rows = normalizeRows(encroachmentGeojson.features.map((f) => f?.properties || {}).filter(Boolean));
      setTableTitle("Encroachment");
      setSpecializedAllRows(rows);
      setColumnFilters({});
      setSelectedRoadId(null);
      setSelectedRoadIds([]);
      setAppliedSelectionIds([]);
      setIsMultiSelectMode(false);
      setActiveFilterColumn(null);
      setFilterPosition(null);
      setIsTableMinimized(false);
      setCurrentPage(1);
      return;
    }

    resetTableState();
  }, [
    selectedFeature,
    streetLightVisible,
    streetLightGeojson,
    underdevelopedVisible,
    underdevelopedGeojson,
    encroachmentVisible,
    encroachmentGeojson,
  ]);

  useEffect(() => {
    const extra = selectedFeature === "encroachment" && selectedEncroachmentZone
      ? (row) => String(row?.zone_no ?? "").trim() === String(selectedEncroachmentZone).trim()
      : null;
    const filtered = applyFiltersToRows(specializedAllRows, columnFilters, appliedSelectionIds, extra);
    setTableRows(filtered);
    setCurrentPage(1);
  }, [specializedAllRows, columnFilters, appliedSelectionIds, selectedFeature, selectedEncroachmentZone]);

  const indexOfFirstRecord = (currentPage - 1) * pageSize;
  const indexOfLastRecord = currentPage * pageSize;
  const currentRecords = useMemo(() => {
    const rows = Array.isArray(tableRows) ? tableRows : [];
    return rows.slice(indexOfFirstRecord, indexOfLastRecord);
  }, [tableRows, indexOfFirstRecord, indexOfLastRecord]);

  const totalPages = useMemo(() => {
    const total = Array.isArray(tableRows) ? tableRows.length : 0;
    return total > 0 ? Math.ceil(total / pageSize) : 1;
  }, [tableRows]);

  const goToPreviousPage = () => setCurrentPage((p) => Math.max(1, p - 1));
  const goToNextPage = () => setCurrentPage((p) => Math.min(totalPages, p + 1));

  const handleTableExport = async (action) => {
    const rows = Array.isArray(tableRows) ? tableRows : [];
    if (!rows.length) {
      alert("No data available to export.");
      return;
    }

    if (action === "excel") {
      exportToExcel(rows, city, { title: tableTitle || "dss_table" });
      return;
    }

    if (action === "pdf") {
      await exportToPDF({
        mapRef,
        rows,
        city,
        watermarkSrc: null,
        layerVisibility: {},
        overlayVisibility: {},
        roadFilter: "",
        title: tableTitle || "DSS Report",
      });
      return;
    }

    if (action === "print") {
      try {
        const canvas = await captureMapCanvas(mapRef);
        await drawWatermark(canvas, null);
        const dataUrl = canvas.toDataURL("image/png");
        const w = window.open("", "_blank");
        if (!w) throw new Error("Popup blocked. Please allow popups to print.");
        w.document.open();
        w.document.write(`
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Print</title>
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
        alert(`Failed to print: ${err?.message || "Unknown error"}`);
      }
    }
  };

  useEffect(() => {
    if (!streetLightVisible) {
      setStreetLightGeojson(null);
      setStreetLightCounts(null);
      return;
    }
    const controller = new AbortController();
    const url = `/api/road-networks/${city}/street-light`;
    fetch(url, { credentials: "include", signal: controller.signal })
      .then((res) => (handleUnauthorized(res) ? null : res.ok ? res.json() : null))
      .then((data) => {
        if (controller.signal.aborted) return;
        if (data?.features) {
          setStreetLightGeojson(data);
          setStreetLightCounts((prev) => prev ?? buildStreetLightCounts(data));
        } else {
          setStreetLightGeojson(null);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setStreetLightGeojson(null);
        }
      });
    fetch(`/api/road-networks/${city}/street-light/counts`, {
      credentials: "include",
      signal: controller.signal,
    })
      .then((res) => (handleUnauthorized(res) ? null : res.ok ? res.json() : null))
      .then((data) => {
        if (controller.signal.aborted) return;
        if (data && typeof data === "object") {
          setStreetLightCounts(data);
        } else {
          setStreetLightCounts(null);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setStreetLightCounts(null);
        }
      });
    return () => controller.abort();
  }, [streetLightVisible, city]);

  const handleUnderdevelopedToggle = async () => {
    if (underdevelopedVisible) {
      setUnderdevelopedVisible(false);
      setUnderdevelopedGeojson(null);
      return;
    }
    setUnderdevelopedVisible(true);
    setUnderdevelopedGeojson(null);
    setUnderdevelopedCounts(null);
    try {
      const res = await fetch(`/api/road-networks/${city}/underdeveloped-analysis/refresh`, {
        method: "POST",
        credentials: "include",
      });
      if (handleUnauthorized(res)) return;
    } catch { }
    try {
      const res = await fetch(`/api/road-networks/${city}/underdeveloped-analysis`, {
        credentials: "include",
      });
      if (handleUnauthorized(res)) return;
      if (res.ok) {
        const data = await res.json();
        if (data?.features) {
          setUnderdevelopedGeojson(data);
          setUnderdevelopedCounts((prev) => prev ?? buildUnderdevelopedCounts(data));
        }
      }
    } catch {
      setUnderdevelopedGeojson(null);
    }
    try {
      const res = await fetch(`/api/road-networks/${city}/underdeveloped-analysis/counts`, {
        credentials: "include",
      });
      if (handleUnauthorized(res)) return;
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data === "object") {
          setUnderdevelopedCounts(data);
          return;
        }
      }
      setUnderdevelopedCounts(null);
    } catch {
      setUnderdevelopedCounts(null);
    }
  };
  const handleEncroachmentToggle = async () => {
    if (encroachmentVisible) {
      setEncroachmentVisible(false);
      setSelectedEncroachmentZone("");
      return;
    }
    setEncroachmentVisible(true);
    setEncroachmentLoading(true);
    setEncroachmentError("");
    setEncroachmentGeojson(null);
    setSelectedEncroachmentZone("");
    try {
      const refreshRes = await fetch(`/api/road-networks/${city}/encroachment-analysis/refresh`, {
        method: "POST",
        credentials: "include",
      });
      if (handleUnauthorized(refreshRes)) return;

      const geoRes = await fetch(`/api/road-networks/${city}/encroachment-analysis`, {
        credentials: "include",
      });
      if (handleUnauthorized(geoRes)) return;
      if (geoRes.ok) {
        const geojson = await geoRes.json();
        if (geojson?.features) {
          setEncroachmentGeojson(geojson);
        }
      }

      const res = await fetch(`/api/road-networks/${city}/encroachment-analysis/summary`, {
        credentials: "include",
      });
      if (handleUnauthorized(res)) return;
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || "Failed to load encroachment summary");
      }
      const payload = await res.json();
      const zones = Array.isArray(payload?.zones) ? payload.zones : [];
      setEncroachmentSummary(zones);
      setEncroachmentOwnershipCode(String(payload?.ownership_code || "").toUpperCase());
    } catch (err) {
      setEncroachmentGeojson(null);
      setEncroachmentSummary([]);
      setEncroachmentOwnershipCode("");
      setEncroachmentError(err?.message || "Failed to load encroachment summary");
    } finally {
      setEncroachmentLoading(false);
    }
  };

  useEffect(() => {
    setEncroachmentVisible(false);
    setEncroachmentLoading(false);
    setEncroachmentGeojson(null);
    setEncroachmentSummary([]);
    setEncroachmentOwnershipCode("");
    setSelectedEncroachmentZone("");
    setEncroachmentError("");
  }, [city]);

  const encroachmentTotals = buildEncroachmentTotals(encroachmentSummary);
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

  const handleColumnFilterChange = (colKey, vals) => {
    setColumnFilters((prev) => {
      const next = { ...(prev || {}) };
      if (!vals || (Array.isArray(vals) && vals.length === 0)) {
        delete next[colKey];
        return next;
      }
      next[colKey] = vals;
      return next;
    });
    setCurrentPage(1);
  };

  const restorePrevTableState = () => {
    const snap = prevTableStateRef.current || lastStableStateRef.current;
    if (!snap) return false;
    setSelectedFeature(snap.selectedFeature || "");
    lastFeatureRef.current = snap.selectedFeature || "";
    setTableTitle(snap.tableTitle || "");
    setSpecializedAllRows(snap.specializedAllRows || []);
    setColumnFilters(snap.columnFilters || {});
    setSelectedRoadId(snap.selectedRoadId ?? null);
    setSelectedRoadIds(snap.selectedRoadIds || []);
    setAppliedSelectionIds(snap.appliedSelectionIds || []);
    setIsMultiSelectMode(!!snap.isMultiSelectMode);
    setIsTableMinimized(!!snap.isTableMinimized);
    setCurrentPage(snap.currentPage || 1);
    prevTableStateRef.current = null;
    return true;
  };

  const toggleMultiSelectMode = () => {
    setIsMultiSelectMode((prev) => {
      const next = !prev;
      if (!next) {
        setSelectedRoadIds([]);
      }
      return next;
    });
  };

  const handleRowClick = (row, idx) => {
    const id = getRowSelectionId(row, idx);
    if (!id) return;

    if (isMultiSelectMode) {
      setSelectedRoadIds((prev) => {
        const list = Array.isArray(prev) ? prev : [];
        const exists = list.includes(String(id));
        return exists ? list.filter((v) => v !== String(id)) : [...list, String(id)];
      });
      return;
    }
    setSelectedRoadId(String(id));
  };

  const applyMultiSelection = () => {
    if (!Array.isArray(selectedRoadIds) || selectedRoadIds.length === 0) return;
    if (!prevTableStateRef.current) {
      prevTableStateRef.current = {
        selectedFeature,
        tableTitle,
        specializedAllRows,
        columnFilters,
        selectedRoadId,
        selectedRoadIds,
        appliedSelectionIds,
        isMultiSelectMode,
        isTableMinimized,
        currentPage,
      };
    }
    lastStableStateRef.current = {
      selectedFeature,
      tableTitle,
      specializedAllRows,
      columnFilters,
      selectedRoadId,
      selectedRoadIds,
      appliedSelectionIds,
      isMultiSelectMode,
      isTableMinimized,
      currentPage,
    };
    setAppliedSelectionIds(selectedRoadIds.slice());
    setIsMultiSelectMode(false);
    setSelectedRoadId(null);
    setCurrentPage(1);
  };

  const clearMultiSelection = () => {
    if (appliedSelectionIds.length > 0 && prevTableStateRef.current) {
      restorePrevTableState();
      return;
    }
    setAppliedSelectionIds([]);
    setSelectedRoadIds([]);
    setSelectedRoadId(null);
    setCurrentPage(1);
  };

  const clearAllDss = () => {
    setStreetLightVisible(false);
    setStreetLightGeojson(null);
    setStreetLightCounts(null);
    setUnderdevelopedVisible(false);
    setUnderdevelopedGeojson(null);
    setUnderdevelopedCounts(null);
    setEncroachmentVisible(false);
    setEncroachmentGeojson(null);
    setEncroachmentSummary([]);
    setEncroachmentOwnershipCode("");
    setSelectedEncroachmentZone("");
    setEncroachmentError("");
    setSelectedFeature("");
    lastFeatureRef.current = "";
    setInfoOpen(false);
    setSpecializedAllRows([]);
    setTableRows([]);
    setTableTitle("");
    setColumnFilters({});
    setSelectedRoadId(null);
    setSelectedRoadIds([]);
    setAppliedSelectionIds([]);
    setIsMultiSelectMode(false);
    setActiveFilterColumn(null);
    setFilterPosition(null);
    setCurrentPage(1);
    setIsTableMinimized(false);
    prevTableStateRef.current = null;
    lastStableStateRef.current = null;
  };

  const hasActiveTableFilter = useMemo(() => {
    return (
      (columnFilters && Object.keys(columnFilters).length > 0) ||
      (Array.isArray(appliedSelectionIds) && appliedSelectionIds.length > 0) ||
      (selectedFeature === "encroachment" && !!selectedEncroachmentZone)
    );
  }, [columnFilters, appliedSelectionIds, selectedFeature, selectedEncroachmentZone]);

  const filteredRowIdSet = useMemo(() => {
    const rows = Array.isArray(tableRows) ? tableRows : [];
    return new Set(rows.map((r, idx) => String(getRowSelectionId(r, idx))));
  }, [tableRows]);

  const filterGeojsonByRowIds = (geojson) => {
    const feats = Array.isArray(geojson?.features) ? geojson.features : [];
    const nextFeatures = feats.filter((f, idx) => {
      const props = f?.properties || {};
      const id = getRowSelectionId(props, idx);
      return filteredRowIdSet.has(String(id));
    });
    return { ...(geojson || { type: "FeatureCollection" }), features: nextFeatures };
  };

  const streetLightGeojsonView = useMemo(() => {
    if (!streetLightGeojson?.features) return streetLightGeojson;
    if (selectedFeature !== "streetLight") return streetLightGeojson;
    return filterGeojsonByRowIds(streetLightGeojson);
  }, [streetLightGeojson, selectedFeature, filteredRowIdSet]);

  const underdevelopedGeojsonView = useMemo(() => {
    if (!underdevelopedGeojson?.features) return underdevelopedGeojson;
    if (selectedFeature !== "underdeveloped") return underdevelopedGeojson;
    return filterGeojsonByRowIds(underdevelopedGeojson);
  }, [underdevelopedGeojson, selectedFeature, filteredRowIdSet]);

  const encroachmentGeojsonView = useMemo(() => {
    if (!encroachmentGeojson?.features) return encroachmentGeojson;
    if (selectedFeature !== "encroachment") return encroachmentGeojson;
    return filterGeojsonByRowIds(encroachmentGeojson);
  }, [encroachmentGeojson, selectedFeature, filteredRowIdSet]);

  const streetLightCountsView = useMemo(() => {
    if (!streetLightVisible) return streetLightCounts;
    if (selectedFeature === "streetLight" && hasActiveTableFilter) {
      return buildStreetLightCounts(streetLightGeojsonView);
    }
    return streetLightCounts;
  }, [streetLightVisible, streetLightCounts, selectedFeature, hasActiveTableFilter, streetLightGeojsonView]);

  const underdevelopedCountsView = useMemo(() => {
    if (!underdevelopedVisible) return underdevelopedCounts;
    if (selectedFeature === "underdeveloped" && hasActiveTableFilter) {
      return buildUnderdevelopedCounts(underdevelopedGeojsonView);
    }
    return underdevelopedCounts;
  }, [underdevelopedVisible, underdevelopedCounts, selectedFeature, hasActiveTableFilter, underdevelopedGeojsonView]);

  return (
    <div
      className="dashboard-page"
      style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}
    >
      <Header city={city} backTarget={backTarget} />
      <div
        style={{
          flex: 1,
          position: "relative",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <MapContainer
          ref={mapRef}
          city={city}
          baseMap={baseMap}
          layerVisibility={layerVisibility}
          streetViewVisible={false}
          streetLightVisible={streetLightVisible}
          streetLightGeojson={streetLightGeojsonView}
          streetLightCounts={streetLightCountsView}
          streetLightFilters={streetLightFilters}
          onStreetLightFilterChange={setStreetLightFilters}
          underdevelopedVisible={underdevelopedVisible}
          underdevelopedGeojson={underdevelopedGeojsonView}
          underdevelopedCounts={underdevelopedCountsView}
          underdevelopedFilters={underdevelopedFilters}
          onUnderdevelopedFilterChange={setUnderdevelopedFilters}
          encroachmentVisible={encroachmentVisible}
          encroachmentGeojson={encroachmentGeojsonView}
          encroachmentZone={selectedEncroachmentZone}
          encroachmentTotals={encroachmentTotals}
          onRoadFilterChange={() => {}}
          onDrainFilterChange={() => {}}
        />
        <div className="map-toolbar left-toolbar">
          <button
            className="map-btn wide-btn"
            onClick={() => {
              setStreetLightVisible((prev) => !prev);
              selectFeature("streetLight");
            }}
          >
            <i className="fas fa-lightbulb" /> <span>Street Light</span>
          </button>
          <button
            className="map-btn wide-btn"
            onClick={() => {
              handleUnderdevelopedToggle();
              selectFeature("underdeveloped");
            }}
          >
            <i className="fas fa-city" /> <span>Underdeveloped Zones</span>
          </button>
          <button
            className="map-btn wide-btn"
            onClick={() => {
              selectFeature("roadMaintenance");
            }}
          >
            <i className="fas fa-road" /> <span>Road maintenace</span>
          </button>
          <button
            className="map-btn wide-btn"
            onClick={() => {
              handleEncroachmentToggle();
              selectFeature("encroachment");
            }}
          >
            <i className="fas fa-ban" /> <span>Encrochment</span>
          </button>
        </div>
        {encroachmentVisible && (
          <div
            style={{
              position: "absolute",
              left: "18px",
              top: "170px",
              width: "340px",
              maxHeight: "calc(100vh - 250px)",
              overflow: "auto",
              padding: "12px",
              borderRadius: "10px",
              background: "rgba(255,255,255,0.94)",
              zIndex: 1200,
              boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
              border: "1px solid rgba(0,0,0,0.08)",
            }}
          >
            <div style={{ fontWeight: 700, fontSize: "14px", marginBottom: "8px" }}>
              Encroachment Analysis {encroachmentOwnershipCode ? `(${encroachmentOwnershipCode})` : ""}
            </div>
            <div style={{ fontSize: "12px", marginBottom: "8px", color: "#334155" }}>
              Total Roads: <strong>{encroachmentTotals.totalRoads}</strong> | Encroached:{" "}
              <strong>{encroachmentTotals.encroachedRoads}</strong> | %:{" "}
              <strong>{encroachmentTotals.encroachmentPercentage.toFixed(2)}</strong>
            </div>
            {encroachmentLoading && (
              <div style={{ fontSize: "12px", color: "#475569" }}>Loading encroachment summary...</div>
            )}
            {!encroachmentLoading && encroachmentError && (
              <div style={{ fontSize: "12px", color: "#dc2626" }}>{encroachmentError}</div>
            )}
            {!encroachmentLoading && !encroachmentError && encroachmentSummary.length === 0 && (
              <div style={{ fontSize: "12px", color: "#475569" }}>No zone-wise encroachment records found.</div>
            )}
            {!encroachmentLoading && !encroachmentError && encroachmentSummary.length > 0 && (
              <>
                <button
                  className="map-btn"
                  style={{ marginBottom: "8px", width: "100%" }}
                  onClick={() => setSelectedEncroachmentZone("")}
                >
                  Show All Zones
                </button>
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  {encroachmentSummary.map((row) => {
                    const zoneNo = String(row?.zone_no ?? "UNKNOWN");
                    const isSelected = selectedEncroachmentZone === zoneNo;
                    return (
                      <button
                        key={zoneNo}
                        onClick={() => setSelectedEncroachmentZone(zoneNo)}
                        style={{
                          textAlign: "left",
                          border: isSelected ? "1px solid #2563eb" : "1px solid rgba(0,0,0,0.15)",
                          borderRadius: "8px",
                          padding: "8px",
                          background: isSelected ? "rgba(37,99,235,0.08)" : "rgba(248,250,252,0.95)",
                          cursor: "pointer",
                        }}
                      >
                        <div style={{ fontSize: "12px", fontWeight: 700, marginBottom: "3px" }}>
                          Zone {zoneNo}
                        </div>
                        <div style={{ fontSize: "11px", color: "#1e293b" }}>
                          Total: {Number(row?.total_roads) || 0} | Encroached: {Number(row?.encroached_roads) || 0} |
                          %: {Number(row?.encroachment_percentage || 0).toFixed(2)}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}
        <div className="map-toolbar right-toolbar">
          <div style={{ position: "relative" }}>
            <button
              className="map-btn"
              onClick={() => setControlsVisible((value) => !value)}
              title="Switch Basemap"
            >
              <i className="fas fa-layer-group" />
            </button>
            {controlsVisible && (
              <div className="controls-panel">
                <h4 style={{ margin: "0 0 10px 0", fontSize: "14px", borderBottom: "1px solid #eee", paddingBottom: "5px" }}>
                  Base Maps
                </h4>
                <div className="basemap-controls">
                  <label>
                    <input
                      type="radio"
                      name="basemap"
                      value="osm"
                      checked={baseMap === "osm"}
                      onChange={() => handleBaseMapChange("osm")}
                    />{" "}
                    OpenStreetMap
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="basemap"
                      value="satellite"
                      checked={baseMap === "satellite"}
                      onChange={() => handleBaseMapChange("satellite")}
                    />{" "}
                    Satellite
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="basemap"
                      value="positron"
                      checked={baseMap === "positron"}
                      onChange={() => handleBaseMapChange("positron")}
                    />{" "}
                    CartoDB Positron
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="basemap"
                      value="toner"
                      checked={baseMap === "toner"}
                      onChange={() => handleBaseMapChange("toner")}
                    />{" "}
                    Toner
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="basemap"
                      value="topo"
                      checked={baseMap === "topo"}
                      onChange={() => handleBaseMapChange("topo")}
                    />{" "}
                    Topo
                  </label>
                </div>
              </div>
            )}
          </div>
          <button
            className="map-btn wide-btn"
            onClick={() => {
              const featureKey = lastFeatureRef.current || selectedFeature;
              if (featureKey && infoConfig[featureKey]) {
                setSelectedFeature(featureKey);
                setInfoOpen(true);
              }
            }}
          >
            <i className="fas fa-circle-info" /> <span>Info</span>
          </button>
          <button
            className="map-btn wide-btn"
            onClick={() => {
              clearAllDss();
            }}
          >
            <i className="fas fa-eraser" /> <span>Clear</span>
          </button>
        </div>
        {infoOpen && activeInfo && (
          <div
            className="dss-info-overlay"
            onClick={() => setInfoOpen(false)}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 100000,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "24px",
              background: "rgba(15, 23, 42, 0.7)",
              backdropFilter: "blur(4px)",
            }}
          >
            <div
              className="dss-info-panel"
              onClick={(event) => event.stopPropagation()}
              style={{
                position: "relative",
                width: "min(92vw, 920px)",
                maxHeight: "88vh",
                background: "#ffffff",
                borderRadius: "16px",
                boxShadow: "0 25px 60px rgba(0, 0, 0, 0.35)",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                overflow: "hidden",
              }}
            >
              <div
                className="dss-info-header"
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "14px 18px",
                  borderBottom: "1px solid #e2e8f0",
                  fontWeight: 700,
                  color: "#1e293b",
                  background: "#f8fafc",
                }}
              >
                <span>{activeInfo.label}</span>
                <button
                  className="dss-info-close"
                  onClick={() => setInfoOpen(false)}
                  style={{
                    border: "none",
                    background: "transparent",
                    color: "#475569",
                    fontSize: "28px",
                    lineHeight: 1,
                    cursor: "pointer",
                  }}
                  aria-label="Close info image"
                >
                  ×
                </button>
              </div>
              <div
                style={{
                  width: "100%",
                  padding: "18px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "#ffffff",
                }}
              >
                <img
                  className="dss-info-image"
                  src={activeInfo.src}
                  alt={activeInfo.label}
                  style={{
                    display: "block",
                    maxWidth: "100%",
                    maxHeight: "calc(88vh - 90px)",
                    width: "auto",
                    height: "auto",
                    objectFit: "contain",
                    borderRadius: "8px",
                  }}
                />
              </div>
            </div>
          </div>
        )}

        {tableRows.length > 0 && (
          <div className={`bottom-table ${isTableMinimized ? "minimized" : ""}`}>
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
                <div
                  style={{
                    background: "rgba(74, 144, 226, 0.1)",
                    padding: "4px 12px",
                    borderRadius: "12px",
                    border: "1px solid rgba(74, 144, 226, 0.3)",
                    color: "#2c3e50",
                    fontWeight: "bold",
                    fontSize: "13px",
                    display: "flex",
                    gap: "10px",
                  }}
                >
                  <span title="Total number of currently filtered records">
                    <i className="fas fa-layer-group" style={{ marginRight: "4px", color: "#4a90e2" }}></i>
                    {tableRows.length} Records
                  </span>
                  <span style={{ color: "rgba(0,0,0,0.2)" }}>|</span>
                  <span title="Total length (km) if length_km exists">
                    <i className="fas fa-ruler-horizontal" style={{ marginRight: "4px", color: "#4a90e2" }}></i>
                    {(tableRows.some((r) => r && r.length_km != null)
                      ? tableRows.reduce((sum, r) => sum + (Number(r?.length_km) || 0), 0).toFixed(2)
                      : "—")} km
                  </span>
                </div>
                {Object.keys(columnFilters || {}).length > 0 && (
                  <div
                    style={{
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
                    }}
                    onClick={() => {
                      setColumnFilters({});
                      setAppliedSelectionIds([]);
                      setSelectedRoadIds([]);
                      setSelectedRoadId(null);
                      setIsMultiSelectMode(false);
                    }}
                    title="Click to clear all column filters"
                  >
                    <i className="fas fa-filter" style={{ fontSize: 11 }}></i>
                    {Object.keys(columnFilters).length} filter{Object.keys(columnFilters).length > 1 ? "s" : ""} active
                    <span style={{ marginLeft: 2, fontSize: 14 }}>×</span>
                  </div>
                )}
                <div style={{ display: "flex", gap: "4px", marginLeft: "auto" }}>
                  <button
                    title="Export Excel"
                    disabled={isDownloading}
                    onClick={async () => {
                      setIsDownloading(true);
                      try {
                        await handleTableExport("excel");
                      } finally {
                        setIsDownloading(false);
                      }
                    }}
                    style={{ background: "#16a34a", color: "#fff", border: "none", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}
                  >
                    {isDownloading ? <i className="fas fa-spinner fa-spin" style={{ fontSize: 11 }} /> : <i className="fas fa-file-excel" style={{ fontSize: 11 }} />} Excel
                  </button>
                  <button
                    title="Export PDF with Map"
                    disabled={isDownloading}
                    onClick={async () => {
                      setIsDownloading(true);
                      try {
                        await handleTableExport("pdf");
                      } finally {
                        setIsDownloading(false);
                      }
                    }}
                    style={{ background: "#dc2626", color: "#fff", border: "none", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}
                  >
                    {isDownloading ? <i className="fas fa-spinner fa-spin" style={{ fontSize: 11 }} /> : <i className="fas fa-file-pdf" style={{ fontSize: 11 }} />} PDF
                  </button>
                  <button
                    title="Export Map Image"
                    disabled={isDownloading}
                    onClick={async () => {
                      setIsDownloading(true);
                      try {
                        await handleTableExport("print");
                      } finally {
                        setIsDownloading(false);
                      }
                    }}
                    style={{ background: "#2563eb", color: "#fff", border: "none", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}
                  >
                    {isDownloading ? <i className="fas fa-spinner fa-spin" style={{ fontSize: 11 }} /> : <i className="fas fa-image" style={{ fontSize: 11 }} />} Print
                  </button>
                </div>
              </div>
              <div className="pagination-buttons">
                <button onClick={goToPreviousPage} disabled={currentPage === 1} className="pagination-btn">
                  Previous
                </button>
                <span className="page-numbers">
                  Page {currentPage} of {totalPages}
                </span>
                <button onClick={goToNextPage} disabled={currentPage === totalPages} className="pagination-btn">
                  Next
                </button>
              </div>
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
                <button className="table-multi-btn" onClick={toggleMultiSelectMode}>
                  {isMultiSelectMode ? "Single" : "Multi"}
                </button>
                <button className="table-apply-btn" disabled={!selectedRoadIds.length} onClick={applyMultiSelection}>
                  Apply
                </button>
                <button
                  className="table-clear-btn"
                  disabled={!selectedRoadIds.length && !appliedSelectionIds.length}
                  onClick={clearMultiSelection}
                >
                  Clear
                </button>
                <button
                  className="table-maximize-btn"
                  onClick={() => {
                    setIsTableMinimized(!isTableMinimized);
                  }}
                >
                  {isTableMinimized ? "▲" : "▼"}
                </button>
                <button className="table-close-btn" onClick={clearAllDss}>
                  ×
                </button>
              </div>
            </div>

            <div
              className="table-wrapper"
              style={{
                order: 1,
                maxHeight: isTableMinimized ? "35px" : "none",
                overflow: isTableMinimized ? "hidden" : "auto",
              }}
            >
              <table>
                <thead>
                  <tr>
                    {isMultiSelectMode && <th>Select</th>}
                    {tableColumns.map((col) => (
                      <th key={col.key}>
                        <div
                          className={`column-header ${col.filterable ? "filterable" : ""}`}
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
                              const spaceRight = window.innerWidth - rect.left;
                              const left = spaceRight < dropdownWidth ? rect.right - dropdownWidth : rect.left;
                              let pos = { left: Math.max(0, left) };
                              if (spaceBelow < dropdownHeight && spaceAbove > spaceBelow) {
                                pos.bottom = viewportHeight - rect.top;
                                pos.maxHeight = Math.min(250, spaceAbove - 20);
                              } else {
                                pos.top = rect.bottom;
                                pos.maxHeight = Math.min(250, spaceBelow - 20);
                              }
                              setFilterPosition(pos);
                              setActiveFilterColumn(col.key);
                            }
                          }}
                        >
                          {col.label}
                          {col.filterable && (
                            <span className={`filter-icon ${columnFilters?.[col.key] ? "active" : ""}`}>▼</span>
                          )}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {currentRecords.length === 0 ? (
                    <tr>
                      <td colSpan={tableColumns.length + (isMultiSelectMode ? 1 : 0)}>No results found</td>
                    </tr>
                  ) : (
                    currentRecords.map((row, i) => (
                      <tr
                        key={indexOfFirstRecord + i}
                        onClick={() => handleRowClick(row, indexOfFirstRecord + i)}
                        className={
                          (isMultiSelectMode
                            ? selectedRoadIds.includes(String(getRowSelectionId(row, indexOfFirstRecord + i)))
                            : (selectedRoadId != null &&
                              String(selectedRoadId) === String(getRowSelectionId(row, indexOfFirstRecord + i))))
                            ? "selected-row"
                            : ""
                        }
                        style={{ cursor: "pointer" }}
                      >
                        {isMultiSelectMode && (
                          <td>
                            <input
                              type="checkbox"
                              checked={selectedRoadIds.includes(String(getRowSelectionId(row, indexOfFirstRecord + i)))}
                              onClick={(e) => e.stopPropagation()}
                              onChange={() => handleRowClick(row, indexOfFirstRecord + i)}
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

        {activeFilterColumn && filterPosition && (
          <FilterDropdown
            column={tableColumns.find((c) => c.key === activeFilterColumn)}
            currentFilters={columnFilters?.[activeFilterColumn]}
            onApply={(vals) => handleColumnFilterChange(activeFilterColumn, vals)}
            onClose={() => {
              setActiveFilterColumn(null);
              setFilterPosition(null);
            }}
            position={filterPosition}
            localRows={specializedAllRows}
          />
        )}
      </div>
      <Footer />
    </div>
  );
};

export default DSS;
