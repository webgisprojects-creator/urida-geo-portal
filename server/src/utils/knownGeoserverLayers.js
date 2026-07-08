import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Same client-only-config problem as cacheWarmer.js's parseCityRegistry:
// cityConfig.js/chainageCityConfig.js import `ol/proj` and can't be
// `import`-ed into the Node server process, so they're parsed as text
// instead. This reuses the exact generic "workspace:layer" string-literal
// regex already proven in scripts/test-geoserver-layers.mjs (which the
// project already runs to smoke-test every layer against live GeoServer),
// rather than hand-maintaining a second, driftable list of valid layers.
const CONFIG_FILES = [
  path.resolve(__dirname, "../../../client/src/assets/configs/cityConfig.js"),
  path.resolve(__dirname, "../../../client/src/assets/configs/chainageCityConfig.js"),
];

// The state-wide boundary used by HomePage.js — not a per-city layer, so it
// never shows up in cityConfig.js's per-city blocks.
const UP_WIDE_BOUNDARY = "Ward_38:Up_District";

const LAYER_LITERAL_RE = /["'`]([^"'`\n]*:[^"'`\n]+)["'`]/g;

let cachedSet = null;

// Parsed once per process and cached — cityConfig.js only changes on a
// redeploy, and re-parsing on every tile request would be wasted work on
// the hot path. Restart the server to pick up newly-added layers.
export function getKnownLayerSet() {
  if (cachedSet) return cachedSet;

  const layers = new Set([UP_WIDE_BOUNDARY]);
  for (const file of CONFIG_FILES) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue; // chainageCityConfig.js etc. may not exist in every checkout
    }
    const withoutComments = text
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    for (const match of withoutComments.matchAll(LAYER_LITERAL_RE)) {
      const layer = match[1].trim();
      if (!layer || layer.includes("${")) continue;
      layers.add(layer);
    }
  }

  cachedSet = layers;
  return cachedSet;
}

export function isKnownGeoserverLayer(layerName) {
  if (!layerName) return false;
  return getKnownLayerSet().has(String(layerName));
}
