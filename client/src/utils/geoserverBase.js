// Single source of truth for resolving the GeoServer base URL from the
// browser. ChartPanel.jsx and MapLegend.jsx each used to hardcode their own
// version that assumed a GeoServer running directly on localhost:8080 —
// wrong in this deployment (GeoServer is remote, reachable only through
// this app's own backend `/geoserver` proxy) and inconsistent with the
// correct logic already in MapContainer.jsx. Both call sites now import
// this instead, so there's one implementation to keep correct.
export const getGeoserverBase = () => {
  const configured = process.env.REACT_APP_GEOSERVER_BASE || process.env.GEOSERVER_BASE;
  if (configured) return configured.replace(/\/$/, "");

  const { protocol, hostname, port } = window.location;
  const isLocalHost = hostname === "localhost" || hostname === "127.0.0.1";
  if (isLocalHost && port && port !== "8060") {
    return `${protocol}//${hostname}:8060/geoserver`;
  }
  return "/geoserver";
};
