import React, { useCallback, useMemo } from "react";
import { cityConfig } from "../assets/configs/cityConfig";

const formatLabel = (value) =>
  String(value || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

const normalizeLayerName = (value) => String(value || "").replace(/\s*:\s*/g, ":").trim();

const DrainFilter = ({
  city,
  layerVisibility,
  setLayerVisibility,
  tableDataset,
  setIsLoading,
  setSelectedRoadId,
  setSelectedRoadIds,
  setIsMultiSelectMode,
  setSelectedRoad,
  setActiveFilterColumn,
  setFilterPosition,
  setColumnFilters,
  setSpecializedColumnFilters,
  setSpecializedAllRows,
  setTableRows,
  setGlobalTableMetrics,
  setCurrentPage,
  setTableDataset,
  setShouldFetchTable,
  setIsTableMinimized,
}) => {
  const cityKey = String(city || "").toLowerCase();
  const cfg = cityConfig[cityKey] || {};
  const specCfg = cfg.specializedNetworks?.drainage;
  const isGroup = specCfg && typeof specCfg === "object" && specCfg.options;
  const isChecked = !!layerVisibility?.network?.drainage;
  const activeOptionRaw = layerVisibility?.specializedOptions?.drainage;
  const effectiveOption =
    activeOptionRaw === undefined || activeOptionRaw === null ? "none" : activeOptionRaw;
  const columnOrder = useMemo(
    () => [
      "zone_name",
      "length",
      "zone_no",
      "ward_name",
      "ward_no",
      "status",
      "ownership",
      "type",
      "const_year",
      "condition",
      "material",
      "depth",
      "width",
    ],
    []
  );
  const columnLabelMap = useMemo(
    () => ({
      zone_name: "Zone Name",
      length: "Length",
      zone_no: "Zone No.",
      ward_name: "Ward Name",
      ward_no: "Ward No",
      status: "Status",
      ownership: "Ownership",
      type: "Type",
      const_year: "Const Year",
      condition: "Condition",
      material: "Material",
      depth: "Depth",
      width: "Width",
    }),
    []
  );

  const resetTableStateForSpecialized = useCallback(() => {
    setSelectedRoadId(null);
    setSelectedRoadIds([]);
    setIsMultiSelectMode(false);
    setSelectedRoad("");
    setActiveFilterColumn(null);
    setFilterPosition(null);
    setColumnFilters({});
    setSpecializedColumnFilters({});
    setSpecializedAllRows([]);
    setTableRows([]);
    setGlobalTableMetrics({ total_roads: 0, total_length_km: 0 });
    setCurrentPage(1);
    setShouldFetchTable(true);
    setIsTableMinimized(false);
  }, [
    setActiveFilterColumn,
    setColumnFilters,
    setCurrentPage,
    setFilterPosition,
    setGlobalTableMetrics,
    setIsMultiSelectMode,
    setIsTableMinimized,
    setSelectedRoad,
    setSelectedRoadId,
    setSelectedRoadIds,
    setShouldFetchTable,
    setSpecializedAllRows,
    setSpecializedColumnFilters,
    setTableRows,
  ]);

  const closeDrainageTableIfOpen = useCallback(() => {
    if (tableDataset?.kind === "specialized" && tableDataset?.networkId === "drainage") {
      setSpecializedColumnFilters({});
      setSpecializedAllRows([]);
      setTableRows([]);
      setCurrentPage(1);
      setTableDataset({ kind: "roads", title: "Road Network", networkId: null, option: null, layerName: null });
    }
  }, [
    setCurrentPage,
    setSpecializedAllRows,
    setSpecializedColumnFilters,
    setTableDataset,
    setTableRows,
    tableDataset?.kind,
    tableDataset?.networkId,
  ]);

  const loadDrainageNetworkTable = useCallback(
    async (optionKey) => {
      if (!isGroup) return;
      if (!optionKey || String(optionKey) === "none") {
        closeDrainageTableIfOpen();
        return;
      }
      const opt = specCfg.options?.[optionKey];
      const layerName = normalizeLayerName(typeof opt === "string" ? opt : (opt?.layer || ""));
      const optLabel = typeof opt === "string" ? optionKey : (opt?.label || optionKey);
      if (!layerName) return;

      resetTableStateForSpecialized();
      setTableDataset({
        kind: "specialized",
        title: `${specCfg.label || "Drainage Network"} (${optLabel})`,
        networkId: "drainage",
        option: optionKey,
        layerName,
        columns: null,
        columnOrder,
        columnLabelMap,
      });

      setIsLoading(true);
      try {
        const url = `/api/road-networks/${cityKey}/specialized-details?network=${encodeURIComponent(
          "drainage"
        )}&option=${encodeURIComponent(optionKey)}&layer=${encodeURIComponent(layerName)}&page=1&limit=2000`;
        const res = await fetch(url);
        const payload = await res.json();
        if (!res.ok) throw new Error(payload?.error || `HTTP ${res.status}`);

        const rows = payload?.data || [];
        setTableDataset({
          kind: "specialized",
          title: `${specCfg.label || "Drainage Network"} (${optLabel})`,
          networkId: "drainage",
          option: optionKey,
          layerName,
          columns: payload?.columns || null,
          columnOrder,
          columnLabelMap,
        });
        setSpecializedAllRows(rows);
        setTableRows(rows);
        setGlobalTableMetrics({ total_roads: payload?.total || rows.length, total_length_km: 0 });
        setCurrentPage(1);
        setShouldFetchTable(true);
        setIsTableMinimized(false);
      } catch (err) {
        console.error("Drainage table load error:", err);
      } finally {
        setIsLoading(false);
      }
    },
    [
      cityKey,
      columnLabelMap,
      columnOrder,
      closeDrainageTableIfOpen,
      isGroup,
      resetTableStateForSpecialized,
      setCurrentPage,
      setGlobalTableMetrics,
      setIsLoading,
      setIsTableMinimized,
      setShouldFetchTable,
      setSpecializedAllRows,
      setTableDataset,
      setTableRows,
      specCfg?.label,
      specCfg?.options,
    ]
  );

  const setDrainageChecked = useCallback(
    (checked) => {
      setLayerVisibility?.((prev) => {
        const next = { ...prev };
        next.network = { ...(prev.network || {}), drainage: checked };
        const current = { ...(prev.specializedOptions || {}) };
        if (checked) {
          if (current.drainage === undefined || current.drainage === null) {
            current.drainage = "none";
          }
          next.specializedOptions = current;
        } else {
          delete current.drainage;
          next.specializedOptions = current;
        }
        return next;
      });

      if (!checked) {
        loadDrainageNetworkTable("none");
      }
    },
    [loadDrainageNetworkTable, setLayerVisibility]
  );

  const setDrainageOption = useCallback(
    (optionKey) => {
      setLayerVisibility?.((prev) => {
        const next = { ...prev };
        next.network = { ...(prev.network || {}), drainage: true };
        next.specializedOptions = { ...(prev.specializedOptions || {}), drainage: optionKey };
        return next;
      });
      loadDrainageNetworkTable(optionKey);
    },
    [loadDrainageNetworkTable, setLayerVisibility]
  );

  if (!specCfg) return null;

  return (
    <div className="specialized-network-item">
      <label className="sidebar-checkable">
        <input
          type="checkbox"
          checked={isChecked}
          onChange={(e) => setDrainageChecked(e.target.checked)}
        />
        <i className="icon fa-solid fa-faucet"></i>
        <span className="text">{specCfg.label || formatLabel("drainage")}</span>
      </label>

      {isGroup && isChecked && (
        <div className="sub-options-radio">
          <label key="none">
            <input
              type="radio"
              name="specialized-drainage"
              checked={String(effectiveOption) === "none"}
              onChange={() => setDrainageOption("none")}
            />
            <i className="icon fa-solid fa-ban"></i>
            <span className="text">None</span>
          </label>
          {Object.entries(specCfg.options || {}).map(([optKey, optCfg]) => (
            <label key={optKey}>
              <input
                type="radio"
                name="specialized-drainage"
                checked={String(effectiveOption) === String(optKey)}
                onChange={() => setDrainageOption(optKey)}
              />
              <i className="icon fa-solid fa-layer-group"></i>
              <span className="text">
                {typeof optCfg === "string" ? formatLabel(optKey) : (optCfg?.label || formatLabel(optKey))}
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
};

export default DrainFilter;
