// src/components/Sidebar.jsx
/* Sidebar UI for layer toggles, road classifications, and analysis options. */
import React, { useMemo, useState } from "react";
import { cityConfig } from "../assets/configs/cityConfig";
import DrainFilter from "./DrainFilter";

const formatLabel = (value) =>
    String(value || "")
        .replace(/_/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());

const amenityIconMap = {
    atm_bank: "fa-university",
    bus_stop: "fa-bus",
    bus_stand: "fa-bus",
    graveyard: "fa-cross",
    hospital: "fa-hospital",
    hotel: "fa-hotel",
    metro: "fa-train-subway",
    park: "fa-tree",
    petrol_pump: "fa-gas-pump",
    stadium: "fa-football",
    railway_station: "fa-train",
    education: "fa-book-open",
    religious: "fa-cross",
    car_charging: "fa-bolt",
    e_charging: "fa-bolt",
};

const otherIconMap = {
    central_gov: "fa-building",
    state_gov: "fa-building",
    community_toilet: "fa-toilet",
    education: "fa-book-open",
    landmark: "fa-landmark",
    post_office: "fa-envelope",
    religious: "fa-cross",
    car_charging: "fa-bolt",
    e_charging: "fa-bolt",
};

const networkIconMap = {
    sewage_diameter: "fa-faucet-drip",
    sewage_length: "fa-ruler-horizontal",
    lulc: "fa-map",
    slum_roads: "fa-road",
    slum_boundary: "fa-vector-square",
};

const analysisOptions = [
    { id: "bankRoad", label: "Roads Near Banks", icon: "fa-university", color: "#2563eb" },
    { id: "hospitalRoad", label: "Roads Near Hospitals", icon: "fa-hospital", color: "#ef4444" },
    { id: "educationRoad", label: "Roads Near Education", icon: "fa-book-open", color: "#a855f7" },
    { id: "hotelRoad", label: "Roads Near Hotels", icon: "fa-hotel", color: "#f59e0b" },
    { id: "parkRoad", label: "Roads Near Parks", icon: "fa-tree", color: "#10b981" },
];

const Sidebar = ({
    isOpen = false,
    city,
    onLayerToggle,
    layerVisibility = {},
    lcluOpacity = 1,
    onLcluOpacityChange = null,
    tableVisible = false,
    tableMinimized = false,
    tableHasRows = false,
    drainageController = null,
    onClose,
}) => {
    const [activeTab, setActiveTab] = useState("amenities");
    const normalizedCity = String(city || "").toLowerCase().trim();
    const cityData = useMemo(() => cityConfig[normalizedCity] || {}, [normalizedCity]);

    const amenities = useMemo(() => Object.keys(cityData.amenities || {}), [cityData]);
    const others = useMemo(() => Object.keys(cityData.others || {}), [cityData]);
    const lcluClassifications = useMemo(() => Object.keys(cityData.LCLUClassifications || {}), [cityData]);
    const classifications = useMemo(
        () => Object.keys(cityData.roadClassifications || {}),
        [cityData]
    );

    const cityPrefix = useMemo(
        () => String(cityData?.name || "").replace(/\s+/g, "_"),
        [cityData]
    );
    const getLcluLabel = (key) => {
        const prefix = cityPrefix ? `${cityPrefix}_` : "";
        const value = prefix && String(key).startsWith(prefix) ? String(key).slice(prefix.length) : key;
        return formatLabel(value);
    };
    const specializedNetworks = useMemo(
        () => Object.keys(cityData.specializedNetworks || {}),
        [cityData]
    );

    const toggleLayer = (group, id, checked, option = null) => {
        if (typeof onLayerToggle === "function") {
            onLayerToggle(group, id, checked, option);
        }
    };

    const selectedClassification = useMemo(() => {
        const entries = Object.entries(layerVisibility?.roadClassifications || {});
        const active = entries.find(([, enabled]) => enabled);
        return active ? active[0] : "none";
    }, [layerVisibility]);

    const isLcluActive = useMemo(
        () => Object.values(layerVisibility?.lclu || {}).some(Boolean),
        [layerVisibility]
    );

    const sidebarClassName = [
        "lucknow-sidebar",
        isOpen ? "show" : "",
        tableHasRows
            ? tableVisible
                ? "with-table"
                : tableMinimized
                    ? "with-table-minimized"
                    : ""
            : "",
    ]
        .filter(Boolean)
        .join(" ");


    return (
        <div className={sidebarClassName}>

            <div className="sidebar-tabs">
                <button
                    type="button"
                    className={`sidebar-tab-btn ${activeTab === "amenities" ? "active" : ""}`}
                    onClick={() => setActiveTab("amenities")}
                >
                    <i className="fa-solid fa-tree amenities-icon"></i>
                    Amenities
                </button>
                <button
                    type="button"
                    className={`sidebar-tab-btn ${activeTab === "network" ? "active" : ""}`}
                    onClick={() => setActiveTab("network")}
                >
                    <i className="fa-solid fa-route network-icon"></i>
                    Network
                </button>
                <button
                    type="button"
                    className={`sidebar-tab-btn ${activeTab === "others" ? "active" : ""}`}
                    onClick={() => setActiveTab("others")}
                >
                    <i className="fa-solid fa-layer-group others-icon"></i>
                    Others
                </button>
                <button
                    type="button"
                    className={`sidebar-tab-btn ${activeTab === "lclu" ? "active" : ""}`}
                    onClick={() => setActiveTab("lclu")}
                >
                    <i className="fa-solid fa-map lclu-icon"></i>
                    LCLU
                </button>
                <button
                    type="button"
                    className={`sidebar-tab-btn ${activeTab === "analysis" ? "active" : ""}`}
                    onClick={() => setActiveTab("analysis")}
                >
                    <i className="fa-solid fa-chart-line analysis-icon"></i>
                    Analysis
                </button>
            </div>

            {activeTab === "amenities" && (
                <div className="sidebar-section">
                    <form>
                        {amenities.length > 0 ? (
                            amenities.map((key) => (
                                <label key={key}>
                                    <input
                                        type="checkbox"
                                        checked={!!layerVisibility?.amenities?.[key]}
                                        onChange={(e) => toggleLayer("amenities", key, e.target.checked)}
                                    />
                                    <i className={`icon fa-solid ${amenityIconMap[key] || "fa-location-dot"}`}></i>
                                    <span className="text">{formatLabel(key)}</span>
                                </label>
                            ))
                        ) : (
                            <div className="text">No amenities available</div>
                        )}
                    </form>
                </div>
            )}

            {activeTab === "network" && (
                <div className="sidebar-section">
                    <form>
                        <label>
                            <input
                                type="checkbox"
                                checked={!!layerVisibility?.network?.roads}
                                onChange={(e) => {
                                    const checked = e.target.checked;
                                    toggleLayer("network", "roads", checked);
                                    if (!checked) {
                                        toggleLayer("roadClassifications", "none", false);
                                        classifications.forEach((key) => toggleLayer("roadClassifications", key, false));
                                    }
                                }}
                            />
                            <i className="icon fa-solid fa-road"></i>
                            <span className="text">Road Network</span>
                        </label>
                    </form>

                    {!!layerVisibility?.network?.roads && (
                        <div className="sub-options-radio">
                            <label>
                                <input
                                    type="radio"
                                    name="road-classification"
                                    checked={selectedClassification === "none"}
                                    onChange={() => toggleLayer("roadClassifications", "none", true)}
                                />
                                <i className="icon fa-solid fa-ban"></i>
                                <span className="text">None</span>
                            </label>
                            {classifications.map((key) => (
                                <label key={key}>
                                    <input
                                        type="radio"
                                        name="road-classification"
                                        checked={selectedClassification === key}
                                        onChange={() => toggleLayer("roadClassifications", key, true)}
                                    />
                                    <i className="icon fa-solid fa-layer-group"></i>
                                    <span className="text">{formatLabel(key)}</span>
                                </label>
                            ))}
                        </div>
                    )}

                    <div className="section-divider"></div>

                    <form>
                        {specializedNetworks.map((key) => {
                            if (key === "drainage") {
                                return (
                                    <DrainFilter
                                        key="drainage"
                                        city={city}
                                        layerVisibility={layerVisibility}
                                        setLayerVisibility={drainageController?.setLayerVisibility}
                                        tableDataset={drainageController?.tableDataset}
                                        setIsLoading={drainageController?.setIsLoading}
                                        setSelectedRoadId={drainageController?.setSelectedRoadId}
                                        setSelectedRoadIds={drainageController?.setSelectedRoadIds}
                                        setIsMultiSelectMode={drainageController?.setIsMultiSelectMode}
                                        setSelectedRoad={drainageController?.setSelectedRoad}
                                        setActiveFilterColumn={drainageController?.setActiveFilterColumn}
                                        setFilterPosition={drainageController?.setFilterPosition}
                                        setColumnFilters={drainageController?.setColumnFilters}
                                        setSpecializedColumnFilters={drainageController?.setSpecializedColumnFilters}
                                        setSpecializedAllRows={drainageController?.setSpecializedAllRows}
                                        setTableRows={drainageController?.setTableRows}
                                        setGlobalTableMetrics={drainageController?.setGlobalTableMetrics}
                                        setCurrentPage={drainageController?.setCurrentPage}
                                        setTableDataset={drainageController?.setTableDataset}
                                        setShouldFetchTable={drainageController?.setShouldFetchTable}
                                        setIsTableMinimized={drainageController?.setIsTableMinimized}
                                    />
                                );
                            }
                            const specCfg = cityData.specializedNetworks[key];
                            const isGroup = specCfg && typeof specCfg === "object" && specCfg.options;
                            const isChecked = !!layerVisibility?.network?.[key];
                            const activeOption = layerVisibility?.specializedOptions?.[key];
                            const effectiveOption =
                                key === "slum" && (activeOption === undefined || activeOption === null)
                                    ? "none"
                                    : activeOption;

                            return (
                                <div key={key} className="specialized-network-item">
                                    <label className="sidebar-checkable">
                                        <input
                                            type="checkbox"
                                            checked={isChecked}
                                            onChange={(e) => toggleLayer("network", key, e.target.checked)}
                                        />
                                        <i className={`icon fa-solid ${networkIconMap[key] || "fa-route"}`}></i>
                                        <span className="text">{specCfg.label || formatLabel(key)}</span>
                                    </label>
                                    {isGroup && isChecked && key === "slum" && (
                                        <div className="sub-options-radio">
                                            <label key="none">
                                                <input
                                                    type="radio"
                                                    name={`specialized-${key}`}
                                                    checked={String(effectiveOption) === "none"}
                                                    onChange={() => toggleLayer("network", key, true, "none")}
                                                />
                                                <i className="icon fa-solid fa-ban"></i>
                                                <span className="text">None</span>
                                            </label>
                                            {Object.entries(specCfg.options).map(([optKey, optCfg]) => (
                                                <label key={optKey}>
                                                    <input
                                                        type="radio"
                                                        name={`specialized-${key}`}
                                                        checked={String(effectiveOption) === String(optKey)}
                                                        onChange={() => toggleLayer("network", key, true, optKey)}
                                                    />
                                                    <i className="icon fa-solid fa-layer-group"></i>
                                                    <span className="text">{typeof optCfg === "string" ? formatLabel(optKey) : optCfg.label}</span>
                                                </label>
                                            ))}
                                        </div>
                                    )}
                                    {isGroup && isChecked && key !== "slum" && (
                                        <div className="sub-options-selector">
                                            {Object.entries(specCfg.options).map(([optKey, optCfg]) => (
                                                <button
                                                    key={optKey}
                                                    type="button"
                                                    className={`sub-opt-btn ${String(activeOption) === String(optKey) ? "active" : ""}`}
                                                    onClick={() => toggleLayer("network", key, true, optKey)}
                                                >
                                                    {typeof optCfg === "string" ? formatLabel(optKey) : optCfg.label}
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </form>
                </div>
            )}

            {activeTab === "others" && (
                <div className="sidebar-section">
                    <form>
                        {others.length > 0 ? (
                            others.map((key) => (
                                <label key={key}>
                                    <input
                                        type="checkbox"
                                        checked={!!layerVisibility?.others?.[key]}
                                        onChange={(e) => toggleLayer("others", key, e.target.checked)}
                                    />
                                    <i className={`icon fa-solid ${otherIconMap[key] || "fa-location-dot"}`}></i>
                                    <span className="text">{formatLabel(key)}</span>
                                </label>
                            ))
                        ) : (
                            <div className="text">No layers available</div>
                        )}
                    </form>
                </div>
            )}

            {activeTab === "lclu" && (
                <div className="sidebar-section">
                    <form>
                        {lcluClassifications.length > 0 ? (
                            lcluClassifications.map((key) => (
                                <label key={key}>
                                    <input
                                        type="checkbox"
                                        checked={!!layerVisibility?.lclu?.[key]}
                                        onChange={(e) => toggleLayer("lclu", key, e.target.checked)}
                                    />
                                    <i className="icon fa-solid fa-map"></i>
                                    <span className="text">{getLcluLabel(key)}</span>
                                </label>
                            ))
                        ) : (
                            <div className="text">No LCLU layers available</div>
                        )}
                    </form>
                    {/* Only shown while an LCLU layer is actually on screen —
                        transparency has nothing to control otherwise, and
                        showing it unconditionally would just be a dead
                        control sitting in the panel. Lives in the normal
                        document flow of this section (not a fixed/absolute
                        overlay), so nothing else in the page can stack on
                        top of it or hide it. */}
                    {isLcluActive && (
                        <div className="lclu-opacity-control">
                            <div className="lclu-opacity-control__label">
                                <i className="fa-solid fa-droplet-slash"></i>
                                <span>Layer Transparency</span>
                                <span className="lclu-opacity-control__value">{Math.round(lcluOpacity * 100)}%</span>
                            </div>
                            <div className="lclu-opacity-control__track-wrap">
                                <i className="fa-solid fa-circle-notch lclu-opacity-control__end-icon lclu-opacity-control__end-icon--min"></i>
                                <input
                                    type="range"
                                    min="0.1"
                                    max="1"
                                    step="0.05"
                                    value={lcluOpacity}
                                    onChange={(e) => onLcluOpacityChange?.(Number(e.target.value))}
                                    className="lclu-opacity-control__slider"
                                    // Drives the CSS fill (see .lclu-opacity-control__slider's
                                    // background-image in Dashboard.css) — a flat gradient
                                    // that never changes with the value doesn't actually read
                                    // as a slider in use, just decoration.
                                    style={{ "--fill": `${((lcluOpacity - 0.1) / 0.9) * 100}%` }}
                                    aria-label="LCLU layer transparency"
                                />
                                <i className="fa-solid fa-circle lclu-opacity-control__end-icon lclu-opacity-control__end-icon--max"></i>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {activeTab === "analysis" && (
                <div className="sidebar-section">
                    <form>
                        {analysisOptions.map((option) => (
                            <label key={option.id}>
                                <input
                                    type="checkbox"
                                    checked={!!layerVisibility?.analysis?.[option.id]}
                                    onChange={(e) => toggleLayer("analysis", option.id, e.target.checked)}
                                />
                                <i
                                    className={`icon fa-solid ${option.icon}`}
                                    style={option.color ? { color: option.color } : undefined}
                                ></i>
                                <span className="text">{option.label}</span>
                            </label>
                        ))}
                    </form>
                </div>
            )}
        </div>
    );
};

export default Sidebar;
