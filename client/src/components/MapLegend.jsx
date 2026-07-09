/* Dynamic map legend derived from visible layers and cityConfig metadata. */
import React, { useMemo, useState, useEffect } from "react";
import { cityConfig } from "../assets/configs/cityConfig";
import { chainageCityConfig } from "../assets/configs/chainageCityConfig";
import bankIcon from "../assets/Amenities_Icons/bank_1.png";
import busIcon from "../assets/Amenities_Icons/bus.png";
import graveyardIcon from "../assets/Amenities_Icons/graveyard.png";
import hospitalIcon from "../assets/Amenities_Icons/hospital.png";
import stadiumIcon from "../assets/Amenities_Icons/stadium.webp";
import hotelIcon from "../assets/Amenities_Icons/hotel.png";
import fuelIcon from "../assets/Amenities_Icons/fuel.png";
import metroIcon from "../assets/Amenities_Icons/metro.webp";
import educationIcon from "../assets/Amenities_Icons/education.png";
import religiousIcon from "../assets/Amenities_Icons/religious.png";
import toiletIcon from "../assets/Amenities_Icons/Community Toilet.png";
import chargingIcon from "../assets/Amenities_Icons/charging.png";
import govIcon from "../assets/Amenities_Icons/Central.png";
import landmarkIcon from "../assets/Amenities_Icons/landmark.png";
import postOfficeIcon from "../assets/Amenities_Icons/post-office.png";
import stateGovIcon from "../assets/Amenities_Icons/State.png";
import mosqueIcon from "../assets/Amenities_Icons/Mosque.png";
import locationIcon from "../assets/Amenities_Icons/location.png";
import manhole from "../assets/Amenities_Icons/manhole.jpg";
import railwayStationIcon from "../assets/Amenities_Icons/railway_station.svg";
import { getGeoserverBase } from "../utils/geoserverBase";
const GEOSERVER_BASE = getGeoserverBase();

const ATTRIBUTE_MAPPING = {
  condition: "condition",
  category: "category",
  material: "material",
  ownership: "ownership",
  cus: "cus_class",
  zone: "zone_no",
  ward: "ward_no",
};

const AMENITY_ICON_MAP = {
  atm_bank: bankIcon,
  bus_stop: busIcon,
  bus_stand: busIcon,
  graveyard: graveyardIcon,
  hospital: hospitalIcon,
  hotel: hotelIcon,
  petrol_pump: fuelIcon,
  stadium: stadiumIcon,
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
  manhole: manhole,
};

// Component to fetch and render dynamic legend
const DynamicLegendItem = ({ item, city, roadFilter, extent }) => {
  const [legendItems, setLegendItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [counts, setCounts] = useState({});

  // 1. Fetch Legend Graphics (Colors)
  useEffect(() => {
    let isMounted = true;

    const fetchLegendGraphic = async () => {
      try {
        const styleParam = item.style ? `&STYLE=${encodeURIComponent(item.style)}` : "";
        const wmsUrl = `${GEOSERVER_BASE}/wms?REQUEST=GetLegendGraphic&VERSION=1.0.0&FORMAT=application/json&LAYER=${encodeURIComponent(
          item.layer
        )}${styleParam}`;

        const res = await fetch(wmsUrl);
        const json = await res.json();

        if (!isMounted) return;

        const rules = json?.Legend?.[0]?.rules || [];
        const items = rules.map((rule) => {
          const title = String(rule.title || rule.name || "").trim();
          const sym = rule.symbolizers?.[0];
          let color = "#ccc";

          if (sym?.Polygon?.fill) color = sym.Polygon.fill;
          else if (sym?.Line?.stroke) color = sym.Line.stroke;
          else if (sym?.Point?.graphics?.[0]?.mark?.fill) color = sym.Point.graphics[0].mark.fill;

          // Helper to get rule-specific icon if needed, but color block is usually enough and cleaner
          // We can also use the GetLegendGraphic RULE param for the icon
          let iconUrl = `${GEOSERVER_BASE}/wms?REQUEST=GetLegendGraphic&VERSION=1.0.0&FORMAT=image/png&WIDTH=20&HEIGHT=20&LAYER=${encodeURIComponent(item.layer)}${styleParam}&LEGEND_OPTIONS=forceLabels:off`;
          if (rule.name) {
            iconUrl += `&RULE=${encodeURIComponent(rule.name)}`;
          }

          return { label: title, name: rule.name, color, iconUrl };
        });

        setLegendItems(items);
      } catch (err) {
        if (isMounted) setLegendItems([]);
      }
    };

    fetchLegendGraphic();
    return () => { isMounted = false; };
  }, [item.layer, item.style]);

  // 2. Fetch Summary Counts (Table Data)
  useEffect(() => {
    let isMounted = true;
    setLoading(true);

    if (item.noCounts) {
      if (isMounted) {
        setCounts({});
        setLoading(false);
      }
      return () => { isMounted = false; };
    }

    const fetchCounts = async () => {
      try {
        const params = new URLSearchParams();
        if (roadFilter) {
          params.set("filter", roadFilter);
        }
        // Live extent sync: keep this badge's count matching the map's
        // current viewport, same as the bottom table - without this it
        // stayed static (zone/ward/category-scoped only) while everything
        // else on screen updated on pan/zoom.
        if (Array.isArray(extent) && extent.length === 4) {
          params.set("bbox", extent.join(","));
        }

        // Use the summary API which aggregates counts based on spatial filter
        const url = `/api/road-networks/${city.toLowerCase()}/summary?${params.toString()}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error("Failed to fetch summary");

        const data = await res.json();

        if (!isMounted) return;

        // Map attribute to the corresponding summary field
        let mapping = {};
        const getCountMap = (arr) => {
          const map = {};
          if (Array.isArray(arr)) {
            arr.forEach(obj => {
              // normalize label — zone_no/ward_no come back as numbers (both
              // columns are INTEGER in the DB), not strings, so this must
              // coerce before lowercasing or every zone/ward count silently
              // throws and the whole map ends up empty (which is what was
              // making the legend fall back to showing every zone/ward
              // swatch unfiltered instead of just the ones actually present).
              map[String(obj.label).toLowerCase()] = obj.count;
            });
          }
          return map;
        };

        if (item.attribute === "condition") mapping = getCountMap(data.byCondition);
        else if (item.attribute === "category") mapping = getCountMap(data.byCategory);
        else if (item.attribute === "material") mapping = getCountMap(data.byMaterial);
        else if (item.attribute === "ownership") mapping = getCountMap(data.byOwnership);
        else if (item.attribute === "cus_class") mapping = getCountMap(data.byCus);
        else if (item.attribute === "zone_no") mapping = getCountMap(data.byZone);
        else if (item.attribute === "ward_no") mapping = getCountMap(data.byWard);

        setCounts(mapping);
      } catch (err) {
        setCounts({});
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    fetchCounts();
    return () => { isMounted = false; };
  }, [city, item.attribute, roadFilter, item.noCounts, extent]);

  if (loading && legendItems.length === 0) return <div style={{ fontSize: '11px', color: '#888' }}>Loading...</div>;

  // Render items that have counts > 0, OR all items if no counts available (fallback)
  // The user wants "fetch from table", so we prioritize items present in the table summary.

  // Create a merged list
  let displayItems = [];

  // Special handling for Ward/Zone breakdown when WMS legend is generic
  // (single symbol) - if we have detailed counts but only a generic legend
  // item, we explode the counts into legend items instead of falling
  // through to the plain WMS rule title. That title is frequently just the
  // bare zone/ward number with no context ("1" instead of "Zone No. 1"),
  // which reads as meaningless on its own next to a count.
  const explodeAttributeLabel = item.attribute === "ward_no"
    ? "Ward No."
    : item.attribute === "zone_no"
      ? "Zone No."
      : null;
  const hasManyCounts = Object.keys(counts).length > 0;
  const hasFewLegendItems = legendItems.length <= 1; // Usually 1 generic item like "gold line"

  if (explodeAttributeLabel && hasManyCounts && hasFewLegendItems) {
    // Explode counts into legend items using the generic style
    let template = legendItems[0];

    if (!template) {
      // Fallback if no rules found: use generic layer legend
      const genericIconUrl = `${GEOSERVER_BASE}/wms?REQUEST=GetLegendGraphic&VERSION=1.0.0&FORMAT=image/png&WIDTH=20&HEIGHT=20&LAYER=${encodeURIComponent(item.layer)}&LEGEND_OPTIONS=forceLabels:off`;
      template = { color: '#ccc', iconUrl: genericIconUrl };
    }

    displayItems = Object.entries(counts).map(([label, count]) => ({
      label: `${explodeAttributeLabel} ${label}`, // e.g. "Zone No. 1" / "Ward No. 1"
      name: label, // e.g. "1" (used for filter)
      color: template.color,
      iconUrl: template.iconUrl,
      count
    }));

    // Sort numerically
    displayItems.sort((a, b) => {
      const na = parseInt(a.name, 10);
      const nb = parseInt(b.name, 10);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });

  } else {
    // Standard matching: match WMS legend items to counts. GeoServer's own
    // rule titles for a zone/ward layer are frequently just the bare number
    // ("1"), one rule per zone/ward with its own real color - preserve that
    // per-item color/icon, only relabel the bare-numeric title so it still
    // reads as "Zone No. 1" instead of a meaningless "1".
    displayItems = legendItems.map(lItem => {
      const count = counts[lItem.label.toLowerCase()] || 0;
      const label = explodeAttributeLabel && /^\d+$/.test(String(lItem.label).trim())
        ? `${explodeAttributeLabel} ${lItem.label.trim()}`
        : lItem.label;
      return { ...lItem, label, count };
    });
  }

  // Filter out zero counts if we have at least some data?
  // If the table returns data, we should probably only show what's there.
  const hasAnyCounts = Object.keys(counts).length > 0 && !item.noCounts;

  // If we have counts, filter. If not (e.g. API error or empty), show all but with 0.
  const finalItems = hasAnyCounts
    ? displayItems.filter(i => i.count > 0)
    : displayItems;

  if (finalItems.length === 0) {
    return <div style={{ fontSize: '11px', color: '#888' }}>{item.noCounts ? "No legend available" : "No matching features in area"}</div>;
  }

  return (
    <div className="dynamic-legend-grid" style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      {finalItems.map((lItem, idx) => {
        // Construct filter expression
        // We need to handle numeric vs string values roughly
        // For safety, assume string and quote it, unless we know it's numeric?
        // Actually, the summary API returns labels.
        // We'll use the label as the value.
        // For Ward explosion, lItem.name is the raw value ("1").

        const valToUse = lItem.name || lItem.label; // Prefer name if available
        const safeVal = `'${valToUse.replace(/'/g, "''")}'`;
        const filterExpr = `${item.attribute}=${safeVal}`;

        return (
          <div
            key={idx}
            style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}
            onClick={() => item.onApply && item.onApply(filterExpr)}
            title={`Filter by ${lItem.label} (${lItem.count})`}
          >
            {lItem.iconUrl ? (
              <img
                src={lItem.iconUrl}
                alt={lItem.label}
                style={{ width: '20px', height: '20px', objectFit: 'contain' }}
                onError={(e) => {
                  const img = e.currentTarget;
                  if (!img) return;
                  img.style.display = "none";

                  const parent = img.parentNode;
                  if (!parent) return;

                  if (parent.querySelector('.fallback-color-box')) return;

                  const span = document.createElement('span');
                  span.className = 'fallback-color-box';
                  span.style.width = '20px';
                  span.style.height = '20px';
                  span.style.backgroundColor = lItem.color || '#ccc';
                  span.style.display = 'inline-block';
                  span.style.borderRadius = '2px';
                  parent.insertBefore(span, img);
                }}
              />
            ) : (
              <div style={{ width: '20px', height: '20px', backgroundColor: lItem.color || '#ccc', borderRadius: '2px' }}></div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', flex: 1, fontSize: '11px' }}>
              <span>{lItem.label}</span>
              {!item.noCounts && (
                <span style={{ fontWeight: 'bold', marginLeft: '4px' }}>
                  {lItem.count.toLocaleString()} {lItem.count === 1 ? "road" : "roads"}
                </span>
              )}
            </div>
          </div>
        )
      })}
    </div>
  );
};

const BoundaryLegendItem = ({ item, colorOverride }) => {
  const [legendColor, setLegendColor] = useState(colorOverride || "#ccc");
  const [iconUrl, setIconUrl] = useState("");
  const [loading, setLoading] = useState(!colorOverride);

  useEffect(() => {
    // MapContainer already resolved (and applied to the actual rendered
    // layer) the correct color for zone/ward boundaries — use that instead
    // of independently fetching, which previously hit a different
    // GeoServer endpoint and could show a different color than the map.
    if (colorOverride) {
      setLegendColor(colorOverride);
      setLoading(false);
      return;
    }
    let isMounted = true;

    const fetchLegendGraphic = async () => {
      try {
        const wmsUrl = `${GEOSERVER_BASE}/wms?REQUEST=GetLegendGraphic&VERSION=1.0.0&FORMAT=application/json&LAYER=${encodeURIComponent(
          item.layer
        )}`;

        const res = await fetch(wmsUrl);
        const json = await res.json();

        if (!isMounted) return;

        const rules = json?.Legend?.[0]?.rules || [];
        const rule = rules.find((r) => r?.symbolizers?.[0]) || rules[0];
        const sym = rule?.symbolizers?.[0];
        let color = "#ccc";

        if (sym?.Polygon?.fill) color = sym.Polygon.fill;
        else if (sym?.Line?.stroke) color = sym.Line.stroke;
        else if (sym?.Point?.graphics?.[0]?.mark?.fill) color = sym.Point.graphics[0].mark.fill;

        if (!isMounted) return;
        setLegendColor(color || "#ccc");
        setIconUrl(
          `${GEOSERVER_BASE}/wms?REQUEST=GetLegendGraphic&VERSION=1.0.0&FORMAT=image/png&WIDTH=20&HEIGHT=20&LAYER=${encodeURIComponent(
            item.layer
          )}&LEGEND_OPTIONS=forceLabels:off`
        );
      } catch (err) {
        if (isMounted) {
          setLegendColor("#ccc");
          setIconUrl("");
        }
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    fetchLegendGraphic();
    return () => { isMounted = false; };
  }, [item.layer, item.label, colorOverride]);

  if (loading) {
    return <div style={{ fontSize: '11px', color: '#888' }}>Loading...</div>;
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      {iconUrl ? (
        <img
          src={iconUrl}
          alt={item.label}
          style={{ width: '18px', height: '18px', objectFit: 'contain' }}
          onError={(e) => {
            const img = e.currentTarget;
            if (img) img.style.display = 'none';
          }}
        />
      ) : (
        <div
          style={{
            width: '14px',
            height: '14px',
            borderRadius: '3px',
            border: `2px solid ${legendColor || '#ccc'}`,
            background: 'transparent',
            boxSizing: 'border-box'
          }}
        ></div>
      )}
      <div style={{ fontSize: '11px', color: '#1e2b3a' }}>{item.label}</div>
    </div>
  );
};

// Shared section-title treatment - bold, uppercase, underlined - so every
// group in the legend (Administrative Boundaries, Chainage, DSS, Amenities,
// Others, per-item labels) reads as a clearly separated block instead of
// blending together under the same plain small-caption style.
const SectionTitle = ({ children }) => (
  <div
    style={{
      fontSize: "11px",
      fontWeight: 700,
      marginBottom: "8px",
      paddingBottom: "5px",
      color: "#16233a",
      letterSpacing: "0.4px",
      textTransform: "uppercase",
      borderBottom: "1px solid rgba(255, 255, 255, 0.4)",
    }}
  >
    {children}
  </div>
);

const MapLegend = ({ city, mode, hasSelectedChainageRoad, layerVisibility, roadFilter, onApplyFilter, amenityCounts, otherCounts, extent, dssLegend, zoneBoundaryColor, wardBoundaryColor, restrictedMode = false }) => {
  // Draggable & Minimized State
  const [position, setPosition] = useState(null); // {x, y} or null
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  // Field-task redirects target a small mobile screen — start collapsed so
  // it doesn't eat map space until someone actually wants to check it;
  // normal dashboard use is unaffected (still starts expanded).
  const [minimized, setMinimized] = useState(restrictedMode);
  const [isMobileView, setIsMobileView] = useState(window.innerWidth <= 768);

  const legendRef = React.useRef(null);

  // Handle global mouse move/up
  useEffect(() => {
    const handlePointerMove = (e) => {
      if (!isDragging) return;
      e.preventDefault();
      setPosition({
        x: e.clientX - dragOffset.x,
        y: e.clientY - dragOffset.y,
      });
    };

    const handlePointerUp = () => {
      setIsDragging(false);
    };

    if (isDragging) {
      document.addEventListener("pointermove", handlePointerMove);
      document.addEventListener("pointerup", handlePointerUp);
      document.addEventListener("pointercancel", handlePointerUp);
    }

    return () => {
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", handlePointerUp);
      document.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [isDragging, dragOffset]);

  useEffect(() => {
    const handleResize = () => {
      setIsMobileView(window.innerWidth <= 768);
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const handlePointerDown = (e) => {
    e.stopPropagation();
    // Only allow dragging from the header
    if (legendRef.current) {
      const rect = legendRef.current.getBoundingClientRect();

      // If position is null (first drag), set it to current rect
      if (!position) {
        setPosition({ x: rect.left, y: rect.top });
      }

      setDragOffset({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      });
      setIsDragging(true);
    }
  };

  const legendItems = useMemo(() => {
    const items = [];
    const cityKey = city?.toLowerCase();
    const cfg = cityConfig[cityKey] || {};
    const chainageCfg = chainageCityConfig[cityKey] || null;

    if (cfg.zoneLayer) {
      items.push({
        id: "zone_boundary",
        label: "Zone Boundary",
        layer: cfg.zoneLayer,
        boundary: true,
      });
    }
    if (cfg.wardLayer) {
      items.push({
        id: "ward_boundary",
        label: "Ward Boundary",
        layer: cfg.wardLayer,
        boundary: true,
      });
    }

    // Note: no legend entry for chainageCfg.roadLayer (roadLayerRef in
    // MapContainer) — that layer is intentionally always invisible except
    // for the zone/ward deep-link case; it exists only to answer identify
    // clicks, never to be drawn, so it shouldn't appear in the legend either.

    if (mode === "CHAINAGE" && hasSelectedChainageRoad && chainageCfg?.chainageLayer) {
      items.push({
        id: "chainage_points",
        label: "Selected Road Chainage",
        layer: chainageCfg.chainageLayer,
        // Must match the STYLES override MapContainer actually applies to
        // this layer once a road is selected (see chainageSource.updateParams
        // in openChainageForRoadId) — the layer's own default GeoServer style
        // renders differently, which is what made the legend swatch not
        // match what's actually drawn on the map.
        style: "chainage_distance_label",
        group: "chainage",
      });
    }

    // 1. Amenities
    const formatAmenityLabel = (value) =>
      String(value || "")
        .split("_")
        .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : ""))
        .join(" ");

    if (layerVisibility?.amenities) {
      Object.entries(layerVisibility.amenities).forEach(([key, visible]) => {
        if (visible && Object.prototype.hasOwnProperty.call(cfg.amenities || {}, key)) {
          items.push({
            id: key,
            label: formatAmenityLabel(key),
            layer: cfg.amenities[key] || "",
            group: "amenities",
          });
        }
      });
    }

    // 2. Others
    if (layerVisibility?.others) {
      Object.entries(layerVisibility.others).forEach(([key, visible]) => {
        if (visible && Object.prototype.hasOwnProperty.call(cfg.others || {}, key)) {
          items.push({
            id: key,
            label: formatAmenityLabel(key),
            layer: cfg.others[key] || "",
            group: "others",
          });
        }
      });
    }

    // 2A. LCLU
    if (layerVisibility?.lclu) {
      const cityPrefix = String(cfg.name || "").replace(/\s+/g, "_");
      const prefix = cityPrefix ? `${cityPrefix}_` : "";
      Object.entries(layerVisibility.lclu).forEach(([key, visible]) => {
        if (visible && Object.prototype.hasOwnProperty.call(cfg.LCLUClassifications || {}, key)) {
          const shortKey = prefix && String(key).startsWith(prefix) ? String(key).slice(prefix.length) : key;
          items.push({
            id: key,
            label: formatAmenityLabel(shortKey),
            layer: cfg.LCLUClassifications[key] || "",
            group: "lclu",
          });
        }
      });
    }

    // 3. Network Layers (Specialized)
    if (layerVisibility?.network) {
      Object.entries(cfg.specializedNetworks || {}).forEach(([id, specCfg]) => {
        if (layerVisibility.network[id]) {
          const isGroup = specCfg && typeof specCfg === "object" && specCfg.options;
          const activeOption = layerVisibility?.specializedOptions?.[id];
          const defaultNoneGroup = id === "drainage" || id === "slum";

          if (
            isGroup &&
            (String(activeOption) === "none" ||
              (defaultNoneGroup && (activeOption === undefined || activeOption === null)))
          ) {
            return;
          }

          let layerName = "";
          let label = specCfg.label || id.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');

          if (isGroup) {
            const optKey = activeOption || Object.keys(specCfg.options)[0];
            const opt = specCfg.options[optKey];
            layerName = typeof opt === "string" ? opt : (opt?.layer || "");
            const optLabel = typeof opt === "string" ? optKey : (opt?.label || optKey);
            label = `${label} (${optLabel})`;
          } else {
            layerName = typeof specCfg === "string" ? specCfg : (specCfg.layer || "");
          }

          if (layerName) {
            items.push({
              id: id,
              label: label,
              layer: layerName,
              isDynamic: true,
              noCounts: true,
            });
          }
        }
      });
    }

    // 3A. Road Classification Legends via Sidebar toggles
    if (layerVisibility?.roadClassifications) {
      Object.entries(layerVisibility.roadClassifications).forEach(
        ([key, visible]) => {
          if (
            visible &&
            cfg.roadClassifications?.[key] &&
            ["category", "condition", "material", "ownership", "cus", "zone", "ward"].includes(
              key
            )
          ) {
            const rcfg = cfg.roadClassifications?.[key];
            const layerName = rcfg && typeof rcfg === "object" ? rcfg.layer : "";
            const styleName = rcfg && typeof rcfg === "object" ? (rcfg.style || "") : "";
            if (!layerName) return;
            items.push({
              id: `road_${key}`,
              label: `Road ${key.charAt(0).toUpperCase() + key.slice(1)}`,
              layer: layerName,
              style: styleName,
              isDynamic: true,
              attribute: ATTRIBUTE_MAPPING[key] || key,
              onApply: (filterExpr) => {
                if (!onApplyFilter) return;

                // Parse current roadFilter to preserve spatial context (zone/ward)
                // unless the new filter overrides it.
                const currentFilter = roadFilter || "";
                const parts = [];

                // Support both quoted and unquoted values (robustness)
                const zoneMatch = currentFilter.match(/zone_no\s*=\s*(?:'[^']+'|"[^"]+"|\d+)/);
                const wardMatch = currentFilter.match(/ward_no\s*=\s*(?:'[^']+'|"[^"]+"|\d+)/);

                const isZoneFilter = filterExpr.startsWith("zone_no");
                const isWardFilter = filterExpr.startsWith("ward_no");

                // Keep zone if we are not setting a new zone
                if (zoneMatch && !isZoneFilter) {
                  parts.push(zoneMatch[0]);
                }

                // Keep ward if we are not setting a new ward
                // (Also, usually ward implies zone, but if we change ward we might drop old ward)
                if (wardMatch && !isWardFilter) {
                  parts.push(wardMatch[0]);
                }

                parts.push(filterExpr);
                onApplyFilter(parts.join(" AND "));
              },
            });
          }
        }
      );
    }

    // 3B. Road Layers via Filter (Base or Classification) - ONLY IF NO CLASSIFICATION VISIBLE
    // If we have any classification visible, we skip this to avoid duplicates or showing "Road Network"
    const hasClassificationVisible = items.some(i => i.id.startsWith("road_"));

    if (roadFilter && !hasClassificationVisible) {
      const filterLower = roadFilter.toLowerCase();
      let activeKey = null;

      if (filterLower.includes("condition")) activeKey = "condition";
      else if (filterLower.includes("category")) activeKey = "category";
      else if (filterLower.includes("material")) activeKey = "material";
      else if (filterLower.includes("ownership")) activeKey = "ownership";
      else if (filterLower.includes("cus_class")) activeKey = "cus";
      else if (filterLower.includes("zone")) activeKey = "zone";
      else if (filterLower.includes("ward_no")) activeKey = "ward";

      if (activeKey && cfg.roadClassifications?.[activeKey]) {
        // Case A: Classification Layer
        // Avoid duplicate legend when the same classification is already toggled in the sidebar
        const alreadyToggled =
          !!layerVisibility?.roadClassifications?.[activeKey];
        if (!alreadyToggled) {
          const rcfg = cfg.roadClassifications?.[activeKey];
          const layerName = rcfg && typeof rcfg === "object" ? rcfg.layer : "";
          const styleName = rcfg && typeof rcfg === "object" ? (rcfg.style || "") : "";
          if (!layerName) return;
          items.push({
            id: `road_${activeKey}`,
            label: `Road by ${activeKey.charAt(0).toUpperCase() + activeKey.slice(1)}`,
            layer: layerName,
            style: styleName,
            isDynamic: true,
            attribute: ATTRIBUTE_MAPPING[activeKey] || activeKey,
            onApply: (filterExpr) => {
              if (!onApplyFilter) return;

              // Parse current roadFilter to preserve spatial context (zone/ward)
              const currentFilter = roadFilter || "";
              const parts = [];

              // Support both quoted and unquoted values (robustness)
              const zoneMatch = currentFilter.match(/zone_no\s*=\s*(?:'[^']+'|"[^"]+"|\d+)/);
              const wardMatch = currentFilter.match(/ward_no\s*=\s*(?:'[^']+'|"[^"]+"|\d+)/);

              const isZoneFilter = filterExpr.startsWith("zone_no");
              const isWardFilter = filterExpr.startsWith("ward_no");

              if (zoneMatch && !isZoneFilter) parts.push(zoneMatch[0]);
              if (wardMatch && !isWardFilter) parts.push(wardMatch[0]);

              parts.push(filterExpr);
              onApplyFilter(parts.join(" AND "));
            },
          });
        }
      } else if (cfg.roadLayer) {
        // Case B: Base Road Network (Search Mode)
        // If we are filtering by Ward or Zone but don't have a specific classification layer for it,
        // we can still explode the base layer legend (e.g. "Ward 1", "Ward 2") if the filter is active.
        let inferredAttribute = null;
        if (activeKey === "ward") inferredAttribute = "ward_no";
        else if (activeKey === "zone") inferredAttribute = "zone_no";

        items.push({
          id: "road_network",
          label: inferredAttribute ? `Road by ${inferredAttribute === 'ward_no' ? 'Ward' : 'Zone'}` : "Road Network",
          layer: cfg.roadLayer,
          attribute: inferredAttribute, // This triggers the explosion logic in DynamicLegendItem if counts exist
          isDynamic: !!inferredAttribute, // ⭐ Enable dynamic mode if we have an attribute to explode
        });
      }
    }

    return items;
  }, [city, mode, hasSelectedChainageRoad, layerVisibility, roadFilter]);

  if (legendItems.length === 0) return null;

  const headerTitle = legendItems.length === 1 ? legendItems[0].label : "Legend";
  const hideItemLabel = legendItems.length === 1;
  const safeItems = (legendItems || []).filter(Boolean);
  const boundaryItems = safeItems.filter((item) => item.boundary);
  const chainageItems = safeItems.filter((item) => item.group === "chainage");
  const amenityItems = safeItems.filter((item) => item.group === "amenities");
  const otherItems = safeItems.filter((item) => item.group === "others");
  const remainingItems = safeItems.filter(
    (item) => !item.boundary && item.group !== "chainage" && item.group !== "amenities" && item.group !== "others"
  );
  const dssGroups = Array.isArray(dssLegend) ? dssLegend.filter(Boolean) : [];

  return (
    <div
      id="map-legend-panel"
      ref={legendRef}
      style={{
        position: "fixed",
        // If we have a position state, use it (dragged mode)
        // Otherwise, fallback to initial bottom-right (anchored mode).
        // Field-task mode always shows the bottom data table, which the
        // normal mobile bottom-anchored legend sits directly underneath
        // (invisible and unreachable) — anchor to the top instead, same as
        // desktop, since there's no toolbar row competing for that space
        // on this restricted layout.
        left: position ? position.x : undefined,
        top: position ? position.y : (isMobileView && !restrictedMode ? undefined : "70px"),
        bottom: position ? undefined : (isMobileView && !restrictedMode ? "80px" : undefined),
        right: position ? undefined : "10px",

        background: "linear-gradient(149deg, rgba(54, 209, 214, 0.78) 15%, rgba(91, 134, 229, 0.78) 55%)",
        backdropFilter: "blur(10px)",
        border: "1px solid rgba(255, 255, 255, 0.6)",
        borderRadius: "8px",
        boxShadow: "0 6px 18px rgba(0,0,0,0.28)",
        zIndex: 4000, // Higher than summary table (3000)
        // Collapsed state only needs to fit the title + one icon button —
        // no reason for it to claim the same width the expanded content
        // view needs, and on a phone that width reads as chunky/oversized
        // for what's just a toggle.
        minWidth: isMobileView ? (minimized ? "110px" : "170px") : "200px",
        maxWidth: isMobileView ? "220px" : "250px",
        display: "flex",
        flexDirection: "column",
        maxHeight: minimized ? "auto" : (isMobileView ? "40vh" : "500px"),
        transition: isDragging ? "none" : "max-height 0.3s ease",
      }}
    >
      {/* Draggable Header */}
      <div
        onPointerDown={handlePointerDown}
        style={{
          padding: isMobileView ? "6px 9px" : "9px 12px",
          background: "rgba(255, 255, 255, 0.18)",
          borderBottom: minimized ? "none" : "1px solid rgba(255, 255, 255, 0.4)",
          borderRadius: "8px 8px 0 0",
          cursor: isDragging ? "grabbing" : "grab",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          userSelect: "none",
          touchAction: "none",
        }}
      >
        <h4 style={{ margin: 0, display: "flex", alignItems: "center", gap: "6px", fontSize: isMobileView ? "12px" : "13px", fontWeight: 700, color: "#203148", letterSpacing: "0.2px" }}>
          <i className="fas fa-layer-group" style={{ fontSize: isMobileView ? "11px" : "12px", opacity: 0.75 }} />
          {headerTitle}
        </h4>
        <div style={{ display: "flex", gap: "6px" }}>
          <button
            onClick={(e) => {
              e.stopPropagation(); // Prevent drag start
              setMinimized(!minimized);
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.4)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            title={minimized ? "Expand" : "Minimize"}
            style={{
              border: "none",
              background: "transparent",
              borderRadius: "5px",
              cursor: "pointer",
              color: "#1f2a3a",
              padding: 0,
              width: isMobileView ? "17px" : "20px",
              height: isMobileView ? "17px" : "20px",
              transition: "background 0.15s ease",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <i className={`fas fa-${minimized ? "plus" : "minus"}`} style={{ fontSize: isMobileView ? "11px" : "12px" }} />
          </button>
        </div>
      </div>

      {/* Content */}
      {!minimized && (
        <div
          style={{
            padding: "12px",
            overflowY: "auto",
            maxHeight: "450px"
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {boundaryItems.length > 0 && (
              <div>
                <SectionTitle>Administrative Boundaries</SectionTitle>
                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  {boundaryItems.map((item) => (
                    <div key={item.id}>
                      <BoundaryLegendItem
                        item={item}
                        colorOverride={
                          item.id === "zone_boundary"
                            ? zoneBoundaryColor
                            : item.id === "ward_boundary"
                              ? wardBoundaryColor
                              : undefined
                        }
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
            {chainageItems.length > 0 && (
              <div>
                <SectionTitle>Chainage</SectionTitle>
                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  {chainageItems.map((item) => (
                    <div key={item.id}>
                      <img
                        src={`${GEOSERVER_BASE}/wms?REQUEST=GetLegendGraphic&VERSION=1.0.0&FORMAT=image/png&WIDTH=20&HEIGHT=20&LAYER=${encodeURIComponent(
                          item.layer
                        )}&LEGEND_OPTIONS=forceLabels:on;fontName:Arial;fontSize:11;fontAntiAliasing:true`}
                        alt={item.label}
                        style={{
                          maxWidth: "100%",
                          display: "block",
                          background: "rgba(255,255,255,0.88)",
                          borderRadius: "6px",
                          padding: "4px 6px",
                          border: "1px solid rgba(0,0,0,0.08)",
                        }}
                        onError={(e) => {
                          const img = e.currentTarget;
                          if (img) img.style.display = "none";
                        }}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
            {dssGroups.length > 0 && (
              <div>
                <SectionTitle>DSS</SectionTitle>
                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                  {dssGroups.map((group) => (
                    <div key={group.id}>
                      <div style={{ fontSize: "12px", fontWeight: 600, marginBottom: "6px", color: "#1e2b3a" }}>
                        {group.title}
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                        {(group.rows || []).filter(Boolean).map((row, idx) => (
                          <div
                            key={`${group.id}-${idx}`}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "8px",
                              background: "rgba(255,255,255,0.88)",
                              borderRadius: "6px",
                              padding: "4px 6px",
                              border: "1px solid rgba(0,0,0,0.08)",
                            }}
                          >
                            <span
                              style={{
                                width: "12px",
                                height: "12px",
                                borderRadius: "3px",
                                background: row.color || "#94a3b8",
                                border: "1px solid rgba(0,0,0,0.12)",
                                flex: "0 0 auto",
                              }}
                            />
                            <div style={{ display: "flex", justifyContent: "space-between", flex: 1, fontSize: "12px", color: "#1e2b3a" }}>
                              <span>{row.label}</span>
                              <span style={{ fontWeight: 600 }}>
                                {typeof row.count === "number" ? row.count : "—"}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {amenityItems.length > 0 && (
              <div>
                <SectionTitle>Amenities</SectionTitle>
                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  {amenityItems.map((item) => {
                    if (!item) return null;
                    const icon = AMENITY_ICON_MAP[item.id];
                    const count = typeof amenityCounts?.[item.id] === "number" ? amenityCounts[item.id] : null;
                    const legendUrl = item.layer
                      ? `${GEOSERVER_BASE}/wms?REQUEST=GetLegendGraphic&VERSION=1.0.0&FORMAT=image/png&WIDTH=20&HEIGHT=20&LAYER=${encodeURIComponent(
                        item.layer
                      )}${item.style ? `&STYLE=${encodeURIComponent(item.style)}` : ""}&LEGEND_OPTIONS=forceLabels:off`
                      : "";
                    return (
                      <div
                        key={item.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "8px",
                          background: "rgba(255,255,255,0.88)",
                          borderRadius: "6px",
                          padding: "4px 6px",
                          border: "1px solid rgba(0,0,0,0.08)",
                        }}
                      >
                        {icon ? (
                          <img
                            src={icon}
                            alt={item.label}
                            style={{ width: "16px", height: "16px", objectFit: "contain" }}
                          />
                        ) : legendUrl ? (
                          <img
                            src={legendUrl}
                            alt={item.label}
                            style={{ width: "16px", height: "16px", objectFit: "contain" }}
                            onError={(e) => {
                              const img = e.currentTarget;
                              if (img) img.style.display = "none";
                            }}
                          />
                        ) : null}
                        <div style={{ display: "flex", justifyContent: "space-between", flex: 1, fontSize: "12px", color: "#1e2b3a" }}>
                          <span>{item.label}</span>
                          <span style={{ fontWeight: 600 }}>{count === null ? "—" : count}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {otherItems.length > 0 && (
              <div>
                <SectionTitle>Others</SectionTitle>
                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  {otherItems.map((item) => {
                    if (!item) return null;
                    const icon = OTHER_ICON_MAP[item.id];
                    const count = typeof otherCounts?.[item.id] === "number" ? otherCounts[item.id] : null;
                    const legendUrl = item.layer
                      ? `${GEOSERVER_BASE}/wms?REQUEST=GetLegendGraphic&VERSION=1.0.0&FORMAT=image/png&WIDTH=20&HEIGHT=20&LAYER=${encodeURIComponent(
                        item.layer
                      )}${item.style ? `&STYLE=${encodeURIComponent(item.style)}` : ""}&LEGEND_OPTIONS=forceLabels:off`
                      : "";
                    return (
                      <div
                        key={item.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "8px",
                          background: "rgba(255,255,255,0.88)",
                          borderRadius: "6px",
                          padding: "4px 6px",
                          border: "1px solid rgba(0,0,0,0.08)",
                        }}
                      >
                        {icon ? (
                          <img
                            src={icon}
                            alt={item.label}
                            style={{ width: "16px", height: "16px", objectFit: "contain" }}
                          />
                        ) : legendUrl ? (
                          <img
                            src={legendUrl}
                            alt={item.label}
                            style={{ width: "16px", height: "16px", objectFit: "contain" }}
                            onError={(e) => {
                              const img = e.currentTarget;
                              if (img) img.style.display = "none";
                            }}
                          />
                        ) : null}
                        <div style={{ display: "flex", justifyContent: "space-between", flex: 1, fontSize: "12px", color: "#1e2b3a" }}>
                          <span>{item.label}</span>
                          <span style={{ fontWeight: 600 }}>{count === null ? "—" : count}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {remainingItems.filter(Boolean).map((item) => (
              <div key={item.id}>
                {!hideItemLabel && !item.boundary && (
                  <SectionTitle>{item.label}</SectionTitle>
                )}
                {item.isDynamic ? (
                  <DynamicLegendItem item={item} city={city} roadFilter={roadFilter} extent={extent} />
                ) : (
                  <img
                    src={`${GEOSERVER_BASE}/wms?REQUEST=GetLegendGraphic&VERSION=1.0.0&FORMAT=image/png&WIDTH=20&HEIGHT=20&LAYER=${encodeURIComponent(
                      item.layer
                    )}${item.style ? `&STYLE=${encodeURIComponent(item.style)}` : ""}&LEGEND_OPTIONS=forceLabels:on;fontName:Arial;fontSize:11;fontAntiAliasing:true`}
                    alt={item.label}
                    style={{
                      maxWidth: "100%",
                      display: "block",
                      background: "rgba(255,255,255,0.88)",
                      borderRadius: "6px",
                      padding: "4px 6px",
                      border: "1px solid rgba(0,0,0,0.08)",
                    }}
                    onError={(e) => {
                      const img = e.currentTarget;
                      if (img) img.style.display = "none";
                    }}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default MapLegend;
