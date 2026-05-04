import React, { useEffect, useRef } from "react";
import "ol/ol.css";
import Map from "ol/Map";
import View from "ol/View";
import TileLayer from "ol/layer/Tile";
import OSM from "ol/source/OSM";
import TileWMS from "ol/source/TileWMS";
import { fromLonLat } from "ol/proj";
import { defaults as defaultControls } from "ol/control";

const GEOSERVER_BASE = window.location.port === "8060"
  ? `${window.location.protocol}//${window.location.hostname}:8080/geoserver`
  : (process.env.REACT_APP_GEOSERVER_BASE || "/geoserver");
const GEOSERVER_WMS = `${GEOSERVER_BASE}/Chainage/wms`;

const Chainage = () => {
  const mapRef = useRef(null);
  const mapInstanceRef = useRef(null);

  useEffect(() => {
    if (!mapRef.current) return;

    const baseLayer = new TileLayer({
      source: new OSM({
        crossOrigin: "anonymous",
      }),
      visible: true,
    });

    const chainageLayer = new TileLayer({
      source: new TileWMS({
        url: GEOSERVER_WMS,
        params: {
          LAYERS: "Chainage:Kanpur_interpolatedpoints",
          TILED: true,
          FORMAT: "image/png",
          TRANSPARENT: true,
        },
        serverType: "geoserver",
        crossOrigin: "anonymous",
      }),
    });

    const segmentationLayer = new TileLayer({
      source: new TileWMS({
        url: GEOSERVER_WMS,
        params: {
          LAYERS: "Chainage:Kanpur_segmentszone2roads",
          TILED: true,
          FORMAT: "image/png",
          TRANSPARENT: true,
        },
        serverType: "geoserver",
        crossOrigin: "anonymous",
      }),
    });

    const map = new Map({
      target: mapRef.current,
      layers: [baseLayer, segmentationLayer, chainageLayer],
      view: new View({
        center: fromLonLat([80.3319, 26.4499]),
        zoom: 12,
      }),
      controls: defaultControls(),
    });

    mapInstanceRef.current = map;

    return () => {
      map.setTarget(null);
      mapInstanceRef.current = null;
    };
  }, []);

  return (
    <div style={{ width: "100%", height: "100%" }}>
      <div ref={mapRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
};

export default Chainage;
