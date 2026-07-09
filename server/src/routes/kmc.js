import express from "express";
import { verifyToken, verifyRole } from "../middleware/authMiddleware.js";
import { authorizeCityAccess } from "../utils/cityAccess.js";
import { pool } from "../config/db.js";
import { chainageDbConfig } from "./chainage.js";

const router = express.Router();

const DEFAULT_KMC_WRITE_URL = "https://kmc.igilesolutions.com/api/v1/writedata";
const MAX_IMAGE_BYTES = Number(process.env.KMC_IMAGE_MAX_BYTES || 10 * 1024 * 1024);

function parseDataUrl(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;,]+)?;base64,(.+)$/);
  if (!match) {
    throw new Error("Invalid map image data");
  }
  const mimeType = match[1] || "image/png";
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length) {
    throw new Error("Map image is empty");
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error("Map image is too large");
  }
  return { buffer, mimeType };
}

async function responseText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

// project_table rows for (project_id, user_id, patch_id) are written by the
// earlier, separate /api/map-project-patches request (already committed by
// the time this route runs) and carry kmc_sync_status/kmc_synced_at/
// kmc_response/kmc_attempts columns used purely as a delivery-tracking
// ledger here — this route never inserts project_table rows itself, only
// updates the status of ones that already exist. Failures here must never
// mask the real outcome already being sent to the caller.
//
// Deliberately does NOT persist the submitted image anywhere — it's a
// one-time, in-memory-only artifact exactly like the pre-existing submit
// flow always was; only the *data* (patch_id/road_id/segments, already
// durable in patch_table/project_table) is ever retried. See
// GET /api/kmc/pending-submissions below for how a failed submission's
// data can be inspected/resent without needing a stored image.
async function recordKmcSyncStatus(cfg, projectId, userId, patchIds, status, response) {
  if (!cfg || !patchIds.length) return;
  const isSynced = status === "synced";
  try {
    await pool.query(
      `UPDATE ${cfg.schema}.project_table
       SET kmc_sync_status = $1,
           kmc_synced_at = CASE WHEN $1 = 'synced' THEN NOW() ELSE kmc_synced_at END,
           kmc_response = $2::jsonb,
           kmc_attempts = CASE WHEN $1 = 'synced' THEN kmc_attempts ELSE COALESCE(kmc_attempts, 0) + 1 END
       WHERE project_id = $3 AND user_id = $4 AND patch_id = ANY($5)`,
      [status, JSON.stringify(response), projectId, String(userId), patchIds]
    );
    if (!isSynced) {
      console.error(
        `[kmc] submit failed for project ${projectId} user ${userId} patches [${patchIds.join(",")}] — ${response?.stage || "unknown stage"}: ${response?.detail || response?.message || JSON.stringify(response)}`
      );
    }
  } catch (err) {
    console.error("[kmc] sync-status update failed:", err.message);
  }
}

router.post("/api/kmc/submit-project-patches", verifyToken, async (req, res) => {
  const city = authorizeCityAccess(req, res, req.body?.city);
  if (!city) return;

  const projectId = Number(req.body?.project_id);
  const userId = Number(req.body?.user_id);
  const patches = Array.isArray(req.body?.patches) ? req.body.patches : [];

  if (!Number.isFinite(projectId) || !Number.isFinite(userId) || patches.length === 0) {
    return res.status(400).json({ error: "Missing project_id, user_id, or patches" });
  }

  const cfg = chainageDbConfig[city];
  // A multi-road patch contributes one `patches[]` entry per road it spans,
  // all sharing the same patch_id (see /api/grouped-patches-by-selection) —
  // dedupe here so downstream queries/checks operate on distinct patch ids.
  const patchIds = [...new Set(patches.map((p) => p?.patch_id).filter(Boolean))];

  // Idempotent re-check: if every patch in this submission is already marked
  // 'synced' from a prior successful call, KMC already has this data and has
  // no idempotency key of its own — skip calling it again on a retry.
  //
  // A multi-road patch has MULTIPLE project_table rows sharing one patch_id
  // (one per road_id it spans) — checking "is *a* row for this patch_id
  // synced" via a plain patch_id-keyed Map would silently drop whichever
  // row Postgres returns first (row order isn't guaranteed without ORDER
  // BY), which could report alreadySynced:true after only one of the
  // patch's roads was actually confirmed delivered. Every matching row
  // (not just one per patch_id) must be 'synced', and every requested
  // patchId must actually have at least one row — a patch_id with zero
  // rows here (never mapped) must not vacuously pass.
  if (cfg && patchIds.length) {
    try {
      const statusRes = await pool.query(
        `SELECT patch_id, kmc_sync_status FROM ${cfg.schema}.project_table
         WHERE project_id = $1 AND user_id = $2 AND patch_id = ANY($3)`,
        [projectId, String(userId), patchIds]
      );
      const rowCountByPatch = new Map();
      let allRowsSynced = statusRes.rows.length > 0;
      for (const row of statusRes.rows) {
        rowCountByPatch.set(row.patch_id, (rowCountByPatch.get(row.patch_id) || 0) + 1);
        if (row.kmc_sync_status !== "synced") allRowsSynced = false;
      }
      const everyPatchHasRows = patchIds.every((id) => rowCountByPatch.has(id));
      if (allRowsSynced && everyPatchHasRows) {
        return res.json({ success: true, alreadySynced: true });
      }
    } catch (err) {
      // Sync-status bookkeeping must never block a real submission.
      console.error("[kmc] sync-status pre-check failed:", err.message);
    }
  }

  const apiKey = process.env.KMC_API_KEY;
  const writeUrl = process.env.KMC_WRITE_URL || DEFAULT_KMC_WRITE_URL;
  if (!apiKey) {
    return res.status(500).json({ error: "KMC integration is not configured" });
  }

  try {
    // KMC's endpoint expects camelCase keys on each patch object (confirmed
    // directly: sending patch_id/road_id gets back {"error":"Undefined
    // array key \"roadId\""}; patchId/roadId succeeds) even though the
    // top-level project_id/user_id keys are accepted as snake_case.
    const jsonPayload = {
      project_id: projectId,
      user_id: userId,
      patches: patches.map((p) => ({
        patchId: p?.patch_id,
        roadId: p?.road_id,
        segments: p?.segments,
      })),
    };

    const jsonRes = await fetch(writeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": apiKey },
      body: JSON.stringify(jsonPayload),
    });

    const jsonText = await responseText(jsonRes);
    if (!jsonRes.ok) {
      await recordKmcSyncStatus(cfg, projectId, userId, patchIds, "failed", {
        stage: "json",
        status: jsonRes.status,
        detail: jsonText.slice(0, 500),
      });
      return res.status(502).json({
        error: "KMC JSON submit failed",
        status: jsonRes.status,
        detail: jsonText.slice(0, 500),
      });
    }

    const { buffer, mimeType } = parseDataUrl(req.body?.imageDataUrl);
    const imageFilename =
      String(req.body?.imageFilename || "").replace(/[^a-zA-Z0-9_.-]/g, "_") ||
      `${city}_project_${projectId}_map.png`;

    const formData = new FormData();
    formData.append("file", new Blob([buffer], { type: mimeType }), imageFilename);
    formData.append("project_id", String(projectId));
    formData.append("user_id", String(userId));

    const imageRes = await fetch(writeUrl, {
      method: "POST",
      headers: { Accept: "application/json", "X-API-KEY": apiKey },
      body: formData,
    });

    const imageText = await responseText(imageRes);
    if (!imageRes.ok) {
      // KMC already durably received the JSON payload at this point — only
      // the follow-up image upload failed. Recorded (not 'synced') so a
      // retry doesn't skip re-attempting the image, but jsonDelivered lets a
      // caller tell this apart from "nothing reached KMC at all".
      await recordKmcSyncStatus(cfg, projectId, userId, patchIds, "failed", {
        stage: "image",
        status: imageRes.status,
        detail: imageText.slice(0, 500),
        jsonDelivered: true,
        kmcJsonStatus: jsonRes.status,
      });
      return res.status(502).json({
        error: "KMC image submit failed",
        status: imageRes.status,
        detail: imageText.slice(0, 500),
        jsonDelivered: true,
      });
    }

    await recordKmcSyncStatus(cfg, projectId, userId, patchIds, "synced", {
      kmcJsonStatus: jsonRes.status,
      kmcImageStatus: imageRes.status,
    });

    return res.json({
      success: true,
      kmcJsonStatus: jsonRes.status,
      kmcImageStatus: imageRes.status,
    });
  } catch (err) {
    console.error("[kmc] submit error:", err.message);
    await recordKmcSyncStatus(cfg, projectId, userId, patchIds, "failed", {
      stage: "exception",
      message: err.message,
    });
    return res.status(500).json({ error: err.message || "KMC submit failed" });
  }
});

// Read-only visibility into anything not yet confirmed delivered to KMC —
// reconstructs the same {road_id, segments} shape the real submit would
// send, straight from patch_table/project_table, so a developer/support
// person can see exactly what's stuck and why (kmc_response has the last
// failure detail) without us ever having stored an image. Actually
// resending still goes through the normal submit endpoint above (which
// re-captures a fresh screenshot client-side) — this endpoint is for
// inspection, not resubmission.
router.get("/api/kmc/pending-submissions", verifyToken, verifyRole("admin"), async (req, res) => {
  const city = authorizeCityAccess(req, res, req.query?.city);
  if (!city) return;
  const cfg = chainageDbConfig[city];
  if (!cfg) return res.status(400).json({ error: "Invalid city" });

  try {
    const { rows } = await pool.query(
      `SELECT
         pr.project_id, pr.user_id, pr.patch_id, pr.road_id,
         pr.kmc_sync_status, pr.kmc_attempts, pr.kmc_synced_at, pr.kmc_response, pr.created_at,
         array_agg(pt.segment_id ORDER BY CAST(split_part(pt.segment_id, 'S', 2) AS NUMERIC)) AS segments
       FROM ${cfg.schema}.project_table pr
       JOIN ${cfg.schema}.patch_table pt ON pt.patch_id = pr.patch_id AND pt.road_id = pr.road_id
       WHERE pr.kmc_sync_status != 'synced'
       GROUP BY pr.project_id, pr.user_id, pr.patch_id, pr.road_id,
                pr.kmc_sync_status, pr.kmc_attempts, pr.kmc_synced_at, pr.kmc_response, pr.created_at
       ORDER BY pr.created_at DESC
       LIMIT 200`
    );
    res.json({ city, count: rows.length, submissions: rows });
  } catch (err) {
    if (err?.code === "42P01") {
      return res.json({ city, count: 0, submissions: [] });
    }
    res.status(500).json({ error: "Unable to load pending KMC submissions" });
  }
});

export default router;
