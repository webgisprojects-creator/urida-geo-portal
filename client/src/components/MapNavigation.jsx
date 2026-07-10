import React, { useState, useEffect, useRef } from "react";
import Draggable from "react-draggable";
import { toLonLat, fromLonLat } from "ol/proj";
import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import Feature from "ol/Feature";
import Point from "ol/geom/Point";
import { Style, Circle, Fill, Stroke } from "ol/style";
import { isCoordinateWithinCityBounds } from "../utils/mapClip";

// ─── Layer ID for cleanup ─────────────────────────────────────────────────────
const LOCATE_LAYER_ID = "__nav_locate_me_layer__";

/**
 * MapNavigation — A fully functional, draggable GIS navigation suite.
 *
 * Features:
 *  1. Real SVG Compass that rotates its north needle live with map rotation.
 *  2. Clicking the compass resets the map to North (0 rotation).
 *  3. Google Maps-style Locate Me:
 *     - Pans/zooms to user GPS location
 *     - Places a blue dot + accuracy circle on the map (OL VectorLayer)
 *     - Dot pulses with a CSS animation overlay handled via OL postrender
 */
const MapNavigation = ({ map, restrictedMode = false, cityBoundaryRingsRef = null, cityName = "this city" }) => {
    const [coordinates, setCoordinates] = useState({ lat: "0.0000", lng: "0.0000" });
    const [scaleProps, setScaleProps] = useState({ width: 100, text: "" });
    const [locating, setLocating] = useState(false);

    const containerRef = useRef(null);
    const compassRef = useRef(null);
    const metricsRef = useRef(null);
    const locateLayerRef = useRef(null);

    // ── Setup / teardown map listeners ────────────────────────────────────────
    useEffect(() => {
        if (!map) return;
        const view = map.getView();

        // 2. Lat/Long — pointer move
        const handlePointerMove = (e) => {
            if (e.dragging) return;
            const coord = map.getEventCoordinate(e.originalEvent);
            if (!coord) return;
            const lonLat = toLonLat(coord, view.getProjection());
            setCoordinates({ lng: lonLat[0].toFixed(4), lat: lonLat[1].toFixed(4) });
        };
        map.on("pointermove", handlePointerMove);

        // 3. Scale Bar — resolution change
        const handleResolution = () => {
            const resolution = view.getResolution();
            const projection = view.getProjection();
            if (!resolution || !projection) return;
            const metersPerUnit = projection.getMetersPerUnit();
            const targetPixels = 100;
            const distance = targetPixels * resolution * metersPerUnit;
            let power = Math.pow(10, Math.floor(Math.log10(distance)));
            let roundDistance = Math.round(distance / power) * power;
            if (power < 10) roundDistance = Math.round(distance);
            const dynamicWidth = roundDistance / (resolution * metersPerUnit);
            const text = roundDistance >= 1000
                ? `${(roundDistance / 1000).toFixed(1).replace(".0", "")} km`
                : `${roundDistance} m`;
            setScaleProps({ width: Math.max(80, Math.min(200, dynamicWidth)), text });
        };
        view.on("change:resolution", handleResolution);
        handleResolution();

        return () => {
            map.un("pointermove", handlePointerMove);
            view.un("change:resolution", handleResolution);
        };
    }, [map]);

    // ── Cleanup locate layer on unmount ───────────────────────────────────────
    useEffect(() => {
        return () => {
            if (map && locateLayerRef.current) {
                map.removeLayer(locateLayerRef.current);
                locateLayerRef.current = null;
            }
        };
    }, [map]);

    // ── Handlers ──────────────────────────────────────────────────────────────

    /**
     * Locate Me — uses Geolocation API, then:
     *  • Pans/zooms the map
     *  • Places a Google Maps-style blue dot with accuracy ring on OL map
     */
    const handleLocateMe = () => {
        if (!map) return;
        if (!navigator.geolocation) {
            alert("Geolocation is not supported by your browser.");
            return;
        }

        setLocating(true);

        navigator.geolocation.getCurrentPosition(
            (pos) => {
                setLocating(false);
                const { latitude, longitude, accuracy } = pos.coords;
                const view = map.getView();
                const projection = view.getProjection();
                const projectedCenter = fromLonLat([longitude, latitude], projection);

                // A GPS fix outside the current city's own coverage (e.g.
                // physically in Lucknow while the dashboard is showing
                // Kanpur) must not pan the map away to it — that would lose
                // the city extent the user actually opened. A small buffer
                // still allows genuinely boundary-adjacent locations.
                const rings = cityBoundaryRingsRef?.current;
                if (!isCoordinateWithinCityBounds(projectedCenter, rings)) {
                    alert(`Your current location appears to be outside ${cityName}. Location is only shown when you're within the selected city.`);
                    return;
                }

                // Pan + zoom the map
                view.animate({ center: projectedCenter, zoom: 16, duration: 1000 });

                // ── Build OL marker layer ──────────────────────────────────
                // Remove previous locate layer if it exists
                if (locateLayerRef.current) {
                    map.removeLayer(locateLayerRef.current);
                }

                const pointFeature = new Feature({
                    geometry: new Point(projectedCenter),
                });

                // Accuracy circle feature (meters → map units)
                const accuracyFeature = new Feature({
                    geometry: new Point(projectedCenter),
                });

                // Pixel radius for the accuracy circle (accuracy in meters → scale to pixels)
                const resolution = view.getResolution() || 1;
                const accuracyRadiusPx = Math.max(20, Math.min(120, accuracy / resolution));

                const locateSource = new VectorSource({
                    features: [accuracyFeature, pointFeature],
                });

                const locateLayer = new VectorLayer({
                    source: locateSource,
                    zIndex: 5000,
                    style: (feature) => {
                        // The accuracy halo
                        if (feature === accuracyFeature) {
                            return new Style({
                                image: new Circle({
                                    radius: accuracyRadiusPx,
                                    fill: new Fill({ color: "rgba(66,133,244,0.12)" }),
                                    stroke: new Stroke({ color: "rgba(66,133,244,0.35)", width: 1.5 }),
                                }),
                            });
                        }
                        // The blue dot (outer white ring + inner blue)
                        return [
                            new Style({
                                image: new Circle({
                                    radius: 12,
                                    fill: new Fill({ color: "rgba(255,255,255,0.95)" }),
                                    stroke: new Stroke({ color: "rgba(66,133,244,0.4)", width: 2 }),
                                }),
                            }),
                            new Style({
                                image: new Circle({
                                    radius: 7,
                                    fill: new Fill({ color: "#4285F4" }),
                                    stroke: new Stroke({ color: "#ffffff", width: 2 }),
                                }),
                            }),
                        ];
                    },
                });

                // Tag layer so we can find it later
                locateLayer.set("id", LOCATE_LAYER_ID);
                locateLayerRef.current = locateLayer;
                map.addLayer(locateLayer);

                // ── Pulsing animation via postrender ──────────────────────
                // We draw an animated ring on the map canvas every frame.
                let animFrame;
                let phase = 0;

                const animatePulse = (event) => {
                    const ctx = event.context;
                    const pixelCoord = map.getPixelFromCoordinate(projectedCenter);
                    if (!pixelCoord) return;

                    const [px, py] = pixelCoord;
                    const ratio = event.frameState?.pixelRatio || 1;
                    const x = px * ratio;
                    const y = py * ratio;

                    // Pulsing ring (grows from 12px to 30px, fading out)
                    const maxRadius = 30 * ratio;
                    const minRadius = 12 * ratio;
                    const radius = minRadius + (maxRadius - minRadius) * phase;
                    const opacity = 1 - phase;

                    ctx.save();
                    ctx.beginPath();
                    ctx.arc(x, y, radius, 0, 2 * Math.PI);
                    ctx.strokeStyle = `rgba(66,133,244,${opacity * 0.7})`;
                    ctx.lineWidth = 2 * ratio;
                    ctx.stroke();
                    ctx.restore();

                    phase += 0.012;
                    if (phase >= 1) phase = 0;

                    map.render();
                };

                locateLayer.on("postrender", animatePulse);

                // Stop pulse after 8 seconds (don't drain GPU forever)
                setTimeout(() => {
                    locateLayer.un("postrender", animatePulse);
                    map.render();
                }, 8000);
            },
            (err) => {
                setLocating(false);
                console.error("Geolocation error:", err);
                if (err.code === 1) {
                    alert("Location access denied. Please allow location in your browser settings.");
                } else {
                    alert("Unable to retrieve your location. Try again.");
                }
            },
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
        );
    };

    if (!map) return null;

    return (
        <div
            ref={containerRef}
            style={{
                position: "absolute",
                top: 0, left: 0, right: 0, bottom: 0,
                pointerEvents: "none",
                zIndex: 4000,
            }}
        >
            {/* ── METRICS (LAT/LONG & SCALE) — Top-Left, below zoom buttons ──
                Hidden entirely in field-task mode: a KMC field worker
                already has the one lat/long that matters (the URL's own
                target, marked on the map) and doesn't need a live
                pointer-position readout or scale bar cluttering a small
                mobile screen. */}
            {!restrictedMode && (
            <Draggable bounds="parent" handle=".drag-handle" nodeRef={metricsRef}>
                <div
                    ref={metricsRef}
                    style={{
                        position: "absolute",
                        top: "37px",   /* Same row as OL zoom +/- buttons */
                        left: "52px",  /* Right of the zoom control box */
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "flex-start",
                        gap: "4px",
                        padding: "4px 10px",
                        pointerEvents: "auto",
                    }}
                    className="nav-glass-panel"
                >
                    <div className="drag-handle" title="Drag" style={{ cursor: "grab", opacity: 0.4, alignSelf: "center" }}>
                        <i className="fa-solid fa-grip-lines" style={{ fontSize: "11px" }} />
                    </div>

                    {/* Lat / Long */}
                    <div style={{ fontSize: "11px", fontFamily: "monospace", color: "#222", display: "flex", gap: "10px", whiteSpace: "nowrap" }}>
                        <span><strong style={{ opacity: 0.55, fontSize: "9px", letterSpacing: "0.5px" }}>LAT</strong> {coordinates.lat}</span>
                        <span><strong style={{ opacity: 0.55, fontSize: "9px", letterSpacing: "0.5px" }}>LNG</strong> {coordinates.lng}</span>
                    </div>

                    <hr style={{ width: "100%", margin: "1px 0", borderTop: "1px solid rgba(0,0,0,0.1)" }} />

                    {/* Scale Bar */}
                    <div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: "8px" }}>
                        <div style={{
                            height: "4px",
                            background: "repeating-linear-gradient(90deg,#1a1a1a 0,#1a1a1a 50%,#fff 50%,#fff 100%)",
                            backgroundSize: "10px 100%",
                            border: "1px solid rgba(0,0,0,0.45)",
                            borderTop: "none",
                            width: `${scaleProps.width}px`,
                            minWidth: "80px",
                            maxWidth: "200px",
                            transition: "width 0.2s ease",
                        }} />
                        <span style={{ fontSize: "10px", fontWeight: 600, color: "#333", whiteSpace: "nowrap" }}>
                            {scaleProps.text}
                        </span>
                    </div>
                </div>
            </Draggable>
            )}

            {/* ── LOCATE ME — Top-Right, below legend. Hidden entirely in
                field-task mode along with the compass it used to sit next
                to (see above) — GPS "where am I" doesn't help a field
                worker whose whole task is already anchored to one specific
                lat/long from the URL. The compass control itself has been
                removed. ── */}
            {!restrictedMode && (
            <Draggable bounds="parent" handle=".drag-handle" nodeRef={compassRef}>
                <div
                    ref={compassRef}
                    style={{
                        position: "absolute",
                        top: "30px",   /* Top-right corner of map area */
                        right: "10px",
                        display: "flex",
                        flexDirection: "row",
                        alignItems: "center",
                        gap: "2px",
                        padding: "4px 6px",
                        pointerEvents: "auto",
                    }}
                    className="nav-glass-panel"
                >
                    <div className="drag-handle" title="Drag" style={{ cursor: "grab", opacity: 0.4 }}>
                        <i className="fa-solid fa-grip-lines" style={{ fontSize: "11px" }} />
                    </div>

                    <button
                        title="Locate Me"
                        onClick={handleLocateMe}
                        disabled={locating}
                        style={{
                            width: "34px", height: "34px",
                            borderRadius: "50%",
                            border: "none",
                            background: locating ? "rgba(66,133,244,0.15)" : "transparent",
                            color: "#4285F4",
                            fontSize: "15px",
                            cursor: locating ? "wait" : "pointer",
                            display: "flex", alignItems: "center", justifyContent: "center",
                            transition: "background 0.2s",
                        }}
                    >
                        {locating
                            ? <i className="fa-solid fa-circle-notch fa-spin" />
                            : <i className="fa-solid fa-location-crosshairs" />
                        }
                    </button>
                </div>
            </Draggable>
            )}
        </div>
    );
};

export default MapNavigation;
