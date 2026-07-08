import React, { useState, useEffect } from "react";
import "../assets/styles/Dashboard.css";
import { cityConfig } from "../assets/configs/cityConfig.js";
import { getGeoserverBase } from "../utils/geoserverBase";

const ALLOWED_ATTRIBUTES = [
  "road_id", "zone_no", "zone_name", "ward_no", "ward_name",
  "ownership", "condition", "category", "material", "yoc",
  "cus_class", "row_meter", "carriage_w", "length_km", "road_name"
];

const formatAttributeName = (name) => {
  if (!name) return "";
  const lower = name.toLowerCase();
  if (lower === 'yoc') return 'Years Of Constructions';
  if (lower === 'cus_class') return 'Scheme';

  return name.split('_').map(part => {
    if (part.toLowerCase() === 'id') return 'ID';
    return part.charAt(0).toUpperCase() + part.slice(1);
  }).join('_');
};

const QueryPanel = ({ city, onClose, onQuery, onClear, topOffset }) => {
  const [activeTab, setActiveTab] = useState("attributes"); // "attributes" or "draw"

  // Attributes Form State
  const [selectedLayer, setSelectedLayer] = useState("");
  const [selectedAttribute, setSelectedAttribute] = useState("");
  const [selectedOperator, setSelectedOperator] = useState("");
  const [queryValue, setQueryValue] = useState("");
  const [queryValue2, setQueryValue2] = useState("");

  // Draw Form State
  const [drawLayer, setDrawLayer] = useState("");
  const [drawShape, setDrawShape] = useState("");

  const [availableLayers, setAvailableLayers] = useState([]);
  const [availableAttributes, setAvailableAttributes] = useState([]);
  const [attributeTypes, setAttributeTypes] = useState({});

  const [uniqueValues, setUniqueValues] = useState([]);
  const [loadingValues, setLoadingValues] = useState(false);

  // Handle Clear
  const handleClear = () => {
    if (onClear) onClear();
  };

  // Populate layers based on city
  useEffect(() => {
    if (!city) return;
    const config = cityConfig[city.toLowerCase()];
    if (!config) return;

    const layers = [];
    if (config.roadLayer) {
      layers.push({ label: "Road Network", value: config.roadLayer });
    }
    setAvailableLayers(layers);
    setSelectedLayer("");
    setDrawLayer("");
  }, [city]);

  // Fetch attributes for selected layer from GeoServer DescribeFeatureType
  useEffect(() => {
    if (!selectedLayer) {
      setAvailableAttributes([]);
      return;
    }

    const GEOSERVER_BASE = getGeoserverBase();
    const url = `${GEOSERVER_BASE}/wfs?service=WFS&version=1.1.0&request=DescribeFeatureType&typeName=${encodeURIComponent(
      selectedLayer
    )}`;

    fetch(url)
      .then((res) => res.text())
      .then((xmlText) => {
        const parser = new window.DOMParser();
        const doc = parser.parseFromString(xmlText, "text/xml");
        const elements = Array.from(doc.getElementsByTagNameNS("*", "element"));
        const pairs = elements
          .map((el) => ({
            name: el.getAttribute("name"),
            type: el.getAttribute("type") || "",
          }))
          .filter((p) => p.name);
        const filtered = pairs.filter((p) => ALLOWED_ATTRIBUTES.includes(p.name.toLowerCase()));
        setAvailableAttributes(filtered.map((p) => p.name));
        const typeMap = {};
        filtered.forEach((p) => {
          typeMap[p.name] = p.type;
        });
        setAttributeTypes(typeMap);
      })
      .catch(() => {
        setAvailableAttributes([]);
        setAttributeTypes({});
      });

  }, [selectedLayer]);

  // Fetch unique values when attribute is selected
  useEffect(() => {
    if (!selectedLayer || !selectedAttribute) {
      setUniqueValues([]);
      return;
    }

    setLoadingValues(true);
    const GEOSERVER_BASE = getGeoserverBase();

    // WFS GetFeature to get all values for the selected property
    const url = `${GEOSERVER_BASE}/wfs?service=WFS&version=1.1.0&request=GetFeature&typeName=${encodeURIComponent(
      selectedLayer
    )}&propertyName=${selectedAttribute}&outputFormat=application/json`;

    fetch(url)
      .then((res) => res.json())
      .then((data) => {
        if (data.features) {
          const values = new Set();
          data.features.forEach((f) => {
            const val = f.properties[selectedAttribute];
            if (val !== null && val !== undefined && val !== "") {
              values.add(val);
            }
          });
          // Sort values: numeric if possible, otherwise string
          const sorted = Array.from(values).sort((a, b) => {
            const numA = Number(a);
            const numB = Number(b);
            if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
            return String(a).localeCompare(String(b));
          });
          // Format numeric values for display if they are row_meter or carriage_w
          const formatted = sorted.map((v) => {
            if (["row_meter", "carriage_w"].includes(selectedAttribute)) {
              return Number(v).toFixed(2);
            }
            return v;
          });
          setUniqueValues(formatted);
        } else {
          setUniqueValues([]);
        }
      })
      .catch((err) => {
        console.error("Error fetching values:", err);
        setUniqueValues([]);
      })
      .finally(() => {
        setLoadingValues(false);
      });
  }, [selectedLayer, selectedAttribute]);

  // Prefill BETWEEN with smallest and largest values
  useEffect(() => {
    if (selectedOperator === "BETWEEN" && uniqueValues.length > 0) {
      const first = uniqueValues[0];
      const last = uniqueValues[uniqueValues.length - 1];
      setQueryValue(first);
      setQueryValue2(last);
    }
    if (selectedOperator !== "BETWEEN") {
      setQueryValue2("");
    }
  }, [selectedOperator, uniqueValues]);

  const handleAttributeQuery = () => {
    if (!selectedLayer || !selectedAttribute || !selectedOperator || !queryValue) {
      alert("Please fill in all fields.");
      return;
    }

    let cql = "";
    const attrType = attributeTypes[selectedAttribute] || "";
    const isNumericType = /xsd:(int|long|short|double|float|decimal)/i.test(attrType);
    if (selectedOperator === "LIKE") {
      cql = `${selectedAttribute} ILIKE '%${queryValue}%'`;
    } else if (selectedOperator === "BETWEEN") {
      if (!queryValue || !queryValue2) {
        alert("Please provide both values for BETWEEN.");
        return;
      }
      const isNumericBoth = isNumericType;
      if (isNumericBoth) {
        const v1 = Number(queryValue);
        const v2 = Number(queryValue2);
        const from = Math.min(v1, v2);
        const to = Math.max(v1, v2);
        cql = `${selectedAttribute} BETWEEN ${from} AND ${to}`;
      } else {
        const v1 = `'${queryValue}'`;
        const v2 = `'${queryValue2}'`;
        cql = `${selectedAttribute} BETWEEN ${v1} AND ${v2}`;
      }
    } else {
      const valuePart = isNumericType ? `${queryValue}` : `'${queryValue}'`;
      const op = selectedOperator === "<>" ? "!=" : selectedOperator;
      cql = `${selectedAttribute} ${op} ${valuePart}`;
    }

    onQuery({
      type: "attribute",
      layer: selectedLayer,
      attribute: selectedAttribute, // Pass selected attribute for layer switching
      filter: cql
    });
  };

  const handleDrawQuery = () => {
    if (!drawLayer || !drawShape) {
      alert("Please select layer and shape.");
      return;
    }
    onQuery({
      type: "draw",
      layer: drawLayer,
      shape: drawShape
    });
  };

  return (
    <div className="floating-panel query-panel" style={{
      width: "300px",
      right: "70px",
      top: typeof topOffset === "number" ? `${topOffset}px` : "100px",
      background: "linear-gradient(149deg, rgba(54, 209, 214, 0.85) 20%, rgba(91, 134, 229, 0.85) 35%)",
      backdropFilter: "blur(2px)",
      boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
      borderRadius: "12px",
      color: "#000000",
      border: "1px solid rgba(255, 255, 255, 0.4)"
    }}>
      <div className="panel-header" style={{ marginBottom: "10px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div className="query-tabs" style={{ marginBottom: 0 }}>
          <button
            className={`tab ${activeTab === "attributes" ? "active" : ""}`}
            onClick={() => setActiveTab("attributes")}
            style={{ color: activeTab === "attributes" ? "#fff" : "#000" }}
          >
            Select by Attributes
          </button>
          <button
            className={`tab ${activeTab === "draw" ? "active" : ""}`}
            onClick={() => setActiveTab("draw")}
            style={{ color: activeTab === "draw" ? "#fff" : "#000" }}
          >
            Select by Draw
          </button>
        </div>
        <button className="table-close-btn" onClick={onClose}>×</button>
      </div>

      <div className="query-body">
        {activeTab === "attributes" && (
          <div className="form-group">
            <select
              value={selectedLayer}
              onChange={(e) => setSelectedLayer(e.target.value)}
              className="form-control"
            >
              <option value="">Select Layer</option>
              {availableLayers.map((layer, i) => (
                <option key={i} value={layer.value}>{layer.label}</option>
              ))}
            </select>

            <select
              value={selectedAttribute}
              onChange={(e) => {
                setSelectedAttribute(e.target.value);
                setQueryValue("");
                setQueryValue2("");
              }}
              className="form-control"
              disabled={!selectedLayer}
            >
              <option value="">Select Attribute</option>
              {availableAttributes.map((attr, i) => (
                <option key={i} value={attr}>{formatAttributeName(attr)}</option>
              ))}
            </select>

            <select
              value={selectedOperator}
              onChange={(e) => setSelectedOperator(e.target.value)}
              className="form-control"
            >
              <option value="">Select Operator</option>
              <option value="=">Equal To</option>
              <option value="<>">Not Equal To</option>
              <option value=">">Greater Than</option>
              <option value="<">Less Than</option>
              <option value=">=">Greater Than or Equal To</option>
              <option value="<=">Less Than or Equal To</option>
              <option value="LIKE">Like (Contains)</option>
              <option value="BETWEEN">Between</option>
            </select>

            {selectedOperator === "BETWEEN" ? (
              <>
                <select
                  value={queryValue}
                  onChange={(e) => setQueryValue(e.target.value)}
                  className="form-control"
                  disabled={!selectedAttribute || loadingValues || uniqueValues.length === 0}
                >
                  <option value="">{loadingValues ? "Loading values..." : "From value"}</option>
                  {uniqueValues.map((val, i) => (
                    <option key={`from-${i}`} value={val}>{val}</option>
                  ))}
                </select>
                <select
                  value={queryValue2}
                  onChange={(e) => setQueryValue2(e.target.value)}
                  className="form-control"
                  disabled={!selectedAttribute || loadingValues || uniqueValues.length === 0}
                >
                  <option value="">{loadingValues ? "Loading values..." : "To value"}</option>
                  {uniqueValues.map((val, i) => (
                    <option key={`to-${i}`} value={val}>{val}</option>
                  ))}
                </select>
              </>
            ) : (
              <select
                value={queryValue}
                onChange={(e) => setQueryValue(e.target.value)}
                className="form-control"
                disabled={!selectedAttribute || loadingValues}
              >
                <option value="">{loadingValues ? "Loading values..." : "Select Value"}</option>
                {uniqueValues.map((val, i) => (
                  <option key={i} value={val}>{val}</option>
                ))}
              </select>
            )}

            <div style={{ display: "flex", gap: "10px", marginTop: "10px" }}>
              <button
                className="btn btn-primary"
                style={{ flex: 1, backgroundColor: "#e67e22" }}
                onClick={handleAttributeQuery}
              >
                Load Layer
              </button>
              <button
                className="btn btn-primary"
                style={{ flex: 1, backgroundColor: "#e67e22" }}
                onClick={handleClear}
              >
                Clear
              </button>
            </div>
          </div>
        )}

        {activeTab === "draw" && (
          <div className="form-group">
            <select
              value={drawLayer}
              onChange={(e) => setDrawLayer(e.target.value)}
              className="form-control"
            >
              <option value="">Select Layer</option>
              {availableLayers.map((layer, i) => (
                <option key={i} value={layer.value}>{layer.label}</option>
              ))}
            </select>

            <select
              value={drawShape}
              onChange={(e) => setDrawShape(e.target.value)}
              className="form-control"
            >
              <option value="">Select Shape</option>
              <option value="Polygon">Polygon</option>
              <option value="Circle">Circle</option>
              <option value="Box">Box</option>
              <option value="Square">Square</option>
              <option value="Star">Star</option>
            </select>

            <div style={{ display: "flex", gap: "10px", marginTop: "10px" }}>
              <button
                className="btn btn-primary"
                style={{ flex: 1, backgroundColor: "#e67e22" }}
                onClick={handleDrawQuery}
              >
                Start Drawing
              </button>
              <button
                className="btn btn-primary"
                style={{ flex: 1, backgroundColor: "#e67e22" }}
                onClick={handleClear}
              >
                Clear
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default QueryPanel;
