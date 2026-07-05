import React, { useState, useEffect } from "react";
import { getGeoserverBase } from "../utils/geoserverBase";

const GEOSERVER_BASE = getGeoserverBase();

const DynamicLegendItem = ({ layerName, label, isManual, items, baseUrl }) => {
    const [legendItems, setLegendItems] = useState(isManual ? items : []);
    const [loading, setLoading] = useState(!isManual);
    const [featureCount, setFeatureCount] = useState(null);

    const effectiveBaseUrl = baseUrl || GEOSERVER_BASE;

    useEffect(() => {
        if (isManual) return;
        let isMounted = true;

        const fetchLegendGraphic = async () => {
            try {
                // Try JSON first for dynamic parsing
                const wmsUrl = `${effectiveBaseUrl}/wms?REQUEST=GetLegendGraphic&VERSION=1.0.0&FORMAT=application/json&LAYER=${encodeURIComponent(
                    layerName
                )}`;

                const res = await fetch(wmsUrl);
                if (!res.ok) throw new Error("JSON legend not supported");
                const json = await res.json();

                if (!isMounted) return;

                const rules = json?.Legend?.[0]?.rules || [];
                if (rules.length === 0) throw new Error("No rules in JSON");

                const parsedItems = rules.map((rule) => {
                    const title = String(rule.title || rule.name || rule.filter || "Layer").trim();
                    const sym = rule.symbolizers?.[0];
                    let color = "#ccc";

                    if (sym?.Polygon?.fill) color = sym.Polygon.fill;
                    else if (sym?.Line?.stroke) color = sym.Line.stroke;
                    else if (sym?.Point?.graphics?.[0]?.mark?.fill) color = sym.Point.graphics[0].mark.fill;

                    let iconUrl = `${effectiveBaseUrl}/wms?REQUEST=GetLegendGraphic&VERSION=1.0.0&FORMAT=image/png&WIDTH=20&HEIGHT=20&LAYER=${encodeURIComponent(layerName)}&LEGEND_OPTIONS=forceLabels:off`;
                    if (rule.name) iconUrl += `&RULE=${encodeURIComponent(rule.name)}`;

                    return { label: title, name: rule.name, color, iconUrl };
                });

                setLegendItems(parsedItems);
            } catch (err) {
                if (isMounted) {
                    setLegendItems([{
                        label: label,
                        iconUrl: `${effectiveBaseUrl}/wms?REQUEST=GetLegendGraphic&VERSION=1.0.0&FORMAT=image/png&LAYER=${encodeURIComponent(layerName)}&LEGEND_OPTIONS=forceLabels:on;fontName:Arial;fontSize:11`
                    }]);
                }
            } finally {
                // Fetch feature counts if possible
                try {
                    const [ws, layerOnly] = layerName.split(":");
                    if (ws && layerOnly && !layerName.toLowerCase().includes("boundary")) {
                        const wfsUrl = `${effectiveBaseUrl}/${ws}/ows?service=WFS&version=1.1.0&request=GetFeature&typeName=${encodeURIComponent(layerName)}&resultType=hits`;
                        const wfsRes = await fetch(wfsUrl);
                        if (wfsRes.ok) {
                            const text = await wfsRes.text();
                            const match = text.match(/numberOfFeatures="(\d+)"/);
                            if (match && match[1]) {
                                if (isMounted) setFeatureCount(parseInt(match[1], 10));
                            }
                        }
                    }
                } catch (countErr) {
                    if (isMounted) setFeatureCount(null);
                }

                if (isMounted) setLoading(false);
            }
        };

        fetchLegendGraphic();
        return () => { isMounted = false; };
    }, [layerName, isManual, effectiveBaseUrl, label]);

    if (!isManual && loading && legendItems.length === 0) {
        return <div style={{ fontSize: '11px', color: '#888' }}>Loading {label}...</div>;
    }

    if (legendItems.length === 0) {
        return <div style={{ fontSize: '11px', color: '#888' }}>No style available for {label}</div>;
    }

    if (legendItems.length === 1) {
        const lItem = legendItems[0];
        return (
            <div className="dynamic-legend-grid" style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {lItem.iconUrl ? (
                        <img
                            src={lItem.iconUrl}
                            alt={label}
                            style={{ width: '20px', height: '20px', objectFit: 'contain' }}
                            onError={(e) => {
                                e.target.style.display = 'none';
                                if (!e.target.parentNode.querySelector('.fallback-color-box')) {
                                    const span = document.createElement('span');
                                    span.className = 'fallback-color-box';
                                    span.style.width = '20px';
                                    span.style.height = '20px';
                                    span.style.backgroundColor = lItem.color || '#ccc';
                                    span.style.display = 'inline-block';
                                    span.style.borderRadius = '2px';
                                    e.target.parentNode.insertBefore(span, e.target);
                                }
                            }}
                        />
                    ) : (
                        <div style={{ width: '20px', height: '20px', backgroundColor: lItem.color || '#ccc', borderRadius: '2px' }}></div>
                    )}
                    <div style={{ fontSize: '12px', fontWeight: 600, color: '#334155' }}>
                        {label} {featureCount !== null && <span style={{ color: '#64748b', fontSize: '11px', fontWeight: 500 }}>({featureCount})</span>}
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="dynamic-legend-grid" style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div style={{ fontSize: '12px', fontWeight: 600, color: '#1e2b3a', marginBottom: '4px' }}>
                {label} {featureCount !== null && <span style={{ color: '#64748b', fontSize: '11px', fontWeight: 500 }}>({featureCount})</span>}
            </div>
            {legendItems.map((lItem, idx) => (
                <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {lItem.iconUrl ? (
                        <img
                            src={lItem.iconUrl}
                            alt={lItem.label || label}
                            style={{ width: '20px', height: '20px', objectFit: 'contain' }}
                            onError={(e) => {
                                e.target.style.display = 'none';
                                if (!e.target.parentNode.querySelector('.fallback-color-box')) {
                                    const span = document.createElement('span');
                                    span.className = 'fallback-color-box';
                                    span.style.width = '20px';
                                    span.style.height = '20px';
                                    span.style.backgroundColor = lItem.color || '#ccc';
                                    span.style.display = 'inline-block';
                                    span.style.borderRadius = '2px';
                                    e.target.parentNode.insertBefore(span, e.target);
                                }
                            }}
                        />
                    ) : (
                        <div style={{ width: '20px', height: '20px', backgroundColor: lItem.color || '#ccc', borderRadius: '2px' }}></div>
                    )}
                    <div style={{ fontSize: '11px', color: '#334155' }}>{lItem.label || label}</div>
                </div>
            ))}
        </div>
    );
};

const HomeMapLegend = ({ layers }) => {
    const [minimized, setMinimized] = useState(false);
    const [position, setPosition] = useState(null);
    const [isDragging, setIsDragging] = useState(false);
    const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });

    useEffect(() => {
        const handlePointerMove = (e) => {
            if (!isDragging) return;
            e.preventDefault();
            setPosition({
                x: e.clientX - dragOffset.x,
                y: e.clientY - dragOffset.y,
            });
        };

        const handlePointerUp = () => setIsDragging(false);

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

    if (!layers || layers.length === 0) return null;

    return (
        <div
            style={{
                position: "fixed",
                left: position ? position.x : undefined,
                top: position ? position.y : undefined,
                bottom: position ? undefined : "30px",
                right: position ? undefined : "15px",
                background: "linear-gradient(149deg, rgba(54, 209, 214, 0.78) 15%, rgba(91, 134, 229, 0.78) 55%)",
                backdropFilter: "blur(10px)",
                border: "1px solid rgba(255, 255, 255, 0.6)",
                borderRadius: "8px",
                boxShadow: "0 6px 18px rgba(0,0,0,0.28)",
                zIndex: 4000,
                minWidth: "200px",
                maxWidth: "250px",
                display: "flex",
                flexDirection: "column",
                transition: isDragging ? "none" : "max-height 0.3s ease",
            }}
        >
            <div
                onPointerDown={(e) => {
                    e.stopPropagation();
                    const rect = e.currentTarget.parentElement.getBoundingClientRect();
                    if (!position) setPosition({ x: rect.left, y: rect.top });
                    setDragOffset({ x: e.clientX - rect.left, y: e.clientY - rect.top });
                    setIsDragging(true);
                }}
                style={{
                    padding: "9px 12px",
                    background: "rgba(255, 255, 255, 0.18)",
                    borderBottom: "1px solid rgba(255, 255, 255, 0.4)",
                    borderRadius: "8px 8px 0 0",
                    cursor: isDragging ? "grabbing" : "grab",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    userSelect: "none",
                    touchAction: "none",
                }}
            >
                <h4 style={{ margin: 0, fontSize: "13px", fontWeight: 600, color: "#203148", letterSpacing: "0.2px" }}>Legend</h4>
                <button
                    onClick={(e) => { e.stopPropagation(); setMinimized(!minimized); }}
                    title={minimized ? "Expand" : "Minimize"}
                    style={{
                        border: "none", background: "transparent", cursor: "pointer",
                        color: "#1f2a3a", padding: 0, width: "20px", height: "20px", display: "flex",
                        alignItems: "center", justifyContent: "center",
                    }}
                >
                    <i className={`fas fa-${minimized ? "plus" : "minus"}`} style={{ fontSize: "12px" }} />
                </button>
            </div>

            {!minimized && (
                <div style={{ padding: "12px", overflowY: "auto", maxHeight: "450px", display: "flex", flexDirection: "column", gap: "12px" }}>
                    {layers.map((layerProps) => (
                        <DynamicLegendItem key={layerProps.layerName} layerName={layerProps.layerName} label={layerProps.label} isManual={layerProps.isManual} items={layerProps.items} baseUrl={layerProps.baseUrl} />
                    ))}
                </div>
            )}
        </div>
    );
};

export default HomeMapLegend;
