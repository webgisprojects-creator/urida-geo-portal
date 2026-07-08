import express from "express";
import { verifyToken } from "../middleware/authMiddleware.js";
import { authorizeCityAccess } from "../utils/cityAccess.js";

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

router.post("/api/kmc/submit-project-patches", verifyToken, async (req, res) => {
  const city = authorizeCityAccess(req, res, req.body?.city);
  if (!city) return;

  const projectId = Number(req.body?.project_id);
  const userId = Number(req.body?.user_id);
  const patches = Array.isArray(req.body?.patches) ? req.body.patches : [];

  if (!Number.isFinite(projectId) || !Number.isFinite(userId) || patches.length === 0) {
    return res.status(400).json({ error: "Missing project_id, user_id, or patches" });
  }

  const apiKey = process.env.KMC_API_KEY;
  const writeUrl = process.env.KMC_WRITE_URL || DEFAULT_KMC_WRITE_URL;
  if (!apiKey) {
    return res.status(500).json({ error: "KMC integration is not configured" });
  }

  try {
    const jsonPayload = {
      project_id: projectId,
      user_id: userId,
      patches,
    };

    const jsonRes = await fetch(writeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": apiKey,
      },
      body: JSON.stringify(jsonPayload),
    });

    const jsonText = await responseText(jsonRes);
    if (!jsonRes.ok) {
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
      headers: {
        Accept: "application/json",
        "X-API-KEY": apiKey,
      },
      body: formData,
    });

    const imageText = await responseText(imageRes);
    if (!imageRes.ok) {
      return res.status(502).json({
        error: "KMC image submit failed",
        status: imageRes.status,
        detail: imageText.slice(0, 500),
      });
    }

    return res.json({
      success: true,
      kmcJsonStatus: jsonRes.status,
      kmcImageStatus: imageRes.status,
    });
  } catch (err) {
    console.error("KMC submit error:", err.message);
    return res.status(500).json({ error: err.message || "KMC submit failed" });
  }
});

export default router;
