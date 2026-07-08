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
