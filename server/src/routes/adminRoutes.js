import express from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { pool } from "../config/db.js";
import { verifyToken, verifyRole, ensureActiveTokensTable } from "../middleware/authMiddleware.js";

const router = express.Router();

router.use(verifyToken);
router.use(verifyRole("admin"));

const quoteIdentifier = (value) => `"${String(value).replace(/"/g, '""')}"`;
const resolveColumn = (columnMap, candidates) => {
  for (const candidate of candidates) {
    const match = columnMap.get(String(candidate).toLowerCase());
    if (match) return match;
  }
  return null;
};

const findTableByName = async (tableName) => {
  const { rows } = await pool.query(
    `SELECT table_schema, table_name
     FROM information_schema.tables
     WHERE table_type = 'BASE TABLE'
       AND table_name = $1
     ORDER BY (table_schema = 'public') DESC, table_schema
     LIMIT 1`,
    [tableName]
  );
  return rows[0] || null;
};

const getTableColumns = async (schema, table) => {
  const { rows } = await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2`,
    [schema, table]
  );
  return new Map(rows.map((r) => [String(r.column_name).toLowerCase(), r.column_name]));
};

const getTableColumnMeta = async (schema, table) => {
  const { rows } = await pool.query(
    `SELECT column_name, data_type, udt_name, is_nullable
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2`,
    [schema, table]
  );
  return new Map(rows.map((r) => [String(r.column_name).toLowerCase(), r]));
};

const getUsersContext = async () => {
  const tableInfo = await findTableByName("users");
  if (!tableInfo) {
    const err = new Error("users table not found");
    err.status = 404;
    throw err;
  }
  const schema = tableInfo.table_schema;
  const table = tableInfo.table_name;
  const columns = await getTableColumns(schema, table);
  const columnMeta = await getTableColumnMeta(schema, table);
  const tableRef = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
  const selected = {
    id: resolveColumn(columns, ["id"]),
    user_id: resolveColumn(columns, ["user_id"]),
    username: resolveColumn(columns, ["username", "user_name"]),
    email: resolveColumn(columns, ["email"]),
    password: resolveColumn(columns, ["password", "password_hash"]),
    role: resolveColumn(columns, ["role", "user_role"]),
    is_active: resolveColumn(columns, ["is_active"]),
    city: resolveColumn(columns, ["city", "city_code", "city_name"]),
    created_at: resolveColumn(columns, ["created_at"]),
    updated_at: resolveColumn(columns, ["updated_at"]),
    last_login: resolveColumn(columns, ["last_login", "last_login_at"]),
    must_change_password: resolveColumn(columns, ["must_change_password"]),
    deleted_at: resolveColumn(columns, ["deleted_at"]),
    password_changed_at: resolveColumn(columns, ["password_changed_at"]),
    failed_attempts: resolveColumn(columns, ["failed_attempts", "failed_attempt", "login_attempts"]),
    lock_until: resolveColumn(columns, ["lock_until", "locked_until"]),
  };
  return { schema, table, columns, columnMeta, tableRef, selected };
};

const getDeletedUsersArchiveRows = async () => {
  const archiveInfo = await findTableByName("deleted_users");
  if (!archiveInfo) return [];
  const schema = archiveInfo.table_schema;
  const table = archiveInfo.table_name;
  const tableRef = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
  const columns = await getTableColumns(schema, table);
  const selected = {
    id: resolveColumn(columns, ["id", "source_id"]),
    user_id: resolveColumn(columns, ["user_id"]),
    username: resolveColumn(columns, ["username", "user_name"]),
    email: resolveColumn(columns, ["email"]),
    role: resolveColumn(columns, ["role"]),
    city: resolveColumn(columns, ["city"]),
    deleted_at: resolveColumn(columns, ["deleted_at", "archived_at", "created_at"]),
  };
  const selectParts = Object.entries(selected)
    .filter(([, col]) => !!col)
    .map(([alias, col]) => `${quoteIdentifier(col)} AS ${quoteIdentifier(alias)}`);
  if (selectParts.length === 0) return [];
  const sql = `
    SELECT ${selectParts.join(", ")}
    FROM ${tableRef}
    ORDER BY ${
      selected.deleted_at ? `${quoteIdentifier(selected.deleted_at)} DESC NULLS LAST` : "1 DESC"
    }
  `;
  const { rows } = await pool.query(sql);
  return (rows || []).map((row) => ({
    ...row,
    is_active: false,
    must_change_password: false,
    deleted_at: row.deleted_at || new Date().toISOString(),
  }));
};

const archiveDeletedUserIfPossible = async (userRow, reqUser) => {
  const archiveInfo = await findTableByName("deleted_users");
  if (!archiveInfo || !userRow) return;
  const schema = archiveInfo.table_schema;
  const table = archiveInfo.table_name;
  const tableRef = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
  const columns = await getTableColumns(schema, table);
  const insertData = {
    id: userRow.id ?? null,
    user_id: userRow.user_id ?? userRow.id ?? null,
    username: userRow.username ?? null,
    email: userRow.email ?? null,
    role: userRow.role ?? null,
    city: userRow.city ?? null,
    deleted_at: new Date(),
    deleted_by: reqUser?.username || reqUser?.user_id || "admin",
  };
  const columnCandidates = {
    id: ["source_id", "id"],
    user_id: ["user_id"],
    username: ["username", "user_name"],
    email: ["email"],
    role: ["role"],
    city: ["city"],
    deleted_at: ["deleted_at", "archived_at", "created_at"],
    deleted_by: ["deleted_by", "updated_by", "created_by"],
  };
  const cols = [];
  const vals = [];
  Object.entries(columnCandidates).forEach(([key, candidates]) => {
    const col = resolveColumn(columns, candidates);
    if (!col) return;
    cols.push(col);
    vals.push(insertData[key]);
  });
  if (cols.length === 0) return;
  const placeholders = vals.map((_, i) => `$${i + 1}`);
  const sql = `
    INSERT INTO ${tableRef} (${cols.map(quoteIdentifier).join(", ")})
    VALUES (${placeholders.join(", ")})
  `;
  await pool.query(sql, vals);
};

const validatePassword = (value) => {
  const pass = String(value || "");
  return pass.length >= 6;
};

const generateTemporaryPassword = (length = 12) => {
  const raw = crypto.randomBytes(24).toString("base64url");
  const base = raw.slice(0, Math.max(8, length - 4));
  return `${base}A1!`;
};

const buildLookupClause = (selected, placeholder = "$1") => {
  const clauses = [];
  if (selected.id) {
    clauses.push(`${quoteIdentifier(selected.id)}::text = ${placeholder}`);
  }
  if (selected.user_id) {
    clauses.push(`${quoteIdentifier(selected.user_id)}::text = ${placeholder}`);
  }
  return clauses.length > 0 ? `(${clauses.join(" OR ")})` : "";
};

router.get("/users", async (req, res) => {
  try {
    const { tableRef, selected } = await getUsersContext();

    const selectParts = Object.entries(selected)
      .filter(([, col]) => !!col)
      .map(([alias, col]) => `${quoteIdentifier(col)} AS ${quoteIdentifier(alias)}`);

    if (selectParts.length === 0) {
      return res.status(400).json({ error: "No readable columns found in users table" });
    }

    const sql = `
      SELECT ${selectParts.join(", ")}
      FROM ${tableRef}
      ORDER BY ${
        selected.created_at
          ? `${quoteIdentifier(selected.created_at)} DESC NULLS LAST`
          : selected.username
            ? `${quoteIdentifier(selected.username)} ASC`
            : "1 DESC"
      }
    `;
    const result = await pool.query(sql);
    const archivedRows = await getDeletedUsersArchiveRows();
    return res.json({ users: [...(result.rows || []), ...archivedRows] });
  } catch (err) {
    console.error("admin users fetch error:", err);
    return res.status(500).json({ error: "Failed to load users" });
  }
});

router.post("/users", async (req, res) => {
  try {
    const { username, email, role, city, password, user_id: userIdInput } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: "username and password are required" });
    }
    if (!validatePassword(password)) {
      return res.status(400).json({ error: "password must be at least 6 characters" });
    }
    const { tableRef, selected, columnMeta } = await getUsersContext();
    if (!selected.username || !selected.password) {
      return res.status(400).json({ error: "users table missing username/password columns" });
    }
    const hashed = await bcrypt.hash(String(password), 10);
    const cols = [selected.username, selected.password];
    const vals = [String(username).trim(), hashed];

    if (selected.user_id) {
      const meta = columnMeta.get(String(selected.user_id).toLowerCase());
      const isNumericId =
        ["smallint", "integer", "bigint"].includes(String(meta?.data_type || "").toLowerCase()) ||
        ["int2", "int4", "int8"].includes(String(meta?.udt_name || "").toLowerCase());
      let userIdValue = userIdInput;
      if (userIdValue === undefined || userIdValue === null || String(userIdValue).trim() === "") {
        if (isNumericId) {
          const seqSql = `
            SELECT COALESCE(MAX(${quoteIdentifier(selected.user_id)}), 0) + 1 AS next_id
            FROM ${tableRef}
          `;
          const seqRes = await pool.query(seqSql);
          userIdValue = Number(seqRes.rows?.[0]?.next_id || 1);
        } else {
          userIdValue = String(username).trim();
        }
      } else if (isNumericId) {
        userIdValue = Number(userIdValue);
      } else {
        userIdValue = String(userIdValue).trim();
      }
      cols.push(selected.user_id);
      vals.push(userIdValue);
    }

    if (selected.email) {
      cols.push(selected.email);
      vals.push(email ? String(email).trim() : null);
    }
    if (selected.role) {
      cols.push(selected.role);
      vals.push(role ? String(role).trim() : "user");
    }
    if (selected.city) {
      cols.push(selected.city);
      vals.push(city ? String(city).trim() : null);
    }
    if (selected.is_active) {
      cols.push(selected.is_active);
      vals.push(true);
    }
    if (selected.must_change_password) {
      cols.push(selected.must_change_password);
      vals.push(true);
    }
    if (selected.created_at) {
      cols.push(selected.created_at);
      vals.push(new Date());
    }
    if (selected.updated_at) {
      cols.push(selected.updated_at);
      vals.push(new Date());
    }

    const placeholders = vals.map((_, i) => `$${i + 1}`);
    const sql = `
      INSERT INTO ${tableRef} (${cols.map(quoteIdentifier).join(", ")})
      VALUES (${placeholders.join(", ")})
    `;
    await pool.query(sql, vals);
    return res.json({ status: "ok" });
  } catch (err) {
    console.error("admin create user error:", err);
    if (err?.code === "23505") {
      return res.status(409).json({ error: "Duplicate value: username/email/user_id already exists" });
    }
    if (err?.code === "23502") {
      return res.status(400).json({ error: `Missing required field in users table: ${err?.column || "unknown"}` });
    }
    if (err?.code === "22P02") {
      return res.status(400).json({ error: "Invalid value type for one of the user fields" });
    }
    return res.status(500).json({ error: err?.message || "Failed to create user" });
  }
});

router.patch("/users/:userId/status", async (req, res) => {
  try {
    const userId = String(req.params.userId || "").trim();
    const isActive = Boolean(req.body?.is_active);
    if (!userId) return res.status(400).json({ error: "userId is required" });
    const { tableRef, selected } = await getUsersContext();
    if (!selected.is_active) {
      return res.status(400).json({ error: "is_active column not found in users table" });
    }
    const whereClause = buildLookupClause(selected, "$1");
    if (!whereClause) return res.status(400).json({ error: "No id column found in users table" });

    if (!isActive) {
      const identityCols = [];
      if (selected.id) identityCols.push(`${quoteIdentifier(selected.id)}::text AS row_id`);
      if (selected.user_id) identityCols.push(`${quoteIdentifier(selected.user_id)}::text AS row_user_id`);
      if (selected.username) identityCols.push(`${quoteIdentifier(selected.username)}::text AS row_username`);
      if (identityCols.length > 0) {
        const selfSql = `
          SELECT ${identityCols.join(", ")}
          FROM ${tableRef}
          WHERE ${whereClause}
          LIMIT 1
        `;
        const selfRes = await pool.query(selfSql, [userId]);
        const row = selfRes.rows[0];
        const tokenUserId = String(req.user?.user_id || "").trim();
        const tokenUsername = String(req.user?.username || "").trim().toLowerCase();
        const rowId = String(row?.row_id || "").trim();
        const rowUserId = String(row?.row_user_id || "").trim();
        const rowUsername = String(row?.row_username || "").trim().toLowerCase();
        const isSelf =
          (tokenUserId && (tokenUserId === rowId || tokenUserId === rowUserId)) ||
          (tokenUsername && tokenUsername === rowUsername);
        if (isSelf) {
          return res.status(400).json({ error: "You cannot deactivate your own active account" });
        }
      }
    }
    const values = [userId, isActive];
    const setParts = [`${quoteIdentifier(selected.is_active)} = $2`];
    if (selected.updated_at) {
      values.push(new Date());
      setParts.push(`${quoteIdentifier(selected.updated_at)} = $${values.length}`);
    }
    const sql = `
      UPDATE ${tableRef}
      SET ${setParts.join(", ")}
      WHERE ${whereClause}
    `;
    const result = await pool.query(sql, values);
    if ((result.rowCount || 0) === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    return res.json({ status: "ok" });
  } catch (err) {
    console.error("admin status update error:", err);
    return res.status(500).json({ error: "Failed to update user status" });
  }
});

router.patch("/users/:userId/role", async (req, res) => {
  try {
    const userId = String(req.params.userId || "").trim();
    const nextRole = String(req.body?.role || "").trim();
    if (!userId || !nextRole) {
      return res.status(400).json({ error: "userId and role are required" });
    }
    const { tableRef, selected } = await getUsersContext();
    if (!selected.role) {
      return res.status(400).json({ error: "role column not found in users table" });
    }
    const whereClause = buildLookupClause(selected, "$2");
    if (!whereClause) return res.status(400).json({ error: "No id column found in users table" });
    const values = [nextRole, userId];
    const setParts = [`${quoteIdentifier(selected.role)} = $1`];
    if (selected.updated_at) {
      values.push(new Date());
      setParts.push(`${quoteIdentifier(selected.updated_at)} = $${values.length}`);
    }
    const sql = `
      UPDATE ${tableRef}
      SET ${setParts.join(", ")}
      WHERE ${whereClause}
    `;
    const result = await pool.query(sql, values);
    if ((result.rowCount || 0) === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    return res.json({ status: "ok" });
  } catch (err) {
    console.error("admin role update error:", err);
    return res.status(500).json({ error: "Failed to update role" });
  }
});

router.patch("/users/:userId/reset-password", async (req, res) => {
  try {
    const userId = String(req.params.userId || "").trim();
    const newPassword = String(req.body?.new_password || "");
    if (!userId || !newPassword) {
      return res.status(400).json({ error: "userId and new_password are required" });
    }
    if (!validatePassword(newPassword)) {
      return res.status(400).json({ error: "new_password must be at least 6 characters" });
    }
    const { tableRef, selected } = await getUsersContext();
    if (!selected.password) {
      return res.status(400).json({ error: "password column not found in users table" });
    }
    const whereClause = buildLookupClause(selected, "$2");
    if (!whereClause) return res.status(400).json({ error: "No id column found in users table" });
    const hashed = await bcrypt.hash(newPassword, 10);
    const values = [hashed, userId];
    const setParts = [`${quoteIdentifier(selected.password)} = $1`];
    if (selected.must_change_password) {
      values.push(true);
      setParts.push(`${quoteIdentifier(selected.must_change_password)} = $${values.length}`);
    }
    if (selected.password_changed_at) {
      values.push(new Date());
      setParts.push(`${quoteIdentifier(selected.password_changed_at)} = $${values.length}`);
    }
    if (selected.updated_at) {
      values.push(new Date());
      setParts.push(`${quoteIdentifier(selected.updated_at)} = $${values.length}`);
    }
    const sql = `
      UPDATE ${tableRef}
      SET ${setParts.join(", ")}
      WHERE ${whereClause}
    `;
    const result = await pool.query(sql, values);
    if ((result.rowCount || 0) === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    return res.json({ status: "ok" });
  } catch (err) {
    console.error("admin password reset error:", err);
    return res.status(500).json({ error: "Failed to reset password" });
  }
});

// Counterpart to authController.js's lockout — clears failed_attempts/
// lock_until so a normal user locked out after 5 failed attempts can get
// back in without waiting out the 15-minute window. This is the admin
// action the login page's own lockout message ("contact RSAC-UP to unlock
// your account") points to.
router.patch("/users/:userId/unlock", async (req, res) => {
  try {
    const userId = String(req.params.userId || "").trim();
    if (!userId) return res.status(400).json({ error: "userId is required" });
    const { tableRef, selected } = await getUsersContext();
    if (!selected.failed_attempts && !selected.lock_until) {
      return res.status(400).json({ error: "This users table has no lockout columns to clear" });
    }
    if (!buildLookupClause(selected, "$1")) {
      return res.status(400).json({ error: "No id column found in users table" });
    }
    const values = [];
    const setParts = [];
    if (selected.failed_attempts) {
      values.push(0);
      setParts.push(`${quoteIdentifier(selected.failed_attempts)} = $${values.length}`);
    }
    if (selected.lock_until) {
      values.push(null);
      setParts.push(`${quoteIdentifier(selected.lock_until)} = $${values.length}`);
    }
    const sql = `
      UPDATE ${tableRef}
      SET ${setParts.join(", ")}
      WHERE ${buildLookupClause(selected, `$${values.length + 1}`)}
    `;
    const result = await pool.query(sql, [...values, userId]);
    if ((result.rowCount || 0) === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    return res.json({ status: "ok" });
  } catch (err) {
    console.error("admin unlock user error:", err);
    return res.status(500).json({ error: "Failed to unlock user" });
  }
});

const handleGenerateTempPassword = async (req, res) => {
  try {
    const userId = String(req.params.userId || "").trim();
    if (!userId) return res.status(400).json({ error: "userId is required" });
    const { tableRef, selected } = await getUsersContext();
    if (!selected.password) return res.status(400).json({ error: "password column not found in users table" });
    const whereClause = buildLookupClause(selected, "$1");
    if (!whereClause) return res.status(400).json({ error: "No id column found in users table" });
    const tempPassword = generateTemporaryPassword(12);
    const hashed = await bcrypt.hash(tempPassword, 10);
    const values = [hashed, userId];
    const setParts = [`${quoteIdentifier(selected.password)} = $1`];
    if (selected.must_change_password) {
      values.push(true);
      setParts.push(`${quoteIdentifier(selected.must_change_password)} = $${values.length}`);
    }
    if (selected.password_changed_at) {
      values.push(new Date());
      setParts.push(`${quoteIdentifier(selected.password_changed_at)} = $${values.length}`);
    }
    if (selected.updated_at) {
      values.push(new Date());
      setParts.push(`${quoteIdentifier(selected.updated_at)} = $${values.length}`);
    }
    const updateSql = `
      UPDATE ${tableRef}
      SET ${setParts.join(", ")}
      WHERE ${whereClause}
    `;
    const updateRes = await pool.query(updateSql, values);
    if ((updateRes.rowCount || 0) === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    return res.json({ status: "ok", temporary_password: tempPassword });
  } catch (err) {
    console.error("admin generate-temp-password error:", err);
    return res.status(500).json({ error: "Failed to generate temporary password" });
  }
};

router.post("/users/:userId/generate-temp-password", handleGenerateTempPassword);
router.post("/users/:userId/temp-password", handleGenerateTempPassword);

router.delete("/users/:userId", async (req, res) => {
  try {
    const userId = String(req.params.userId || "").trim();
    if (!userId) return res.status(400).json({ error: "userId is required" });
    const { tableRef, selected } = await getUsersContext();
    const whereClause = buildLookupClause(selected, "$2");
    if (!whereClause) return res.status(400).json({ error: "No id column found in users table" });

    const identityCols = [];
    if (selected.id) identityCols.push(`${quoteIdentifier(selected.id)}::text AS row_id`);
    if (selected.user_id) identityCols.push(`${quoteIdentifier(selected.user_id)}::text AS row_user_id`);
    if (selected.username) identityCols.push(`${quoteIdentifier(selected.username)}::text AS row_username`);
    if (identityCols.length > 0) {
      const selfSql = `
        SELECT ${identityCols.join(", ")}
        FROM ${tableRef}
        WHERE ${buildLookupClause(selected, "$1")}
        LIMIT 1
      `;
      const selfRes = await pool.query(selfSql, [userId]);
      const row = selfRes.rows[0];
      const tokenUserId = String(req.user?.user_id || "").trim();
      const tokenUsername = String(req.user?.username || "").trim().toLowerCase();
      const rowId = String(row?.row_id || "").trim();
      const rowUserId = String(row?.row_user_id || "").trim();
      const rowUsername = String(row?.row_username || "").trim().toLowerCase();
      const isSelf =
        (tokenUserId && (tokenUserId === rowId || tokenUserId === rowUserId)) ||
        (tokenUsername && tokenUsername === rowUsername);
      if (isSelf) {
        return res.status(400).json({ error: "You cannot delete your own account" });
      }
    }

    const selectCols = [];
    if (selected.id) selectCols.push(`${quoteIdentifier(selected.id)} AS id`);
    if (selected.user_id) selectCols.push(`${quoteIdentifier(selected.user_id)} AS user_id`);
    if (selected.username) selectCols.push(`${quoteIdentifier(selected.username)} AS username`);
    if (selected.email) selectCols.push(`${quoteIdentifier(selected.email)} AS email`);
    if (selected.role) selectCols.push(`${quoteIdentifier(selected.role)} AS role`);
    if (selected.city) selectCols.push(`${quoteIdentifier(selected.city)} AS city`);
    let targetRow = null;
    if (selectCols.length > 0) {
      const getSql = `
        SELECT ${selectCols.join(", ")}
        FROM ${tableRef}
        WHERE ${buildLookupClause(selected, "$1")}
        LIMIT 1
      `;
      const targetRes = await pool.query(getSql, [userId]);
      targetRow = targetRes.rows[0] || null;
    }
    try {
      await archiveDeletedUserIfPossible(targetRow, req.user);
    } catch (archiveErr) {
      console.warn("archive deleted user skipped:", archiveErr?.message || archiveErr);
    }

    const whereDeleteClause = buildLookupClause(selected, "$1");
    if (!whereDeleteClause) return res.status(400).json({ error: "No id column found in users table" });
    const sql = `DELETE FROM ${tableRef} WHERE ${whereDeleteClause}`;
    const result = await pool.query(sql, [userId]);
    if ((result.rowCount || 0) === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    return res.json({ status: "ok" });
  } catch (err) {
    console.error("admin delete user error:", err);
    return res.status(500).json({ error: "Failed to delete user" });
  }
});

router.get("/active-tokens/summary", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 15));
    const offset = (page - 1) * limit;

    // Guarantees ip_address/user_agent exist even on a freshly-started
    // server process that hasn't handled a login yet this run (those
    // columns are added by this same idempotent migration on first call).
    await ensureActiveTokensTable();
    const tokenTable = await findTableByName("active_tokens");
    if (!tokenTable) {
      return res.status(404).json({ error: "active_tokens table not found" });
    }
    const tokenSchema = tokenTable.table_schema;
    const tokenName = tokenTable.table_name;
    const tokenRef = `${quoteIdentifier(tokenSchema)}.${quoteIdentifier(tokenName)}`;

    const usersTable = await findTableByName("users");
    let recentSessions = [];
    const now = new Date();

    const countsSql = `
      SELECT
        COUNT(*)::int AS total_sessions,
        COUNT(*) FILTER (WHERE status = 'active')::int AS active_sessions,
        COUNT(*) FILTER (WHERE status <> 'active')::int AS inactive_sessions
      FROM ${tokenRef}
    `;
    const countsRes = await pool.query(countsSql);
    const counts = countsRes.rows[0] || {
      total_sessions: 0,
      active_sessions: 0,
      inactive_sessions: 0,
    };

    if (usersTable) {
      const userSchema = usersTable.table_schema;
      const userName = usersTable.table_name;
      const userRef = `${quoteIdentifier(userSchema)}.${quoteIdentifier(userName)}`;
      const userColumns = await getTableColumns(userSchema, userName);
      const usernameCol = resolveColumn(userColumns, ["username", "user_name"]);
      const userIdCol = resolveColumn(userColumns, ["user_id", "id"]);

      if (usernameCol && userIdCol) {
        // active_tokens.user_id is whatever login() put there — user_id if
        // the users table actually has that column populated, otherwise
        // username as a fallback (see authController.js's
        // `userIdForToken = user.user_id ?? user.username`). Most accounts
        // here have a NULL user_id column, so login sessions are keyed by
        // username in practice — joining on user_id alone left every one
        // of those rows unmatched, showing "Unknown user" for virtually
        // everyone. Matching on either covers both cases.
        const sessionsSql = `
          SELECT
            t.token_hash,
            u.${quoteIdentifier(usernameCol)} AS username,
            t.status,
            t.issued_at,
            t.expires_at,
            t.last_activity_time,
            t.ip_address,
            t.user_agent
          FROM ${tokenRef} t
          LEFT JOIN ${userRef} u
            ON t.user_id = u.${quoteIdentifier(userIdCol)}::text
            OR t.user_id = u.${quoteIdentifier(usernameCol)}
          ORDER BY t.last_activity_time DESC NULLS LAST
          LIMIT $1 OFFSET $2
        `;
        const sessionsRes = await pool.query(sessionsSql, [limit, offset]);
        recentSessions = sessionsRes.rows || [];
      }
    }

    return res.json({
      summary: {
        total_sessions: Number(counts.total_sessions) || 0,
        active_sessions: Number(counts.active_sessions) || 0,
        inactive_sessions: Number(counts.inactive_sessions) || 0,
        timestamp: now.toISOString(),
      },
      recent_sessions: recentSessions,
      page,
      limit,
      total_pages: Math.max(1, Math.ceil((Number(counts.total_sessions) || 0) / limit)),
    });
  } catch (err) {
    console.error("admin active_tokens summary error:", err);
    return res.status(500).json({ error: "Failed to load active token summary" });
  }
});

// Revoke a single session (e.g. "sign this device out") — identified by
// its token_hash, the same opaque value returned in recent_sessions above
// (a SHA-256 hash, not the actual bearer token, so returning it to the
// admin UI reveals nothing that could itself be used to log in).
router.patch("/active-tokens/:tokenHash/revoke", async (req, res) => {
  try {
    const tokenHash = String(req.params.tokenHash || "").trim();
    if (!tokenHash) return res.status(400).json({ error: "tokenHash is required" });
    const tokenTable = await findTableByName("active_tokens");
    if (!tokenTable) return res.status(404).json({ error: "active_tokens table not found" });
    const tokenRef = `${quoteIdentifier(tokenTable.table_schema)}.${quoteIdentifier(tokenTable.table_name)}`;
    const result = await pool.query(
      `UPDATE ${tokenRef} SET status = 'revoked_by_admin' WHERE token_hash = $1 AND status = 'active'`,
      [tokenHash]
    );
    if ((result.rowCount || 0) === 0) {
      return res.status(404).json({ error: "Session not found or already inactive" });
    }
    return res.json({ status: "ok" });
  } catch (err) {
    console.error("admin session revoke error:", err);
    return res.status(500).json({ error: "Failed to revoke session" });
  }
});

// Bulk cleanup — deletes every non-active row (logged_out, expired,
// inactivated, revoked, etc.) so the list doesn't grow forever with
// history nobody needs to keep. Never touches status='active' rows; use
// the single-session revoke above for those.
router.delete("/active-tokens/inactive", async (req, res) => {
  try {
    const tokenTable = await findTableByName("active_tokens");
    if (!tokenTable) return res.status(404).json({ error: "active_tokens table not found" });
    const tokenRef = `${quoteIdentifier(tokenTable.table_schema)}.${quoteIdentifier(tokenTable.table_name)}`;
    const result = await pool.query(`DELETE FROM ${tokenRef} WHERE status <> 'active'`);
    return res.json({ status: "ok", cleared: result.rowCount || 0 });
  } catch (err) {
    console.error("admin session cleanup error:", err);
    return res.status(500).json({ error: "Failed to clear inactive sessions" });
  }
});

export default router;
