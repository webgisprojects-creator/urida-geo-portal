import { getRenderPixel } from "ol/render";

// Flattens Polygon/MultiPolygon features into a plain list of coordinate
// rings (exterior + holes, in the map's projection) so the render-time clip
// loop below doesn't have to walk feature/geometry wrappers every frame.
export function extractClipRings(features) {
  const rings = [];
  (features || []).forEach((feature) => {
    const geometry = feature?.getGeometry?.();
    if (!geometry) return;
    const type = geometry.getType();
    const polygons =
      type === "MultiPolygon"
        ? geometry.getPolygons()
        : type === "Polygon"
          ? [geometry]
          : [];
    polygons.forEach((polygon) => {
      polygon.getLinearRings().forEach((ring) => {
        rings.push(ring.getCoordinates());
      });
    });
  });
  return rings;
}

// Masks a raster layer to the given boundary rings instead of just their
// rectangular extent, so nothing renders outside the real (irregular)
// boundary shape. `ringsRef` is a React ref rather than a plain array so the
// mask can be populated later (after an async WFS fetch resolves) without
// re-attaching listeners or recreating the layer — an empty/null ref simply
// renders the layer unclipped in the meantime.
// `evenodd` fill rule is winding-direction-independent, so this correctly
// unions multiple disjoint boundary polygons (e.g. every zone in a city) and
// subtracts holes within a single polygon, regardless of how the source
// data happens to wind its rings.
export function attachLayerClip(layer, map, ringsRef) {
  layer.on("prerender", (event) => {
    const rings = ringsRef.current;
    if (!rings || !rings.length) return;
    const ctx = event.context;
    ctx.save();
    ctx.beginPath();
    rings.forEach((ring) => {
      ring.forEach((coordinate, i) => {
        const pixel = getRenderPixel(event, map.getPixelFromCoordinate(coordinate));
        if (i === 0) ctx.moveTo(pixel[0], pixel[1]);
        else ctx.lineTo(pixel[0], pixel[1]);
      });
      ctx.closePath();
    });
    ctx.clip("evenodd");
  });
  layer.on("postrender", (event) => {
    const rings = ringsRef.current;
    if (!rings || !rings.length) return;
    event.context.restore();
  });
}

// "Tinted window" mask: paints a single semi-transparent fill everywhere
// *outside* the given boundary rings, so the real basemap underneath still
// shows through (dimmed) instead of a hard cutoff to a flat void. This is
// the inverse of attachLayerClip above and deliberately reuses the exact
// same technique - same ringsRef contract, same evenodd fill rule (winding-
// direction independent, so it doesn't matter whether the source rings are
// clockwise or counter-clockwise) - just applied to a full-canvas fill
// instead of clipping another layer's own content. Costs zero network
// requests: it draws directly on `layer`'s own render pass using geometry
// already fetched for attachLayerClip, no tiles, no second basemap.
export function attachInvertedMask(layer, map, ringsRef, fillColor = "rgba(234,234,234,0.65)") {
  layer.on("postrender", (event) => {
    const rings = ringsRef.current;
    if (!rings || !rings.length) return;
    const ctx = event.context;
    const width = ctx.canvas.width;
    const height = ctx.canvas.height;
    ctx.save();
    ctx.beginPath();
    // Outer ring: the whole render canvas, in device pixels.
    ctx.rect(0, 0, width, height);
    // Inner rings: the real boundary - evenodd makes this a hole rather
    // than adding to the filled area.
    rings.forEach((ring) => {
      ring.forEach((coordinate, i) => {
        const pixel = getRenderPixel(event, map.getPixelFromCoordinate(coordinate));
        if (i === 0) ctx.moveTo(pixel[0], pixel[1]);
        else ctx.lineTo(pixel[0], pixel[1]);
      });
      ctx.closePath();
    });
    ctx.clip("evenodd");
    ctx.fillStyle = fillColor;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  });
}

// ---------------------------------------------------------------------
// Point-in-city-boundary test (used by "locate me" — a resolved GPS
// position outside the current city's coverage shouldn't pan the map away
// from it). Rings are the same flat coordinate-ring lists extractClipRings
// produces, in the map's projection (EPSG:3857 everywhere this app uses
// them, so plain Euclidean distance below is already in meters).
// ---------------------------------------------------------------------

// Even-odd ray-casting test — same winding-independent rule the clip/mask
// functions above already rely on, so a coordinate is judged "inside" by
// exactly the same logic that decides what's rendered as inside the city.
function isCoordinateInRing(coordinate, ring) {
  const [x, y] = coordinate;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const crosses = (yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

function isCoordinateInRings(coordinate, rings) {
  let inside = false;
  rings.forEach((ring) => {
    if (isCoordinateInRing(coordinate, ring)) inside = !inside;
  });
  return inside;
}

function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function distanceToRings(coordinate, rings) {
  const [x, y] = coordinate;
  let min = Infinity;
  rings.forEach((ring) => {
    for (let i = 0; i < ring.length - 1; i++) {
      const d = distanceToSegment(x, y, ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1]);
      if (d < min) min = d;
    }
  });
  return min;
}

// True if `coordinate` is inside the boundary rings, or within
// `bufferMeters` of the nearest edge (a small tolerance for GPS jitter and
// genuinely boundary-adjacent locations, per city). If no rings are loaded
// yet (boundary still fetching, or this city has no zone/ward layer
// configured), this fails open — it doesn't block "locate me" just because
// the boundary hasn't arrived yet.
export function isCoordinateWithinCityBounds(coordinate, rings, bufferMeters = 2000) {
  if (!Array.isArray(rings) || !rings.length) return true;
  if (isCoordinateInRings(coordinate, rings)) return true;
  return distanceToRings(coordinate, rings) <= bufferMeters;
}
