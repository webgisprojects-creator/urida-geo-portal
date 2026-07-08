# Load Balancer 2 / Nginx Performance Audit

Audit date: 2026-07-07

Scope: read-only inspection of `load-balancer-2` / `lb2` (`27.100.38.133`) and the URIDA Nginx path.

## Current Findings

- Host: `load-balancer-2`
- OS/kernel: Ubuntu, kernel `5.15.0-177-generic`
- Nginx: `nginx/1.18.0 (Ubuntu)`
- Active LB software: Nginx only
- HAProxy: inactive
- keepalived: inactive
- CPU/RAM: `2 vCPU`, `7.6 GiB RAM`
- Disk: root filesystem has about `68G` free
- Public listeners: `80`, `443`

Current Nginx routing:

```text
/geoserver/ -> http://162.245.218.6:8080/geoserver/
/api/       -> http://27.100.38.131:8060/api/
/           -> http://27.100.38.131:8060/
```

Important config gaps:

- No `upstream` blocks, so there is no named upstream pool, keepalive pool, or clean future migration target switch.
- `/geoserver/` has `proxy_buffering off`, so Nginx cannot shield GeoServer from slow clients.
- No `proxy_cache`, no `proxy_cache_lock`, no stale serving, and no cache status logging.
- `worker_connections` remains default-ish at `768`.
- TLS server block does not use HTTP/2.
- Logs do not include `$request_time`, `$upstream_response_time`, `$upstream_cache_status`, or `$upstream_addr`, so production bottlenecks are harder to see.
- Access-log sample showed direct `/geoserver/gwc/service/wms` tile traffic returning `200`, meaning some users still hit GeoServer paths directly instead of only the app `/api/gwc-tiles` and `/api/wms-tile-cache` routes.

## Main Decision

For the heavy road/classification traffic, put Nginx in front of the app's cache routes, not directly in front of raw GeoServer.

The app already solved the hard cache-key problem. `MapContainer.jsx` requests stable z/x/y URLs such as:

```text
/api/wms-tile-cache/Road_Network:Kanpur_Road_Network/16/47409/27780.png?cqlFilter=...&styles=...
```

That URL is a reusable, filter-safe cache key. It preserves the CQL filter and style in the request URI, so one ward's tile cannot collide with another ward's tile. If Nginx caches raw GeoServer WMS directly, it has to reimplement tile-grid snapping and dynamic filter detection in Nginx config. That is more fragile and gives a worse hit rate for arbitrary bbox requests.

Recommended first-phase target:

```text
Client/WAF -> Nginx edge cache -> Node PM2 app cache routes -> GeoServer -> PgBouncer/Postgres
```

GeoServer can still be reached directly by Nginx for narrow, safe cases: legends, capabilities, describe metadata, and unfiltered direct GWC tiles.

## Auth Safety

The app tile routes are protected by `verifyToken`:

- `/api/wms-tile-cache/...`
- `/api/gwc-tiles/...`
- `/api/tiles/...`
- `/api/boundary-geojson/...`

That means a shared Nginx cache must not serve protected tile responses to callers that have not been authenticated. The conservative migration template therefore keys the app-tile edge cache by URL plus the current auth cookie/header. This is safe, but it is mostly per-session cache.

Because each login gets its own JWT, this first phase will not share filtered tile hits across different workers even when they are assigned to the same ward. That cross-worker benefit requires the phase-2 auth gate below.

For true cross-user shared edge cache, add an explicit Nginx auth gate first:

```text
Nginx auth_request -> cheap app auth endpoint -> URI-only shared tile cache
```

The existing `/api/auth/profile` endpoint can prove the concept, but a smaller `/api/auth/edge-check` endpoint would be cleaner for production because it can return `204` without profile JSON. Until that is added and tested, do not use a URI-only shared cache for protected `/api/...` tile routes.

## Recommended Low-Risk Changes

1. Add named upstreams with keepalive:

```nginx
upstream urida_app {
    server 27.100.38.131:8060;
    keepalive 64;
}

upstream urida_geoserver {
    server 162.245.218.6:8080 max_fails=3 fail_timeout=15s;
    keepalive 32;
}
```

2. Enable HTTP/2 on TLS:

```nginx
listen 443 ssl http2;
```

3. Turn on buffering for proxied tile and GeoServer responses:

```nginx
proxy_buffering on;
proxy_buffers 32 32k;
proxy_busy_buffers_size 256k;
```

4. Add a conservative app-tile edge cache:

- Cache `/api/wms-tile-cache/` and `/api/gwc-tiles/` for short periods, keyed by URI plus auth token.
- Cache `/api/tiles/` similarly; this mainly helps repeat basemap/boundary-mask requests that reach Nginx after the browser cache is cold or bypassed.
- Optionally cache `/api/boundary-geojson/` briefly, also behind auth.
- Do not cache generic `/api/` JSON.
- Do not cache `401`, `403`, `5xx`, or responses with `Set-Cookie`.

5. Keep direct GeoServer cache narrow:

- Cache direct `/geoserver/gwc/service/wms` only when it is GET/HEAD and has no `CQL_FILTER`, `SLD_BODY`, `FILTER`, or `viewparams`.
- Cache legend/capabilities/describe metadata briefly.
- Do not cache WFS `GetFeature` or WMS `GetFeatureInfo` directly at Nginx in this phase.
- Do not cache POST.
- Do not cache `/geoserver/web/` or `/geoserver/rest/`.

6. Use `proxy_cache_lock on` so 200 users asking for the same uncached key cause one upstream render/fetch instead of 200.

7. Use stale responses on upstream error/timeout while a background refresh happens:

```nginx
proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;
proxy_cache_background_update on;
```

8. Add observability log format:

```nginx
log_format urida_timing '$remote_addr - $host "$request" $status '
                        'rt=$request_time urt=$upstream_response_time '
                        'cache=$upstream_cache_status upstream=$upstream_addr '
                        'bytes=$body_bytes_sent';
```

9. Keep GeoServer admin/private endpoints restricted:

```nginx
location ^~ /geoserver/web/  { return 404; }
location ^~ /geoserver/rest/ { return 404; }
```

If admin UI is needed, expose it only over VPN/admin IP allowlist, not the public path.

## Why This Helps

- Nginx serves repeat app-tile hits without running the expensive tile route again.
- The app keeps ownership of CQL/filter/style-safe cache keys.
- Nginx `proxy_cache_lock` prevents thundering-herd behavior on cold cache keys.
- Nginx stale-cache serving lets users keep seeing tiles during short app or GeoServer stalls.
- Upstream keepalive reduces repeated TCP setup between Nginx and app/GeoServer.
- HTTP/2 reduces browser connection pressure for many tile requests.
- Buffering lets Nginx read the upstream response quickly, then stream to slow clients without tying GeoServer/Tomcat to the client speed.
- Timing logs make it obvious whether slowness is client, Nginx, app, GeoServer, or upstream network.

This does not eliminate cold-cache miss cost. If a filtered road tile is not in Node's disk cache yet, GeoServer still has to render it. GeoServer JVM tuning, control-flow limits, spatial indexes, PgBouncer, and cache warming still matter for the multi-second miss path.

## What Not To Do

- Do not unpublish GeoServer layers for performance.
- Do not cache protected `/api/...` tile routes by URI only unless Nginx has a real auth gate first.
- Do not cache GeoServer admin or REST responses.
- Do not cache authenticated API JSON blindly at Nginx.
- Do not cache direct `SLD_BODY`, `CQL_FILTER`, `FILTER`, or `viewparams` GeoServer requests.
- Do not make Nginx per-IP limits too tight if all real users are behind one WAF/proxy IP.
- Do not rely on Nginx cache alone for dynamic CQL-filtered road tiles; keep using the app `/api/wms-tile-cache` route for those.

## Reference Docs

- Nginx proxy cache, cache locks, stale cache, buffering: https://nginx.org/en/docs/http/ngx_http_proxy_module.html
- Nginx upstream keepalive: https://nginx.org/en/docs/http/ngx_http_upstream_module.html
- GeoServer control-flow extension: https://docs.geoserver.org/latest/en/user/extensions/controlflow/index.html
- GeoServer GeoWebCache usage: https://docs.geoserver.org/latest/en/user/geowebcache/using.html

## Validation Plan

Before applying:

```bash
sudo cp /etc/nginx/sites-available/geoserver.conf /root/geoserver.conf.before-urida-cache-$(date +%Y%m%d-%H%M%S)
sudo nginx -t
```

After applying:

```bash
sudo nginx -t
sudo systemctl reload nginx
curl -kI https://27.100.38.133/
curl -kI 'https://27.100.38.133/geoserver/ows?service=WMS&version=1.1.1&request=GetCapabilities'
tail -f /var/log/nginx/urida_timing.log
```

Expected:

- First repeated app tile request: `X-Edge-Cache: MISS`
- Second repeated app tile request with the same auth token: `X-Edge-Cache: HIT`
- Existing app route header still shows Node cache state as `X-Cache: HIT/MISS/STALE`
- If app/GeoServer stalls but a cached copy exists: `X-Edge-Cache: STALE`
