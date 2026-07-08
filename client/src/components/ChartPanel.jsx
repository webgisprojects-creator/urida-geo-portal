import { useEffect, useMemo, useRef, useState } from "react";
import {
    Chart as ChartJS,
    CategoryScale,
    LinearScale,
    BarElement,
    ArcElement,
    Tooltip,
    Legend
} from "chart.js";
import { Bar, Doughnut } from "react-chartjs-2";
import ChartDataLabels from "chartjs-plugin-datalabels";
import { cityConfig } from "../assets/configs/cityConfig";
import bankIcon from "../assets/Amenities_Icons/bank_1.png";
import busIcon from "../assets/Amenities_Icons/bus.png";
import graveyardIcon from "../assets/Amenities_Icons/graveyard.png";
import hospitalIcon from "../assets/Amenities_Icons/hospital.png";
import stadiumIcon from "../assets/Amenities_Icons/stadium.webp";
import hotelIcon from "../assets/Amenities_Icons/hotel.png";
import fuelIcon from "../assets/Amenities_Icons/fuel.png";
import metroIcon from "../assets/Amenities_Icons/metro.webp";
import defaultIcon from "../assets/Amenities_Icons/place.png";
import { getGeoserverBase } from "../utils/geoserverBase";

const GEOSERVER_BASE = getGeoserverBase();

ChartJS.register(
    CategoryScale,
    LinearScale,
    BarElement,
    ArcElement,
    Tooltip,
    Legend
);

const DEFAULT_FILTERS = [
    { key: "category", label: "CATEGORY" },
    { key: "condition", label: "CONDITION" },
    { key: "material", label: "MATERIAL" },
    { key: "ownership", label: "OWNERSHIP" },
    { key: "cus_class", label: "SCHEME" },
];

const FILTER_LAYER_KEY = {
    ownership: "ownership",
    category: "category",
    condition: "condition",
    material: "material",
    cus_class: "cus",
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
};

const resolveCityKey = (rawCity) => {
    const raw = String(rawCity || "").toLowerCase().trim();
    if (cityConfig[raw]) return raw;
    const normalized = raw.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
    if (cityConfig[normalized]) return normalized;
    const noSuffix = normalized.replace(/\s+(nagar|district)$/g, "").trim();
    if (cityConfig[noSuffix]) return noSuffix;
    const firstToken = normalized.split(" ")[0];
    if (cityConfig[firstToken]) return firstToken;
    return raw || "lucknow";
};

const fetchWfsCount = async (layerName, signal) => {
    if (!layerName) return 0;
    const parts = String(layerName).split(":");
    const workspace = parts.length > 1 ? parts[0] : null;
    const base = workspace ? `${GEOSERVER_BASE}/${workspace}/wfs` : `${GEOSERVER_BASE}/wfs`;
    const url = `${base}?service=WFS&version=1.1.0&request=GetFeature&typeName=${encodeURIComponent(
        layerName
    )}&resultType=hits`;
    const res = await fetch(url, { signal });
    if (!res.ok) {
        throw new Error("WFS count failed");
    }
    const text = await res.text();
    const match = text.match(/numberOfFeatures="(\d+)"/) || text.match(/numberMatched="(\d+)"/);
    return match ? Number(match[1]) : 0;
};

const formatCqlValue = (value) => {
    const raw = String(value ?? "").trim();
    if (/^\d+(\.\d+)?$/.test(raw)) {
        return raw;
    }
    return `'${raw.replace(/'/g, "''")}'`;
};



const scrollbarStyles = `
  .custom-scroll::-webkit-scrollbar { width: 4px; }
  .custom-scroll::-webkit-scrollbar-track { background: rgba(0,0,0,0.05); }
  .custom-scroll::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.2); border-radius: 2px; }
`;

const gridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
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

const cardSecondRowStyle = { ...cardStyle, gridRow: "auto" };
const scrollListStyle = {
  flex: 1,
  overflowY: "auto",
  paddingRight: "4px",
  marginTop: "4px"
};

const doughnutOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
        legend: {
            position: "bottom",
            labels: {
                boxWidth: 12,
                padding: 8,
                font: { size: 10, weight: 600 },
            },
        },

        datalabels: {
            color: "#fff",
            font: { weight: "bold", size: 11 },
            anchor: "center",
            align: "center",
            formatter: (value, ctx) => {
                const data = ctx.chart.data.datasets[0].data;
                const total = data.reduce((a, b) => Number(a) + Number(b), 0);
                const safeValue = Number(value) || 0;
                if (total === 0) return "";
                const pct = ((safeValue / total) * 100).toFixed(1);
                return pct < 3 ? "" : `${pct}%`;
            },
        },
    },
};



function SummaryPanel({ city = "lucknow", isOpen, onClose, onMinimize, filters = DEFAULT_FILTERS, onFilterChange, onClassificationChange, onChartClick, roadWmsSource, panelSide = "right", tableOpen = false }) {
    const [activeFilter, setActiveFilter] = useState(null);

    const [metrics, setMetrics] = useState({ total_roads: "--", total_length_km: "--", });
    const [chartData, setChartData] = useState(null);
    const [summaryData, setSummaryData] = useState(null);
    const [zones, setZones] = useState([]);
    const [wards, setWards] = useState([]);
    const [legendColors, setLegendColors] = useState({});
    const [activeSection, setActiveSection] = useState("charts");
    const [amenitiesData, setAmenitiesData] = useState([]);
    const [amenitiesLoading, setAmenitiesLoading] = useState(false);
    const [amenitiesError, setAmenitiesError] = useState("");
    const [selectedChartValue, setSelectedChartValue] = useState("");
    const [chartMetric, setChartMetric] = useState("length"); // "count" | "length"



    const [selectedZone, setSelectedZone] = useState("");
    const [selectedWard, setSelectedWard] = useState("");
    const [showZoneDropdown, setShowZoneDropdown] = useState(false);
    const [showWardDropdown, setShowWardDropdown] = useState(false);
    const zoneDropdownRef = useRef(null);//new
const wardDropdownRef = useRef(null);//new

    const panelRef = useRef(null);
    const dragStateRef = useRef({ dragging: false });
    const [panelPos, setPanelPos] = useState(null);
    const summaryCacheRef = useRef(new Map());
    const zonesCacheRef = useRef(new Map());
    const wardsCacheRef = useRef(new Map());
    const amenitiesCacheRef = useRef(new Map());
    const legendColorCacheRef = useRef(new Map());

    useEffect(() => {
    const handleClickOutside = (event) => {
        if (
            zoneDropdownRef.current &&
            !zoneDropdownRef.current.contains(event.target)
        ) {
            setShowZoneDropdown(false);
        }

        if (
            wardDropdownRef.current &&
            !wardDropdownRef.current.contains(event.target)
        ) {
            setShowWardDropdown(false);
        }
    };

    document.addEventListener("mousedown", handleClickOutside);

    return () => {
        document.removeEventListener("mousedown", handleClickOutside);
    };
}, []);//new


    const cityKey = resolveCityKey(city);
    const baseApi = "/api/road-networks";
    const cityLayer = cityConfig[cityKey]?.roadLayer || null;
    const amenityTables = useMemo(() => {
        return Object.keys(cityConfig[cityKey]?.amenities || {});
    }, [cityKey]);
    const classificationLayer = useMemo(() => {
        const layerKey = FILTER_LAYER_KEY[activeFilter];
        if (!layerKey) return null;
        return cityConfig[cityKey]?.roadClassifications?.[layerKey]?.layer || null;
    }, [cityKey, activeFilter]);

    const buildFilter = () => {
        const parts = [];
        if (selectedZone) {
            parts.push(`zone_no='${selectedZone}'`);
        }
        if (selectedWard) {
            parts.push(`ward_no='${selectedWard}'`);
        }
        return parts.join(" AND ");
    };
    const buildMapFilter = () => {
        const parts = [];
        if (selectedZone) {
            parts.push(`zone_no=${formatCqlValue(selectedZone)}`);
        }
        if (selectedWard) {
            parts.push(`ward_no=${formatCqlValue(selectedWard)}`);
        }
        if (activeFilter && selectedChartValue) {
            parts.push(`${activeFilter}=${formatCqlValue(selectedChartValue)}`);
        }
        return parts.join(" AND ");
    };

    const fetchSummaryData = async (filter, signal) => {
        const cacheKey = `${cityKey}|${filter || "ALL"}`;
        if (summaryCacheRef.current.has(cacheKey)) {
            return summaryCacheRef.current.get(cacheKey);
        }

        const params = new URLSearchParams();
        if (filter) params.append("filter", filter);

        const res = await fetch(`${baseApi}/${cityKey}/summary?${params}`, {
            signal
        });
        if (!res.ok) return null;
        const data = await res.json();
        summaryCacheRef.current.set(cacheKey, data);
        return data;
    };

    const startDrag = (event) => {
        const isPrimary = event.button === undefined || event.button === 0;
        if (!isPrimary) return;
        if (!panelRef.current) return;
        event.stopPropagation();
        const rect = panelRef.current.getBoundingClientRect();
        dragStateRef.current = {
            dragging: true,
            startX: event.clientX,
            startY: event.clientY,
            startLeft: panelPos?.x ?? rect.left,
            startTop: panelPos?.y ?? rect.top,
            width: rect.width,
            height: rect.height,
        };
        event.preventDefault();
        event.currentTarget?.setPointerCapture?.(event.pointerId);
    };

    useEffect(() => {
        const handleMove = (event) => {
            if (!dragStateRef.current?.dragging) return;
            const dx = event.clientX - dragStateRef.current.startX;
            const dy = event.clientY - dragStateRef.current.startY;
            const nextX = dragStateRef.current.startLeft + dx;
            const nextY = dragStateRef.current.startTop + dy;
            const maxX = window.innerWidth - dragStateRef.current.width - 8;
            const maxY = window.innerHeight - dragStateRef.current.height - 8;
            setPanelPos({
                x: Math.max(8, Math.min(maxX, nextX)),
                y: Math.max(8, Math.min(maxY, nextY)),
            });
        };
        const handleUp = () => {
            if (dragStateRef.current?.dragging) {
                dragStateRef.current = { ...dragStateRef.current, dragging: false };
            }
        };
        window.addEventListener("pointermove", handleMove);
        window.addEventListener("pointerup", handleUp);
        window.addEventListener("pointercancel", handleUp);
        return () => {
            window.removeEventListener("pointermove", handleMove);
            window.removeEventListener("pointerup", handleUp);
            window.removeEventListener("pointercancel", handleUp);
        };
    }, []);

    useEffect(() => {
        if (!isOpen) return;

        const cacheKey = cityKey;
        if (zonesCacheRef.current.has(cacheKey)) {
            setZones(zonesCacheRef.current.get(cacheKey));
            return;
        }

        fetch(`${baseApi}/${cityKey}`)
            .then(r => r.json())
            .then((data) => {
                zonesCacheRef.current.set(cacheKey, data);
                setZones(data);
            });
    }, [isOpen, cityKey]);


    useEffect(() => {
        if (!selectedZone) {
            setWards([]);
            setSelectedWard("");
            return;
        }

        const cacheKey = `${cityKey}|${selectedZone}`;
        if (wardsCacheRef.current.has(cacheKey)) {
            setWards(wardsCacheRef.current.get(cacheKey));
            return;
        }

        fetch(`${baseApi}/${cityKey}/wards?zone=${selectedZone}`)
            .then(r => r.json())
            .then((data) => {
                wardsCacheRef.current.set(cacheKey, data);
                setWards(data);
            });
    }, [selectedZone, cityKey]);


    useEffect(() => {
        if (!isOpen) return;

        const controller = new AbortController();

        const filter = buildFilter();

        fetchSummaryData(filter, controller.signal)
            .then((data) => {
                if (!data) return;
                setMetrics({
                    total_roads: data?.totalRoads ?? 0,
                    total_length_km: data?.roadLengthKm ?? 0,
                    total_wards: data?.totalWards ?? 0,
                    total_zones: data?.zones ?? 0,
                });
                setSummaryData(data);

            })
            .catch(err => {
                if (err.name !== "AbortError") {
                    console.error("Metrics fetch failed", err);
                }
            });

        return () => controller.abort();
    }, [isOpen, selectedZone, selectedWard, cityKey]);





    // const handleFilterClick = (key) => {
    //     setActiveFilter(key);
    // };

    const handleFilterClick = (key) => {
        setActiveFilter(key);
        setSelectedChartValue("");
        onClassificationChange?.(FILTER_LAYER_KEY[key] || null);

        if (!roadWmsSource) return;
        console.log(
            "SLD before:",
            roadWmsSource.getParams().STYLES
        );

        const layerKey = FILTER_LAYER_KEY[key];
        const layerName = cityConfig[cityKey]?.roadClassifications?.[layerKey]?.layer;
        if (!layerName) return;

        roadWmsSource.updateParams({
            LAYERS: layerName,
            _t: Date.now(),
        });
    };
    const handleChartSelection = (event, elements) => {
        if (!elements?.length) {
            setSelectedChartValue("");
            return;
        }
        const index = elements[0].index;
        const label = chartData?.labels?.[index];
        if (!label || label === "No data") return;
        setSelectedChartValue((prev) => {
            const newValue = prev === label ? "" : label;
            if (onChartClick && activeFilter) {
                onChartClick(activeFilter, newValue);
            }
            return newValue;
        });
    };

    const handleOverviewClick = (filterKey, label) => {
        if (!label || label === "No data") return;

        // 1. Switch the map layer to match this category
        handleFilterClick(filterKey);

        // 2. Set the internal chart segment state
        setSelectedChartValue(label);

        // 3. Trigger the table filter via the prop
        if (onChartClick) {
            onChartClick(filterKey, label);
        }
    };



    // Reset the WMS SLD back to default only when this panel is actually
    // unmounted (a real Close) — not on every isOpen flip, since Minimize
    // now keeps the component mounted (just visually hidden) specifically
    // so filters/layers are preserved and restorable.
    const roadWmsSourceRef = useRef(roadWmsSource);
    roadWmsSourceRef.current = roadWmsSource;
    const cityLayerRef = useRef(cityLayer);
    cityLayerRef.current = cityLayer;
    useEffect(() => {
        return () => {
            const source = roadWmsSourceRef.current;
            const layer = cityLayerRef.current;
            if (!source || !layer) return;
            source.updateParams({
                LAYERS: layer,
                _t: Date.now(),
            });
        };
    }, []);



    useEffect(() => {
        if (!isOpen || !activeFilter) return;

        const controller = new AbortController();

        const run = async () => {
            try {
                const filter = buildFilter();
                const data = await fetchSummaryData(filter, controller.signal);
                if (!data) return;
                const groupKeyMap = {
                    ownership: "byOwnership",
                    category: "byCategory",
                    condition: "byCondition",
                    material: "byMaterial",
                    cus_class: "byCus",
                    zone_no: "byZone",
                    ward_no: "byWard",
                };
                const groupKey = groupKeyMap[activeFilter];
                const rows = groupKey ? data?.[groupKey] : [];

                if (!rows?.length) {
                    setChartData({
                        labels: ["No data"],
                        datasets: [{
                            label: activeFilter.toUpperCase(),
                            data: [0],
                            backgroundColor: ["rgba(200,200,200,0.4)"],
                            borderWidth: 1
                        }]
                    });
                    return;
                }

                const labels = rows.map(r => r.label ?? r.name ?? "Unknown");

                // Use the selected metric: count vs length, ensuring length is parsed as a Number
                const values = rows.map(r => chartMetric === "length" ? (Number(r.length_km) || 0) : (Number(r.count) || 0));

                const getLegendColor = (label) => {
                    const map = legendColors[activeFilter] || {};
                    const key = String(label ?? "").trim();
                    if (map[key]) return map[key];
                    const lower = key.toLowerCase();
                    if (map[lower]) return map[lower];
                    const matchKey = Object.keys(map).find(
                        k => String(k).toLowerCase() === lower
                    );
                    if (matchKey) return map[matchKey];
                    return "#999999";
                };

                const colors = labels.map(label => getLegendColor(label));

                setChartData({
                    labels,
                    datasets: [{
                        label: activeFilter.toUpperCase(),
                        data: values,
                        backgroundColor: colors,
                        borderWidth: 1,
                        metricUnit: chartMetric === "length" ? "km" : "roads" // Custom prop for tooltips
                    }]
                });
            } catch (err) {
                if (err.name !== "AbortError") {
                    console.error("Chart fetch failed", err);
                }
            }
        };

        run();
        return () => controller.abort();

    }, [isOpen, activeFilter, selectedZone, selectedWard, legendColors, cityKey, chartMetric]);


    useEffect(() => {
        const legendDiv = document.getElementById("legend1");
        if (!legendDiv) return;

        // Panel closed → legend hidden
        if (!isOpen) {
            legendDiv.style.display = "none";
            legendDiv.innerHTML = "";
            return;
        }

        // Panel open but no filter yet → legend hidden
        if (!activeFilter) {
            legendDiv.style.display = "none";
            legendDiv.innerHTML = "";
            return;
        }

        // 🔹 Panel open + filter active → show legend
        if (!classificationLayer) return;

        legendDiv.style.display = "block";
        legendDiv.innerHTML = `<img src="${GEOSERVER_BASE}/wms?SERVICE=WMS&REQUEST=GetLegendGraphic&VERSION=1.0.0&FORMAT=image/png&LAYER=${encodeURIComponent(
            classificationLayer
        )}&LEGEND_OPTIONS=forceLabels:on;fontSize:11" />`;
    }, [isOpen, activeFilter, classificationLayer]);



    async function fetchLegendColors(layerName) {
        if (!layerName) return {};
        if (legendColorCacheRef.current.has(layerName)) {
            return legendColorCacheRef.current.get(layerName);
        }

        const url =
            `${GEOSERVER_BASE}/wms` +
            "?SERVICE=WMS" +
            "&VERSION=1.1.1" +
            "&REQUEST=GetLegendGraphic" +
            "&FORMAT=application/json" +
            `&LAYER=${encodeURIComponent(layerName)}` +
            "&LEGEND_OPTIONS=forceLabels:on";

        try {
            const res = await fetch(url);
            if (!res.ok) return {};
            const text = await res.text();
            if (text.trim().startsWith("<")) {
                return {};
            }
            const legend = JSON.parse(text);
            const colorMap = {};
            const rules = legend?.Legend?.[0]?.rules || [];
            rules.forEach(rule => {
                colorMap[rule.name] =
                    rule.symbolizers[0].Polygon?.fill ||
                    rule.symbolizers[0].Line?.stroke ||
                    rule.symbolizers[0].Point?.fill;
            });
            legendColorCacheRef.current.set(layerName, colorMap);
            return colorMap;
        } catch {
            return {};
        }
    }


    useEffect(() => {
        let cancelled = false;

        async function loadAllColors() {
            const cfg = cityConfig[cityKey] || {};
            const cls = cfg.roadClassifications || {};
            const pairs = [
                { key: "condition", field: "condition" },
                { key: "category", field: "category" },
                { key: "cus", field: "cus_class" },
                { key: "material", field: "material" },
                { key: "ownership", field: "ownership" },
            ];

            const allColors = {};
            for (const { key } of pairs) {
                const layer = cls[key]?.layer;
                if (!layer) continue;
                try {
                    const colors = await fetchLegendColors(layer);
                    allColors[key === "cus" ? "cus_class" : key] = colors;
                } catch { }
            }

            if (!cancelled) {
                setLegendColors(allColors);
            }
        }

        loadAllColors();

        return () => {
            cancelled = true;
        };
    }, [cityKey]);


    useEffect(() => {
        if (isOpen) return;

        setActiveFilter(null);
        setSelectedChartValue("");
        setSelectedZone("");
        setSelectedWard("");
        setWards([]);
        setChartData(null);
        setMetrics({
            total_roads: "--",
            total_length_km: "--",
        });
        onFilterChange?.(null);
        setActiveSection("charts");


    }, [isOpen]);


    useEffect(() => {
        if (!selectedZone) {
            setSelectedWard("");
            return;
        }

        setSelectedWard("");
    }, [selectedZone]);


    useEffect(() => {
        if (!roadWmsSource) return;

        // If panel closed → remove CQL
        if (!isOpen) {
            onFilterChange?.("");
            roadWmsSource.updateParams({
                CQL_FILTER: null,
                _t: Date.now(),
            });
            return;
        }

        const cql = buildMapFilter();
        onFilterChange?.(cql || "");

        roadWmsSource.updateParams({
            CQL_FILTER: cql || null,
            _t: Date.now(),
        });

    }, [isOpen, selectedZone, selectedWard, activeFilter, selectedChartValue, roadWmsSource]);

    useEffect(() => {
        if (!isOpen) return;
        if (activeSection !== "amenities") return;

        const controller = new AbortController();
        if (!amenityTables.length) {
            setAmenitiesData([]);
            setAmenitiesLoading(false);
            setAmenitiesError("No amenities configured");
            return () => controller.abort();
        }
        setAmenitiesLoading(true);
        setAmenitiesError("");
        setAmenitiesData(
            amenityTables.map((name) => ({ name, count: 0 }))
        );

        const fetchAmenities = async () => {
            try {
                const cacheKey = cityKey;
                if (amenitiesCacheRef.current.has(cacheKey)) {
                    setAmenitiesData(amenitiesCacheRef.current.get(cacheKey));
                    return;
                }

                const amenityLayers = cityConfig[cityKey]?.amenities || {};
                const normalized = await Promise.all(
                    amenityTables.map(async (name) => {
                        const layerName = amenityLayers[name];
                        if (!layerName) return { name, count: 0 };
                        const count = await fetchWfsCount(layerName, controller.signal);
                        return { name, count };
                    })
                );
                amenitiesCacheRef.current.set(cacheKey, normalized);
                setAmenitiesData(normalized);
            } catch (err) {
                if (err.name !== "AbortError") {
                    console.error("Amenities fetch failed", err);
                    setAmenitiesError("Failed to load amenities");
                }
            } finally {
                setAmenitiesLoading(false);
            }
        };

        fetchAmenities();

        return () => controller.abort();

    }, [isOpen, activeSection, cityKey, amenityTables]);


    const formatAmenityName = (name) => {
        return name
            .replace(/_/g, " ")
            .toUpperCase();
    };
    const getAmenityIcon = (name) => {
        const key = String(name || "").toLowerCase();
        return AMENITY_ICON_MAP[key] || defaultIcon;
    };

    // The big cards are now universally visible at the top, so renderOverviewBigCard is removed.

    const getOverviewLegendColor = (attr, label) => {
        const map = legendColors[attr] || {};
        const key = String(label || "").trim();
        const lower = key.toLowerCase();
        if (map[key]) return map[key];
        if (map[lower]) return map[lower];
        const matchKey = Object.keys(map).find(k => String(k).toLowerCase() === lower);
        if (matchKey) return map[matchKey];
        return "#000000";
    };

    const renderOverviewCards = (d) => {
        return (
        <>
            <div style={cardStyle}>
            <div style={labelStyle}>
                <span>Road Count of Category</span>
                <i className="fas fa-list-ul" style={{ opacity: 0.5 }}></i>
            </div>
            <div style={scrollListStyle} className="custom-scroll">
                {(d?.byCategory || []).map((r) => (
                <div
                    key={`cat-${r.label}`}
                    style={{ ...listItemStyle, cursor: "pointer" }}
                    onClick={() => handleOverviewClick("category", r.label)}
                    className="overview-list-item"
                >
                    <span>{r.label}</span>
                    <span style={{ color: getOverviewLegendColor("category", r.label), fontWeight: 800 }}>{r.count}</span>
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
                {(d?.byCondition || []).map((r) => (
                <div
                    key={`cond-${r.label}`}
                    style={{ ...listItemStyle, cursor: "pointer" }}
                    onClick={() => handleOverviewClick("condition", r.label)}
                    className="overview-list-item"
                >
                    <span>{r.label}</span>
                    <span style={{ color: getOverviewLegendColor("condition", r.label), fontWeight: 800 }}>{r.count}</span>
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
                {(d?.byCus || []).map((r) => (
                <div
                    key={`cus-${r.label}`}
                    style={{ ...listItemStyle, cursor: "pointer" }}
                    onClick={() => handleOverviewClick("cus_class", r.label)}
                    className="overview-list-item"
                >
                    <span>{r.label}</span>
                    <span style={{ color: getOverviewLegendColor("cus_class", r.label), fontWeight: 800 }}>{r.count}</span>
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
                {(d?.byMaterial || []).map((r) => (
                <div
                    key={`mat-${r.label}`}
                    style={{ ...listItemStyle, cursor: "pointer" }}
                    onClick={() => handleOverviewClick("material", r.label)}
                    className="overview-list-item"
                >
                    <span>{r.label}</span>
                    <span style={{ color: getOverviewLegendColor("material", r.label), fontWeight: 800 }}>{r.count}</span>
                </div>
                ))}
            </div>
            </div>

            <div style={cardSecondRowStyle}>
            <div style={labelStyle}>
                <span>Road Count of Ownership</span>
                <i className="fas fa-handshake" style={{ opacity: 0.5 }}></i>
            </div>
            <div style={scrollListStyle} className="custom-scroll">
                {(d?.byOwnership || []).map((r) => (
                <div
                    key={`own-${r.label}`}
                    style={{ ...listItemStyle, cursor: "pointer" }}
                    onClick={() => handleOverviewClick("ownership", r.label)}
                    className="overview-list-item"
                >
                    <span>{r.label}</span>
                    <span style={{ color: getOverviewLegendColor("ownership", r.label), fontWeight: 800 }}>{r.count}</span>
                </div>
                ))}
            </div>
            </div>
        </>
        );
    };

/*function component return section- this value is shown on browser i.e HTML element render */
    const isChartsVisible = activeSection === "charts" && !!chartData;

    return (
        <div
            ref={panelRef}
            className={`summary-panel ${isOpen ? "open" : ""} ${panelSide === "left" ? "summary-panel-left" : ""} ${isChartsVisible ? "charts-active" : ""} ${tableOpen ? "table-open" : ""}`} style={panelPos ? { left: panelPos.x, top: panelPos.y, right: "auto", resize: "both", overflow: "hidden" } : { resize: "both", overflow: "hidden" }}
        >


            <div className="summary-header" onPointerDown={startDrag} style={{ touchAction: "none" }}>
                <span>ROAD NET SUMMARY</span>
                <div className="summary-header-actions">
                    {onMinimize && (
                        <button
                            className="summary-minimize"
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={onMinimize}
                            title="Minimize (keeps filters and layers)"
                        >
                            —
                        </button>
                    )}
                    <button className="summary-close" onPointerDown={(e) => e.stopPropagation()} onClick={onClose} title="Close (clears filters and layers)">×</button>
                </div>
            </div>

            <div className="summary-filters-row" style={{ display: 'flex', gap: '10px', marginBottom: '10px' }}>
                {/* Custom Zone Dropdown */}
                {/* new */}
                <div ref={zoneDropdownRef} style={{ flex: 1, position: 'relative' }}>
                    <div

                        className="custom-select-trigger"
                        onClick={() => {
                            setShowZoneDropdown(!showZoneDropdown);
                            setShowWardDropdown(false);
                        }}
                    >
                        <span>{selectedZone ? (zones.find(z => String(z.zone_no) === String(selectedZone))?.name || `Zone ${selectedZone}`) : "All Zones"}</span>
                        <i className={`fas fa-chevron-${showZoneDropdown ? 'up' : 'down'}`}></i>
                    </div>
                    {showZoneDropdown && (
                        <div className="custom-select-options custom-scroll">
                            <div className="option-item" onClick={() => { setSelectedZone(""); setShowZoneDropdown(false); }}>All Zones</div>
                            {zones.map(z => (
                                <div
                                    key={z.zone_no}
                                    className={`option-item ${String(selectedZone) === String(z.zone_no) ? 'selected' : ''}`}
                                    onClick={() => {
                                        setSelectedZone(z.zone_no);
                                        setShowZoneDropdown(false);
                                    }}
                                >
                                    {z.name || `Zone ${z.zone_no}`}
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Custom Ward Dropdown */}
                <div ref={wardDropdownRef} style={{ flex: 1, position: 'relative' }}>
                    <div

                        className={`custom-select-trigger ${!selectedZone ? 'disabled' : ''}`}
                        onClick={() => {
                            if (!selectedZone) return;
                            setShowWardDropdown(!showWardDropdown);
                            setShowZoneDropdown(false);
                        }}
                    >
                        <span>{selectedWard ? (wards.find(w => String(w.ward_no) === String(selectedWard))?.name || `Ward ${selectedWard}`) : "All Wards"}</span>
                        <i className={`fas fa-chevron-${showWardDropdown ? 'up' : 'down'}`}></i>
                    </div>
                    {showWardDropdown && (
                        <div className="custom-select-options custom-scroll">
                            <div className="option-item" onClick={() => { setSelectedWard(""); setShowWardDropdown(false); }}>All Wards</div>
                            {wards.map(w => (
                                <div
                                    key={w.ward_no}
                                    className={`option-item ${String(selectedWard) === String(w.ward_no) ? 'selected' : ''}`}
                                    onClick={() => {
                                        setSelectedWard(w.ward_no);
                                        setShowWardDropdown(false);
                                    }}
                                >
                                    {w.name || `Ward ${w.ward_no}`}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>


            <div className="summary-metrics">
                <div className="metric-card">
                    <div className="metric-value">
                        {metrics.total_zones === "--" ? "--" : Number(metrics.total_zones).toLocaleString()}
                    </div>
                    <div className="metric-label" style={{ textTransform: "uppercase" }}>
                        Total Zones
                    </div>
                </div>

                <div className="metric-card">
                    <div className="metric-value">
                        {metrics.total_length_km === "--" ? "--" : Number(metrics.total_length_km).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        <span style={{ fontSize: 13, fontWeight: 600, opacity: 0.7, marginLeft: 2 }}>km</span>
                    </div>
                    <div className="metric-label" style={{ textTransform: "uppercase" }}>
                        Total Length
                    </div>
                </div>

                <div className="metric-card">
                    <div className="metric-value">
                        {metrics.total_roads === "--" ? "--" : Number(metrics.total_roads).toLocaleString()}
                    </div>
                    <div className="metric-label" style={{ textTransform: "uppercase" }}>
                        Total Roads
                    </div>
                </div>

                <div className="metric-card">
                    <div className="metric-value">
                        {metrics.total_wards === "--" ? "--" : Number(metrics.total_wards).toLocaleString()}
                    </div>
                    <div className="metric-label" style={{ textTransform: "uppercase" }}>
                        Total Wards
                    </div>
                </div>
            </div>


            <div className="summary-section-toggle">

                <button
                    className={`tab-btn ${activeSection === "overview" ? "active" : ""}`}
                    onClick={() => setActiveSection("overview")}
                >
                    Overview
                </button>
<button
                    className={`tab-btn ${activeSection === "charts" ? "active" : ""}`}
                    onClick={() => setActiveSection("charts")}
                >
                    Charts
                </button>

                <button
                    className={`tab-btn ${activeSection === "amenities" ? "active" : ""}`}
                    onClick={() => setActiveSection("amenities")}
                >
                    Amenities
                </button>
            </div>


            {activeSection === "charts" && (
                <div className="summary-filter-grid">

                    {filters.map((f) => (
                        <button
                            key={f.key}
                            className={`summary-filter-btn ${activeFilter === f.key ? "active" : ""}`}
                            onClick={() => handleFilterClick(f.key)}
                        >
                            {f.label}
                        </button>
                    ))}
                </div>
            )}

            {activeSection === "charts" && activeFilter && (
                <div className="metric-toggle-row">
                    <button
                        className={`metric-toggle-btn ${chartMetric === "length" ? "active" : ""}`}
                        onClick={() => setChartMetric("length")}
                    >
                        By Length (km)
                    </button>
                    <button
                        className={`metric-toggle-btn ${chartMetric === "count" ? "active" : ""}`}
                        onClick={() => setChartMetric("count")}
                    >
                        By Count
                    </button>
                </div>
            )}



            {activeSection === "charts" && chartData && (
                <div className="summary-body dynamic-chart-layout">
                    <div className="chart-item">
                        <div className="chart-item-label">Bar Chart</div>
                        <div className="chart-inner">
                            <Bar
                                data={chartData}
                                options={{
                                    responsive: true,
                                    maintainAspectRatio: false,
                                    onClick: handleChartSelection,
                                    plugins: {
                                        legend: { display: false },
                                        tooltip: {
                                            callbacks: {
                                                label: function(context) {
                                                    let label = context.dataset.label || '';
                                                    if (label) { label += ': '; }
                                                    const val = context.parsed.y;
                                                    const unit = context.dataset.metricUnit === "km" ? " km" : " roads";

                                                    const dataArr = context.chart.data.datasets[0].data;
                                                    const total = dataArr.reduce((a, b) => a + b, 0);
                                                    const pct = total > 0 ? ((val / total) * 100).toFixed(1) : 0;

                                                    if (context.dataset.metricUnit === "km") {
                                                        return `${label}${val.toFixed(2)}${unit} (${pct}%)`;
                                                    }
                                                    return `${label}${val}${unit} (${pct}%)`;
                                                }
                                            }
                                        }
                                    },
                                    scales: {
                                        x: {
                                            ticks: { font: { size: 10 }, maxRotation: 45, minRotation: 0 },
                                            grid: { display: false }
                                        },
                                        y: {
                                            ticks: { font: { size: 10 } },
                                            grid: { color: 'rgba(0,0,0,0.06)' }
                                        }
                                    }
                                }}
                            />
                        </div>
                    </div>

                    <div className="chart-item">
                        <div className="chart-item-label">Distribution</div>
                        <div className="chart-inner">
                            <Doughnut
                                data={chartData}
                            options={{
                                ...doughnutOptions,
                                onClick: handleChartSelection,
                                cutout: '55%',
                                plugins: {
                                    ...doughnutOptions.plugins,
                                    tooltip: {
                                        callbacks: {
                                            label: function(context) {
                                                const val = context.parsed;
                                                const unit = context.dataset.metricUnit === "km" ? " km" : " roads";

                                                const dataArr = context.chart.data.datasets[0].data;
                                                const total = dataArr.reduce((a, b) => a + b, 0);
                                                const pct = total > 0 ? ((val / total) * 100).toFixed(1) : 0;

                                                if (context.dataset.metricUnit === "km") {
                                                    return ` ${val.toFixed(2)}${unit} (${pct}%)`;
                                                }
                                                return ` ${val}${unit} (${pct}%)`;
                                            }
                                        }
                                    }
                                }
                            }}
                            plugins={[ChartDataLabels]}
                            />
                        </div>
                    </div>
                </div>
            )}

            {activeSection === "amenities" && (
                <div className="amenities-grid">
                    {amenitiesData.map((item) => (
                        <div key={item.name} className="amenity-card">
                            <div className="amenity-name">
                                <img className="amenity-icon" src={getAmenityIcon(item.name)} alt={formatAmenityName(item.name)} />
                                {formatAmenityName(item.name)}
                            </div>
                            <div className="amenity-count">
                                {amenitiesLoading ? "--" : item.count}
                            </div>
                        </div>
                    ))}
                    {!!amenitiesError && (
                        <div className="amenities-empty">{amenitiesError}</div>
                    )}
                </div>
            )}


            {activeSection === "overview" && summaryData && (
                <div className="overview-container custom-scroll" style={{ flex: 1, padding: "10px", overflowY: "auto" }}>
                    <style>{scrollbarStyles}</style>
                    <div style={gridStyle}>
                        {renderOverviewCards(summaryData)}
                    </div>
                </div>
            )}

        </div>
    );
}

export default SummaryPanel;
