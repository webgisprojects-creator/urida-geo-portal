// src/components/Sidebar.jsx
/* Sidebar UI for layer toggles, road classifications, and analysis options. */
import React, { useMemo, useState } from "react";
import { cityConfig } from "../assets/configs/cityConfig";

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
    drainage: "fa-faucet",
    drainage_condition: "fa-clipboard-check",
    drainage_material: "fa-trowel-bricks",
    lulc: "fa-map",
    slum_roads: "fa-road",
    slum_boundary: "fa-vector-square",
};

const analysisOptions = [
    { id: "bankRoad", label: "Roads Near Banks", icon: "fa-university" },
    { id: "hospitalRoad", label: "Roads Near Hospitals", icon: "fa-hospital" },
    { id: "educationRoad", label: "Roads Near Education", icon: "fa-book-open" },
    { id: "hotelRoad", label: "Roads Near Hotels", icon: "fa-hotel" },
    { id: "parkRoad", label: "Roads Near Parks", icon: "fa-tree" },
];

const Sidebar = ({
    isOpen = false,
    city,
    onLayerToggle,
    layerVisibility = {},
    tableVisible = false,
    tableMinimized = false,
    tableHasRows = false,
}) => {
    const [activeTab, setActiveTab] = useState("amenities");
    const normalizedCity = String(city || "").toLowerCase().trim();
    const cityData = useMemo(() => cityConfig[normalizedCity] || {}, [normalizedCity]);

    const amenities = useMemo(() => Object.keys(cityData.amenities || {}), [cityData]);
    const others = useMemo(() => Object.keys(cityData.others || {}), [cityData]);
    const classifications = useMemo(
        () => Object.keys(cityData.roadClassifications || {}),
        [cityData]
    );
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
                                onChange={(e) => toggleLayer("network", "roads", e.target.checked)}
                            />
                            <i className="icon fa-solid fa-road"></i>
                            <span className="text">Road Network</span>
                        </label>
                        {specializedNetworks.map((key) => {
                            const specCfg = cityData.specializedNetworks[key];
                            const isGroup = specCfg && typeof specCfg === "object" && specCfg.options;
                            const isChecked = !!layerVisibility?.network?.[key];
                            const activeOption = layerVisibility?.specializedOptions?.[key];

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
                                    {isGroup && isChecked && (
                                        <div className="sub-options-selector">
                                            {Object.entries(specCfg.options).map(([optKey, optCfg]) => (
                                                <button
                                                    key={optKey}
                                                    type="button"
                                                    className={`sub-opt-btn ${String(activeOption) === String(optKey) ? "active" : ""}`}
                                                    onClick={() => toggleLayer("network", key, true, optKey)}
                                                >
                                                    {typeof optCfg === 'string' ? formatLabel(optKey) : optCfg.label}
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </form>
                    <div className="section-divider"></div>
                    <form>
                        <label>
                            <input
                                type="radio"
                                name="road-classification"
                                checked={selectedClassification === "none"}
                                onChange={() => toggleLayer("roadClassifications", "none", false)}
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
                                <i className={`icon fa-solid ${option.icon}`}></i>
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
