
import React, { useState, useRef } from "react";
import Header from "../components/Header";
import Footer from "../components/Footer";
import { useNavigate, useLocation } from "react-router-dom";
import MapContainer from "../components/MapContainer";

const ChainagePage = () => {
    const navigate = useNavigate();
    //     const location = useLocation();
    const location = useLocation();

    const query = new URLSearchParams(location.search);
    const city = query.get("city") || "lucknow";
    const zone = query.get("zone");
const ward = query.get("ward");
const userId = query.get("user_id");
const latitude = query.get("latitude");
const longitude = query.get("longitude");

// redirected mobile/app URL detection
const isRedirectedMode =
    !!zone &&
    !!ward &&
    !!userId &&
    !!latitude &&
    !!longitude;

    const [baseMap, setBaseMap] = useState("osm");
    const [showBasemap, setShowBasemap] = useState(false);
    const backTarget = `/dashboard?city=${encodeURIComponent(city)}`;
    const [controlsVisible, setControlsVisible] = useState(false);

    const mapRef = useRef(null);

    //  BASEMAP SWITCH LOGIC

    const handleBaseMapChange = (selectedBaseMap) => {
    const map =
        mapRef.current?.instance ||
        mapRef.current?.map ||
        mapRef.current;

    if (!map) return;

    const baseGroup = map
        .getLayers()
        .getArray()
        .find((l) => l.get("title") === "Base Maps");

    if (!baseGroup) {
        console.log("Base Maps group not found");
        return;
    }

    const baseLayers = baseGroup.getLayers().getArray();

    // Hide all basemaps first
    baseLayers.forEach((l) => l.setVisible(false));

    // Activate selected basemap
    baseLayers.forEach((l) => {
        const title = l.get("title");

        // OSM
        if (
            selectedBaseMap === "osm" &&
            title === "OpenStreetMap"
        ) {
            l.setVisible(true);
        }

        // Satellite
        if (
            selectedBaseMap === "satellite" &&
            (
                title === "Satellite + Labels" ||
                title === "Satellite"
            )
        ) {
            l.setVisible(true);
        }

        // Positron
        if (
            selectedBaseMap === "positron" &&
            title === "CartoDB Positron"
        ) {
            l.setVisible(true);
        }

        // Topo
        if (
            selectedBaseMap === "topo" &&
            title === "Topo"
        ) {
            l.setVisible(true);
        }

        // Toner
        if (
            selectedBaseMap === "toner" &&
            title === "Toner"
        ) {
            l.setVisible(true);
        }
    });

    map.renderSync?.();
    setBaseMap(selectedBaseMap);
};
    return (
        <div style={{ height: "100vh", width: "100%", position: "relative" }}>
            <Header city={city} backTarget={backTarget} hideBack={isRedirectedMode} />

            {/* <button
                onClick={() => navigate(-1)}
                title="Go Back"
                style={{
                    position: "absolute",
                    top: 20,
                    left: 40,
                    zIndex: 1000000,
                    padding: "8px 12px",
                    background: "linear-gradient(to bottom, #0f172a, #1e3a8a)",
                    border: "1px solid #3b82f6",
                    color: "white",
                    cursor: "pointer",
                    borderRadius: "5px",
                    cursor: "pointer",
                    fontWeight:"bold"
                }}
            >

                ⬅ Back
            </button> */}

            {/* 🗺 MAP */}
            <MapContainer
                ref={mapRef}
                city={city}
                showChainage={true}
                mode={"CHAINAGE"}
            />

            {/* 🌍 BASEMAP SWITCH (LIKE SEARCH PANEL) */}
            <div className="chainage-basemap-wrapper">

                {/* 🔘 Toggle Button */}
                <button
                    className="map-btn"
                    onClick={() => { setControlsVisible((v) => !v);  }}
                >
                    {showBasemap ? "" : ""}
                    <i className="fas fa-layer-group" />
                </button>

                {/* 📦 Expand Panel */}
                {/* <div
                    className={`chainage-basemap-panel ${showBasemap ? "open" : ""
                        }`}
                >
                    <div
                        className={`basemap-item ${baseMap === "osm" ? "active" : ""
                            }`}
                        onClick={() => handleBaseMapChange("osm")}
                    >
                        OpenStreetMap
                    </div>

                    <div
                        className={`basemap-item ${baseMap === "satellite" ? "active" : ""}`}
                        onClick={() => handleBaseMapChange("satellite")}
                    >
                        Satellite
                    </div>

                    <div
                        className={`basemap-item ${baseMap === "toner" ? "active" : ""}`}
                        onClick={() => handleBaseMapChange("toner")}
                    >
                        Toner
                    </div>

                </div> */}
                {controlsVisible && (
                <div className="controls-panel">
                    <div className="controls-panel-header">
                        <i className="fas fa-map" style={{ color: "#3b82f6", marginRight: 6 }} />
                        Base Maps
                    </div>
                    {/* Modern basemap card grid */}
                    <div className="basemap-card-grid">
                        {[
                            { value: "osm", label: "OSM", icon: "fas fa-map", color: "#e8f5e9" },
                            { value: "satellite", label: "Satellite", icon: "fas fa-satellite", color: "#e3f2fd" },
                            { value: "positron", label: "Positron", icon: "fas fa-circle", color: "#fce4ec" },
                            { value: "topo", label: "Topo", icon: "fas fa-mountain", color: "#fff3e0" },
                            { value: "toner", label: "Toner", icon: "fas fa-adjust", color: "#f3e5f5" },
                        ].map(({ value, label, icon, color }) => (
                            <button
                                key={value}
                                className={`basemap-card ${baseMap === value ? "basemap-card--active" : ""}`}
                                style={{ "--bm-color": color }}
                                onClick={() => handleBaseMapChange(value)}
                            >
                                <span className="basemap-card__icon"><i className={icon} /></span>
                                <span className="basemap-card__label">{label}</span>
                                {baseMap === value && <span className="basemap-card__check"><i className="fas fa-check-circle" /></span>}
                            </button>
                        ))}
                    </div>
                </div>
                )}

            </div>
            <Footer />

        </div>
    );
};

export default ChainagePage;
