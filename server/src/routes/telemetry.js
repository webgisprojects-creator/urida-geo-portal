import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Client-side action/timing log — separate from audit.log (which is
// per-request, server-side only, and doesn't know *why* a request
// happened). This captures what the user actually did (pan, zoom, toggle a
// layer, open a panel) and what the browser observed (a layer's real load
// duration, or one that got stuck) so the two logs can be read side by
// side: "user did X at time T" -> "these backend requests happened" ->
// "this specific one took/never finished."
const LOG_DIR = path.join(__dirname, "..", "..", "logs");
const LOG_FILE = path.join(LOG_DIR, "telemetry.log");

let dirReady = false;
async function ensureLogDir() {
  if (dirReady) return;
  await fs.promises.mkdir(LOG_DIR, { recursive: true });
  dirReady = true;
}

router.post("/api/telemetry", express.json({ limit: "256kb" }), async (req, res) => {
  // Always 204 regardless of body shape — this is best-effort diagnostic
  // logging, not a feature the app depends on; it must never itself cause
  // a visible error or retry storm in the browser.
  res.status(204).end();
  try {
    const events = Array.isArray(req.body?.events) ? req.body.events : [];
    if (!events.length) return;
    await ensureLogDir();
    const lines = events
      .map((e) =>
        JSON.stringify({
          receivedAt: new Date().toISOString(),
          ts: e?.ts,
          type: e?.type,
          details: e?.details,
          path: e?.path,
          sessionId: e?.sessionId,
        })
      )
      .join("\n") + "\n";
    fs.promises.appendFile(LOG_FILE, lines).catch(() => {});
  } catch {
    // best-effort — never let a logging failure surface to the client
  }
});

export default router;
