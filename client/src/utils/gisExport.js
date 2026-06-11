/**
 * gisExport.js
 * Professional GIS map export utilities for URIDA portal.
 * Produces publication-quality PDF (map layout + table), Excel, and KML.
 */
import html2canvas from "html2canvas";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import * as XLSX from "xlsx";
import { saveAs } from "file-saver";

// ─── Clean export columns (no gid, no system fields) ────────────────────────
export const EXPORT_COLUMNS = [
  { label: "Road ID",          key: "road_id"   },
  { label: "Road Name",        key: "road_name" },
  { label: "Zone",             key: "zone_no"   },
  { label: "Zone Name",        key: "zone_name" },
  { label: "Ward",             key: "ward_no"   },
  { label: "Ward Name",        key: "ward_name" },
  { label: "Ownership",        key: "ownership" },
  { label: "Condition",        key: "condition" },
  { label: "Category",         key: "category"  },
  { label: "Material",         key: "material"  },
  { label: "Year of Const.",   key: "yoc"       },
  { label: "Scheme",           key: "cus_class" },
  { label: "RoW (m)",          key: "row_meter" },
  { label: "Carriage Way (m)", key: "carriage_w"},
  { label: "Length (km)",      key: "length_km" },
];

// ─── Numeric fields that should be formatted to 2 decimal places ─────────────
const NUMERIC_KEYS = ["row_meter", "carriage_w", "length_km"];

// ─── Escape XML special characters for KML ───────────────────────────────────
const escapeXml = (unsafe) => {
  if (unsafe === null || unsafe === undefined) return "";
  return String(unsafe).replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case "<":  return "&lt;";
      case ">":  return "&gt;";
      case "&":  return "&amp;";
      case "'":  return "&apos;";
      case '"':  return "&quot;";
      default:   return c;
    }
  });
};

/**
 * Format a row's value for display (numeric rounding etc.)
 */
const formatVal = (key, val) => {
  if (val === null || val === undefined) return "";
  if (NUMERIC_KEYS.includes(key)) {
    const n = Number(val);
    return Number.isFinite(n) ? n.toFixed(2) : String(val);
  }
  return String(val);
};

/**
 * Clean a row to only the EXPORT_COLUMNS fields.
 */
const cleanRow = (row) => {
  const out = {};
  EXPORT_COLUMNS.forEach(({ key }) => {
    out[key] = formatVal(key, row[key]);
  });
  return out;
};

/**
 * Clean a row for Excel export — preserves raw numeric values for full precision.
 */
const cleanRowForExcel = (row) => {
  const out = {};
  EXPORT_COLUMNS.forEach(({ key }) => {
    const val = row[key];
    if (val === null || val === undefined) {
      out[key] = "";
    } else if (NUMERIC_KEYS.includes(key)) {
      const n = Number(val);
      out[key] = Number.isFinite(n) ? n : val;
    } else {
      out[key] = val;
    }
  });
  return out;
};

// ─── North arrow SVG (base64) ─────────────────────────────────────────────────
const NORTH_ARROW_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="64" viewBox="0 0 48 64">
  <defs>
    <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-color="rgba(0,0,0,0.4)"/>
    </filter>
  </defs>
  <!-- Arrow shaft -->
  <polygon points="24,4 28,52 24,46 20,52" fill="#1a1a2e" filter="url(#shadow)"/>
  <!-- North cap (red) -->
  <polygon points="24,4 30,26 24,22 18,26" fill="#e63946"/>
  <!-- South cap (white) -->
  <polygon points="24,46 30,26 24,22 18,26" fill="#f1faee" stroke="#aaa" stroke-width="0.5"/>
  <!-- N label -->
  <text x="24" y="62" text-anchor="middle" font-family="Arial" font-size="11" font-weight="bold" fill="#1a1a2e">N</text>
</svg>`;

const northArrowDataUrl = `data:image/svg+xml;base64,${btoa(NORTH_ARROW_SVG)}`;

// ─── Build visible layer legend list ─────────────────────────────────────────
/**
 * Returns a list of human-readable visible layer labels from layerVisibility.
 */
export const buildLegendLabels = (layerVisibility, overlayVisibility) => {
  const labels = [];
  if (overlayVisibility?.zoneBoundary) labels.push("Zone Boundary");
  if (overlayVisibility?.wardBoundary) labels.push("Ward Boundary");
  if (layerVisibility?.network?.roads) labels.push("Road Network");

  const formatLabel = (key) =>
    String(key)
      .split("_")
      .map((p) => (p ? p[0].toUpperCase() + p.slice(1) : ""))
      .join(" ");

  Object.entries(layerVisibility?.amenities || {}).forEach(([k, v]) => {
    if (v) labels.push(formatLabel(k));
  });
  Object.entries(layerVisibility?.others || {}).forEach(([k, v]) => {
    if (v) labels.push(formatLabel(k));
  });
  Object.entries(layerVisibility?.roadClassifications || {}).forEach(([k, v]) => {
    if (v) labels.push(`Roads by ${formatLabel(k)}`);
  });
  Object.entries(layerVisibility?.analysis || {}).forEach(([k, v]) => {
    if (v) labels.push(formatLabel(k));
  });
  return labels;
};

// ─── Draw watermark logo onto canvas ─────────────────────────────────────────
/**
 * Draws the RSAC/org watermark at the bottom-right corner, proportionally
 * sized so it never overlaps map content. Also writes a text fallback.
 * Exported so both PNG-print and PDF callers can use it.
 */
export const drawWatermark = async (canvas, watermarkSrc) => {
  console.log("drawWatermark called with src:", watermarkSrc);
  const ctx    = canvas.getContext("2d");
  const margin = 14;

  // ── Try loading the image (no crossOrigin — webpack assets are same-origin) ──
  let wImg = null;
  if (watermarkSrc) {
    wImg = await new Promise((resolve) => {
      const img   = new Image();
      img.onload  = () => {
        console.log("Watermark image loaded. naturalWidth:", img.naturalWidth);
        resolve(img);
      };
      img.onerror = (e) => {
        console.error("Watermark image failed to load:", e);
        resolve(null);
      };
      img.src     = watermarkSrc;           // ← no crossOrigin here
    });
  } else {
    console.warn("No watermarkSrc provided to drawWatermark");
  }

  if (wImg && wImg.naturalWidth > 0) {
    console.log("Drawing image watermark...");
    // ── Image watermark: bottom-right, max 20% wide × 7% tall, white bg pill ──
    const maxW  = Math.max(80, canvas.width  * 0.20);
    const maxH  = Math.max(30, canvas.height * 0.07);
    const scale = Math.min(maxW / wImg.naturalWidth, maxH / wImg.naturalHeight);
    const w     = wImg.naturalWidth  * scale;
    const h     = wImg.naturalHeight * scale;
    const x     = canvas.width  - w - margin;
    const y     = canvas.height - h - margin;
    const pad   = 8;

    console.log(`Image watermark dims - maxW:${maxW}, maxH:${maxH}, scale:${scale}, w:${w}, h:${h}, x:${x}, y:${y}`);

    ctx.save();
    // White pill background — ensures logo is readable over any map tile
    ctx.fillStyle = "rgba(255,255,255,0.82)";
    ctx.beginPath();
    ctx.roundRect(x - pad, y - pad, w + pad * 2, h + pad * 2, 6);
    ctx.fill();
    // Logo
    ctx.globalAlpha = 0.90;
    ctx.drawImage(wImg, x, y, w, h);
    ctx.restore();
    console.log("Image watermark drawn successfully.");

  } else {
    console.log("Drawing text fallback watermark...");
    // ── Text fallback: always draw "© RSAC-UP" with white pill backing ──────
    const fontSize = Math.max(13, Math.round(canvas.width * 0.013));
    const text     = "© RSAC-UP | URIDA";
    ctx.save();
    ctx.font         = `bold ${fontSize}px Arial, sans-serif`;
    ctx.textBaseline = "top";
    const tw = ctx.measureText(text).width;
    const th = fontSize;
    const x  = canvas.width  - tw - margin * 2;
    const y  = canvas.height - th - margin * 2;

    console.log(`Text fallback dims - fontSize:${fontSize}, tw:${tw}, th:${th}, x:${x}, y:${y}`);

    // White pill
    ctx.fillStyle = "rgba(255,255,255,0.82)";
    ctx.beginPath();
    ctx.roundRect(x - 8, y - 5, tw + 16, th + 10, 5);
    ctx.fill();

    // Dark text
    ctx.fillStyle = "rgba(20,40,80,0.92)";
    ctx.fillText(text, x, y);
    ctx.restore();
    console.log("Text fallback drawn successfully.");
  }
};



// ─── Capture OpenLayers map canvas ───────────────────────────────────────────
/**
 * Captures #map-root, then composites the live legend panel on top at the
 * EXACT same screen position the user sees it (tracks drag position).
 *
 * Smart visibility: uses getBoundingClientRect() not offsetParent — because
 * position:fixed elements always have offsetParent===null which broke the
 * previous check.
 *
 * @param {React.RefObject} mapRef
 * @returns {Promise<HTMLCanvasElement>}
 */
export const captureMapCanvas = async (mapRef) => {
  // 1. Force OL render sync
  const mapInstance =
    mapRef?.current?.instance || mapRef?.current?.map || mapRef?.current;
  if (mapInstance && typeof mapInstance.renderSync === "function") {
    mapInstance.renderSync();
  }

  // 2. Wait for async tile renders
  await new Promise((r) => setTimeout(r, 900));

  const mapElement = document.getElementById("map-root");
  if (!mapElement) throw new Error("map-root element not found");

  // 3. Smart legend injection ─────────────────────────────────────────────────
  //    The legend is position:fixed so html2canvas can't capture it as part of
  //    #map-root. Instead we: read its screen rect → subtract mapRect to get
  //    the relative offset → move it into #map-root as position:absolute →
  //    do ONE html2canvas → restore everything.
  //    This way the legend appears exactly where the user sees it on screen.
  const legendEl = document.getElementById("map-legend-panel");
  let legendRestore = null;

  if (legendEl) {
    const legendRect = legendEl.getBoundingClientRect();
    const mapRect    = mapElement.getBoundingClientRect();
    const isVisible  =
      legendRect.height > 60 &&
      legendRect.width  > 10 &&
      getComputedStyle(legendEl).display    !== "none" &&
      getComputedStyle(legendEl).visibility !== "hidden";

    if (isVisible) {
      // Save everything we'll modify so we can restore exactly
      legendRestore = {
        parentNode:        legendEl.parentNode,
        position:          legendEl.style.position,
        left:              legendEl.style.left,
        top:               legendEl.style.top,
        right:             legendEl.style.right,
        bottom:            legendEl.style.bottom,
        background:        legendEl.style.background,
        backdropFilter:    legendEl.style.backdropFilter,
        webkitBackdrop:    legendEl.style.webkitBackdropFilter,
        zIndex:            legendEl.style.zIndex,
      };

      // Position relative to map-root (same visual spot)
      const relLeft = legendRect.left - mapRect.left;
      const relTop  = legendRect.top  - mapRect.top;

      // Glassmorphism blur isn't supported by html2canvas → solid gradient
      legendEl.style.position          = "absolute";
      legendEl.style.left              = `${relLeft}px`;
      legendEl.style.top               = `${relTop}px`;
      legendEl.style.right             = "auto";
      legendEl.style.bottom            = "auto";
      legendEl.style.zIndex            = "9999";
      legendEl.style.background        =
        "linear-gradient(149deg, rgba(54,209,214,0.97) 15%, rgba(91,134,229,0.97) 55%)";
      legendEl.style.backdropFilter    = "none";
      legendEl.style.webkitBackdropFilter = "none";

      mapElement.appendChild(legendEl);   // ← move inside the capture target
    }
  }

  // 4. Single html2canvas call — legend is now inside map-root
  let canvas;
  try {
    canvas = await html2canvas(mapElement, {
      useCORS:                true,
      allowTaint:             false,
      foreignObjectRendering: false,
      logging:                false,
      scale:                  1.5,
      ignoreElements: (el) => {
        const cls    = el.className || "";
        const clsStr = typeof cls === "string" ? cls : "";
        return (
          clsStr.includes("ol-control")      ||
          clsStr.includes("ol-popup")         ||
          clsStr.includes("map-toolbar")      ||
          clsStr.includes("map-legend")       ||
          el.id === "layer-switcher-target"
          // ⚠️  map-legend-panel is NOT excluded — it's now inside map-root
        );
      },
    });
  } finally {
    // 5. Always restore the legend to original parent + styles
    if (legendRestore && legendEl) {
      legendRestore.parentNode.appendChild(legendEl);
      legendEl.style.position             = legendRestore.position;
      legendEl.style.left                 = legendRestore.left;
      legendEl.style.top                  = legendRestore.top;
      legendEl.style.right                = legendRestore.right;
      legendEl.style.bottom               = legendRestore.bottom;
      legendEl.style.zIndex               = legendRestore.zIndex;
      legendEl.style.background           = legendRestore.background;
      legendEl.style.backdropFilter       = legendRestore.backdropFilter;
      legendEl.style.webkitBackdropFilter = legendRestore.webkitBackdrop;
    }
  }

  // 6. Guarantee a pristine, unclipped canvas for downstream drawing.
  //    html2canvas often leaves its internal context in a dirty state
  //    (with arbitrary clip paths) which causes subsequent canvas drawing
  //    to fail silently if it falls outside the clip region.
  const cleanCanvas = document.createElement("canvas");
  if (canvas) {
    cleanCanvas.width = canvas.width;
    cleanCanvas.height = canvas.height;
    const ctx = cleanCanvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(canvas, 0, 0);
  }

  return cleanCanvas;
};

// ─── Draw north arrow onto PDF page ──────────────────────────────────────────────
const drawNorthArrow = (doc, x, y, size = 28) => {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        doc.addImage(img, "PNG", x, y, size, size * (64 / 48));
      } catch (_) {}
      resolve();
    };
    img.onerror = resolve;
    img.src = northArrowDataUrl;
  });
};

// ─── MAIN: Export to PDF ─────────────────────────────────────────────────────
/**
 * Exports map screenshot + attribute table to a professional PDF layout.
 *
 * @param {object} opts
 *   mapRef          — mapRef from Dashboard
 *   rows            — cleaned data.data array
 *   city            — city name string
 *   watermarkSrc    — rsacBanner import URL
 *   layerVisibility — from Dashboard state
 *   overlayVisibility — from Dashboard state
 *   roadFilter      — current filter string (shown in title)
 */
export const exportToPDF = async ({
  mapRef,
  rows,
  city,
  watermarkSrc,
  layerVisibility,
  overlayVisibility,
  roadFilter,
  columnFilters, // ⭐ NEW
  title,
  mapTitle,
  columns: overrideColumns,
}) => {
  // ── 1. Capture map ──
  const mapCanvas = await captureMapCanvas(mapRef);
  await drawWatermark(mapCanvas, watermarkSrc);

  const toLabel = (key) =>
    String(key || "")
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  const hidden = new Set(["geometry", "geom", "the_geom", "bbox", "wkt"]);
  const inferColumns = (inputRows) => {
    const sample = Array.isArray(inputRows) ? inputRows.slice(0, 80) : [];
    const keys = new Set();
    sample.forEach((r) => {
      if (!r || typeof r !== "object") return;
      Object.keys(r).forEach((k) => {
        const key = String(k || "");
        if (!key) return;
        if (hidden.has(key.toLowerCase())) return;
        keys.add(k);
      });
    });
    const list = Array.from(keys);
    const hasRoadColumns = EXPORT_COLUMNS.every((c) => Object.prototype.hasOwnProperty.call(sample[0] || {}, c.key));
    if (hasRoadColumns) {
      return EXPORT_COLUMNS.map((c) => ({ header: c.label, dataKey: c.key }));
    }
    return list.map((k) => ({ header: toLabel(k), dataKey: k }));
  };
  const columns = Array.isArray(overrideColumns) && overrideColumns.length
    ? overrideColumns
    : inferColumns(rows);
  const bodyRows = (Array.isArray(rows) ? rows : []).map((r) => {
    const out = {};
    columns.forEach((c) => {
      const key = c.dataKey;
      out[key] = formatVal(key, r?.[key]);
    });
    return out;
  });

  // ── 2. Create PDF (landscape A4) ──
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();   // ~842
  const pageH = doc.internal.pageSize.getHeight();  // ~595

  const margin = 24;
  const headerH = 28;

  // ── 3. Page 1 — Map Layout ──
  // Header bar
  doc.setFillColor(36, 62, 143);
  doc.rect(0, 0, pageW, headerH, "F");
  doc.setFontSize(13);
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  const cityTitle = mapTitle || `${String(city).toUpperCase()} — ${title ? `${title} Map` : "Map"}`;
  doc.text(cityTitle, margin, 18);

  // Timestamp (right side of header)
  const now = new Date().toLocaleString("en-IN", { hour12: true });
  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  const tsW = doc.getTextWidth(now);
  doc.text(now, pageW - margin - tsW, 18);

  // Map image block
  const mapY = headerH + 6;
  const mapAreaH = pageH - mapY - 78; // leave room for footer
  const mapAreaW = pageW - margin * 2 - 48; // leave 48pt for north arrow

  const imgAspect = mapCanvas.width / mapCanvas.height;
  let drawW = mapAreaW;
  let drawH = drawW / imgAspect;
  if (drawH > mapAreaH) {
    drawH = mapAreaH;
    drawW = drawH * imgAspect;
  }
  const imgX = margin;
  const imgY = mapY;

  // Map border
  doc.setDrawColor(100, 100, 120);
  doc.setLineWidth(1.2);
  doc.rect(imgX - 1, imgY - 1, drawW + 2, drawH + 2);

  // Map image
  try {
    const imgData = mapCanvas.toDataURL("image/jpeg", 0.92);
    doc.addImage(imgData, "JPEG", imgX, imgY, drawW, drawH);
  } catch (err) {
    console.warn("PDF map image error:", err);
  }

  // North arrow (top-right of map area)
  const northX = imgX + drawW + 8;
  const northY = imgY + 6;
  await drawNorthArrow(doc, northX, northY, 32);

  // Legend text block (bottom-left of page)
  const legendLabels = buildLegendLabels(layerVisibility, overlayVisibility);
  const legendY = imgY + drawH + 10;
  doc.setFontSize(8);
  doc.setTextColor(50, 50, 60);
  doc.setFont("helvetica", "bold");
  doc.text("Active Layers:", margin, legendY);
  doc.setFont("helvetica", "normal");
  const legendText = legendLabels.length > 0 ? legendLabels.join("  |  ") : "Base Map Only";
  doc.text(legendText, margin + 58, legendY, { maxWidth: drawW - 60 });

  // Filter context
  let filterLines = [];
  if (roadFilter && roadFilter !== "INCLUDE") {
    let readableFilter = roadFilter
      .replace(/zone_no='/g, "Zone: ")
      .replace(/ward_no='/g, "Ward: ")
      .replace(/category='/g, "Category: ")
      .replace(/condition='/g, "Condition: ")
      .replace(/material='/g, "Material: ")
      .replace(/ownership='/g, "Ownership: ")
      .replace(/cus_class='/g, "Scheme: ")
      .replace(/'/g, "")
      .replace(/ AND /g, "  |  ");
    filterLines.push(`Map Filters: ${readableFilter.length > 120 ? readableFilter.slice(0, 117) + "..." : readableFilter}`);
  }

  if (columnFilters && Object.keys(columnFilters).length > 0) {
    const tableFilters = Object.entries(columnFilters)
      .map(([col, val]) => {
          if (Array.isArray(val) && val.length === 2) {
              return `${col}: ${val[0]} to ${val[1]}`;
          }
          return `${col}: ${val}`;
      })
      .join("  |  ");
    filterLines.push(`Table Filters: ${tableFilters.length > 120 ? tableFilters.slice(0, 117) + "..." : tableFilters}`);
  }

  if (filterLines.length > 0) {
    doc.setFontSize(7.5);
    doc.setTextColor(80, 80, 90);
    filterLines.forEach((line, idx) => {
        doc.text(line, margin, legendY + 13 + (idx * 10), { maxWidth: drawW });
    });
  }

  // Page number
  doc.setFontSize(8);
  doc.setTextColor(120, 120, 130);
  doc.text(`Page 1`, pageW - margin - 30, pageH - 10);

  // ── 4. Page 2+ — Attribute Table ──
  if (rows && rows.length > 0) {
    doc.addPage("a4", "landscape");

    // Table header
    doc.setFillColor(36, 62, 143);
    doc.rect(0, 0, pageW, headerH, "F");
    doc.setFontSize(12);
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.text(`${String(city).toUpperCase()} — ${title || "Attribute Table"} (${rows.length} records)`, margin, 18);

    autoTable(doc, {
      columns,
      body: bodyRows,
      startY: headerH + 8,
      margin: { left: margin, right: margin },
      styles: {
        fontSize: 6.5,
        cellPadding: 2.5,
        overflow: "linebreak",
        halign: "left",
        lineColor: [200, 205, 215],
        lineWidth: 0.3,
      },
      headStyles: {
        fillColor: [36, 62, 143],
        textColor: [255, 255, 255],
        fontStyle: "bold",
        fontSize: 7,
        cellPadding: 3,
      },
      alternateRowStyles: {
        fillColor: [245, 247, 252],
      },
      columnStyles: columns.some((c) => c.dataKey === "road_id") ? {
        road_id: { cellWidth: 38 },
        road_name: { cellWidth: 75 },
        zone_no: { cellWidth: 28 },
        zone_name: { cellWidth: 60 },
        ward_no: { cellWidth: 28 },
        ward_name: { cellWidth: 60 },
        ownership: { cellWidth: 55 },
        condition: { cellWidth: 40 },
        category: { cellWidth: 45 },
        material: { cellWidth: 40 },
        yoc: { cellWidth: 32 },
        cus_class: { cellWidth: 40 },
        row_meter: { cellWidth: 32 },
        carriage_w: { cellWidth: 38 },
        length_km: { cellWidth: 36 },
      } : undefined,
      didDrawPage: (data) => {
        // Footer with page numbers
        doc.setFontSize(7.5);
        doc.setTextColor(120, 120, 130);
        doc.text(
          `Page ${data.pageNumber}`,
          pageW - margin - 30,
          pageH - 10
        );
        doc.text(
          `URIDA — ${String(city).toUpperCase()} Road Network`,
          margin,
          pageH - 10
        );
      },
    });
  }

  // ── 5. Save ──
  const dateStr = new Date().toISOString().slice(0, 10);
  const safeTitle = String(title || "report").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  doc.save(`${safeTitle}_${String(city).toLowerCase()}_${dateStr}.pdf`);
};

// ─── MAIN: Export to Excel ────────────────────────────────────────────────────
/**
 * Exports road attribute data to a clean, formatted Excel file.
 *
 * @param {object[]} rows  — data.data array from API
 * @param {string}   city  — city name
 */
export const exportToExcel = (rows, city, opts = {}) => {
  const toLabel = (key) =>
    String(key || "")
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  const hidden = new Set(["geometry", "geom", "the_geom", "bbox", "wkt"]);
  const safeTitle = String(opts?.title || "data").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

  const inputRows = Array.isArray(rows) ? rows : [];
  const sample = inputRows.slice(0, 80);
  const hasRoadColumns = EXPORT_COLUMNS.every((c) => Object.prototype.hasOwnProperty.call(sample[0] || {}, c.key));
  const columns = Array.isArray(opts?.columns) && opts.columns.length
    ? opts.columns
    : (hasRoadColumns
      ? EXPORT_COLUMNS.map((c) => ({ label: c.label, key: c.key }))
      : (() => {
        const keys = new Set();
        sample.forEach((r) => {
          if (!r || typeof r !== "object") return;
          Object.keys(r).forEach((k) => {
            const key = String(k || "");
            if (!key) return;
            if (hidden.has(key.toLowerCase())) return;
            keys.add(k);
          });
        });
        return Array.from(keys).map((k) => ({ label: toLabel(k), key: k }));
      })());

  const wsData = [
    columns.map((c) => c.label),
    ...inputRows.map((row) => columns.map((c) => {
      const val = row?.[c.key];
      if (val === null || val === undefined) return "";
      const asNum = Number(val);
      return Number.isFinite(asNum) && String(val).trim() !== "" ? asNum : val;
    })),
  ];

  const ws = XLSX.utils.aoa_to_sheet(wsData);

  // Auto-column widths
  const colWidths = columns.map((col) => {
    const maxLen = Math.max(
      String(col.label || "").length,
      ...inputRows.slice(0, 200).map((r) => String(r?.[col.key] ?? "").length)
    );
    return { wch: Math.min(maxLen + 2, 40) };
  });
  ws["!cols"] = colWidths;

  // Style header row (freeze header)
  ws["!freeze"] = { xSplit: 0, ySplit: 1 };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, opts?.sheetName || (hasRoadColumns ? "Road Data" : "Table Data"));

  const dateStr = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `${safeTitle}_${String(city).toLowerCase()}_${dateStr}.xlsx`);
};

// ─── Convert GeoJSON geometry to KML coords string ────────────────────────────
const geoJsonToKmlGeom = (geom) => {
  if (!geom || !geom.coordinates) return "";

  const coordStr = (c) => `${c[0]},${c[1]},0`;

  if (geom.type === "LineString") {
    return `<LineString><tessellate>1</tessellate><coordinates>${geom.coordinates
      .map(coordStr)
      .join(" ")}</coordinates></LineString>`;
  }
  if (geom.type === "MultiLineString") {
    return `<MultiGeometry>${geom.coordinates
      .map(
        (line) =>
          `<LineString><tessellate>1</tessellate><coordinates>${line
            .map(coordStr)
            .join(" ")}</coordinates></LineString>`
      )
      .join("")}</MultiGeometry>`;
  }
  if (geom.type === "Point") {
    return `<Point><coordinates>${coordStr(geom.coordinates)}</coordinates></Point>`;
  }
  if (geom.type === "MultiPoint") {
    return `<MultiGeometry>${geom.coordinates
      .map((c) => `<Point><coordinates>${coordStr(c)}</coordinates></Point>`)
      .join("")}</MultiGeometry>`;
  }
  if (geom.type === "Polygon") {
    const rings = geom.coordinates
      .map(
        (ring, i) =>
          i === 0
            ? `<outerBoundaryIs><LinearRing><coordinates>${ring.map(coordStr).join(" ")}</coordinates></LinearRing></outerBoundaryIs>`
            : `<innerBoundaryIs><LinearRing><coordinates>${ring.map(coordStr).join(" ")}</coordinates></LinearRing></innerBoundaryIs>`
      )
      .join("");
    return `<Polygon>${rings}</Polygon>`;
  }
  if (geom.type === "MultiPolygon") {
    return `<MultiGeometry>${geom.coordinates
      .map((poly) => {
        const rings = poly
          .map(
            (ring, i) =>
              i === 0
                ? `<outerBoundaryIs><LinearRing><coordinates>${ring.map(coordStr).join(" ")}</coordinates></LinearRing></outerBoundaryIs>`
                : `<innerBoundaryIs><LinearRing><coordinates>${ring.map(coordStr).join(" ")}</coordinates></LinearRing></innerBoundaryIs>`
          )
          .join("");
        return `<Polygon>${rings}</Polygon>`;
      })
      .join("")}</MultiGeometry>`;
  }
  return "";
};

// ─── MAIN: Export to KML ─────────────────────────────────────────────────────
/**
 * Exports road spatial data to a KML file with clean attribute popups.
 *
 * @param {object[]} rows  — data.data array from API (must have geom field)
 * @param {string}   city  — city name
 * @returns {{ kmlBlob: Blob, skippedCount: number }}
 */
export const exportToKML = (rows, city) => {
  const dateStr = new Date().toISOString().slice(0, 10);
  let skippedCount = 0;

  // KML Style definitions (road line color by condition)
  const styleBlock = `
  <Style id="road_default">
    <LineStyle><color>ff0055ff</color><width>2</width></LineStyle>
  </Style>
  <Style id="road_good">
    <LineStyle><color>ff00aa00</color><width>2</width></LineStyle>
  </Style>
  <Style id="road_moderate">
    <LineStyle><color>ff00aaff</color><width>2</width></LineStyle>
  </Style>
  <Style id="road_poor">
    <LineStyle><color>ff0000ff</color><width>2</width></LineStyle>
  </Style>`;

  const getStyleUrl = (condition) => {
    const c = String(condition || "").toLowerCase();
    if (c.includes("good") || c === "g") return "#road_good";
    if (c.includes("mod") || c === "m") return "#road_moderate";
    if (c.includes("poor") || c === "p") return "#road_poor";
    return "#road_default";
  };

  const placemarks = rows
    .map((row) => {
      if (!row.geom) {
        skippedCount++;
        return "";
      }
      const geomXml = geoJsonToKmlGeom(row.geom);
      if (!geomXml) {
        skippedCount++;
        return "";
      }

      // Build clean description table using only EXPORT_COLUMNS
      const descRows = EXPORT_COLUMNS.filter(({ key }) => row[key] !== null && row[key] !== undefined && row[key] !== "")
        .map(({ label, key }) => `<tr><td style="font-weight:bold;padding:3px 6px;border:1px solid #ddd;">${label}</td><td style="padding:3px 6px;border:1px solid #ddd;">${escapeXml(formatVal(key, row[key]))}</td></tr>`)
        .join("");

      const description = `<![CDATA[<table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:12px;">${descRows}</table>]]>`;

      const name = escapeXml(row.road_name || row.road_id || "Road");
      const styleUrl = getStyleUrl(row.condition);

      return `  <Placemark>
    <name>${name}</name>
    <description>${description}</description>
    <styleUrl>${styleUrl}</styleUrl>
    ${geomXml}
  </Placemark>`;
    })
    .filter(Boolean)
    .join("\n");

  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>Road Data — ${escapeXml(city)}</name>
  <description>Exported from URIDA Portal on ${dateStr}</description>
  ${styleBlock}
${placemarks}
</Document>
</kml>`;

  const blob = new Blob([kml], {
    type: "application/vnd.google-earth.kml+xml;charset=utf-8",
  });

  saveAs(blob, `road_data_${String(city).toLowerCase()}_${dateStr}.kml`);
  return { skippedCount };
};
