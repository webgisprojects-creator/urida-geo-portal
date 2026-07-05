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
