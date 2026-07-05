import { chainageCityConfig } from "../assets/configs/chainageCityConfig";

// chainageCityConfig is the authoritative source: it's what actually drives
// which GeoServer WMS layers exist and render for a city's chainage mode.
export function isChainageAvailable(city) {
  return !!chainageCityConfig[String(city || "").toLowerCase()];
}

export function chainageUnavailableMessage(city) {
  return `Chainage is still in progress for ${city || "this city"}. You can continue using other map features.`;
}
