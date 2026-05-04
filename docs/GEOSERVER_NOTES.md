# GeoServer Configuration Notes for URIDA Production

## 1. Known WFS Name Typos in PostGIS Table `4326_all_boundaries`

The `Ward_38:4326_all_boundaries` layer in GeoServer has 3 incorrect `Name` values in the database.
These cause the hover popup and click-to-select to fail for 3 cities.

### Current (wrong) vs Correct values:

| Wrong in DB     | Correct           |
|-----------------|-------------------|
| `Varansi`       | `Varanasi`        |
| `Shaharanpur`   | `Saharanpur`      |
| `Shahajahanpur` | `Shahjahanpur`    |

### Fix when you have PostGIS access on the production server:

Connect to the `All_DB` database (host: 162.245.218.6, user: postgres) and run:

```sql
UPDATE "4326_all_boundaries" SET "Name" = 'Varanasi'    WHERE "Name" = 'Varansi';
UPDATE "4326_all_boundaries" SET "Name" = 'Saharanpur'  WHERE "Name" = 'Shaharanpur';
UPDATE "4326_all_boundaries" SET "Name" = 'Shahjahanpur' WHERE "Name" = 'Shahajahanpur';
-- verify:
SELECT "Name" FROM "4326_all_boundaries" ORDER BY "Name";
```

> **Note:** Until the DB is fixed on production, a client-side workaround (`WFS_NAME_MAP` in `HomePage.js`) corrects these names in the app automatically.

---

## 2. GeoServer Tile Caching (GeoWebCache)

### Already configured (done on this server):
```bash
# Set expireClients = 3600s (1h browser cache) and gutter = 50px for the upDistrict WMS layer:
curl -u admin:geoserver -X PUT -H "Content-Type: application/json" \
  "http://localhost:8080/geoserver/gwc/rest/layers/Ward_38:up_district.json" \
  -d '{"GeoServerLayer":{"expireClients":3600,"gutter":50,"name":"Ward_38:up_district","inMemoryCached":true}}'
```

### Apply on production server:
Run the same curl command replacing `localhost` with the GeoServer host. Credentials: `admin:geoserver`.

### Verify caching is active:
- Visit GeoServer Admin → Tile Caching → Tile Layers → `Ward_38:up_district`
- Should show `Enabled: Yes`, `In-Memory Caching: Yes`

---

## 3. Pre-seed Tile Cache (optional — for fastest cold-start performance)

Once caching is enabled, seed the cache at zoom levels used by the app (zoom 7–10):

```bash
curl -u admin:geoserver -X POST \
  "http://localhost:8080/geoserver/gwc/rest/seed/Ward_38:up_district.json" \
  -H "Content-Type: application/json" \
  -d '{
    "seedRequest": {
      "name": "Ward_38:up_district",
      "gridSetId": "EPSG:900913",
      "zoomStart": 6,
      "zoomStop": 11,
      "format": "image/png",
      "type": "seed",
      "threadCount": 2
    }
  }'
```

Check seed progress:
```bash
curl -u admin:geoserver "http://localhost:8080/geoserver/gwc/rest/seed/Ward_38:up_district.json"
```
