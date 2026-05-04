/* Summary panel with metrics, zone/ward filtering, and classification drill-down. */
import React, { useEffect, useState, useMemo } from "react";
import { cityConfig } from "../assets/configs/cityConfig";

const resolveCityKey = (rawCity) => {
  const normalized = String(rawCity || "").toLowerCase().trim();
  if (cityConfig[normalized]) return normalized;
  const lowered = Object.keys(cityConfig).find((key) => key.toLowerCase() === normalized);
  if (lowered) return lowered;
  return normalized || "lucknow";
};

const stripStyle = {
  position: "fixed",
  height: "auto",
  padding: "8px 12px",
  zIndex: 1101,
  background:
    "linear-gradient(149deg, rgba(54, 209, 214, 0.40) 20%, rgba(91, 134, 229, 0.40) 35%)",
  backdropFilter: "blur(4px)",
  boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
  borderRadius: "12px",
  border: "1px solid rgba(255, 255, 255, 0.4)",
};

const headerBarStyle = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "6px 10px",
  background: "rgba(255, 255, 255, 0.2)",
  borderRadius: 8,
  color: "#000000",
  fontWeight: 700,
  marginBottom: 8,
  cursor: "grab",
  userSelect: "none",
};

const headItemStyle = {
  padding: "4px 10px",
  borderRadius: 6,
  background: "rgba(255, 255, 255, 0.25)",
  color: "#000000",
  border: "1px solid rgba(255, 255, 255, 0.4)",
};

const gridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
  gap: 12,
  paddingBottom: 12,
};

const bigCardStyle = {
  background: "rgba(255, 255, 255, 0.05)",
  backdropFilter: "blur(6px)",
  borderRadius: 12,
  padding: "10px 16px",
  marginBottom: "10px",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  border: "1px solid rgba(255, 255, 255, 0.3)",
  boxShadow: "0 4px 16px rgba(0,0,0,0.1)",
};

const bigMetricStyle = {
  display: "flex",
  flexDirection: "column",
  gap: "2px",
  flex: 1,
  padding: "0 8px",
  borderRight: "1px solid rgba(0,0,0,0.1)",
};

const bigLabelStyle = {
  fontSize: 12,
  color: "#000000",
  fontWeight: 700,
  opacity: 0.8,
  textTransform: "uppercase",
  letterSpacing: "0.5px",
};

const bigValueStyle = {
  fontSize: 16,
  fontWeight: 800,
  color: "#000000",
  lineHeight: "1.2",
};

const cardStyle = {
  background: "rgba(255, 255, 255, 0.02)",
  backdropFilter: "blur(4px)",
  color: "#000000",
  borderRadius: 10,
  padding: "8px 10px",
  border: "1px solid rgba(0, 0, 0, 0.1)",
  height: 140,
  display: "flex",
  flexDirection: "column",
  boxShadow: "0 2px 6px rgba(0,0,0,0.05)",
  transition: "transform 0.2s ease, box-shadow 0.2s ease",
};

const labelStyle = {
  fontSize: 12,
  color: "#000000",
  fontWeight: 700,
  marginBottom: 8,
  borderBottom: "1px solid rgba(0,0,0,0.1)",
  paddingBottom: 6,
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
};

const valueStyle = {
  fontSize: 14,
  fontWeight: 800,
  color: "#000000",
};

const listItemStyle = {
  fontSize: 13,
  color: "#000000",
  lineHeight: "1.5",
  padding: "4px 0",
  borderBottom: "1px solid rgba(0,0,0,0.05)",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
};

const posStyle = { color: "#000000", fontWeight: 700 };
const negStyle = { color: "#000000", fontWeight: 700 };
const cardSecondRowStyle = { ...cardStyle, gridRow: "auto" };
const scrollListStyle = {
  flex: 1,
  overflowY: "auto",
  paddingRight: "4px",
  marginTop: "4px"
};

// Custom scrollbar for lists
const scrollbarStyles = `
  .custom-scroll::-webkit-scrollbar {
    width: 4px;
  }
  .custom-scroll::-webkit-scrollbar-track {
    background: rgba(0,0,0,0.05);
  }
  .custom-scroll::-webkit-scrollbar-thumb {
    background: rgba(0,0,0,0.2);
    border-radius: 2px;
  }
`;

const GEOSERVER_BASE = window.location.port === "8060"
  ? `${window.location.protocol}//${window.location.hostname}:8080/geoserver`
  : (process.env.REACT_APP_GEOSERVER_BASE || "/geoserver");

const SummaryTable = ({ city, onClose, onApplyFilter, onClassificationChange }) => {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState("summary");
  const [legendColors, setLegendColors] = useState({});
  const [minimized, setMinimized] = useState(false);

  // New state for zones
  const [zonesList, setZonesList] = useState([]);
  const [selectedZone, setSelectedZone] = useState("");
  const [showZoneDropdown, setShowZoneDropdown] = useState(false);
  const [wardsList, setWardsList] = useState([]);
  const [selectedWard, setSelectedWard] = useState("");
  const [showWardDropdown, setShowWardDropdown] = useState(false);

  // Refs for height calculation
  const containerRef = React.useRef(null);
  const zonesBtnRef = React.useRef(null);
  const wardsBtnRef = React.useRef(null);
  const [zonesMaxHeight, setZonesMaxHeight] = useState(300);
  const [wardsMaxHeight, setWardsMaxHeight] = useState(300);

  // Calculate dropdown max heights when they open
  useEffect(() => {
    if (showZoneDropdown && containerRef.current && zonesBtnRef.current) {
      const containerRect = containerRef.current.getBoundingClientRect();
      const btnRect = zonesBtnRef.current.getBoundingClientRect();
      // Available height = container bottom - button bottom - padding (approx 10px)
      // Ensure at least 100px so it's usable even if table is small
      const h = Math.max(100, containerRect.bottom - btnRect.bottom - 10);
      setZonesMaxHeight(h);
    }
  }, [showZoneDropdown]);

  useEffect(() => {
    if (showWardDropdown && containerRef.current && wardsBtnRef.current) {
      const containerRect = containerRef.current.getBoundingClientRect();
      const btnRect = wardsBtnRef.current.getBoundingClientRect();
      const h = Math.max(100, containerRect.bottom - btnRect.bottom - 10);
      setWardsMaxHeight(h);
    }
  }, [showWardDropdown]);

  const hasValidZones = useMemo(() => {
    return (
      zonesList.length > 0 &&
      zonesList.some((z) => {
        const zn = String(z.zone_no || "").trim().toLowerCase();
        return zn !== "" && zn !== "null" && zn !== "na" && zn !== "0";
      })
    );
  }, [zonesList]);

  // Draggable and Resizable state
  const [position, setPosition] = useState({ x: 60, y: window.innerHeight - 320 });
  const [size, setSize] = useState({ width: 800, height: 260 });
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [resizeDir, setResizeDir] = useState("");
  const dragOffset = React.useRef({ x: 0, y: 0 });
  const resizeStart = React.useRef({ x: 0, y: 0, w: 0, h: 0, px: 0, py: 0 });

  const getResizeDir = (e) => {
    if (minimized) return "";
    const rect = containerRef.current.getBoundingClientRect();
    const threshold = 10;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    let dir = "";
    if (y < threshold) dir += "n";
    else if (y > rect.height - threshold) dir += "s";

    if (x < threshold) dir += "w";
    else if (x > rect.width - threshold) dir += "e";

    return dir;
  };

  const handleMouseDown = (e) => {
    const dir = getResizeDir(e);
    if (dir) {
      setIsResizing(true);
      setResizeDir(dir);
      resizeStart.current = {
        x: e.clientX,
        y: e.clientY,
        w: size.width,
        h: size.height,
        px: position.x,
        py: position.y
      };
      e.preventDefault();
      return;
    }

    // Only allow dragging from the header bar
    const header = e.target.closest('.summary-header-bar');
    if (!header) return;

    // Prevent dragging if clicking buttons or dropdowns
    if (e.target.closest('button') || e.target.closest('[role="button"]')) return;

    setIsDragging(true);
    dragOffset.current = {
      x: e.clientX - position.x,
      y: e.clientY - position.y
    };
  };

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (isDragging) {
        setPosition({
          x: e.clientX - dragOffset.current.x,
          y: e.clientY - dragOffset.current.y
        });
      } else if (isResizing) {
        const dx = e.clientX - resizeStart.current.x;
        const dy = e.clientY - resizeStart.current.y;
        const newSize = { ...size };
        const newPos = { ...position };

        if (resizeDir.includes("e")) {
          newSize.width = Math.max(300, resizeStart.current.w + dx);
        } else if (resizeDir.includes("w")) {
          const dw = Math.max(300, resizeStart.current.w - dx);
          if (dw !== 300 || resizeStart.current.w !== 300) {
            newSize.width = dw;
            newPos.x = resizeStart.current.px + (resizeStart.current.w - dw);
          }
        }

        if (resizeDir.includes("s")) {
          newSize.height = Math.max(150, resizeStart.current.h + dy);
        } else if (resizeDir.includes("n")) {
          const dh = Math.max(150, resizeStart.current.h - dy);
          if (dh !== 150 || resizeStart.current.h !== 150) {
            newSize.height = dh;
            newPos.y = resizeStart.current.py + (resizeStart.current.h - dh);
          }
        }

        setSize(newSize);
        setPosition(newPos);
      }
    };
    const handleMouseUp = () => {
      setIsDragging(false);
      setIsResizing(false);
      setResizeDir("");
    };

    if (isDragging || isResizing) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, isResizing, resizeDir, size, position]);

  const getScopeFilterParts = () => {
    const parts = [];
    if ((activeTab === "zones" || activeTab === "wards") && selectedZone) {
      parts.push(`zone_no='${selectedZone}'`);
    }
    if (activeTab === "wards" && selectedWard) {
      parts.push(`ward_no='${selectedWard}'`);
    }
    return parts;
  };

  const colorForCondition = (label) => {
    const k = String(label || "").toLowerCase();
    if (k.includes("poor") || k.includes("bad") || k.includes("very")) return "#e74c3c";
    if (k.includes("avg") || k.includes("average") || k.includes("fair")) return "#f1c40f";
    if (k.includes("good")) return "#2ecc71";
    return "#000000";
  };
  const handleConditionClick = (label) => {
    if (typeof onClassificationChange === "function") onClassificationChange("condition");
    let filter = `condition='${label}'`;
    const scopeParts = getScopeFilterParts();
    if (scopeParts.length > 0) filter += ` AND ${scopeParts.join(" AND ")}`;
    if (typeof onApplyFilter === "function") onApplyFilter(filter);
  };
  const getLegendColor = (attr, label) => {
    const m = legendColors[attr] || {};
    const key = String(label || "").trim().toLowerCase();
    return m[key] || (attr === "condition" ? colorForCondition(label) : "#000000");
  };
  const cityKey = useMemo(() => resolveCityKey(city), [city]);
  const handleClickGeneric = (classificationKey, attrField, label) => {
    if (typeof onClassificationChange === "function") onClassificationChange(classificationKey);
    const safe = String(label || "").replace(/'/g, "''");
    let filter = `${attrField}='${safe}'`;
    const scopeParts = getScopeFilterParts();
    if (scopeParts.length > 0) filter += ` AND ${scopeParts.join(" AND ")}`;
    if (typeof onApplyFilter === "function") onApplyFilter(filter);
  };
  useEffect(() => {
    const cfg = cityConfig[cityKey] || {};
    const cls = cfg.roadClassifications || {};
    const pairs = [
      { key: "condition", field: "condition" },
      { key: "category", field: "category" },
      { key: "cus", field: "cus_class" },
      { key: "material", field: "material" },
      { key: "ownership", field: "ownership" },
    ];
    pairs.forEach(async ({ key }) => {
      const layer = cls[key]?.layer;
      if (!layer) return;
      try {
        const url = `${GEOSERVER_BASE}/wms?REQUEST=GetLegendGraphic&VERSION=1.0.0&FORMAT=application/json&LAYER=${encodeURIComponent(
          layer
        )}`;
        const res = await fetch(url);
        const json = await res.json();
        const rules = json?.Legend?.[0]?.rules || [];
        const map = {};
        rules.forEach((rule) => {
          const title = String(rule.title || rule.name || "").trim().toLowerCase();
          const sym = rule.symbolizers?.[0];
          let color = "#000000";
          if (sym?.Polygon?.fill) color = sym.Polygon.fill;
          else if (sym?.Line?.stroke) color = sym.Line.stroke;
          else if (sym?.Point?.graphics?.[0]?.mark?.fill) color = sym.Point.graphics[0].mark.fill;
          if (title) map[title] = color;
        });
        setLegendColors((prev) => ({ ...prev, [key === "cus" ? "cus_class" : key]: map }));
      } catch { }
    });
  }, [cityKey]);

  useEffect(() => {
    const fetchZones = async () => {
      try {
        const res = await fetch(`/api/road-networks/${cityKey}`);
        if (!res.ok) {
          setError(`Failed to load zones (${res.status})`);
          return;
        }
        const data = await res.json();
        setZonesList(data);
      } catch (e) {
        setError(e?.message || "Failed to load zones");
      }
    };
    if (cityKey) fetchZones();
  }, [cityKey]);

  useEffect(() => {
    const fetchWards = async () => {
      // If there are valid zones but none selected, we don't fetch wards yet.
      // But if there are NO valid zones, we fetch all wards.
      if (hasValidZones && !selectedZone) {
        setWardsList([]);
        setSelectedWard("");
        return;
      }
      try {
        const url = selectedZone
          ? `/api/road-networks/${cityKey}/wards?zone=${encodeURIComponent(
            selectedZone
          )}`
          : `/api/road-networks/${cityKey}/wards`;

        const res = await fetch(url);
        if (!res.ok) {
          setError(`Failed to load wards (${res.status})`);
          return;
        }
        const wData = await res.json();
        const normalized = (Array.isArray(wData) ? wData : [])
          .map((w) => {
            if (w && typeof w === "object") {
              return {
                ward_no: w.ward_no,
                ward_name: w.ward_name,
                name: w.name || (w.ward_no ? `Ward ${w.ward_no}` : ""),
              };
            }
            const m = String(w || "").match(/(\d+)/);
            const wardNo = m ? m[1] : "";
            return { ward_no: wardNo, ward_name: null, name: wardNo ? `Ward ${wardNo}` : String(w || "") };
          })
          .filter((w) => w.ward_no !== "" && w.ward_no !== null && w.ward_no !== undefined);
        setWardsList(normalized);
      } catch (e) {
        setError(e?.message || "Failed to load wards");
      }
    };
    if (cityKey) fetchWards();
  }, [cityKey, selectedZone, hasValidZones]);

  const renderBigCard = (d) => {
    const isWardView = activeTab === "wards" && selectedWard;
    const isZoneView = (activeTab === "zones" || activeTab === "wards") && selectedZone && !isWardView;

    return (
      <div style={bigCardStyle}>
        {hasValidZones && (
          <div style={bigMetricStyle}>
            <div style={bigLabelStyle}>
              {isWardView ? "Selected Ward" : isZoneView ? "Selected Zone" : "No. of Zones"}
            </div>
            <div style={bigValueStyle}>
              {isWardView
                ? (wardsList.find((w) => String(w.ward_no) === String(selectedWard))?.name || `Ward ${selectedWard}`)
                : isZoneView
                  ? (zonesList.find((z) => String(z.zone_no) === String(selectedZone))?.name || `Zone ${selectedZone}`)
                  : d.zones}
            </div>
          </div>
        )}

        {!hasValidZones && isWardView && (
          <div style={bigMetricStyle}>
            <div style={bigLabelStyle}>Selected Ward</div>
            <div style={bigValueStyle}>
              {wardsList.find((w) => String(w.ward_no) === String(selectedWard))?.name || `Ward ${selectedWard}`}
            </div>
          </div>
        )}

        <div style={bigMetricStyle}>
          <div style={bigLabelStyle}>Total Road Length</div>
          <div style={bigValueStyle}>
            {Number(d.roadLengthKm || 0).toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}{" "}
            <span style={{ fontSize: 14, fontWeight: 600, opacity: 0.7 }}>km</span>
          </div>
        </div>

        <div style={bigMetricStyle}>
          <div style={bigLabelStyle}>Total No. of Roads</div>
          <div style={bigValueStyle}>{Number(d.totalRoads || 0).toLocaleString()}</div>
        </div>

        <div style={{ ...bigMetricStyle, borderRight: 'none' }}>
          <div style={bigLabelStyle}>Total Wards</div>
          <div style={bigValueStyle}>{Number(d.totalWards || 0).toLocaleString()}</div>
        </div>
      </div>
    );
  };

  const renderCards = (d) => {
    return (
      <>
        <div style={cardStyle}>
          <div style={labelStyle}>
            <span>Road Count of Category</span>
            <i className="fas fa-list-ul" style={{ opacity: 0.5 }}></i>
          </div>
          <div style={scrollListStyle} className="custom-scroll">
            {(d.byCategory || []).map((r) => (
              <div
                key={`cat-${r.label}`}
                style={{ ...listItemStyle, cursor: "pointer" }}
                onClick={() => handleClickGeneric("category", "category", r.label)}
              >
                <span>{r.label}</span>
                <span style={{ color: getLegendColor("category", r.label), fontWeight: 800 }}>
                  {r.count}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div style={cardStyle}>
          <div style={labelStyle}>
            <span>Road Count by Condition</span>
            <i className="fas fa-traffic-light" style={{ opacity: 0.5 }}></i>
          </div>
          <div style={scrollListStyle} className="custom-scroll">
            {(d.byCondition || []).map((r) => (
              <div
                key={`cond-${r.label}`}
                style={{ ...listItemStyle, cursor: "pointer" }}
                onClick={() => handleConditionClick(r.label)}
              >
                <span>{r.label}</span>
                <span style={{ color: getLegendColor("condition", r.label), fontWeight: 800 }}>
                  {r.count}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div style={cardStyle}>
          <div style={labelStyle}>
            <span>Road Count of Scheme</span>
            <i className="fas fa-building" style={{ opacity: 0.5 }}></i>
          </div>
          <div style={scrollListStyle} className="custom-scroll">
            {(d.byCus || []).map((r) => (
              <div
                key={`cus-${r.label}`}
                style={{ ...listItemStyle, cursor: "pointer" }}
                onClick={() => handleClickGeneric("cus", "cus_class", r.label)}
              >
                <span>{r.label}</span>
                <span style={{ color: getLegendColor("cus_class", r.label), fontWeight: 800 }}>
                  {r.count}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div style={cardSecondRowStyle}>
          <div style={labelStyle}>
            <span>Road Count of Material</span>
            <i className="fas fa-layer-group" style={{ opacity: 0.5 }}></i>
          </div>
          <div style={scrollListStyle} className="custom-scroll">
            {(d.byMaterial || []).map((r) => (
              <div
                key={`mat-${r.label}`}
                style={{ ...listItemStyle, cursor: "pointer" }}
                onClick={() => handleClickGeneric("material", "material", r.label)}
              >
                <span>{r.label}</span>
                <span style={{ color: getLegendColor("material", r.label), fontWeight: 800 }}>
                  {r.count}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div style={cardSecondRowStyle}>
          <div style={labelStyle}>
            <span>Road Count of Ownership</span>
            <i className="fas fa-user-tag" style={{ opacity: 0.5 }}></i>
          </div>
          <div style={scrollListStyle} className="custom-scroll">
            {(d.byOwnership || []).map((r) => (
              <div
                key={`own-${r.label}`}
                style={{ ...listItemStyle, cursor: "pointer" }}
                onClick={() => handleClickGeneric("ownership", "ownership", r.label)}
              >
                <span>{r.label}</span>
                <span style={{ color: getLegendColor("ownership", r.label), fontWeight: 800 }}>
                  {r.count}
                </span>
              </div>
            ))}
          </div>
        </div>
      </>
    );
  };

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        setError(null);
        let url = `/api/road-networks/${cityKey}/summary`;
        const params = new URLSearchParams();
        const filters = [];
        if (selectedZone) filters.push(`zone_no='${selectedZone}'`);
        if (selectedWard) filters.push(`ward_no='${selectedWard}'`);

        if (filters.length > 0) {
          params.append("filter", filters.join(" AND "));
        }

        const qs = params.toString();
        if (qs) url += `?${qs}`;

        const res = await fetch(url);
        if (res.ok) {
          const d = await res.json();
          setData(d);
        } else {
          const detail = await res.text();
          setError(detail ? `Failed to fetch data: ${detail}` : `Failed to fetch data (${res.status})`);
        }
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };
    if (cityKey) fetchData();
  }, [cityKey, selectedZone, selectedWard]);

  return (
    <div
      ref={containerRef}
      onMouseDown={handleMouseDown}
      onMouseMove={(e) => {
        if (isResizing) return;
        const dir = getResizeDir(e);
        if (dir) {
          e.currentTarget.style.cursor =
            dir === "n" || dir === "s" ? "ns-resize" :
              dir === "e" || dir === "w" ? "ew-resize" :
                dir === "nw" || dir === "se" ? "nwse-resize" :
                  dir === "ne" || dir === "sw" ? "nesw-resize" : "default";

          // Add visual feedback
          e.currentTarget.style.boxShadow = "0 0 0 2px rgba(59, 130, 246, 0.5)";
        } else {
          e.currentTarget.style.cursor = "default";
          e.currentTarget.style.boxShadow = "0 4px 12px rgba(0,0,0,0.15)";
        }
      }}
      onMouseLeave={(e) => {
        if (!isResizing) {
          e.currentTarget.style.boxShadow = "0 4px 12px rgba(0,0,0,0.15)";
        }
      }}
      style={{
        ...stripStyle,
        left: position.x,
        top: position.y,
        width: minimized ? "auto" : size.width,
        height: minimized ? "auto" : size.height,
        maxWidth: "calc(100vw - 40px)",
        maxHeight: "calc(100vh - 40px)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        transition: isDragging || isResizing ? "none" : "all 0.1s ease-out"
      }}
    >
      <div className="summary-header-bar" style={headerBarStyle}>
        <div
          style={{
            ...headItemStyle,
            cursor: "pointer",
            background:
              activeTab === "summary"
                ? "rgba(255, 255, 255, 0.4)"
                : "rgba(255, 255, 255, 0.15)",
          }}
          onClick={() => {
            setActiveTab("summary");
            setSelectedZone("");
            setSelectedWard("");
            setWardsList([]);
            setShowZoneDropdown(false);
            setShowWardDropdown(false);
            if (typeof onClassificationChange === "function") onClassificationChange(null);
            if (typeof onApplyFilter === "function") onApplyFilter("");
          }}
        >
          Summary
        </div>
        {hasValidZones && (
          <div
            ref={zonesBtnRef}
            style={{
              ...headItemStyle,
              cursor: "pointer",
              background:
                activeTab === "zones"
                  ? "rgba(255, 255, 255, 0.4)"
                  : "rgba(255, 255, 255, 0.15)",
              display: "flex",
              alignItems: "center",
              gap: "6px",
              position: "relative"
            }}
            onClick={() => {
              setActiveTab("zones");
              setShowZoneDropdown(!showZoneDropdown);
              setShowWardDropdown(false);
            }}
          >
            Zones
            {activeTab === "zones" && showZoneDropdown && (
              <div
                style={{
                  position: "absolute",
                  top: "100%",
                  left: "0",
                  marginTop: "4px",
                  background: "transparent",
                  zIndex: 5000,
                  minWidth: "auto",
                  width: "max-content",
                  maxHeight: zonesMaxHeight,
                  overflowY: "auto",
                  padding: "2px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "4px",
                }}
              >
                {zonesList.map((z) => (
                  <div
                    key={z.zone_no}
                    style={{
                      ...cardStyle,
                      width: "100%",
                      height: "55px",
                      whiteSpace: "nowrap",
                      flexDirection: "row",
                      alignItems: "center",
                      justifyContent: "flex-start",
                      padding: "0 12px",
                      cursor: "pointer",
                      fontSize: "13px",
                      fontWeight: String(selectedZone) === String(z.zone_no) ? "bold" : "normal",
                      background:
                        String(selectedZone) === String(z.zone_no)
                          ? "rgba(255, 255, 255, 0.6)"
                          : "rgba(255, 255, 255, 0.3)",
                      backdropFilter: "blur(4px)",
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedZone(z.zone_no);
                      setShowZoneDropdown(false);
                      setSelectedWard("");
                      setWardsList([]);
                      setShowWardDropdown(false);
                      if (typeof onClassificationChange === "function") onClassificationChange(null);
                      if (typeof onApplyFilter === "function") onApplyFilter(`zone_no='${z.zone_no}'`);
                    }}
                    onMouseEnter={(e) => {
                      if (String(selectedZone) !== String(z.zone_no))
                        e.currentTarget.style.backgroundColor = "rgba(255, 255, 255, 0.25)";
                    }}
                    onMouseLeave={(e) => {
                      if (String(selectedZone) !== String(z.zone_no))
                        e.currentTarget.style.backgroundColor = "rgba(255, 255, 255, 0.1)";
                    }}
                  >
                    {z.name || `Zone ${z.zone_no}`}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        <div
          ref={wardsBtnRef}
          style={{
            ...headItemStyle,
            cursor: "pointer",
            background:
              activeTab === "wards"
                ? "rgba(255, 255, 255, 0.4)"
                : "rgba(255, 255, 255, 0.15)",
            display: "flex",
            alignItems: "center",
            gap: "6px",
            position: "relative"
          }}
          onClick={() => {
            setActiveTab("wards");
            setShowWardDropdown(!showWardDropdown);
            setShowZoneDropdown(false);
          }}
        >
          Wards
          {activeTab === "wards" && showWardDropdown && (
            <div
              style={{
                position: "absolute",
                top: "100%",
                left: "0",
                marginTop: "4px",
                background: "transparent",
                zIndex: 5000,
                minWidth: "auto",
                width: "max-content",
                maxHeight: wardsMaxHeight,
                overflowY: "auto",
                padding: "2px",
                display: "flex",
                flexDirection: "column",
                gap: "4px",
              }}
            >
              {wardsList.length > 0 ? (
                wardsList.map((w) => (
                  <div
                    key={w.ward_no}
                    style={{
                      ...cardStyle,
                      width: "100%",
                      height: "55px",
                      whiteSpace: "nowrap",
                      flexDirection: "row",
                      alignItems: "center",
                      justifyContent: "flex-start",
                      padding: "0 12px",
                      cursor: "pointer",
                      fontSize: "13px",
                      fontWeight: String(selectedWard) === String(w.ward_no) ? "bold" : "normal",
                      background:
                        String(selectedWard) === String(w.ward_no)
                          ? "rgba(255, 255, 255, 0.6)"
                          : "rgba(255, 255, 255, 0.3)",
                      backdropFilter: "blur(4px)",
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedWard(w.ward_no);
                      setShowWardDropdown(false);
                      if (typeof onClassificationChange === "function") onClassificationChange(null);
                      const filter = selectedZone
                        ? `zone_no='${selectedZone}' AND ward_no='${w.ward_no}'`
                        : `ward_no='${w.ward_no}'`;
                      if (typeof onApplyFilter === "function") onApplyFilter(filter);
                    }}
                    onMouseEnter={(e) => {
                      if (String(selectedWard) !== String(w.ward_no))
                        e.currentTarget.style.backgroundColor = "rgba(255, 255, 255, 0.25)";
                    }}
                    onMouseLeave={(e) => {
                      if (String(selectedWard) !== String(w.ward_no))
                        e.currentTarget.style.backgroundColor = "rgba(255, 255, 255, 0.1)";
                    }}
                  >
                    {w.name || `Ward ${w.ward_no}`}
                  </div>
                ))
              ) : (
                <div
                  style={{
                    ...cardStyle,
                    width: "100%",
                    height: "50px",
                    padding: "0 12px",
                    fontSize: "13px",
                    color: "rgba(0,0,0,0.7)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: "rgba(255, 255, 255, 0.1)",
                    backdropFilter: "blur(4px)",
                  }}
                >
                  {hasValidZones && !selectedZone ? "Select Zone first" : "No wards found"}
                </div>
              )}
            </div>
          )}
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {loading && (
            <div style={{ display: "flex", alignItems: "center", color: "#333", marginRight: 4 }}>
              <i className="fas fa-spinner fa-spin" />
            </div>
          )}
          <button
            onClick={() => setMinimized(!minimized)}
            title={minimized ? "Maximize" : "Minimize"}
            style={{
              background: minimized ? "rgba(59,130,246,0.95)" : "rgba(107,114,128,0.95)",
              color: "#fff",
              border: "none",
              borderRadius: "50%",
              width: 30,
              height: 30,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
            }}
          >
            {minimized ? "▲" : "▼"}
          </button>
          <button
            onClick={onClose}
            title="Close"
            style={{
              background: "rgba(239,68,68,0.95)",
              color: "#fff",
              border: "none",
              borderRadius: "50%",
              width: 30,
              height: 30,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
            }}
          >
            <i className="fas fa-times" />
          </button>
        </div>
      </div>

      {!minimized && (
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflowY: 'auto', paddingRight: 4 }} className="custom-scroll">
          <style>{scrollbarStyles}</style>

          {error && !loading && (
            <div style={{ ...cardStyle, marginBottom: 16, height: 'auto', background: 'rgba(239, 68, 68, 0.1)' }}>
              <div style={{ ...labelStyle, color: '#ef4444' }}>Error</div>
              <div style={{ color: "#ef4444" }}>{String(error)}</div>
            </div>
          )}

          {data && (
            <>
              {renderBigCard(data)}
              <div style={gridStyle}>
                {renderCards(data)}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default SummaryTable;
