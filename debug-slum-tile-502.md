# [OPEN] slum-tile-502

## Symptom
- Browser console shows `502 (Bad Gateway)` for:
  - `/api/gwc-tiles/Road_Network%3AAyodhya_Slum_Boundary/...`
  - `/api/gwc-tiles/Road_Network%3AAyodhya_Slum_Roads/...`
- Expected: slum boundary and slum roads tiles load normally.

## Initial Evidence
- Client proxy can return `502` when both backend targets are unreachable.
- Backend tile route also returns `502` when upstream GeoServer/GWC tile fetch fails.
- The failing URLs are on the cached GIS tile route, not a frontend rendering-only path.

## Falsifiable Hypotheses
1. The backend is reachable, but GeoServer/GWC cannot fetch `Road_Network:Ayodhya_Slum_Boundary` or `Road_Network:Ayodhya_Slum_Roads`.
2. Those Ayodhya slum layers are configured in the app but are missing/unpublished/misnamed upstream in GeoServer.
3. GeoServer serves those layers, but tile requests are timing out or failing under load, so the backend returns `502`.
4. The request path is correct, but the backend tile cache/proxy is failing before it can persist or return the upstream tile.
5. The frontend proxy is sometimes hitting an unavailable backend port, causing a proxy-generated `502` before the tile route runs.

## Code Locations
- Client proxy fallback/error handling: `client/src/setupProxy.js`
- Cached GWC tile route: `server/src/routes/tiles.js`
- Concurrency/backpressure logic: `server/src/utils/concurrencyLimiter.js`

## Next Evidence To Collect
- Exact response body for one failing `/api/gwc-tiles/...` request from browser Network tab
- Backend log line paired with the same request
- Whether the same layers open directly in GeoServer preview/WMS GetMap