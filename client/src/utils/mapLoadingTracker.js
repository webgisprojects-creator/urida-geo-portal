// Automatically tracks loading state for every layer already on a map, and
// for any layer added later (including inside nested LayerGroups) — so a
// brand new TileLayer/ImageLayer with a `title` set shows up in the shared
// loading indicator with zero extra wiring. Nobody adding a layer later
// needs to know this exists; it just works, as long as the layer has a
// `title` (already this codebase's convention for every real layer).
//
// Call once per map instance (e.g. right after `new Map({...})`); returns a
// cleanup function to call on unmount/city change.
//
// `onChange(loading, labels)` fires whenever the overall loading state or
// the set of currently-loading friendly labels changes. `labels` omits raw
// GeoServer layer names — it's always whatever human-readable `title` the
// layer was given (e.g. "Road Network Layer", "Satellite"), so the message
// always reflects what the user actually picked, never internal layer IDs.
import { logEvent } from "./telemetry";

function prettifyLabel(label) {
  return String(label)
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// A single basemap/WMS tile realistically never takes longer than this to
// either load or fail. Bounding each individual load's lifetime (rather
// than one shared "give up" timer for the whole tracker) is what makes this
// self-healing: a shared timer gets pushed back by every *other* normal
// tile finishing nearby, so one tile that OL never reports a load/error for
// (discarded mid-flight while panning, a connection that stalls without
// erroring, etc.) can wedge the indicator on indefinitely even though
// everything else is working fine — which is exactly the "stuck for
// minutes" bug this replaced. Bounding per-load means one orphaned tile
// only ever costs 12s, regardless of how much unrelated traffic is
// happening at the same time.
const LOAD_AUTO_EXPIRE_MS = 12000;

export function attachMapLoadingTracker(map, onChange) {
  const active = new Map(); // source -> { label, count, layer }
  let hideDebounceTimer = null;

  const emit = () => {
    clearTimeout(hideDebounceTimer);
    const labels = [
      ...new Set(
        [...active.values()]
          // A hidden layer's in-flight tiles are wasted work, not something
          // the user is waiting on — most visibly, switching between road
          // classifications (zone -> category -> ...) hides the old layer
          // but doesn't cancel its already-queued tile requests, so without
          // this check the banner keeps naming a classification the user
          // already switched away from until those orphaned tiles happen to
          // finish loading.
          .filter((v) => v.count > 0 && (!v.layer || v.layer.getVisible?.() !== false))
          .map((v) => prettifyLabel(v.label))
      ),
    ];
    if (labels.length) {
      onChange(true, labels);
    } else {
      // Small debounce so a burst of fast cache-hit tiles doesn't flicker
      // the bar on/off within the same interaction.
      hideDebounceTimer = setTimeout(() => onChange(false, []), 250);
    }
  };

  const trackSource = (source, label, layer) => {
    if (!source || source.__loadTrackerAttached) return;
    source.__loadTrackerAttached = true;
    const entry = { label, count: 0, layer };
    active.set(source, entry);
    const pendingExpiries = []; // FIFO queue — matches OL's own load/error firing order closely enough
    // Per-burst counters (a "burst" = from the first tile requested after
    // being idle, to the layer going idle again) — logged once per burst
    // instead of per tile, so a single pan/zoom that requests 40 tiles for
    // one layer produces one summary line ("Road Network: 40 tiles, 1.2s
    // total, slowest 340ms") instead of 40 separate log lines.
    let burstStartedAt = null;
    let burstTileCount = 0;
    let burstSlowestMs = 0;

    const inc = () => {
      const startedAt = performance.now();
      if (entry.count === 0) {
        burstStartedAt = startedAt;
        burstTileCount = 0;
        burstSlowestMs = 0;
      }
      entry.count += 1;
      const timeoutId = setTimeout(() => {
        const idx = pendingExpiries.findIndex((p) => p.id === timeoutId);
        if (idx !== -1) pendingExpiries.splice(idx, 1);
        entry.count = Math.max(0, entry.count - 1);
        // If you see this, some tile/image/feature request for this layer
        // never reported success or failure within 12s — that's the "stuck
        // for minutes" symptom. Check the Network tab for a request to this
        // layer that's still pending or stalled.
        console.warn(
          `[map-loading] "${label}" — a tile never resolved (load/error) within ${LOAD_AUTO_EXPIRE_MS}ms, force-clearing it.`
        );
        logEvent("layer_load_stuck", { label, afterMs: LOAD_AUTO_EXPIRE_MS });
        emit();
      }, LOAD_AUTO_EXPIRE_MS);
      pendingExpiries.push({ id: timeoutId, startedAt });
      emit();
    };
    const dec = () => {
      const pending = pendingExpiries.shift();
      if (pending) {
        clearTimeout(pending.id);
        const durationMs = Math.round(performance.now() - pending.startedAt);
        burstTileCount += 1;
        burstSlowestMs = Math.max(burstSlowestMs, durationMs);
        if (durationMs > 3000) {
          // Slow but not stuck — worth knowing about without being alarming.
          console.debug(`[map-loading] "${label}" took ${durationMs}ms`);
          logEvent("layer_load_slow", { label, durationMs });
        }
      }
      entry.count = Math.max(0, entry.count - 1);
      if (entry.count === 0 && burstStartedAt !== null) {
        logEvent("layer_burst_complete", {
          label,
          tileCount: burstTileCount,
          totalMs: Math.round(performance.now() - burstStartedAt),
          slowestMs: burstSlowestMs,
        });
        burstStartedAt = null;
      }
      emit();
    };

    // Tile-based sources (XYZ, TileWMS, TileImage, VectorTile).
    source.on?.("tileloadstart", inc);
    source.on?.("tileloadend", dec);
    source.on?.("tileloaderror", dec);
    // Single-image sources (ImageWMS and other ol/source/Image subclasses).
    source.on?.("imageloadstart", inc);
    source.on?.("imageloadend", dec);
    source.on?.("imageloaderror", dec);
    // Vector sources loading via the built-in url+format convenience.
    source.on?.("featuresloadstart", inc);
    source.on?.("featuresloadend", dec);
    source.on?.("featuresloaderror", dec);
  };

  const trackLayer = (layer) => {
    if (!layer) return;
    if (typeof layer.getLayers === "function") {
      // LayerGroup — recurse into current children, and keep watching for
      // ones added to this group later (e.g. per-amenity/per-classification
      // layers built after the group itself already exists).
      layer.getLayers().forEach(trackLayer);
      layer.getLayers().on("add", (e) => trackLayer(e.element));
      return;
    }
    const label = layer.get?.("title") || layer.get?.("label");
    if (!label) return; // untitled helper layers (markers, search outline) shouldn't clutter the message
    // Hiding a layer should drop it from the banner immediately, not wait
    // for its in-flight tiles to finish resolving on their own.
    layer.on?.("change:visible", emit);
    const attach = () => {
      const source = layer.getSource?.();
      if (source) trackSource(source, label, layer);
    };
    attach();
    // A layer's source can be swapped after creation (e.g. style/workspace
    // changes) — keep tracking whatever source is current.
    layer.on?.("change:source", attach);
  };

  map.getLayers().forEach(trackLayer);
  map.getLayers().on("add", (e) => trackLayer(e.element));

  // Correlates the tile timing logs above with the user action that caused
  // them — so "why is this stuck" can be answered from the log alone
  // (zoomed/panned at 12:03:41 -> these layer_burst_complete/layer_load_*
  // events followed -> which ones, if any, were slow or stuck).
  let moveStartedAt = null;
  const handleMoveStart = () => {
    moveStartedAt = performance.now();
    console.debug("[map-loading] pan/zoom started");
    logEvent("map_move_start", {
      zoom: map.getView()?.getZoom?.(),
      center: map.getView()?.getCenter?.(),
    });
  };
  const handleMoveEnd = () => {
    if (moveStartedAt === null) return;
    logEvent("map_move_end", {
      durationMs: Math.round(performance.now() - moveStartedAt),
      zoom: map.getView()?.getZoom?.(),
    });
    moveStartedAt = null;
  };
  map.on("movestart", handleMoveStart);
  map.on("moveend", handleMoveEnd);

  return () => {
    clearTimeout(hideDebounceTimer);
    map.un("movestart", handleMoveStart);
    map.un("moveend", handleMoveEnd);
  };
}
