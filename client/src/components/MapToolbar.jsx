/* Map toolbar UI for base maps, overlays, search, query, and road network tools. */
import React, { useState, useEffect, useRef } from "react";
import "../assets/styles/Dashboard.css";
import QueryPanel from "./QueryPanel";
import { useLocation, useNavigate } from "react-router-dom";
import { isChainageAvailable, chainageUnavailableMessage } from "../utils/chainageAvailability";

const MapToolbar = ({
  onDataAnalysis,
  onDssRoad,
  onSearch,
  onQuery,
  onSummary,
  onClear,
  city,
  mapRef,
  onChainageToggle,
  chainageActive,
  chainageDisabled,
  onRoadSelected,
  onApplyRoadFilter, // ⭐ ADDED — this will send filter to MapContainer
  onZoomToFilter, // ⭐ ADDED — this will trigger zoom to filtered features
  onClassificationChange, // ⭐ NEW: Switch active layer (category, condition, etc.)
  showRoadNetworkPanel, // ⭐ ADDED
  onToggleRoadNetworkPanel, // ⭐ ADDED
  baseMap,
  overlayVisibility,
  roadNetworkVisible,
  onBaseMapChange,
  onOverlayToggle,
  onRoadNetworkToggle,
  streetViewVisible,
  onStreetViewToggle,
  onLatLngSearch,
  onPlaceSearch,
  // Field-task deep links (KMC/iGile redirects) restrict the toolbar to
  // just viewing/creating chainage patches — these general-purpose
  // exploration tools aren't part of that scoped workflow.
  restrictedMode = false,
  // The URL's own zone_no, and the ward_no list (target ward + whatever
  // borders it) already resolved in Dashboard — the Road Network panel
  // reuses both instead of ever fetching/loading a full zone or city.
  lockedZone = null,
  lockedWardList = null,
  // The task's own assigned ward specifically — kept separate from
  // lockedWardList because that list's order isn't guaranteed to put the
  // primary ward first (it comes back from /adjacent-wards sorted by ward
  // number, which only coincidentally matches for some assignments).
  primaryWard = null,
}) => {
  const restrictedBtnStyle = restrictedMode
    ? { opacity: 0.45, cursor: "not-allowed" }
    : undefined;
  // const [showRoadFilter, setShowRoadFilter] = useState(false); // REMOVED local state
  const [isLoading, setIsLoading] = useState(false);

  const [showSearchBox, setShowSearchBox] = useState(false);
  const [selectedRoads, setSelectedRoads] = useState({});
  const [roadList, setRoadList] = useState([]);

  const [zones, setZones] = useState([]);
  const [hasZones, setHasZones] = useState(true);

  const [selectedRoad, setSelectedRoad] = useState("null");
  const [nestedList, setNestedList] = useState([]);
  const [nestedTitle, setNestedTitle] = useState("");
  const navigate = useNavigate();

  const [activeTool, setActiveTool] = useState(null);
  const [activeQueryTab, setActiveQueryTab] = useState("attributes");
  const [selectedZone, setSelectedZone] = useState(null);
  const [isAllRoadsSelected, setIsAllRoadsSelected] = useState(false); // ⭐ NEW STATE
  const [contextNode, setContextNode] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const searchTimeoutRef = useRef(null);
  const placeSearchAbortRef = useRef(null);
  const [placeResults, setPlaceResults] = useState([]);
  const [isPlaceLoading, setIsPlaceLoading] = useState(false);
  // const [searchResults, setSearchResults] = useState([]); // REMOVED

  const [roadDropdown, setRoadDropdown] = useState([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const dropdownRef = useRef(null);
  const controlsPanelRef = useRef(null);
  const searchPanelRef = useRef(null);
  const [controlsPanelHeight, setControlsPanelHeight] = useState(0);
  const [searchPanelHeight, setSearchPanelHeight] = useState(0);
  // const [isRoadDropdownOpen, setIsRoadDropdownOpen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(false);

  const cityCode = city?.toLowerCase() || "lucknow";
  const cityLabel = city
    ? `${city.charAt(0).toUpperCase()}${city.slice(1)}`
    : "City";

  const toggleRoadFilter = () => onToggleRoadNetworkPanel((v) => !v);

  useEffect(() => {
    if (!controlsVisible) {
      setControlsPanelHeight(0);
      return;
    }
    const el = controlsPanelRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      setControlsPanelHeight(el.getBoundingClientRect().height || 0);
    });
  }, [controlsVisible, baseMap, overlayVisibility, roadNetworkVisible]);

  useEffect(() => {
    if (!showSearchBox) {
      setSearchPanelHeight(0);
      return;
    }
    const el = searchPanelRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      setSearchPanelHeight(el.getBoundingClientRect().height || 0);
    });
  }, [showSearchBox, roadDropdown.length, placeResults.length, isPlaceLoading, isLoadingMore]);

  const basePanelTop = 10;
  const panelGap = 12;
  const controlsPanelTop = basePanelTop;
  const searchPanelTop = basePanelTop + (controlsVisible ? controlsPanelHeight + panelGap : 0);
  const queryPanelTop =
    basePanelTop +
    (controlsVisible ? controlsPanelHeight + panelGap : 0) +
    (showSearchBox ? searchPanelHeight + panelGap : 0);

  // Field-task mode's "scope" is always zone + (target ward plus whatever
  // borders it) — every restricted-mode load/filter below reuses this
  // instead of ever touching a whole-zone or whole-city query.
  const summaryScopeFilter = () => {
    const zoneNum = lockedZone ? Number(lockedZone) : NaN;
    const wardNums = (lockedWardList || []).map(Number).filter(Number.isFinite);
    const parts = [];
    if (Number.isFinite(zoneNum)) parts.push(`zone_no=${zoneNum}`);
    if (wardNums.length === 1) parts.push(`ward_no=${wardNums[0]}`);
    else if (wardNums.length > 1) parts.push(`ward_no IN (${wardNums.join(",")})`);
    return parts.join(" AND ");
  };

  // Shared by loadCategories/loadCondition/loadMaterial/loadOwnership/
  // loadCus's restricted-mode branch — same shape as each function's own
  // (unmodified) non-restricted path below, just scoped to the locked
  // ward(s) via the generic `filter` param instead of GeoServer's zone-only
  // `zone` param.
  const applyRestrictedSummaryLoad = async (summaryField, title, classificationKey) => {
    onClassificationChange?.(classificationKey);
    const scopeFilter = summaryScopeFilter();
    onApplyRoadFilter?.(scopeFilter);
    try {
      const cityLower = city.toLowerCase();
      const res = await fetch(
        `/api/road-networks/${cityLower}/summary?filter=${encodeURIComponent(scopeFilter)}`
      );
      setNestedTitle(title);
      const summary = await res.json();
      const list = Array.isArray(summary?.[summaryField])
        ? summary[summaryField].filter((r) => (r?.count ?? 0) > 0).map((r) => r.label)
        : [];
      setNestedList(sortNestedList(title, list));
    } catch (err) {
      setNestedList([]);
    }
  };

  const closeRoadFilter = () => {
    onToggleRoadNetworkPanel(false);
    setSelectedZone(null);
    setIsAllRoadsSelected(false);
    setNestedList([]);
    setNestedTitle("");
    if (onApplyRoadFilter) {
      onApplyRoadFilter("");
    }
    // ⭐ Reset classification layer to default (base layer)
    if (onClassificationChange) {
      onClassificationChange(null);
    }
    if (onClear) {
      onClear();
    }
  };

  // GET ZONES
  useEffect(() => {
    const fetchZones = async () => {
      if (!city) {
        console.log("No city selected, skipping zone fetch");
        return;
      }

      const cityLower = city.toLowerCase().trim();
      console.log(`Fetching zones for city: ${cityLower}`);
      setIsLoading(true);

      try {
        const endpoint = `/api/road-networks/${cityLower}`;
        console.log(`Making request to: ${endpoint}`);

        const response = await fetch(endpoint, {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          credentials: "include",
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error("Error response:", errorText);
          setZones([]);
          setHasZones(false);
          return;
        }

        const data = await response.json();

        setZones(data);
        // detect if city actually has usable zones
        const validZones = (Array.isArray(data) ? data : []).filter((z) => {
          const v = String(z?.zone_no ?? "")
            .trim()
            .toLowerCase();
          return v && v !== "na" && v !== "n/a" && v !== "null" && v !== "0" && v !== "0.0";
        });

        setZones(validZones);
        setHasZones(validZones.length > 0);

        // reset selection when city changes
        setSelectedZone(null);
        setNestedList([]);
        setNestedTitle("");
      } catch (err) {
        console.error("Error in fetchZones:", err);
        setZones([]);
        setHasZones(false);
      } finally {
        setIsLoading(false);
      }
    };

    fetchZones();
  }, [city]);

  const handleDataAnalysis = () => {
    if (onDataAnalysis) {
      onDataAnalysis();
    }
  };

  const handleRoadNetworkSelect = (roadType, isChecked) => {
    setSelectedRoads((prev) => ({
      ...prev,
      [roadType]: isChecked,
    }));
  };

  // Field-task mode scopes the search dropdown/results to the locked ward
  // set (target ward + neighbors) instead of the whole city — appended to
  // every /search call below, a no-op string when not in that mode.
  const wardsQueryParam = () => {
    if (!restrictedMode) return "";
    const wardNums = (lockedWardList || []).map(Number).filter(Number.isFinite);
    return wardNums.length ? `&wards=${wardNums.join(",")}` : "";
  };

  const handleSearchClick = async () => {
    setShowSearchBox(true);
    // setIsRoadDropdownOpen(true);
    setPage(1); // Reset page
    setHasMore(true);

    try {
      const res = await fetch(`/api/road-networks/${city.toLowerCase()}/search?page=1&limit=50${wardsQueryParam()}`);
      const data = await res.json();
      const roads = Array.isArray(data) ? data : [];
      setRoadDropdown(roads);
      if (roads.length < 50) setHasMore(false);
      console.log("Road dropdown data:", roads);
    } catch (err) {
      console.error(err);
      setRoadDropdown([]);
    }
  };

  // REMOVED WFS SEARCH FETCH
  // useEffect(() => {
  //   if (!showSearchBox) return;
  //   ...
  // }, [showSearchBox, city]);

  const applySelectedRoad = () => {
    if (!selectedRoad) {
      alert("Please select a road.");
      return;
    }
    if (onRoadSelected) onRoadSelected(selectedRoad);
    setShowSearchBox(false);
  };

  const handleRoadSelectChange = (event) => {
    const road = event.target.value;
    setSelectedRoad(road);
    if (onRoadSelected) onRoadSelected(road);
  };

  const handleSearch = async (query) => {
    // If query is empty, reload default list (page 1)
    if (!query || !query.trim()) {
      handleSearchClick();
      return;
    }

    setPage(1);
    setHasMore(true);

    try {
      const response = await fetch(
        `/api/road-networks/${city.toLowerCase()}/search?q=${encodeURIComponent(
          query
        )}&page=1&limit=50${wardsQueryParam()}`
      );
      if (!response.ok) throw new Error("Search failed");
      const data = await response.json();
      const roads = Array.isArray(data) ? data : [];
      setRoadDropdown(roads);
      if (roads.length < 50) setHasMore(false);
    } catch (error) {
      console.error("Search error:", error);
      setRoadDropdown([]);
    }
  };

  const fetchPlaceSuggestions = async (query) => {
    if (!query || query.trim().length < 3) {
      setPlaceResults([]);
      setIsPlaceLoading(false);
      return;
    }
    if (placeSearchAbortRef.current) {
      placeSearchAbortRef.current.abort();
    }
    const controller = new AbortController();
    placeSearchAbortRef.current = controller;
    setIsPlaceLoading(true);
    const cityHint = city ? ` ${city}` : "";
    try {
      const nominatimUrl =
        `https://nominatim.openstreetmap.org/search` +
        `?format=jsonv2` +
        `&addressdetails=1` +
        `&polygon_geojson=1` +
        `&limit=6` +
        `&countrycodes=in` +
        `&q=${encodeURIComponent(`${query}${cityHint}`)}`;
      const response = await fetch(nominatimUrl, { signal: controller.signal });
      const data = response.ok ? await response.json() : [];
      let results = Array.isArray(data) ? data : [];
      if (!results.length) {
        const photonUrl =
          `https://photon.komoot.io/api/` +
          `?q=${encodeURIComponent(`${query}${cityHint}`)}` +
          `&limit=6` +
          `&lang=en`;
        const photonResponse = await fetch(photonUrl, { signal: controller.signal });
        const photonData = photonResponse.ok ? await photonResponse.json() : null;
        const features = Array.isArray(photonData?.features) ? photonData.features : [];
        const toDisplayName = (props) => {
          const parts = [
            props?.name,
            props?.street,
            props?.city,
            props?.state,
            props?.country,
          ].filter(Boolean);
          if (!parts.length) return "";
          const first = parts[0];
          return [first, ...parts.slice(1).filter((v) => v !== first)].join(", ");
        };
        results = features
          .map((feature, index) => {
            const props = feature?.properties || {};
            const coords = feature?.geometry?.coordinates || [];
            const lon = Number(coords[0]);
            const lat = Number(coords[1]);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
            const extent = Array.isArray(props.extent) && props.extent.length === 4 ? props.extent : null;
            const boundingbox = extent
              ? [extent[1], extent[3], extent[0], extent[2]]
              : null;
            const displayName = toDisplayName(props);
            return {
              place_id: `photon-${props.osm_id ?? index}`,
              osm_type: props.osm_type ?? props.osm_key ?? "photon",
              lat,
              lon,
              display_name: displayName || props.name || props.city || props.state || "Place",
              name: props.name || props.city || props.state || "Place",
              type: props.type || props.osm_value,
              class: props.osm_key,
              address: {
                road: props.street,
                city: props.city,
                state: props.state,
                country: props.country,
                postcode: props.postcode,
              },
              boundingbox,
            };
          })
          .filter(Boolean);
      }
      setPlaceResults(results);
    } catch (err) {
      if (controller.signal.aborted) return;
      setPlaceResults([]);
    } finally {
      if (!controller.signal.aborted) setIsPlaceLoading(false);
    }
  };

  const parseLatLng = (value) => {
    const text = String(value || "").trim().replace(/[()]/g, "");
    if (!text) return null;
    const toDecimal = (deg, min, sec, hem) => {
      const d = Number(deg);
      const m = Number(min || 0);
      const s = Number(sec || 0);
      if (!Number.isFinite(d) || !Number.isFinite(m) || !Number.isFinite(s)) return null;
      const abs = Math.abs(d) + m / 60 + s / 3600;
      const h = String(hem || "").toUpperCase();
      if (h === "S" || h === "W") return -Math.abs(abs);
      if (h === "N" || h === "E") return Math.abs(abs);
      return d < 0 ? -abs : abs;
    };

    const hemiRegex =
      /(-?\d+(?:\.\d+)?)(?:[^0-9+-]+(\d+(?:\.\d+)?))?(?:[^0-9+-]+(\d+(?:\.\d+)?))?\s*([NSEW])/gi;
    const hemiMatches = [];
    let match;
    while ((match = hemiRegex.exec(text))) {
      const valueDec = toDecimal(match[1], match[2], match[3], match[4]);
      if (Number.isFinite(valueDec)) {
        hemiMatches.push({ value: valueDec, hem: match[4].toUpperCase() });
      }
    }
    if (hemiMatches.length >= 2) {
      const latPart =
        hemiMatches.find((p) => p.hem === "N" || p.hem === "S") || hemiMatches[0];
      const lngPart =
        hemiMatches.find((p) => p.hem === "E" || p.hem === "W") || hemiMatches[1];
      const lat = latPart.value;
      const lng = lngPart.value;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
      return { lat, lng };
    }

    const numbers = text.match(/-?\d+(?:\.\d+)?/g) || [];
    if (numbers.length === 2) {
      let lat = Number(numbers[0]);
      let lng = Number(numbers[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      if (Math.abs(lat) > 90 && Math.abs(lng) <= 90) {
        [lat, lng] = [lng, lat];
      }
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
      return { lat, lng };
    }

    if (numbers.length === 4 || numbers.length === 6) {
      const latDeg = numbers[0];
      const latMin = numbers[1];
      const latSec = numbers.length === 6 ? numbers[2] : 0;
      const lngDeg = numbers.length === 6 ? numbers[3] : numbers[2];
      const lngMin = numbers.length === 6 ? numbers[4] : numbers[3];
      const lngSec = numbers.length === 6 ? numbers[5] : 0;
      const lat = toDecimal(latDeg, latMin, latSec, "");
      const lng = toDecimal(lngDeg, lngMin, lngSec, "");
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
      return { lat, lng };
    }

    return null;
  };

  const loadMoreRoads = async () => {
    if (!hasMore || isLoadingMore) return;

    setIsLoadingMore(true);
    const nextPage = page + 1;

    try {
      let url = `/api/road-networks/${city.toLowerCase()}/search?page=${nextPage}&limit=50${wardsQueryParam()}`;
      if (searchQuery && searchQuery.trim() !== "") {
        url += `&q=${encodeURIComponent(searchQuery)}`;
      }

      const res = await fetch(url);
      const data = await res.json();
      const newRoads = Array.isArray(data) ? data : [];

      if (newRoads.length > 0) {
        setRoadDropdown((prev) => [...prev, ...newRoads]);
        setPage(nextPage);
        if (newRoads.length < 50) setHasMore(false);
      } else {
        setHasMore(false);
      }
    } catch (err) {
      console.error("Error loading more roads:", err);
    } finally {
      setIsLoadingMore(false);
    }
  };

  const handleSearchInputChange = (e) => {
    const val = e.target.value;
    setSearchQuery(val);

    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }

    searchTimeoutRef.current = setTimeout(() => {
      if (parseLatLng(val)) {
        setRoadDropdown([]);
        setHasMore(false);
        setPlaceResults([]);
        setIsPlaceLoading(false);
        return;
      }
      if (!parseLatLng(val)) {
        handleSearch(val);
        // A purely numeric query (road IDs in this dataset look like
        // "093400900604") can never match a real place name — skip the
        // external Nominatim/Photon geocoding round trip entirely instead
        // of firing it and throwing away a guaranteed-empty result.
        if (/^\d{4,}$/.test(val.trim())) {
          setPlaceResults([]);
          setIsPlaceLoading(false);
        } else {
          fetchPlaceSuggestions(val);
        }
      }
    }, 300);
  };

  const handlePlaceSelect = (place) => {
    if (!place) return;
    onPlaceSearch?.(place);
    setShowSearchBox(false);
    setSearchQuery("");
  };

  const handleSelectRoad = (road) => {
    setSelectedRoad(road.road_name);
    if (onRoadSelected) onRoadSelected(road);
    setRoadDropdown([]);
    setSearchQuery("");
  };

  const sortNestedList = (title, list) => {
    if (!Array.isArray(list)) return [];
    const normalize = (v) => String(v ?? "").toLowerCase();
    if (title === "Wards") {
      return [...list].sort((a, b) => {
        const aVal =
          typeof a === "object" && a !== null ? a.ward_no ?? a.name : a;
        const bVal =
          typeof b === "object" && b !== null ? b.ward_no ?? b.name : b;
        const aNum = Number(String(aVal).replace(/[^0-9]/g, ""));
        const bNum = Number(String(bVal).replace(/[^0-9]/g, ""));
        if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) {
          return aNum - bNum;
        }
        return normalize(aVal).localeCompare(normalize(bVal));
      });
    }
    return [...list].sort((a, b) => {
      const aLabel =
        typeof a === "object" && a !== null
          ? a.label ?? a.name ?? a.ward_name ?? a.ward_no
          : a;
      const bLabel =
        typeof b === "object" && b !== null
          ? b.label ?? b.name ?? b.ward_name ?? b.ward_no
          : b;
      return normalize(aLabel).localeCompare(normalize(bLabel));
    });
  };

  const loadWards = async () => {
    if (restrictedMode) {
      // The ward list (target + neighbors) is already known from Dashboard's
      // /adjacent-wards lookup — no need to fetch every ward in the zone.
      onClassificationChange?.("zone");
      onApplyRoadFilter?.(summaryScopeFilter());
      setNestedTitle("Wards");
      const list = (lockedWardList || []).map((w) => ({ ward_no: w, name: `Ward ${w}` }));
      setNestedList(sortNestedList("Wards", list));
      return;
    }
    onClassificationChange?.(hasZones && selectedZone?.zone_no ? "zone" : null);
    onApplyRoadFilter?.(hasZones && selectedZone?.zone_no ? `zone_no='${selectedZone.zone_no}'` : "");
    try {
      const cityLower = city.toLowerCase();

      const url =
        hasZones && selectedZone?.zone_no
          ? `/api/road-networks/${cityLower}/wards?zone=${encodeURIComponent(
            selectedZone.zone_no
          )}`
          : `/api/road-networks/${cityLower}/wards`;
      console.log("wards url : " + url.toString());

      setNestedTitle("Wards");
      const res = await fetch(url);
      const data = await res.json();
      const list = Array.isArray(data) ? data : [];
      setNestedList(sortNestedList("Wards", list));
    } catch (err) {
      console.error("Error loading wards:", err);
      setNestedList([]);
    }
  };

  const loadCategories = async () => {
    if (restrictedMode) return applyRestrictedSummaryLoad("byCategory", "Road Category", "category");
    onClassificationChange?.("category");
    onApplyRoadFilter?.(hasZones && selectedZone?.zone_no ? `zone_no='${selectedZone.zone_no}'` : "");
    try {
      const cityLower = city.toLowerCase();
      if (hasZones && selectedZone?.zone_no) {
        const res = await fetch(
          `/api/road-networks/${cityLower}/summary?zone=${encodeURIComponent(
            selectedZone.zone_no
          )}`
        );
        setNestedTitle("Road Category");
        const summary = await res.json();
        const list = Array.isArray(summary?.byCategory)
          ? summary.byCategory
            .filter((r) => (r?.count ?? 0) > 0)
            .map((r) => r.label)
          : [];
        setNestedList(sortNestedList("Road Category", list));
      } else {
        const res = await fetch(`/api/road-networks/${cityLower}/categories`);
        const data = await res.json();
        setNestedTitle("Road Category");
        const list = Array.isArray(data) ? data : [];
        setNestedList(sortNestedList("Road Category", list));
      }
    } catch (err) {
      setNestedList([]);
    }
  };

  const loadCondition = async () => {
    if (restrictedMode) return applyRestrictedSummaryLoad("byCondition", "Road Condition", "condition");
    onClassificationChange?.("condition");
    onApplyRoadFilter?.(hasZones && selectedZone?.zone_no ? `zone_no='${selectedZone.zone_no}'` : "");
    try {
      const cityLower = city.toLowerCase();
      if (hasZones && selectedZone?.zone_no) {
        const res = await fetch(
          `/api/road-networks/${cityLower}/summary?zone=${encodeURIComponent(
            selectedZone.zone_no
          )}`
        );
        setNestedTitle("Road Condition");
        const summary = await res.json();
        const list = Array.isArray(summary?.byCondition)
          ? summary.byCondition
            .filter((r) => (r?.count ?? 0) > 0)
            .map((r) => r.label)
          : [];
        setNestedList(sortNestedList("Road Condition", list));
      } else {
        const res = await fetch(`/api/road-networks/${cityLower}/conditions`);
        const data = await res.json();
        setNestedTitle("Road Condition");
        const list = Array.isArray(data) ? data : [];
        setNestedList(sortNestedList("Road Condition", list));
      }
    } catch (err) {
      setNestedList([]);
    }
  };

  const loadMaterial = async () => {
    if (restrictedMode) return applyRestrictedSummaryLoad("byMaterial", "Road Material", "material");
    onClassificationChange?.("material");
    onApplyRoadFilter?.(hasZones && selectedZone?.zone_no ? `zone_no='${selectedZone.zone_no}'` : "");
    try {
      const cityLower = city.toLowerCase();
      if (hasZones && selectedZone?.zone_no) {
        const res = await fetch(
          `/api/road-networks/${cityLower}/summary?zone=${encodeURIComponent(
            selectedZone.zone_no
          )}`
        );
        setNestedTitle("Road Material");
        const summary = await res.json();
        const list = Array.isArray(summary?.byMaterial)
          ? summary.byMaterial
            .filter((r) => (r?.count ?? 0) > 0)
            .map((r) => r.label)
          : [];
        setNestedList(sortNestedList("Road Material", list));
      } else {
        const res = await fetch(`/api/road-networks/${cityLower}/materials`);
        const data = await res.json();
        setNestedTitle("Road Material");
        const list = Array.isArray(data) ? data : [];
        setNestedList(sortNestedList("Road Material", list));
      }
    } catch (err) {
      setNestedList([]);
    }
  };

  const loadOwnership = async () => {
    if (restrictedMode) return applyRestrictedSummaryLoad("byOwnership", "Road Ownership", "ownership");
    onClassificationChange?.("ownership");
    onApplyRoadFilter?.(hasZones && selectedZone?.zone_no ? `zone_no='${selectedZone.zone_no}'` : "");
    try {
      const cityLower = city.toLowerCase();
      if (hasZones && selectedZone?.zone_no) {
        const res = await fetch(
          `/api/road-networks/${cityLower}/summary?zone=${encodeURIComponent(
            selectedZone.zone_no
          )}`
        );
        setNestedTitle("Road Ownership");
        const summary = await res.json();
        const list = Array.isArray(summary?.byOwnership)
          ? summary.byOwnership
            .filter((r) => (r?.count ?? 0) > 0)
            .map((r) => r.label)
          : [];
        setNestedList(sortNestedList("Road Ownership", list));
      } else {
        const res = await fetch(`/api/road-networks/${cityLower}/ownership`);
        const data = await res.json();
        setNestedTitle("Road Ownership");
        const list = Array.isArray(data) ? data : [];
        setNestedList(sortNestedList("Road Ownership", list));
      }
    } catch (err) {
      setNestedList([]);
    }
  };

  const loadCus = async () => {
    if (restrictedMode) return applyRestrictedSummaryLoad("byCus", "Road CUS Class", "cus");
    onClassificationChange?.("cus");
    onApplyRoadFilter?.(hasZones && selectedZone?.zone_no ? `zone_no='${selectedZone.zone_no}'` : "");
    try {
      const cityLower = city.toLowerCase();
      if (hasZones && selectedZone?.zone_no) {
        const res = await fetch(
          `/api/road-networks/${cityLower}/summary?zone=${encodeURIComponent(
            selectedZone.zone_no
          )}`
        );
        setNestedTitle("Road CUS Class");
        const summary = await res.json();
        const list = Array.isArray(summary?.byCus)
          ? summary.byCus
            .filter((r) => (r?.count ?? 0) > 0)
            .map((r) => r.label)
          : [];
        setNestedList(sortNestedList("Road CUS Class", list));
      } else {
        const res = await fetch(`/api/road-networks/${cityLower}/cus`);
        const data = await res.json();
        setNestedTitle("Road CUS Class");
        const list = Array.isArray(data) ? data : [];
        setNestedList(sortNestedList("Road CUS Class", list));
      }
    } catch (err) {
      setNestedList([]);
    }
  };

  // ⭐ ADDED — APPLY FILTER WHEN CLICKING ANY ITEM IN PANEL 3
  const applyFilter = (item) => {
    if (!nestedTitle) return;

    let filter = ""; // ✅ declare ONCE at top

    if (nestedTitle === "Wards") {
      let val = item;
      if (typeof item === "object" && item !== null) {
        val = item.ward_no;
      }
      const wardNum = String(val).replace(/[^0-9]/g, "");
      filter = `ward_no='${wardNum}'`;
    } else if (nestedTitle === "Road Category") {
      filter = `category='${item}'`;
    } else if (nestedTitle === "Road Condition") {
      filter = `condition='${item}'`;
    } else if (nestedTitle === "Road Material") {
      filter = `material='${item}'`;
    } else if (nestedTitle === "Road Ownership") {
      filter = `ownership='${item}'`;
    } else if (nestedTitle === "Road CUS Class") {
      filter = `cus_class='${item}'`;
    }

    if (restrictedMode) {
      // Picking one specific ward scopes down to just that ward (same as
      // normal-dashboard behavior); every other nested list (Category,
      // Condition, ...) stays scoped to the full locked ward set rather
      // than widening back out to the whole zone.
      if (nestedTitle === "Wards") {
        const zoneNum = lockedZone ? Number(lockedZone) : NaN;
        if (Number.isFinite(zoneNum)) filter = `zone_no=${zoneNum} AND ${filter}`;
      } else {
        const scopeFilter = summaryScopeFilter();
        if (scopeFilter) filter = `${scopeFilter} AND ${filter}`;
      }
    } else if (hasZones && selectedZone?.zone_no) {
      // ✅ ONLY add zone filter if city actually has zones
      filter = `zone_no='${selectedZone.zone_no}' AND ${filter}`;
    }
    console.log("Applying filter:", filter);
    // if (onApplyRoadFilter) {
    //   onApplyRoadFilter(filter);
    //   // ⭐ ADDED: Also trigger zoom for road network selections
    //   if (onZoomToFilter) {
    //     onZoomToFilter(filter);
    //   }
    // }
    onApplyRoadFilter?.(filter);
    onZoomToFilter?.(filter);
  };

  // Apply zone filter as soon as a zone is selected
  const handleZoneClick = (zone) => {
    // ✅ IMPORTANT: selectedZone set karna mandatory hai (warna submenu render hi nahi hota)
    setSelectedZone(zone);
    setIsAllRoadsSelected(false);
    setNestedList([]);
    setNestedTitle("");
    onClassificationChange?.("zone"); // Switch to Zone classification layer

    if (restrictedMode) {
      // Opening the zone submenu must never load that zone's full road set —
      // apply the locked ward-scoped filter instead of the bare zone filter
      // a normal-dashboard click would use.
      const scopeFilter = summaryScopeFilter();
      onApplyRoadFilter?.(scopeFilter);
      onZoomToFilter?.(scopeFilter);
      return;
    }

    // ✅ Only apply zone filter when city actually has zones
    if (hasZones && zone?.zone_no) {
      const zoneFilter = `zone_no='${zone.zone_no}'`;
      onApplyRoadFilter?.(zoneFilter);
      onZoomToFilter?.(zoneFilter);
    }
  };

  return (
    <>
      {/* Left Toolbar */}
      <div className="map-toolbar left-toolbar">
        <button
          className={`map-btn wide-btn${restrictedMode ? " restricted-hide-mobile" : ""}`}
          disabled={restrictedMode}
          style={restrictedBtnStyle}
          onClick={() => !restrictedMode && onStreetViewToggle?.(!streetViewVisible)}
        >
          <i className="fas fa-street-view" /> <span>Street View</span>
        </button>

        <button className="map-btn wide-btn" onClick={toggleRoadFilter}>
          <i className="fas fa-road" /> <span>Road Network</span>
        </button>

        <button
          className={`map-btn wide-btn${restrictedMode ? " restricted-hide-mobile" : ""}`}
          disabled={restrictedMode}
          style={restrictedBtnStyle}
          onClick={() => !restrictedMode && handleDataAnalysis()}
        >
          <i className="fas fa-chart-column" /> <span>Data Analysis</span>
        </button>

        <button
          className={`map-btn wide-btn${restrictedMode ? " restricted-hide-mobile" : ""}`}
          disabled={restrictedMode}
          style={restrictedBtnStyle}
          onClick={() => !restrictedMode && onDssRoad?.()}
        >
          <i className="fas fa-sitemap" /> <span>DSS</span>
        </button>
         {/* chainage — "Patch Creation / View Chainage": grayed out (but still
             clickable, so it can explain why) until some road layer is
             visible on the map, since chainage needs a road to click. */}
              <button
            className={`map-btn wide-btn${chainageActive ? " active" : ""}${
              !chainageActive && chainageDisabled ? " map-btn--disabled-look" : ""
            }`}
              onClick={() => {
                if (!isChainageAvailable(city)) {
                  if (mapRef?.current?.showFeatureNotice) {
                    mapRef.current.showFeatureNotice({
                      feature: "Chainage",
                      message: chainageUnavailableMessage(city),
                      dedupeKey: `${city}|chainage-unavailable`,
                    });
                  } else {
                    window.alert(chainageUnavailableMessage(city));
                  }
                  return;
                }
                if (onChainageToggle) {
                  onChainageToggle();
                } else {
                  // Fallback for any context without an in-place toggle handler.
                  navigate(`/chainage?city=${city?.toLowerCase()}&mode=CHAINAGE`);
                }
              }}
              title={
                chainageActive
                  ? "Exit Patch Creation / View Chainage (select a road on the map)"
                  : chainageDisabled
                    ? "Patch Creation / View Chainage — open a road layer first"
                    : "Patch Creation / View Chainage"
              }
            >
            🔗
          </button>

      </div>

      {/* Right Toolbar */}
      <div className="map-toolbar right-toolbar">
        <div style={{ position: "relative" }}>
          <button
            className="map-btn"
            onClick={() => {
              setControlsVisible((v) => {
                const next = !v;
                if (next) {
                  setShowSearchBox(false);
                  setActiveTool(null);
                }
                return next;
              });
            }}
            title="Switch Basemap"
          >
            <i className="fas fa-layer-group" />
          </button>
          {controlsVisible && (
            <div className="controls-panel" ref={controlsPanelRef} style={{ top: `${controlsPanelTop}px` }}>
              <h4 style={{ margin: "0 0 10px 0", fontSize: "14px", borderBottom: "1px solid #eee", paddingBottom: "5px" }}>
                <i className="fas fa-map" style={{ color: "#3b82f6", marginRight: 6 }} />
                Base Maps
              </h4>
              <div className="basemap-card-grid">
                {[
                  { value: "osm", label: "OSM", icon: "fas fa-map", color: "#e8f5e9" },
                  { value: "satellite", label: "Satellite", icon: "fas fa-satellite", color: "#e3f2fd" },
                  { value: "positron", label: "Positron", icon: "fas fa-circle", color: "#fce4ec" },
                  { value: "topo", label: "Topo", icon: "fas fa-mountain", color: "#fff3e0" },
                  { value: "toner", label: "Toner", icon: "fas fa-adjust", color: "#f3e5f5" },
                ].map(({ value, label, icon, color }) => (
                  <button
                    key={value}
                    className={`basemap-card ${baseMap === value ? "basemap-card--active" : ""}`}
                    style={{ "--bm-color": color }}
                    onClick={() => onBaseMapChange?.(value)}
                  >
                    <span className="basemap-card__icon"><i className={icon} /></span>
                    <span className="basemap-card__label">{label}</span>
                    {baseMap === value && <span className="basemap-card__check"><i className="fas fa-check-circle" /></span>}
                  </button>
                ))}
              </div>

              <div className="controls-panel-divider" />
              <h4 style={{ margin: "10px 0 10px 0", fontSize: "14px", borderBottom: "1px solid #eee", paddingBottom: "5px" }}>
                Overlay Layers
              </h4>
              <div className="layer-controls">
                {[
                  { key: "zoneBoundary", label: "Zone Boundary", checked: !!overlayVisibility?.zoneBoundary, onToggle: () => onOverlayToggle?.("zoneBoundary") },
                  { key: "wardBoundary", label: "Ward Boundary", checked: !!overlayVisibility?.wardBoundary, onToggle: () => onOverlayToggle?.("wardBoundary") },
                  { key: "roadNetwork", label: "Road Network", checked: !!roadNetworkVisible, onToggle: () => onRoadNetworkToggle?.(!roadNetworkVisible) },
                ].map(({ key, label, checked, onToggle }) => (
                  <label key={key} className="layer-toggle-row">
                    <span className="layer-toggle-label">{label}</span>
                    <span
                      className={`layer-toggle-switch ${checked ? "layer-toggle-switch--on" : ""}`}
                      onClick={onToggle}
                      role="switch"
                      aria-checked={checked}
                    >
                      <span className="layer-toggle-knob" />
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* SEARCH BUTTON WITH FLYOUT DROPDOWN — in field-task mode this stays
            usable but scoped: its preloaded list and search results are
            restricted to the locked ward set via the `wards` param below,
            and searching also matches road_id (a field worker is more
            likely to have a road number than a name) so this reuses the
            already-optimized search flow rather than being hidden. */}
        <div style={{ position: "relative" }}>
          {/* THE SEARCH BOX (FLYOUT TO LEFT) */}
          {showSearchBox && (
            <div
              ref={searchPanelRef}
              style={{
                position: "absolute",
                right: "100%",
                top: `${searchPanelTop}px`,
                marginRight: "10px",
                width: "300px",
                backgroundColor: "white",
                borderRadius: "4px",
                boxShadow: "0 2px 10px rgba(0,0,0,0.2)",
                zIndex: 2000
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  borderBottom: "1px solid #eee",
                  padding: "5px 10px",
                  height: "38px"
                }}
              >
                <input
                  type="text"
                  placeholder="Search Road or Lat,Lng"
                  value={searchQuery}
                  autoFocus // Auto focus when opened
                  onChange={handleSearchInputChange}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    const candidate = parseLatLng(searchQuery);
                    if (candidate && onLatLngSearch) {
                      onLatLngSearch(candidate);
                      setShowSearchBox(false);
                      setSearchQuery("");
                    }
                  }}
                  style={{
                    border: "none",
                    outline: "none",
                    width: "100%",
                    fontSize: "14px",
                    color: "#333",
                    paddingLeft: "4px"
                  }}
                />
                <i
                  className="fas fa-times"
                  style={{ color: "#999", cursor: "pointer", padding: "5px" }}
                  onClick={() => {
                    setSearchQuery("");
                    setShowSearchBox(false); // Close on X
                    // setIsRoadDropdownOpen(false);
                  }}
                />
              </div>

              {/* DROPDOWN LIST */}
              <div
                style={{
                  maxHeight: "300px",
                  overflowY: "auto",
                  backgroundColor: "#fff",
                  borderRadius: "0 0 4px 4px",
                }}
                onScroll={(e) => {
                  const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;
                  if (scrollHeight - scrollTop <= clientHeight + 50) {
                    loadMoreRoads();
                  }
                }}
              >
                {(() => {
                  const candidate = parseLatLng(searchQuery);
                  if (!candidate) return null;
                  return (
                    <div
                      onClick={() => {
                        onLatLngSearch?.(candidate);
                        setShowSearchBox(false);
                        setSearchQuery("");
                      }}
                      style={{
                        padding: "10px 12px",
                        cursor: "pointer",
                        borderBottom: "1px solid #eee",
                        backgroundColor: "#fff",
                        fontSize: "14px",
                        color: "#333",
                        display: "flex",
                        justifyContent: "space-between",
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "#f0f7ff")}
                      onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "#fff")}
                    >
                      <span style={{ fontWeight: 600 }}>
                        Go to {candidate.lat.toFixed(6)}, {candidate.lng.toFixed(6)}
                      </span>
                      <span style={{ color: "#888", fontSize: "12px" }}>Lat/Lng</span>
                    </div>
                  );
                })()}
                {placeResults.length > 0 && (
                  <div>
                    <div style={{ padding: "8px 12px", fontSize: "12px", color: "#666" }}>Places</div>
                    {placeResults.map((place) => (
                      <div
                        key={`${place.place_id}-${place.osm_type}`}
                        onClick={() => handlePlaceSelect(place)}
                        style={{
                          padding: "10px 12px",
                          cursor: "pointer",
                          borderBottom: "1px solid #eee",
                          backgroundColor: "#fff",
                          fontSize: "14px",
                          color: "#333",
                          display: "flex",
                          justifyContent: "space-between"
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "#f0f7ff")}
                        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "#fff")}
                      >
                        <span style={{ fontWeight: 500 }}>{place.display_name}</span>
                      </div>
                    ))}
                  </div>
                )}
                {isPlaceLoading && (
                  <div style={{ padding: "10px 12px", color: "#666", fontSize: "12px" }}>
                    Searching places...
                  </div>
                )}
                {roadDropdown.length > 0 ? (
                  <>
                    {roadDropdown.map((road, i) => (
                      <div
                        key={i}
                        onClick={() => {
                          const gisId = road.gis_id;
                          if (gisId) {
                            onApplyRoadFilter?.(`gis_id='${gisId}'`);
                            onZoomToFilter?.(`gis_id='${gisId}'`);
                          }
                          // Close after selection
                          setShowSearchBox(false);
                          // setIsRoadDropdownOpen(false);
                          setSearchQuery("");
                        }}
                        style={{
                          padding: "10px 12px",
                          cursor: "pointer",
                          borderBottom: "1px solid #eee",
                          backgroundColor: "#fff",
                          fontSize: "14px",
                          color: "#333",
                          display: "flex",
                          justifyContent: "space-between"
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "#f0f7ff")}
                        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "#fff")}
                      >
                        <span style={{ fontWeight: 500 }}>
                          {road.road_name || "Unnamed Road"}
                        </span>
                        {road.ward_name && (
                          <span style={{ color: "#888", fontSize: "12px" }}>
                            {road.ward_name}
                          </span>
                        )}
                      </div>
                    ))}
                    {hasMore && (
                      <div style={{ padding: "10px", textAlign: "center", color: "#666", fontSize: "12px" }}>
                        {isLoadingMore ? "Loading more..." : "Scroll for more"}
                      </div>
                    )}
                  </>
                ) : (() => {
                  const candidate = parseLatLng(searchQuery);
                  const showNoResults =
                    searchQuery && !candidate && placeResults.length === 0 && !isPlaceLoading;
                  if (!showNoResults) return null;
                  return (
                    <div style={{ padding: "15px", textAlign: "center", color: "#666", fontSize: "14px" }}>
                      No results found
                    </div>
                  );
                })()}
              </div>
            </div>
          )}

          {/* THE BUTTON */}
          <button
            className="map-btn wide-btn right-btn"
            onClick={() => {
              // Toggle search box
              if (!showSearchBox) {
                handleSearchClick(); // Load data
                setShowSearchBox(true);
                setControlsVisible(false);
                setActiveTool(null);
              } else {
                setShowSearchBox(false);
              }
            }}
          >
            <i className="fas fa-search" />
            <span>Search</span>
          </button>
        </div>

        <button
          className={`map-btn wide-btn right-btn${restrictedMode ? " restricted-hide-mobile" : ""}`}
          disabled={restrictedMode}
          style={restrictedBtnStyle}
          onClick={() => {
            if (restrictedMode) return;
            setActiveTool("query");
            setShowSearchBox(false);
            setControlsVisible(false);
          }}
        >
          <span>Query</span> <i className="fas fa-filter" />
        </button>

        <button
          className={`map-btn wide-btn right-btn${restrictedMode ? " restricted-hide-mobile" : ""}`}
          disabled={restrictedMode}
          style={restrictedBtnStyle}
          onClick={() => !restrictedMode && onSummary?.()}
        >
          <span>Summary</span> <i className="fas fa-table" />
        </button>

        <button className="map-btn wide-btn right-btn" onClick={onClear}>
          <span>Clear</span> <i className="fas fa-trash" />
        </button>
      </div>

      {/* REMOVED OLD SEARCH PANEL */}

      {/* QUERY PANEL */}
      {activeTool === "query" && (
        <QueryPanel
          city={city}
          onClose={() => setActiveTool(null)}
          onQuery={(queryData) => {
            console.log("Query Data:", queryData);
            if (onQuery) onQuery(queryData);
          }}
          onClear={onClear}
          topOffset={queryPanelTop}
        />
      )}

      {/* ROAD NETWORK PANEL */}
      {/* ROAD NETWORK PANEL */}
      {showRoadNetworkPanel && (
        <div className="modern-panel">
          <div className="panel-header">
            <span>Road Network</span>
            <button className="close-btn" onClick={closeRoadFilter}>
              ×
            </button>
          </div>

          {/* Field-task users can't tell from the menu alone whether "Zone
              2" here means the whole zone or just their assigned ward — it's
              always the latter (ward + bordering wards), but that needs to
              be stated plainly rather than inferred from the zone/ward
              numbers already visible on the map. */}
          {restrictedMode && (
            <div className="road-network-scope-banner">
              Showing roads for Zone {lockedZone}, Ward {primaryWard || "—"}
              {(() => {
                const others = (lockedWardList || [])
                  .map(String)
                  .filter((w) => w !== String(primaryWard));
                return others.length ? ` + adjacent wards (${others.join(", ")})` : "";
              })()}
            </div>
          )}

          {/* LEVEL 1 */}
          <ul className="menu-list">
            {!restrictedMode && (
              <li
                className="menu-item"
                onClick={() => {
                  setSelectedZone(null);
                  setIsAllRoadsSelected(true);
                  setNestedList([]);
                  setNestedTitle("");
                  onApplyRoadFilter?.("INCLUDE");
                  onClassificationChange?.(null); // Reset to base layer
                }}
              >
                {cityLabel} All Roads »
              </li>
            )}

            {/* ZONE CITIES — field-task mode only ever shows the URL's own
                zone; there's nothing useful a different zone could do here
                since the whole page is locked to one ward's task anyway. */}
            {/* ZONE CITIES */}
            {hasZones &&
              (isLoading ? (
                <li className="menu-item">Loading zones...</li>
              ) : (
                (restrictedMode
                  ? zones.filter((z) => String(z.zone_no) === String(lockedZone))
                  : zones
                ).map((zone, index) => (
                  <li
                    key={index}
                    className="menu-item"
                    onClick={() => handleZoneClick(zone)}
                  >
                    {zone.name} »
                  </li>
                ))
              ))}
          </ul>

          {/* LEVEL 2 + 3 — COMMON (ZONE + NO-ZONE) */}
          {/* LEVEL 2 + 3 — COMMON (ZONE + NO-ZONE + ALL ROADS) */}
          {(hasZones ? (!!selectedZone || isAllRoadsSelected) : true) && (
            <div className="submenu-column">
              <div className="modern-submenu">
                <div className="submenu-header">
                  {hasZones
                    ? (selectedZone?.name || (isAllRoadsSelected ? "All Roads" : "Road Network"))
                    : "Road Network"}
                </div>

                <ul className="submenu-list">
                  <li onClick={loadWards}>Wards »</li>
                  <li onClick={loadCategories}>Road Category »</li>
                  <li onClick={loadCondition}>Road Condition »</li>
                  <li onClick={loadMaterial}>Road Material »</li>
                  <li onClick={loadOwnership}>Road Ownership »</li>
                  <li onClick={loadCus}>Road CUS »</li>
                </ul>
              </div>

              {nestedList.length > 0 && (
                <div className="modern-submenu nested-list">
                  <div className="submenu-header">{nestedTitle}</div>
                  <ul className="submenu-list">
                    {nestedList.map((item, i) => (
                      <li key={i} onClick={() => applyFilter(item)}>
                        {typeof item === "object" && item !== null
                          ? (nestedTitle === "Wards" ? (item.name || `Ward No. ${item.ward_no}`) : (item.name || item.ward_name || item.ward_no || item.label || item))
                          : item}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
};

export default MapToolbar;
