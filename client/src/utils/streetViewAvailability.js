import { cityConfig } from "../assets/configs/cityConfig";

// Street view availability is now configured in cityConfig.js under the streetView property
export function isStreetViewAvailable(city) {
  const cityKey = String(city || "").toLowerCase().trim();
  const config = cityConfig[cityKey];
  return Boolean(config?.streetView?.enabled);
}

export function streetViewUnavailableMessage(city) {
  const cityKey = String(city || "").toLowerCase().trim();
  const config = cityConfig[cityKey];
  const cityName = config?.name || city || "this city";
  return `Street View is not available for ${cityName}. You can continue using other map features.`;
}
