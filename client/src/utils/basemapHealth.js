// Shared basemap-outage detection for every map in the portal (HomePage +
// city Dashboards). OL loads tiles as <img> elements, which can't read the
// tile proxy's JSON error body — so this listens for a burst of
// `tileloaderror` events on a basemap's source (a couple of isolated errors
// are normal during fast panning; a burst means the style is genuinely
// down), then makes one authenticated fetch() probe for a single tile to
// read the server's failure classification, and reports it through
// whatever notification UI the calling page owns.
//
// The server's `reason` field (see server/src/routes/tiles.js,
// classifyUpstreamFailure): "network" = the deployment network is blocking
// the provider (firewall — e.g. UPSDC environment), "provider" = the CDN
// answered but is erroring (their outage).

const ERROR_BURST_THRESHOLD = 3;
const ERROR_BURST_WINDOW_MS = 15000;
const RENOTIFY_COOLDOWN_MS = 5 * 60 * 1000;

// Module-level so the cooldown holds across page/dashboard remounts —
// switching cities shouldn't re-toast the same dead provider every time.
const lastNotifiedAt = {};

export function basemapFailureMessage(displayName, reason) {
  return reason === "network"
    ? `The ${displayName} basemap is not available because the UPSDC network is not allowing this service. Please contact the UPSDC network team.`
    : `The open source basemap provider for ${displayName} is facing an issue right now. Please use another basemap.`;
}

// `probeUrl`: a concrete single-tile URL for this style (low zoom, always
// within coverage), same origin/base as the layer's own tiles so it
// exercises the identical path. `notify(reason, message)` is the page's
// own toast/banner mechanism.
export function attachBasemapErrorNotifier(source, styleKey, displayName, probeUrl, notify) {
  if (!source?.on) return;
  let burstStart = 0;
  let burstCount = 0;
  let probing = false;

  source.on("tileloaderror", async () => {
    const now = Date.now();
    if (now - burstStart > ERROR_BURST_WINDOW_MS) {
      burstStart = now;
      burstCount = 0;
    }
    burstCount += 1;
    if (burstCount < ERROR_BURST_THRESHOLD || probing) return;
    if (lastNotifiedAt[styleKey] && now - lastNotifiedAt[styleKey] < RENOTIFY_COOLDOWN_MS) return;

    probing = true;
    try {
      const res = await fetch(probeUrl, { cache: "no-store", credentials: "include" });
      if (res.ok) return; // transient blip (probe succeeded) — stay quiet
      let reason = "provider";
      try {
        const body = await res.json();
        if (body?.reason === "network") reason = "network";
      } catch {
        /* non-JSON error body — keep "provider" */
      }
      lastNotifiedAt[styleKey] = Date.now();
      notify(reason, basemapFailureMessage(displayName, reason));
    } catch {
      // fetch() itself failed — can't even reach our own backend, which on
      // this architecture (same-origin proxy) means the local network path
      // is down, not the third-party provider.
      lastNotifiedAt[styleKey] = Date.now();
      notify("network", basemapFailureMessage(displayName, "network"));
    } finally {
      probing = false;
    }
  });
}
