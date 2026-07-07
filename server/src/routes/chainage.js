import "dotenv/config";
import express from "express";
import { pool as pool1 } from "../config/db.js";
import { verifyToken } from "../middleware/authMiddleware.js";

const router = express.Router();

// Every route below reads or writes real patch/chainage data and was
// reachable with no auth at all (unlike roadNetwork.js/cityRoutes.js, which
// both gate themselves the same way). Every real path into this feature —
// including the KMC mobile deep-link — already goes through the app's
// normal login first (client/src/App.js's <Protected> wraps /chainage and
// redirects unauthenticated visitors to log in before they ever reach this
// UI), so requiring a valid session here is transparent to real users.
//
// verifyToken is applied per-route below, NOT as a blanket `router.use()`.
// This router (like tiles.js/wfsCache.js) is mounted at the app root with
// no path prefix (`app.use(chainageRoutes)` in app.js), because its own
// routes are already fully-qualified (/api/chainage/..., /api/create-patch,
// etc.) — a blanket `router.use(verifyToken)` here would run for *every*
// request that reaches this router, including the bare `/` page-shell
// request and every other router's routes mounted after it in app.js
// (confirmed live: it broke the app shell and would have also gated
// telemetry.js's deliberately-public endpoint). Route-level middleware only
// runs when that specific route actually matches.

const requiredDbEnv = ["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASS"];

const missingDbEnv = requiredDbEnv.filter((key) => !process.env[key]);

if (missingDbEnv.length > 0) {
    throw new Error(
        `Missing required database environment variables: ${missingDbEnv.join(", ")}`
    );
}

const unavailableMessage = (city) =>
    `Chainage is still in progress for ${city || "this city"}. You can continue using other map features.`;

const isMissingRelationError = (err) => err?.code === "42P01";

const sendFeatureUnavailable = (res, city, feature = "Chainage") => res.status(503).json({
    error: "FEATURE_IN_PROGRESS",
    feature,
    city,
    message: unavailableMessage(city),
});

// const chainageDbConfig = {
//     kanpur: {
//         table: "Kanpur.interpolatedpoints",
//         roadIdColumn: "road_id",
//         distanceColumn: "distance",
//     },
//     lucknow: {
//         table: "lucknow_interpolatedpoints",
//         roadIdColumn: "road_id",
//         distanceColumn: "distance",
//     },
//     agra: {
//         table: 'agra."agr-points"',
//         roadIdColumn: "road_id",
//         distanceColumn: "distance",
//     },
// };

const chainageDbConfig = {
    kanpur: {
        schema: "kanpur",
        chainageTable: "Kanpur.chainage_points",
        segmentTable: "Kanpur.knn_chainage_segments_clean",
        roadIdColumn: "road_id",
        distanceColumn: "distance",
        segmentIdColumn: "segment_id",
    },
    // lucknow: not verified as working chainage data yet. Client-side
    // chainageCityConfig.js (client/src/assets/configs/chainageCityConfig.js)
    // also has no lucknow entry — keep both in sync. Re-add once confirmed.
    // lucknow: {
    //     schema: "lucknow",
    //     chainageTable: "lucknow_interpolatedpoints",
    //     segmentTable: "lucknow.segmentszone2roads",
    //     roadIdColumn: "road_id",
    //     distanceColumn: "distance",
    //     segmentIdColumn: "segment_id",
    // },
    agra: {
        schema: "agra",
        chainageTable: 'agra.agra_points',
        segmentTable: 'agra.agra_seg1',
        roadIdColumn: "road_id",
        distanceColumn: "distance",
        segmentIdColumn: "segment_id",
    },
};
router.get("/api/chainage/:city/:roadId", verifyToken, async (req, res) => {
    const city = String(req.params.city || "").toLowerCase().trim();
    const roadId = String(req.params.roadId || "").trim();

    const cfg = chainageDbConfig[city];

    if (!cfg) {
        return res.status(400).json({ error: "Unsupported city" });
    }

    if (!roadId) {
        return res.status(400).json({ error: "roadId is required" });
    }

    try {
        const query = `
    SELECT ${cfg.distanceColumn} AS distance
    FROM ${cfg.chainageTable}
    WHERE ${cfg.roadIdColumn} = $1
    ORDER BY ${cfg.distanceColumn}
`;

        const result = await pool1.query(query, [roadId]);

        console.log("API HIT:", city, roadId, result.rows.length);

        res.json(result.rows);
    } catch (err) {
        if (isMissingRelationError(err)) {
            return sendFeatureUnavailable(res, city, "Chainage");
        }
        res.status(500).json({ error: "Unable to load chainage data" });
    }
});

// router.post("/api/create-patch", verifyToken, async (req, res) => {
//     const { city, road_id, startPoint, endPoint } = req.body;

//     const cityKey = city?.toLowerCase();
//     const cfg = chainageDbConfig[cityKey];

//     if (!cfg) return res.status(400).json({ error: "Invalid city" });

//     const start = Number(startPoint);
//     const end = Number(endPoint);

//     if (!road_id || isNaN(start) || isNaN(end)) {
//         return res.status(400).json({ error: "Invalid input" });
//     }

//     if (start >= end) {
//         return res.status(400).json({ error: "Invalid range" });
//     }

//     const patchId = `${road_id}P${start}T${end}`;

//     const startSeg = start + 10;
//     const endSeg = end;

//     const client = await pool1.connect();

//     try {
//         await client.query("BEGIN");

//         const segQuery = `
//       SELECT *
//         FROM ${cfg.segmentTable}
//         WHERE ${cfg.roadIdColumn} = $1
//         AND CAST(split_part(${cfg.segmentIdColumn}, 'S', 2) AS INTEGER)
//         BETWEEN $2 AND $3
//         ORDER BY CAST(split_part(${cfg.segmentIdColumn}, 'S', 2) AS INTEGER)
//     `;

//         const segRes = await client.query(segQuery, [
//             road_id,
//             startSeg,
//             endSeg,
//         ]);

//         if (segRes.rows.length === 0) {
//             throw new Error("No segments found");
//         }

//         const insertQuery = `
//         INSERT INTO ${cfg.schema}.patch_table
//         (patch_id, road_id, segment_id, geom, attributes)
//         VALUES ($1, $2, $3, $4, $5)
//     `;

//         for (const row of segRes.rows) {
//             await client.query(insertQuery, [
//                 patchId,
//                 row[cfg.roadIdColumn],
//                 row[cfg.segmentIdColumn],
//                 row.geom || null,
//                 row,
//             ]);
//         }

//         await client.query("COMMIT");

//         res.json({
//             success: true,
//             patch_id: patchId,
//             inserted: segRes.rows.length,
//             schema: cfg.schema,
//         });

//     } catch (err) {
//         await client.query("ROLLBACK");
//         console.error(err.message);
//         res.status(500).json({ error: err.message });
//     } finally {
//         client.release();
//     }
// });


/* CREATE PATCH */
// Read-only preview of the segments a patch would cover for a given
// road/chainage range, without writing anything — used to show the user an
// exact map/image preview before they confirm "Save" on /api/create-patch,
// which runs the same range query but inside an insert transaction.
router.get("/api/patch-preview/:city/:roadId", verifyToken, async (req, res) => {
    const cityKey = String(req.params.city || "").toLowerCase().trim();
    const roadId = String(req.params.roadId || "").trim();
    const cfg = chainageDbConfig[cityKey];

    if (!cfg) return res.status(400).json({ error: "Invalid city" });
    if (!roadId) return res.status(400).json({ error: "roadId is required" });

    const start = Number(req.query.start);
    const end = Number(req.query.end);

    if (Number.isNaN(start) || Number.isNaN(end)) {
        return res.status(400).json({ error: "Invalid input" });
    }
    if (start >= end) {
        return res.status(400).json({ error: "Invalid range" });
    }

    try {
        const segQuery = `
            SELECT *, ST_AsGeoJSON(geom) AS geojson
            FROM ${cfg.segmentTable}
            WHERE ${cfg.roadIdColumn} = $1
            AND CAST(split_part(${cfg.segmentIdColumn}, 'S', 2) AS NUMERIC) > $2
            AND CAST(split_part(${cfg.segmentIdColumn}, 'S', 2) AS NUMERIC) <= $3
            ORDER BY CAST(split_part(${cfg.segmentIdColumn}, 'S', 2) AS NUMERIC)
        `;

        const segRes = await pool1.query(segQuery, [roadId, start, end]);

        res.json({
            road_id: roadId,
            start,
            end,
            count: segRes.rows.length,
            data: segRes.rows,
        });
    } catch (err) {
        if (isMissingRelationError(err)) {
            return sendFeatureUnavailable(res, cityKey, "Chainage patch preview");
        }
        res.status(500).json({ error: "Unable to load patch preview" });
    }
});

router.post("/api/create-patch", verifyToken, async (req, res) => {
    const { city, road_id, startPoint, endPoint } = req.body;

    const cityKey = city?.toLowerCase();
    const cfg = chainageDbConfig[cityKey];

    if (!cfg) return res.status(400).json({ error: "Invalid city" });

    const start = Number(startPoint);
    const end = Number(endPoint);

    if (!road_id || Number.isNaN(start) || Number.isNaN(end)) {
        return res.status(400).json({ error: "Invalid input" });
    }

    if (start >= end) {
        return res.status(400).json({ error: "Invalid range" });
    }

    const patchId = `${road_id}P${start}T${end}`;
    const client = await pool1.connect();

    try {
        await client.query("BEGIN");

        const existingPatchRes = await client.query(
    `
    SELECT patch_id
    FROM ${cfg.schema}.patch_table
    WHERE patch_id = $1
    AND road_id = $2
    LIMIT 1
    `,
    [patchId, road_id]
);

if (existingPatchRes.rows.length > 0) {
    await client.query("ROLLBACK");

    return res.status(409).json({
        success: false,
        alreadyExists: true,
        patch_id: patchId,
        message: "Patch already exists. Please select it from the checkbox list."
    });
}

        const segQuery = `
      SELECT *
        FROM ${cfg.segmentTable}
        WHERE ${cfg.roadIdColumn} = $1
        AND CAST(split_part(${cfg.segmentIdColumn}, 'S', 2) AS NUMERIC) > $2
        AND CAST(split_part(${cfg.segmentIdColumn}, 'S', 2) AS NUMERIC) <= $3
        ORDER BY CAST(split_part(${cfg.segmentIdColumn}, 'S', 2) AS NUMERIC)
    `;

        const segRes = await client.query(segQuery, [road_id, start, end]);

        if (segRes.rows.length === 0) {
            throw new Error("No segments found");
        }

        const insertQuery = `
        INSERT INTO ${cfg.schema}.patch_table
        (patch_id, road_id, segment_id, geom, attributes)
        VALUES ($1, $2, $3, $4, $5)
    `;

        for (const row of segRes.rows) {
            await client.query(insertQuery, [
                patchId,
                row[cfg.roadIdColumn],
                row[cfg.segmentIdColumn],
                row.geom || null,
                row,
            ]);
        }

        await client.query("COMMIT");

        res.json({
            success: true,
            patch_id: patchId,
            inserted: segRes.rows.length,
            schema: cfg.schema,
        });
    } catch (err) {
        await client.query("ROLLBACK");
        if (isMissingRelationError(err)) {
            return sendFeatureUnavailable(res, cityKey, "Chainage patch creation");
        }
        res.status(500).json({ error: "Unable to create patch" });
    } finally {
        client.release();
    }
});

router.get("/api/patches/:city/:roadId", verifyToken, async (req, res) => {
    const city = String(req.params.city || "").toLowerCase().trim();
    const roadId = String(req.params.roadId || "").trim();

    const cfg = chainageDbConfig[city];
    if (!cfg) return res.status(400).json({ error: "Invalid city" });

    try {
        const query = `
        SELECT patch_id, segment_id, ST_AsGeoJSON(geom) AS geom
        FROM ${cfg.schema}.patch_table
        WHERE road_id = $1
    `;

        const result = await pool1.query(query, [roadId]);

        res.json({
            exists: result.rows.length > 0,
            count: result.rows.length,
            data: result.rows,
        });

    } catch (err) {
        if (isMissingRelationError(err)) {
            return sendFeatureUnavailable(res, city, "Chainage patches");
        }
        res.status(500).json({ error: "Unable to load patches" });
    }
});

router.post("/api/patch-segments", verifyToken, async (req, res) => {
    const { city, patchIds } = req.body;

    const cfg = chainageDbConfig[city?.toLowerCase()];
    if (!cfg) return res.status(400).json({ error: "Invalid city" });

    if (!patchIds || patchIds.length === 0) {
        return res.status(400).json({ error: "No patchIds provided" });
    }

    try {
        const query = `
        SELECT p.patch_id,p.segment_id,
        s.*
        FROM ${cfg.schema}.patch_table p
        JOIN ${cfg.segmentTable} s
        ON p.segment_id = s.${cfg.segmentIdColumn}
        WHERE p.patch_id = ANY($1)
        ORDER BY p.patch_id, p.segment_id
    `;

        const result = await pool1.query(query, [patchIds]);

        res.json(result.rows);

    } catch (err) {
        if (isMissingRelationError(err)) {
            return sendFeatureUnavailable(res, city, "Chainage patch segments");
        }
        res.status(500).json({ error: "Unable to load patch segments" });
    }
});

// router.get("/api/chainage-search/:city", verifyToken, async (req, res) => {
//     const city = req.params.city?.toLowerCase();
//     const q = req.query.q || "";

//     const cfg = chainageDbConfig[city];
//     if (!cfg) return res.status(400).json({ error: "Invalid city" });

//     try {
//         const query = `
//         SELECT DISTINCT road_id, road_name
//         FROM ${cfg.segmentTable}
//         WHERE LOWER(road_name) LIKE LOWER($1)
//         LIMIT 20
//     `;

//         const result = await pool1.query(query, [`%${q}%`]);

//         res.json(result.rows);
//     } catch (err) {
//         console.error(err);
//         res.status(500).json({ error: "Search error" });
//     }
// });

router.get("/api/chainage-search/:city", verifyToken, async (req, res) => {
    const city = req.params.city?.toLowerCase();
    const q = req.query.q || "";

    const cfg = chainageDbConfig[city];
    if (!cfg) return res.status(400).json({ error: "Invalid city" });

    try {
        const query = `
        WITH matched_roads AS (
            SELECT
                road_id,
                road_name,
                ward_no,
                ST_Centroid(ST_Collect(geom)) AS center
            FROM ${cfg.segmentTable}
            WHERE road_name ILIKE $1
            GROUP BY road_id, road_name, ward_no
            ORDER BY road_name
            LIMIT 20
        )
        SELECT
            road_id,
            road_name,
            ward_no,
            ST_X(center) AS lon,
            ST_Y(center) AS lat
        FROM matched_roads
`;
        const result = await pool1.query(query, [`%${q}%`]);

        res.json(result.rows);
    } catch (err) {
        if (isMissingRelationError(err)) {
            return sendFeatureUnavailable(res, city, "Chainage search");
        }
        res.status(500).json({ error: "Unable to search chainage roads" });
    }
});

router.post("/api/map-project-patches", verifyToken, async (req, res) => {
    const { city, project_id, user_id, patchIds } = req.body;

    const cityKey = city?.toLowerCase();
    const cfg = chainageDbConfig[cityKey];

    if (!cfg) {
        return res.status(400).json({ error: "Invalid city" });
    }

    if (!project_id || !user_id || !patchIds || patchIds.length === 0) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    try {
        const query = `
            INSERT INTO ${cfg.schema}.project_table
                (project_id, user_id, road_id, patch_id, created_at)
            SELECT
                $1,
                $2,
                p.road_id,
                p.patch_id,
                NOW()
            FROM ${cfg.schema}.patch_table p
            WHERE p.patch_id = ANY($3)
            GROUP BY p.road_id, p.patch_id

        `;

        await pool1.query(query, [
            Number(project_id),
            String(user_id),
            patchIds
        ]);

        res.json({ success: true });

    } catch (err) {
        if (isMissingRelationError(err)) {
            return sendFeatureUnavailable(res, cityKey, "Project patch mapping");
        }
        res.status(500).json({ error: "Failed to map project patches" });
    }
});


router.post("/api/grouped-patches-by-selection", verifyToken, async (req, res) => {
    const { city, project_id, patchIds } = req.body;

    const cityKey = city?.toLowerCase();
    const cfg = chainageDbConfig[cityKey];

    if (!cfg) {
        return res.status(400).json({ error: "Invalid city" });
    }

    if (!project_id || !patchIds || patchIds.length === 0) {
        return res.status(400).json({ error: "Missing project_id or patchIds" });
    }

    try {
        const query = `
    SELECT
        x.patch_id,
        x.road_id,
        array_agg(
            x.segment_id
            ORDER BY x.seg_no
        ) AS segments
    FROM (
        SELECT DISTINCT
            p.patch_id,
            p.road_id,
            p.segment_id,
            CAST(split_part(p.segment_id, 'S', 2) AS NUMERIC) AS seg_no
        FROM ${cfg.schema}.patch_table p
        WHERE p.patch_id = ANY($2)
        AND EXISTS (
            SELECT 1
            FROM ${cfg.schema}.project_table pr
            WHERE pr.project_id = $1
            AND pr.patch_id = p.patch_id
            AND pr.road_id = p.road_id
        )
    ) x
    GROUP BY x.patch_id, x.road_id
    ORDER BY x.road_id, x.patch_id
`;

        const result = await pool1.query(query, [
            Number(project_id),
            patchIds
        ]);

        res.json({
            project_id,
            total_patches: result.rowCount,
            patches: result.rows
        });

    } catch (err) {
        if (isMissingRelationError(err)) {
            return sendFeatureUnavailable(res, cityKey, "Grouped patches");
        }
        res.status(500).json({ error: "Failed to fetch grouped patches" });
    }
});

export default router;
