# URIDA — TASK CONTEXT
# Read this file alongside PROJECT_CONTEXT.md before every session.
# PROJECT_CONTEXT.md = what the codebase is
# TASK_CONTEXT.md = what needs to be built or fixed

---

## HOW TO START EVERY ANTIGRAVITY SESSION

Paste this exact line at the start — nothing else needed:

```
Read PROJECT_CONTEXT.md and TASK_CONTEXT.md from /var/www/urida_prod/ before starting.
You are a [ROLE FROM SECTION 1]. 
Task: [TASK NUMBER AND NAME FROM SECTION 2].
Return only changed functions. Do not rewrite unchanged code.
```

---

## SECTION 1 — ROLES

Use the correct role for each task. One role per session.

| Task | Role |
|------|------|
| Task 1 (table toggle bug) | Senior React state management engineer |
| Task 2 (bbox table fetch) | Senior React and OpenLayers integration engineer |
| Task 3 (range slider filter) | Senior React UI component engineer |
| Task 4 (export rewrite) | Senior JavaScript GIS export engineer |
| Task 5 (button audit) | Senior React UI and QA engineer |
| Any MapContainer change | Senior OpenLayers GIS developer |
| Any backend change | Senior Node.js and PostgreSQL engineer |

---

## SECTION 2 — PENDING TASKS IN ORDER

Complete and test each task before starting the next one.
Each task has: the file, the exact function, what to do, and how to test.

---

### TASK 1 — Fix table disappearing when amenity is toggled
**Status:** Pending
**File:** `client/src/components/Dashboard.jsx`
**Function:** `handleLayerToggle`

**Problem:**
When any amenity/others/analysis layer is toggled ON, this block runs:
```javascript
if (checked && group !== "network") {
  setBaseFilter("");
  setColumnFilters({});
  setTableRows([]);   // ← destroys road table even when roads are ON
}
```

**Fix:**
Wrap the entire clear block with a roads-active guard:
```javascript
if (checked && group !== "network" && !layerVisibility.network?.roads) {
  setBaseFilter("");
  setColumnFilters({});
  setTableRows([]);
  setZoomFilter("");
  setSelectedRoad("");
  setSelectedRoadId(null);
  setCurrentPage(1);
}
```

Also fix road OFF behavior — currently calls `setTableRows([])`, change to:
```javascript
// Road layer turned OFF → minimize only, preserve data
if (group === "network" && id === "roads" && !checked) {
  setIsTableMinimized(true);
  // do NOT call setTableRows([])
}
// Road layer turned ON → restore
if (group === "network" && id === "roads" && checked) {
  setIsTableMinimized(false);
  setShouldFetchTable(true);
  setBaseFilter("INCLUDE");
}
```

**Table close rule — enforce this:**
Only the `×` button handler may call `setTableRows([])`. No other place.

**Test:** Toggle ATM Bank ON while roads are visible → table must stay with all data intact.

---

### TASK 2 — Add map bbox extent to table data fetch
**Status:** Pending (do after Task 1)
**Files:** `client/src/components/Dashboard.jsx` + `client/src/components/MapContainer.jsx`

**What to add in Dashboard.jsx:**
```javascript
const [mapExtent, setMapExtent] = useState(null);
```

Append bbox to the table fetch URL:
```javascript
// In the table fetch useEffect, change the fetch URL to:
const bboxParam = mapExtent ? `&bbox=${mapExtent.join(',')}` : '';
fetch(`/api/road-networks/${city}/details?filter=${encodeURIComponent(roadFilter)}${bboxParam}`)
```

Only append bbox when `baseFilter === 'INCLUDE'` (no specific filter active).
When a specific filter is active (zone/ward/condition etc), bbox is secondary — both apply.

**What to add in MapContainer.jsx:**
Add prop: `onMapExtentChange`
Wire moveend event after map initializes:
```javascript
map.on('moveend', () => {
  const extent = map.getView().calculateExtent(map.getSize());
  if (onMapExtentChange) onMapExtentChange(extent);
});
```

Also expose via `useImperativeHandle`:
```javascript
getCurrentExtent: () => mapRef.current?.getView()?.calculateExtent(mapRef.current?.getSize())
```

**Test:** Open roads layer, pan/zoom map → table rows change to show only roads in current viewport.

---

### TASK 3 — Range slider for numeric column filters
**Status:** Pending (do after Task 1)
**File:** `client/src/components/Dashboard.jsx`
**Component:** `FilterDropdown` (internal component at top of Dashboard.jsx)

**Numeric columns that need range slider:**
`yoc`, `row_meter`, `carriage_w`, `length_km`

**Text/categorical columns — keep checkbox as-is:**
`zone_no`, `zone_name`, `ward_no`, `ward_name`, `ownership`, `condition`, `category`, `material`, `cus_class`

**What to build:**
- Detect numeric: `const isNumeric = ['yoc','row_meter','carriage_w','length_km'].includes(column.key)`
- If numeric: fetch all distinct values from existing endpoint, take `Math.min` and `Math.max`
- Render dual-handle range slider — pure CSS + React state, no external library
- Two thumb handles on a track, labels showing current value above each handle
- Style: clean minimal like Amazon price filter
- Use `pointerdown/pointermove/pointerup` for drag behavior
- Min thumb cannot exceed max thumb value

**CQL output for numeric range:**
```javascript
// onApply sends this to handleColumnFilterChange:
`${column.key} >= ${minVal} AND ${column.key} <= ${maxVal}`
```

**Update `handleColumnFilterChange` in Dashboard.jsx:**
```javascript
// Detect if value is a range string (numeric columns)
const isRangeFilter = typeof selectedValues === 'string' && selectedValues.includes('>=');
if (isRangeFilter) {
  // Store as raw CQL string, not IN() array
  newFilters[key] = { type: 'range', cql: selectedValues };
}
```

Update the `useEffect` that builds `roadFilter` to handle range type:
```javascript
const colParts = Object.entries(columnFilters).map(([colKey, val]) => {
  if (val?.type === 'range') return val.cql;  // range filter
  // existing IN() logic for categorical...
});
```

**Cascading still works:** other `columnFilters` context still applied to distinct fetch for min/max.

**Test:** Click ▼ on Length (km) column → shows two-handle slider, not checkbox list. Drag handles → table filters accordingly.

---

### TASK 4 — Rewrite export logic
**Status:** Pending (do after Task 2, needs mapExtent state)
**Files:** `client/src/utils/gisExport.js` + `handleDownloadAction` in `client/src/components/Dashboard.jsx`

**PRINT MAP (PNG):**

After `captureMapCanvas(mapRef)` returns canvas:
1. Use `html2canvas` on the legend DOM element (pass `legendRef` or query `.map-legend`)
2. Draw legend image onto top-right corner of map canvas
3. Draw bottom-left info box on canvas:
   - Line 1: `formatCityName(city) + ' Nagar Nigam'`
   - Line 2: `'Date: ' + new Date().toLocaleDateString('en-IN')`
   - Line 3: active layer names joined by comma
   - Style: white text on semi-transparent dark background pill, 12px Arial
4. Draw RSAC logo bottom-right: `globalAlpha = 0.35`, size 120×40px, 10px from edges
5. Filename: `sitemap_${city}_${new Date().toISOString().slice(0,10)}_${activeLayers}.png`
6. City name ALWAYS via `formatCityName(city)` — never hardcoded

**EXCEL — 3 scenarios, auto-detect from state:**

Scenario A — `!layerVisibility.network.roads`:
- Sheet: "Zone-Ward Summary"
- Fetch: `/api/city/${city}/zone-summary` and `/api/city/${city}/ward-summary`
- Columns: Zone No, Zone Name, Ward No, Ward Name, Total Roads, Total Length (km)

Scenario B — `layerVisibility.network.roads === true`, no active amenities:
- Sheet: "Road Data"
- Fetch: `/api/road-networks/${city}/details?filter=${roadFilter !== 'INCLUDE' ? roadFilter : ''}&bbox=${mapExtent.join(',')}&limit=99999`
- Columns: road_id, zone_no, zone_name, ward_no, ward_name, ownership, road_name, condition, category, material, yoc, cus_class, row_meter, carriage_w, length_km

Scenario C — roads ON + at least one amenity active in `layerVisibility.amenities`:
- Sheet 1 "Road Data": same as Scenario B
- Sheet 2 "Amenities":
  - Convert mapExtent EPSG:3857 → WGS84 `[south, west, north, east]`
  - For each active amenity id, query Overpass using same `OSM_AMENITY_FILTERS` from MapContainer.jsx
  - Fetch DB amenities: `/api/road-networks/${city}/amenities?type=${id}&bbox=...`
  - Merge results: DB record wins if within 50m Haversine distance of an OSM point
  - Columns: Name, Amenity Type, Road, Ward, Zone, Postcode, Lat, Lng, Source

**PDF:**

Detect heading from `baseFilter`:
```javascript
const getCityHeading = (baseFilter, city) => {
  const fmt = (n) => n.toLowerCase().split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  if (/zone_no/i.test(baseFilter)) {
    const zoneMatch = baseFilter.match(/IN \('?(\d+)'?\)/i);
    return `Sitemap of Zone ${zoneMatch?.[1] || ''} — ${fmt(city)} Nagar Nigam`;
  }
  if (/ward_no/i.test(baseFilter)) {
    const wardMatch = baseFilter.match(/IN \('?(\d+)'?\)/i);
    return `Sitemap of Ward ${wardMatch?.[1] || ''} — ${fmt(city)} Nagar Nigam`;
  }
  return `${fmt(city)} Nagar Nigam — Road Network Sitemap`;
};
```

Page 1: map canvas image, RSAC logo bottom-right 35% opacity, date bottom-left
Page 2+: data table matching Excel scenario above, alternating row colors, page numbers

**Updated function signatures:**
```javascript
captureMapCanvas(mapRef, { legendRef, city, layerVisibility, overlayVisibility, rsacLogo })
exportToExcel({ rows, city, layerVisibility, roadFilter, mapExtent, amenityData })
exportToPDF({ mapRef, rows, city, watermarkSrc, layerVisibility, overlayVisibility, roadFilter, mapExtent, baseFilter, amenityData })
```

Update `handleDownloadAction` in Dashboard.jsx to collect and pass `mapExtent` from state and pass new params.

**Test:** 
- Print → PNG downloads with legend, info box, RSAC watermark visible
- Excel with only zone/ward → Zone-Ward sheet, no roads
- Excel with roads → Road Data sheet with bbox-scoped rows
- Excel with roads + ATM → two sheets
- PDF → correct dynamic heading per active filter

---

### TASK 5 — Table button audit and responsive fixes
**Status:** Pending (do last)
**File:** `client/src/components/Dashboard.jsx`

**Audit each button:**

| Button | Handler | Should be disabled when | Check |
|--------|---------|------------------------|-------|
| Back | `restorePrevTableState()` | `!prevTableStateRef.current && !lastStableStateRef.current` | stale closure on refs |
| Multi | `toggleMultiSelectMode()` | never | state toggle clean |
| Apply | `applyMultiSelection()` | `selectedRoadIds.length === 0` | filter build end-to-end |
| Clear | `clearMultiSelection()` | `selectedRoadIds.length === 0` | state reset complete |
| ▲▼ | `setIsTableMinimized(!isTableMinimized)` | never | CSS `.minimized` class applies |
| × | full close handler | never | ONLY place calling `setTableRows([])` |

**Responsive fixes:**
- All buttons: `minHeight: 44px`, `minWidth: 44px`
- Pagination bar wrapper: `flexWrap: 'wrap'`
- On screens < 768px: abbreviate button labels (Multi→M, Apply→✓, Clear→✕, Back→←)
- Hide "Showing X to Y of Z entries" text on mobile via CSS `@media (max-width: 768px)`
- Keep "Page X of Y" visible always

**Test:** All 6 buttons work on desktop. On mobile viewport all buttons visible and tappable.

---

## SECTION 3 — ABSOLUTE RULES FOR ALL TASKS

Antigravity must follow these in every session without exception.

1. **City is always dynamic** — `city` comes from URL param `?city=lucknow`. Never hardcode any city name. Always use `formatCityName(city)` for display.

2. **Never restart pm2** — `pm2 restart`, `pm2 stop`, `pm2 reload` are forbidden. Use `pm2 reload urida-prod --update-env` only if explicitly told to.

3. **Never run npm install** — package environment is frozen.

4. **Build before deploy** — after any client change: `cd /var/www/urida_prod/client && npm run build`

5. **Return only changed code** — do not rewrite unchanged functions or components.

6. **One task per session** — do not combine tasks. Finish and test one before the next.

7. **Never touch files outside the assigned task** — if MapContainer is not in the task, do not edit it.

8. **Table data is roads only** — amenity data never goes in the road table. They are completely separate.

9. **OSM_AMENITY_FILTERS already exists** in `MapContainer.jsx` — reuse it for export, do not redefine.

10. **`formatCityName` already exists** in `Header.jsx` — import or replicate the same logic, do not create a new version.

---

## SECTION 4 — KEY STATE VARIABLES (Dashboard.jsx)

Quick reference for all tasks — do not rename or restructure these.

| Variable | Type | Purpose |
|----------|------|---------|
| `city` | string | dynamic from URL, always lowercase |
| `baseFilter` | string | primary CQL filter, `"INCLUDE"` = roads on no filter |
| `columnFilters` | object | `{colKey: [values]}` from table dropdowns |
| `roadFilter` | string | computed: baseFilter AND columnFilters |
| `zoomFilter` | string | map animation only, not layer filter |
| `mapExtent` | array | `[minX,minY,maxX,maxY]` EPSG:3857 — TO BE ADDED in Task 2 |
| `tableRows` | array | current road data in table |
| `isTableMinimized` | bool | table collapsed state |
| `shouldFetchTable` | bool | gate for table fetch |
| `layerVisibility` | object | `{amenities:{}, network:{}, others:{}, analysis:{}, roadClassifications:{}}` |
| `overlayVisibility` | object | `{zoneBoundary: bool, wardBoundary: bool}` |
| `selectedRoadId` | any | single selected road |
| `selectedRoadIds` | array | multi-select road ids |
| `isMultiSelectMode` | bool | multi-select active |
| `amenityLegendCounts` | object | counts per amenity type from MapContainer |
| `otherLegendCounts` | object | counts per other type from MapContainer |

---

End of Task Context.