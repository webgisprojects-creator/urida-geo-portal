// Canonical cache key builder for the Smart Shared Cache Delivery Engine.
//
// A "family" is one of the six cacheable request shapes this app serves
// (see cachePolicy.js for the matching share-scope table):
//   basemap | clipped-basemap | gwc | wms-filtered | boundary-geojson | wfs-bbox
//
// Every builder below produces the same shape:
//   { key, hash, family, dims }
// `key` is a stable, human-readable string (useful in logs); `hash` is a
// short sha1 prefix of it (used in the X-Cache-Key-Hash header and as the
// SQLite index's cache_key_hash column). `dims` carries the individual
// normalized dimensions the key was built from, so callers don't have to
// re-parse the key string back apart.
//
// IMPORTANT: this module only computes identifiers/metadata. It never
// touches the filesystem and never changes the on-disk cache-file layout
// that server/src/routes/tiles.js and wfsCache.js already use — those
// paths remain the source of truth for where bytes are actually stored in
// Phase 1. This module's hash is what ties a disk file back to a row in
// cache-index.sqlite (see cacheIndex.js) for eviction/access-policy
// purposes, wrapped gradually around the existing functions.
import crypto from "crypto";

export function sha1(input) {
  return crypto.createHash("sha1").update(String(input)).digest("hex");
}

function shortHash(input) {
  return sha1(input).slice(0, 16);
}

function safe(value) {
  return String(value ?? "").replace(/[^a-zA-Z0-9_:.\/-]/g, "_");
}

// ---------------------------------------------------------------------
// CQL / query normalization — run before hashing so semantically-identical
// requests that merely differ in whitespace, operator casing, param order,
// or trivially-equivalent value formatting collapse onto the same cache
// key instead of fragmenting the cache with near-duplicate entries.
// ---------------------------------------------------------------------

// Canonical operator spellings. Longest-match-first so e.g. ">=" is not
// first mangled by a bare ">" rule.
const OPERATOR_ALIASES = [
  [/<>/g, "!="],
  [/\s*>=\s*/g, " >= "],
  [/\s*<=\s*/g, " <= "],
  [/\s*!=\s*/g, " != "],
  [/\s*=\s*/g, " = "],
  [/\s*>\s*/g, " > "],
  [/\s*<\s*/g, " < "],
];

// Normalizes a single scalar literal: numeric strings collapse to a plain
// decimal form (so "3", "3.0", "03" all match), quoted strings keep their
// quotes but trim internal whitespace and lowercase the surrounding quote
// style to a single-quote convention (CQL accepts both ' and ", GeoServer
// itself only ever emits ').
function normalizeValue(raw) {
  const trimmed = raw.trim();
  if (/^['"].*['"]$/s.test(trimmed)) {
    const inner = trimmed.slice(1, -1).trim();
    return `'${inner}'`;
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    return Number.isFinite(num) ? String(num) : trimmed;
  }
  return trimmed.replace(/\s+/g, " ");
}

// Splits a CQL filter on top-level " AND " (case-insensitive), ignoring
// ANDs that appear nested inside quoted string literals or parens, then
// sorts the resulting simple conditions so `a=1 AND b=2` and
// `b=2 AND a=1` normalize identically. Only ever reorders *simple*,
// unparenthesized top-level conditions — anything containing OR, a
// function call, or nested parens is left as its own single normalized
// term rather than risk changing the filter's meaning.
function splitTopLevelAnd(input) {
  const parts = [];
  let depth = 0;
  let inQuote = null;
  let current = "";
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (inQuote) {
      current += ch;
      if (ch === inQuote) inQuote = null;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inQuote = ch;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === "(") {
      depth += 1;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === ")") {
      depth -= 1;
      current += ch;
      i += 1;
      continue;
    }
    if (depth === 0 && /\s/.test(ch) && /and/i.test(input.slice(i + 1, i + 4)) && /\s/.test(input[i + 4] || " ")) {
      // lookahead for a whole-word "AND" bounded by whitespace
      const word = input.slice(i + 1, i + 4);
      if (/^and$/i.test(word)) {
        parts.push(current.trim());
        current = "";
        i += 5; // skip " AND "
        continue;
      }
    }
    current += ch;
    i += 1;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

// Normalizes a single "field OP value" condition's operator + value
// spacing/casing. Falls through unchanged (just whitespace-trimmed) for
// anything that doesn't match the simple shape, e.g. function calls,
// BBOX(...), IN (...), IS NULL.
const SIMPLE_CONDITION_RE = /^([\w:.]+)\s*(=|!=|<>|>=|<=|>|<)\s*(.+)$/s;
function normalizeSimpleCondition(term) {
  const trimmed = term.trim().replace(/\s+/g, " ");
  const match = SIMPLE_CONDITION_RE.exec(trimmed);
  if (!match) return trimmed;
  const [, field, op, value] = match;
  const normalizedOp = op === "<>" ? "!=" : op;
  return `${field} ${normalizedOp} ${normalizeValue(value)}`;
}

// Full CQL/query-string normalization pipeline:
//   1. trim outer whitespace, collapse internal runs of whitespace
//   2. normalize operator spelling/spacing
//   3. split on top-level AND, normalize + sort each simple condition
//   4. normalize numeric/string literals
//   5. drop empty terms
// Non-AND filters (OR, nested function predicates, etc.) still get steps
// 1-2 and per-term literal normalization, just without the sort (splitting
// only ever happens on top-level AND, so a single-term/OR-only filter is
// one "part" and sorting a 1-element array is a no-op anyway).
export function normalizeCqlFilter(cqlFilterRaw) {
  const raw = String(cqlFilterRaw || "").trim();
  if (!raw) return "";

  let normalized = raw.replace(/\s+/g, " ");
  for (const [pattern, replacement] of OPERATOR_ALIASES) {
    normalized = normalized.replace(pattern, replacement);
  }

  const parts = splitTopLevelAnd(normalized)
    .map(normalizeSimpleCondition)
    .filter(Boolean);

  parts.sort((a, b) => a.localeCompare(b));
  return parts.join(" AND ");
}

// Generic "remove empty params, sort remaining keys" normalizer for any
// plain query-param object (styles, viewparams, featureid lists, etc.) —
// used ahead of hashing so `?a=1&b=` and `?b=&a=1` (or any key order)
// collapse onto the same key.
export function normalizeQueryParams(paramsObj) {
  const out = {};
  const keys = Object.keys(paramsObj || {}).sort();
  for (const key of keys) {
    const value = paramsObj[key];
    if (value === undefined || value === null) continue;
    const str = String(value).trim();
    if (!str) continue;
    out[key] = str;
  }
  return out;
}

function stableStringify(obj) {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

// ---------------------------------------------------------------------
// Per-family canonical key builders.
// ---------------------------------------------------------------------

export function buildBasemapKey({ style, z, x, y }) {
  const dims = { style: safe(style), z: Number(z), x: Number(x), y: Number(y) };
  const key = `basemap/${dims.style}/${dims.z}/${dims.x}/${dims.y}`;
  return { key, hash: shortHash(key), family: "basemap", dims };
}

export function buildClippedBasemapKey({ style, boundaryLayer, z, x, y }) {
  const boundaryHash = shortHash(safe(boundaryLayer));
  const dims = {
    style: safe(style),
    boundaryLayer: String(boundaryLayer || ""),
    boundaryHash,
    z: Number(z),
    x: Number(x),
    y: Number(y),
  };
  const key = `clipped-basemap/${dims.style}/${boundaryHash}/${dims.z}/${dims.x}/${dims.y}`;
  return { key, hash: shortHash(key), family: "clipped-basemap", dims };
}

export function buildGwcKey({ layerName, z, x, y }) {
  const dims = { layerName: String(layerName || ""), z: Number(z), x: Number(x), y: Number(y) };
  const key = `gwc/${safe(layerName)}/${dims.z}/${dims.x}/${dims.y}`;
  return { key, hash: shortHash(key), family: "gwc", dims };
}

export function buildWmsFilteredKey({ layerName, cqlFilter, styles, z, x, y }) {
  const cqlNormalized = normalizeCqlFilter(cqlFilter);
  const stylesNormalized = String(styles || "").trim();
  const cqlHash = shortHash(cqlNormalized);
  const styleHash = shortHash(stylesNormalized);
  const dims = {
    layerName: String(layerName || ""),
    cqlNormalized,
    cqlHash,
    stylesNormalized,
    styleHash,
    z: Number(z),
    x: Number(x),
    y: Number(y),
  };
  const key = `wms-filtered/${safe(layerName)}/${cqlHash}/${styleHash}/${dims.z}/${dims.x}/${dims.y}`;
  return { key, hash: shortHash(key), family: "wms-filtered", dims };
}

export function buildBoundaryGeojsonKey({ layerName }) {
  const dims = { layerName: String(layerName || "") };
  const key = `boundary-geojson/${safe(layerName)}`;
  return { key, hash: shortHash(key), family: "boundary-geojson", dims };
}

// wfs-bbox: bbox is an exact floating-point extent (see wfsCache.js's own
// comment on why this fragments differently than grid-snapped tile keys) —
// normalized here by trimming to a fixed precision so trivially-different
// float formatting of the same extent still collapses to one key, then
// combined with the normalized CQL filter and the other WFS params.
function normalizeBboxString(bboxRaw) {
  const parts = String(bboxRaw || "")
    .split(",")
    .map((part) => {
      const num = Number(part.trim());
      return Number.isFinite(num) ? num.toFixed(6) : part.trim();
    });
  return parts.join(",");
}

export function buildWfsBboxKey({ layerName, bbox, srsName, maxFeatures, cqlFilter }) {
  const cqlNormalized = normalizeCqlFilter(cqlFilter);
  const params = normalizeQueryParams({
    bbox: normalizeBboxString(bbox),
    srsName,
    maxFeatures,
  });
  const dims = {
    layerName: String(layerName || ""),
    ...params,
    cqlNormalized,
    cqlHash: shortHash(cqlNormalized),
  };
  const key = `wfs-bbox/${safe(layerName)}/${stableStringify(params)}/${dims.cqlHash}`;
  return { key, hash: shortHash(key), family: "wfs-bbox", dims };
}

export default {
  sha1,
  normalizeCqlFilter,
  normalizeQueryParams,
  buildBasemapKey,
  buildClippedBasemapKey,
  buildGwcKey,
  buildWmsFilteredKey,
  buildBoundaryGeojsonKey,
  buildWfsBboxKey,
};
