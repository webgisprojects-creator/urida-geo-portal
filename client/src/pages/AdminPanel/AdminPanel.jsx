import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import "./AdminPanel.css";
import rsacIcon from "../../assets/NN_Logo/rsac (1).png";
import Footer from "../../components/Footer";

export default function AdminPanel() {
  const navigate = useNavigate();
  const [users, setUsers] = useState([]);
  const [sessionSummary, setSessionSummary] = useState({
    total_sessions: 0,
    active_sessions: 0,
    inactive_sessions: 0,
  });
  const [recentSessions, setRecentSessions] = useState([]);
  const [sessionsPage, setSessionsPage] = useState(1);
  const [sessionsTotalPages, setSessionsTotalPages] = useState(1);
  const [sessionActionLoading, setSessionActionLoading] = useState({});
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState({});
  const [error, setError] = useState("");
  const [currentUser, setCurrentUser] = useState({ user_id: "", username: "" });
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [createFormError, setCreateFormError] = useState("");
  const [createForm, setCreateForm] = useState({
    username: "",
    email: "",
    password: "",
    role: "user",
    city: "",
  });
  const [roleModalOpen, setRoleModalOpen] = useState(false);
  const [roleFormError, setRoleFormError] = useState("");
  const [roleForm, setRoleForm] = useState({ userKey: "", username: "", role: "user" });
  const [resetModalOpen, setResetModalOpen] = useState(false);
  const [resetFormError, setResetFormError] = useState("");
  const [resetForm, setResetForm] = useState({ userKey: "", username: "", password: "" });
  // Set once reset-password succeeds so the modal can explain what happens
  // next (must_change_password is always set by this endpoint — see
  // adminRoutes.js) instead of just silently closing with no indication
  // of what the affected user will now experience at their next login.
  const [resetSuccessUsername, setResetSuccessUsername] = useState("");
  const [tempPasswordModalOpen, setTempPasswordModalOpen] = useState(false);
  const [tempPasswordError, setTempPasswordError] = useState("");
  const [tempPasswordData, setTempPasswordData] = useState({
    userKey: "",
    username: "",
    password: "",
  });
  const [selectedStatsView, setSelectedStatsView] = useState("total");

  const clearSession = () => {
    localStorage.removeItem("authToken");
    localStorage.removeItem("authUser");
    localStorage.removeItem("authRole");
    localStorage.removeItem("authCity");
  };

  const handleUnauthorized = () => {
    clearSession();
    window.location.replace("/");
  };

  const authFetch = async (url, options = {}) => {
    return fetch(url, { ...options, credentials: "include" });
  };

  const loadData = async (opts = {}) => {
    const { silent = false, sessionsPage: pageArg } = opts;
    const page = pageArg || sessionsPage;
    if (!silent) setLoading(true);
    setError("");
    try {
      const [usersRes, sessionRes, profileRes] = await Promise.all([
        authFetch("/api/admin/users"),
        authFetch(`/api/admin/active-tokens/summary?page=${page}&limit=15`),
        authFetch("/api/auth/profile"),
      ]);
      if (!usersRes.ok) {
        if (usersRes.status === 401 || usersRes.status === 403) throw new Error("Unauthorized");
        throw new Error("Failed to load users");
      }
      if (!sessionRes.ok) {
        if (sessionRes.status === 401 || sessionRes.status === 403) throw new Error("Unauthorized");
        throw new Error("Failed to load active sessions");
      }
      if (!profileRes.ok) {
        if (profileRes.status === 401 || profileRes.status === 403) throw new Error("Unauthorized");
        throw new Error("Failed to load profile");
      }
      const usersData = await usersRes.json();
      const sessionData = await sessionRes.json();
      const profileData = await profileRes.json();
      setUsers(Array.isArray(usersData?.users) ? usersData.users : []);
      setSessionSummary(sessionData?.summary || {});
      setRecentSessions(Array.isArray(sessionData?.recent_sessions) ? sessionData.recent_sessions : []);
      setSessionsTotalPages(Number(sessionData?.total_pages) || 1);
      setCurrentUser({
        user_id: String(profileData?.user?.id ?? profileData?.user?.user_id ?? ""),
        username: String(profileData?.user?.username || "").toLowerCase(),
      });
    } catch (err) {
      if (String(err?.message || "").toLowerCase().includes("unauthorized")) {
        handleUnauthorized();
        return;
      }
      setError(err?.message || "Failed to load admin data");
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionsPage]);

  // This page imports the shared <Footer/>, which pulls in Dashboard.css —
  // whose global `html, body, #root { overflow: hidden }` reset is meant
  // for the OpenLayers map pages (Dashboard/HomePage), which manage their
  // own internal scrolling. Admin is an ordinary scrolling page, not a
  // map, so that reset left anything below the fold (pagination, session
  // list, etc.) completely unreachable — no scrollbar existed anywhere on
  // the page to get to it. Same class-toggle pattern LoginPage.jsx already
  // uses for its own page-level override.
  useEffect(() => {
    const rootEl = document.getElementById("root");
    document.body.classList.add("admin-page-active");
    document.documentElement.classList.add("admin-page-active");
    if (rootEl) rootEl.classList.add("admin-page-active");
    return () => {
      document.body.classList.remove("admin-page-active");
      document.documentElement.classList.remove("admin-page-active");
      if (rootEl) rootEl.classList.remove("admin-page-active");
    };
  }, []);

  const handleRevokeSession = async (tokenHash) => {
    setSessionActionLoading((prev) => ({ ...prev, [tokenHash]: true }));
    try {
      const res = await authFetch(`/api/admin/active-tokens/${tokenHash}/revoke`, { method: "PATCH" });
      if (res.status === 401 || res.status === 403) return handleUnauthorized();
      await loadData({ silent: true });
    } catch {
      setError("Failed to revoke session");
    } finally {
      setSessionActionLoading((prev) => ({ ...prev, [tokenHash]: false }));
    }
  };

  const handleClearInactiveSessions = async () => {
    setSessionActionLoading((prev) => ({ ...prev, __clearAll: true }));
    try {
      const res = await authFetch("/api/admin/active-tokens/inactive", { method: "DELETE" });
      if (res.status === 401 || res.status === 403) return handleUnauthorized();
      setSessionsPage(1);
      await loadData({ silent: true, sessionsPage: 1 });
    } catch {
      setError("Failed to clear inactive sessions");
    } finally {
      setSessionActionLoading((prev) => ({ ...prev, __clearAll: false }));
    }
  };

  useEffect(() => {
    const push = () => {
      window.history.pushState({ admin_lock: true }, "", window.location.href);
    };
    push();
    const onPopState = () => {
      navigate("/admin", { replace: true });
      push();
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
    };
  }, [navigate]);

  const stats = useMemo(() => {
    const nonDeleted = users.filter((u) => !u?.deleted_at);
    const totalUsers = nonDeleted.length;
    const activeUsers = nonDeleted.filter((u) => u?.is_active === true).length;
    const inactiveUsers = nonDeleted.filter((u) => u?.is_active === false).length;
    const resetPending = nonDeleted.filter((u) => u?.must_change_password === true).length;
    return { totalUsers, activeUsers, inactiveUsers, resetPending };
  }, [users]);

  const getDisplayName = (u, idx = 0) =>
    String(u?.username || u?.user_name || u?.user_id || `User ${idx + 1}`);

  const sortUsersByName = (list) =>
    [...list].sort((a, b) =>
      getDisplayName(a).localeCompare(getDisplayName(b), undefined, { sensitivity: "base" })
    );

  const statsViewUsers = useMemo(() => {
    const nonDeletedUsers = users.filter((u) => !u?.deleted_at);
    if (!selectedStatsView) {
      return [];
    }
    if (selectedStatsView === "active") {
      return sortUsersByName(nonDeletedUsers.filter((u) => u?.is_active === true));
    }
    if (selectedStatsView === "inactive") {
      return sortUsersByName(nonDeletedUsers.filter((u) => u?.is_active === false));
    }
    if (selectedStatsView === "reset") {
      return sortUsersByName(nonDeletedUsers.filter((u) => u?.must_change_password === true));
    }
    return sortUsersByName(nonDeletedUsers);
  }, [users, selectedStatsView]);

  const statsViewTitle = useMemo(() => {
    if (!selectedStatsView) return "Select a tab to view users";
    if (selectedStatsView === "active") return "Active Users";
    if (selectedStatsView === "inactive") return "Inactive Users";
    if (selectedStatsView === "reset") return "Password Reset Pending Users";
    return "Total Users";
  }, [selectedStatsView]);

  const formatDate = (value) => {
    if (!value) return "-";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "-";
    return d.toLocaleString();
  };

  // Reduces a raw User-Agent string to a short, human-scannable device
  // label instead of dumping the entire UA string into the session list —
  // "which machine is this" only needs OS + browser, not every token.
  const formatDeviceLabel = (userAgent) => {
    const ua = String(userAgent || "");
    if (!ua) return "Unknown device";
    let os = "Unknown OS";
    if (/windows/i.test(ua)) os = "Windows";
    else if (/android/i.test(ua)) os = "Android";
    else if (/iphone|ipad|ios/i.test(ua)) os = "iOS";
    else if (/mac os/i.test(ua)) os = "macOS";
    else if (/linux/i.test(ua)) os = "Linux";
    let browser = "Unknown browser";
    if (/edg\//i.test(ua)) browser = "Edge";
    else if (/chrome\//i.test(ua)) browser = "Chrome";
    else if (/firefox\//i.test(ua)) browser = "Firefox";
    else if (/safari\//i.test(ua) && !/chrome/i.test(ua)) browser = "Safari";
    return `${os} · ${browser}`;
  };

  const getUserKey = (u) => String(u?.user_id ?? u?.id ?? "");
  const buildClientTemporaryPassword = (length = 12) => {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    const finalLength = Math.max(8, Number(length) || 12);
    const bytes = new Uint8Array(finalLength);
    if (window?.crypto?.getRandomValues) {
      window.crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < finalLength; i += 1) {
        bytes[i] = Math.floor(Math.random() * 256);
      }
    }
    let out = "";
    for (let i = 0; i < finalLength - 3; i += 1) {
      out += chars[bytes[i] % chars.length];
    }
    return `${out}A1!`;
  };
  const isSelfRow = (u) => {
    const id = String(u?.id ?? "");
    const userId = String(u?.user_id ?? "");
    const uname = String(u?.username ?? u?.user_name ?? "").toLowerCase();
    return (
      (currentUser.user_id && (currentUser.user_id === id || currentUser.user_id === userId)) ||
      (currentUser.username && currentUser.username === uname)
    );
  };

  const runAction = async (key, fn) => {
    setActionLoading((prev) => ({ ...prev, [key]: true }));
    setError("");
    let success = false;
    try {
      await fn();
      await loadData({ silent: true });
      success = true;
    } catch (err) {
      if (String(err?.message || "").toLowerCase().includes("unauthorized")) {
        handleUnauthorized();
        return false;
      }
      setError(err?.message || "Action failed");
    } finally {
      setActionLoading((prev) => ({ ...prev, [key]: false }));
    }
    return success;
  };

  const openCreateUserModal = async () => {
    try {
      const profileRes = await authFetch("/api/auth/profile");
      if (!profileRes.ok) {
        if (profileRes.status === 401 || profileRes.status === 403) {
          handleUnauthorized();
          return;
        }
        throw new Error("Failed to load profile");
      }
      const profileData = await profileRes.json();
      const isValid = Boolean(profileData?.success);
      const role = String(profileData?.user?.role || "").toLowerCase();
      if (!isValid || role !== "admin") {
        navigate("/home", { replace: true });
        return;
      }
    } catch (err) {
      if (String(err?.message || "").toLowerCase().includes("unauthorized")) {
        handleUnauthorized();
        return;
      }
      setError(err?.message || "Failed to open create user modal");
      return;
    }
    setCreateForm({
      username: "",
      email: "",
      password: "",
      role: "user",
      city: "",
    });
    setCreateFormError("");
    setCreateModalOpen(true);
  };

  const handleCreateInputChange = (event) => {
    const { name, value } = event.target;
    setCreateForm((prev) => ({ ...prev, [name]: value }));
  };

  const handleCreateSubmit = async (event) => {
    event.preventDefault();
    const username = String(createForm.username || "").trim();
    const password = String(createForm.password || "");
    const role = String(createForm.role || "user").trim().toLowerCase();
    const email = String(createForm.email || "").trim();
    const city = String(createForm.city || "").trim();
    if (!username) {
      setCreateFormError("Username is required");
      return;
    }
    if (password.length < 6) {
      setCreateFormError("Password must be at least 6 characters");
      return;
    }
    if (!role) {
      setCreateFormError("Role is required");
      return;
    }
    setCreateFormError("");
    const created = await runAction("create-user", async () => {
      const res = await authFetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username,
          password,
          email,
          role,
          city: city || null,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 401) throw new Error("Unauthorized");
        throw new Error(data?.error || "Failed to create user");
      }
    });
    if (created) {
      setCreateModalOpen(false);
    }
  };

  const handleSetActive = async (u, isActive) => {
    const key = getUserKey(u);
    if (!key) return;
    await runAction(`status-${key}`, async () => {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(key)}/status`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: isActive }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 401) throw new Error("Unauthorized");
        throw new Error(data?.error || "Failed to update status");
      }
    });
  };

  const handleRoleUpdate = async (u) => {
    const key = getUserKey(u);
    if (!key) return;
    setRoleForm({
      userKey: key,
      username: getDisplayName(u),
      role: String(u?.role || "user").toLowerCase(),
    });
    setRoleFormError("");
    setRoleModalOpen(true);
  };

  const submitRoleUpdate = async (event) => {
    event.preventDefault();
    const key = String(roleForm.userKey || "");
    const nextRole = String(roleForm.role || "").trim().toLowerCase();
    if (!key) {
      setRoleFormError("Invalid user selected");
      return;
    }
    if (!nextRole) {
      setRoleFormError("Role is required");
      return;
    }
    const updated = await runAction(`role-${key}`, async () => {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(key)}/role`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: nextRole }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 401) throw new Error("Unauthorized");
        throw new Error(data?.error || "Failed to update role");
      }
    });
    if (updated) {
      setRoleModalOpen(false);
    }
  };

  const handleResetPassword = async (u) => {
    const key = getUserKey(u);
    if (!key) return;
    setResetForm({
      userKey: key,
      username: getDisplayName(u),
      password: "",
    });
    setResetFormError("");
    setResetSuccessUsername("");
    setResetModalOpen(true);
  };

  const submitResetPassword = async (event) => {
    event.preventDefault();
    const key = String(resetForm.userKey || "");
    const newPassword = String(resetForm.password || "");
    if (!key) {
      setResetFormError("Invalid user selected");
      return;
    }
    if (newPassword.length < 6) {
      setResetFormError("Password must be at least 6 characters");
      return;
    }
    const reset = await runAction(`pass-${key}`, async () => {
      const res = await authFetch(`/api/admin/users/${encodeURIComponent(key)}/reset-password`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ new_password: newPassword }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 401) throw new Error("Unauthorized");
        throw new Error(data?.error || "Failed to reset password");
      }
    });
    if (reset) {
      // Stay open long enough to show what happens next — this endpoint
      // always sets must_change_password (see adminRoutes.js), so the
      // affected user is forced through the "set a new password" screen
      // at their very next login, they don't land in the dashboard with
      // this password permanently.
      setResetSuccessUsername(resetForm.username);
    }
  };

  const handleDeleteUser = async (u) => {
    const key = getUserKey(u);
    if (!key) return;
    const ok = window.confirm(`Delete user ${u?.username || key}?`);
    if (!ok) return;
    await runAction(`delete-${key}`, async () => {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(key)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 401) throw new Error("Unauthorized");
        throw new Error(data?.error || "Failed to delete user");
      }
    });
  };

  const handleGenerateTempPassword = async (u) => {
    const key = getUserKey(u);
    if (!key) return;
    setTempPasswordError("");
    setTempPasswordData({
      userKey: key,
      username: getDisplayName(u),
      password: "",
    });
    setTempPasswordModalOpen(true);
    await runAction(`temp-pass-${key}`, async () => {
      const encodedKey = encodeURIComponent(key);
      let data = {};
      let routeMatched = false;
      for (const endpoint of ["generate-temp-password", "temp-password"]) {
        const res = await fetch(`/api/admin/users/${encodedKey}/${endpoint}`, {
          method: "POST",
          credentials: "include",
        });
        data = await res.json().catch(() => ({}));
        if (res.ok) {
          routeMatched = true;
          break;
        }
        if (res.status === 401) throw new Error("Unauthorized");
        if (res.status !== 404) {
          throw new Error(data?.error || "Failed to generate temporary password");
        }
      }

      if (!routeMatched) {
        // Compatibility fallback: if temp-password routes are missing on current server,
        // generate on client and persist via existing reset-password endpoint.
        const generatedPassword = buildClientTemporaryPassword(12);
        const resetRes = await authFetch(`/api/admin/users/${encodedKey}/reset-password`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ new_password: generatedPassword }),
        });
        const resetData = await resetRes.json().catch(() => ({}));
        if (!resetRes.ok) {
          if (resetRes.status === 401) throw new Error("Unauthorized");
          throw new Error(resetData?.error || "Failed to generate temporary password");
        }
        setTempPasswordData({
          userKey: key,
          username: getDisplayName(u),
          password: generatedPassword,
        });
        return;
      }

      const tempPass = String(data?.temporary_password || "");
      if (!tempPass) {
        throw new Error("Temporary password was not returned by server");
      }
      setTempPasswordData({
        userKey: key,
        username: getDisplayName(u),
        password: tempPass,
      });
    });
  };

  const handleLogout = async () => {
    try {
      await authFetch("/api/auth/logout", { method: "POST" });
    } catch {
    } finally {
      clearSession();
      window.location.replace("/");
    }
  };

  const renderUsersTable = (list, options = {}) => {
    const { isDeletedPartition = false } = options;
    return (
    <table>
      <thead>
        <tr>
          <th>S.No.</th>
          <th>Name</th>
          <th>Role</th>
          <th>City</th>
          <th>Status</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {list.map((u, idx) => {
          const key = getUserKey(u) || `row-${idx}`;
          const statusBusy = !!actionLoading[`status-${key}`];
          const roleBusy = !!actionLoading[`role-${key}`];
          const passBusy = !!actionLoading[`pass-${key}`];
          const tempPassBusy = !!actionLoading[`temp-pass-${key}`];
          const deleteBusy = !!actionLoading[`delete-${key}`];
          const isInactive = !u.is_active;
          const isSelf = isSelfRow(u);
          const isDeleted = isDeletedPartition || !!u?.deleted_at;
          return (
            <tr key={key}>
              <td>{idx + 1}</td>
              <td>
                {getDisplayName(u, idx)}
                <div className="muted">
                  {u.email || "-"}
                  {isDeleted && u?.deleted_at ? ` | deleted: ${formatDate(u.deleted_at)}` : ""}
                </div>
              </td>
              <td>{u.role || "-"}</td>
              <td>{u.city || "-"}</td>
              <td>
                <span className={`badge ${isDeleted ? "deleted" : u.is_active ? "active" : "inactive"}`}>
                  {isDeleted ? "deleted" : u.is_active ? "active" : "inactive"}
                </span>
              </td>
              <td className="actions">
                <button
                  type="button"
                  disabled={isDeleted || u.is_active || statusBusy}
                  onClick={() => handleSetActive(u, true)}
                >
                  Activate
                </button>
                <button
                  type="button"
                  disabled={isDeleted || !u.is_active || statusBusy || isSelf}
                  onClick={() => handleSetActive(u, false)}
                  title={isSelf ? "You cannot deactivate your own account" : ""}
                >
                  Deactivate
                </button>
                <button
                  type="button"
                  disabled={isDeleted || isInactive || roleBusy || statusBusy}
                  onClick={() => handleRoleUpdate(u)}
                >
                  Permissions
                </button>
                <button
                  type="button"
                  disabled={isDeleted || isInactive || passBusy || statusBusy}
                  onClick={() => handleResetPassword(u)}
                >
                  Reset Password
                </button>
                <button
                  type="button"
                  disabled={isDeleted || isInactive || tempPassBusy || statusBusy}
                  onClick={() => handleGenerateTempPassword(u)}
                >
                  {tempPassBusy ? "Generating..." : "Temp Password"}
                </button>
                <button
                  className="danger"
                  type="button"
                  disabled={isDeleted || isInactive || deleteBusy || statusBusy || isSelf}
                  onClick={() => handleDeleteUser(u)}
                  title={isSelf ? "You cannot delete your own account" : ""}
                >
                  Delete
                </button>
              </td>
            </tr>
          );
        })}
        {!loading && list.length === 0 && (
          <tr>
            <td colSpan="6" className="muted">
              No users found
            </td>
          </tr>
        )}
      </tbody>
    </table>
    );
  };

  return (
    <div className="admin-page">
      <header className="admin-header">
        <div className="admin-header-title">
          <img src={rsacIcon} alt="RSAC" className="admin-header-logo" />
          <h2>RSAC Admin Control Panel</h2>
        </div>
        <div className="admin-header-actions">
          <button className="secondary-btn" type="button" onClick={() => navigate("/home")}>
            Home
          </button>
          <button className="secondary-btn" type="button" onClick={handleLogout}>
            Logout
          </button>
          <button
            className="primary-btn"
            type="button"
            onClick={openCreateUserModal}
            disabled={!!actionLoading["create-user"]}
          >
            {actionLoading["create-user"] ? "Creating..." : "+ Create User"}
          </button>
        </div>
      </header>

      <section className="main-grid">
        <div className="panel">
          <h3>User Management {loading ? "(Loading...)" : ""}</h3>
          <div className="user-partition-heading">
            {selectedStatsView ? `${statsViewTitle} (${statsViewUsers.length})` : statsViewTitle}
          </div>
          {!selectedStatsView ? (
            <div className="muted">Click a top tab/card to view related users.</div>
          ) : (
            <div className="user-table-scroll">
              {renderUsersTable(statsViewUsers)}
            </div>
          )}
        </div>

        <div className="panel session-overview-panel">
          <h3>Session Overview (active_tokens)</h3>
          <div className="perm-box">
            <p>
              <strong>Total Sessions:</strong> {sessionSummary?.total_sessions || 0}
            </p>
            <p>
              <strong>Active Sessions:</strong> {sessionSummary?.active_sessions || 0}
            </p>
            <p>
              <strong>Inactive Sessions:</strong> {sessionSummary?.inactive_sessions || 0}
            </p>
          </div>
        </div>
      </section>

      <section className="stats-grid">
        <button
          type="button"
          className={`card stat-card ${selectedStatsView === "total" ? "active" : ""}`}
          onClick={() => setSelectedStatsView("total")}
        >
          <h4>Total Users</h4>
          <p>{stats.totalUsers}</p>
        </button>
        <button
          type="button"
          className={`card stat-card ${selectedStatsView === "active" ? "active" : ""}`}
          onClick={() => setSelectedStatsView("active")}
        >
          <h4>Active Users</h4>
          <p className="ok">{stats.activeUsers}</p>
        </button>
        <button
          type="button"
          className={`card stat-card ${selectedStatsView === "inactive" ? "active" : ""}`}
          onClick={() => setSelectedStatsView("inactive")}
        >
          <h4>Inactive Users</h4>
          <p className="bad">{stats.inactiveUsers}</p>
        </button>
        <button
          type="button"
          className={`card stat-card ${selectedStatsView === "reset" ? "active" : ""}`}
          onClick={() => setSelectedStatsView("reset")}
        >
          <h4>Password Reset Pending</h4>
          <p>{stats.resetPending}</p>
        </button>
      </section>
      {error && <div className="admin-error">{error}</div>}

      <section className="panel recent-session-panel">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <h3 style={{ margin: 0 }}>Recent Session Activity</h3>
          <button
            type="button"
            className="danger"
            disabled={!!sessionActionLoading.__clearAll}
            onClick={handleClearInactiveSessions}
            title="Permanently deletes every non-active session record (logged out, expired, revoked). Active sessions are never touched."
          >
            {sessionActionLoading.__clearAll ? "Clearing..." : "Clear Inactive History"}
          </button>
        </div>
        {/* Same scroll container the users table uses (min(320px, 40vh) —
            see AdminPanel.css) so this scrolls internally instead of
            pushing the rest of the panel/page past the viewport, paired
            with server-side pagination (15/page) rather than loading
            everything at once. */}
        <div className="user-table-scroll" style={{ height: "min(320px, 40vh)", maxHeight: "min(320px, 40vh)" }}>
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th>Status</th>
                <th>Last Active</th>
                <th>Device</th>
                <th>IP</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {recentSessions.map((row) => (
                <tr key={row.token_hash}>
                  <td>{row.username || "Unknown user"}</td>
                  <td>
                    <span className={`badge ${row.status === "active" ? "active" : "inactive"}`}>
                      {row.status || "-"}
                    </span>
                  </td>
                  <td>{formatDate(row.last_activity_time)}</td>
                  <td className="muted">{formatDeviceLabel(row.user_agent)}</td>
                  <td className="muted">{row.ip_address || "-"}</td>
                  <td className="actions">
                    {row.status === "active" && (
                      <button
                        type="button"
                        className="danger"
                        disabled={!!sessionActionLoading[row.token_hash]}
                        onClick={() => handleRevokeSession(row.token_hash)}
                        title="Sign this specific session out"
                      >
                        {sessionActionLoading[row.token_hash] ? "..." : "Sign Out"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {!loading && recentSessions.length === 0 && (
                <tr>
                  <td colSpan="6" className="muted">No recent sessions found</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {sessionsTotalPages > 1 && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, marginTop: 8 }}>
            <button
              type="button"
              disabled={sessionsPage <= 1}
              onClick={() => setSessionsPage((p) => Math.max(1, p - 1))}
            >
              Prev
            </button>
            <span style={{ fontSize: 13, color: "#475569" }}>
              Page {sessionsPage} of {sessionsTotalPages}
            </span>
            <button
              type="button"
              disabled={sessionsPage >= sessionsTotalPages}
              onClick={() => setSessionsPage((p) => Math.min(sessionsTotalPages, p + 1))}
            >
              Next
            </button>
          </div>
        )}
      </section>
      {createModalOpen && (
        <div className="admin-modal-overlay" onClick={() => setCreateModalOpen(false)}>
          <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
            <div className="admin-modal-header">
              <h3>Create User</h3>
              <button
                type="button"
                className="admin-modal-close"
                onClick={() => setCreateModalOpen(false)}
              >
                ×
              </button>
            </div>
            <form className="admin-form" onSubmit={handleCreateSubmit}>
              <label>
                Username
                <input
                  name="username"
                  value={createForm.username}
                  onChange={handleCreateInputChange}
                  placeholder="Enter username"
                  required
                />
              </label>
              <label>
                Email
                <input
                  name="email"
                  type="email"
                  value={createForm.email}
                  onChange={handleCreateInputChange}
                  placeholder="Enter email"
                />
              </label>
              <label>
                Password
                <input
                  name="password"
                  type="password"
                  value={createForm.password}
                  onChange={handleCreateInputChange}
                  placeholder="Temporary password"
                  minLength={6}
                  required
                />
              </label>
              <label>
                Role
                <select name="role" value={createForm.role} onChange={handleCreateInputChange}>
                  <option value="user">user</option>
                  <option value="admin">admin</option>
                  <option value="viewer">viewer</option>
                  <option value="manager">manager</option>
                </select>
              </label>
              <label>
                City
                <input
                  name="city"
                  value={createForm.city}
                  onChange={handleCreateInputChange}
                  placeholder="Enter city"
                />
              </label>
              {createFormError && <div className="admin-form-error">{createFormError}</div>}
              <div className="admin-form-actions">
                <button type="button" className="secondary-btn" onClick={() => setCreateModalOpen(false)}>
                  Cancel
                </button>
                <button type="submit" className="primary-btn" disabled={!!actionLoading["create-user"]}>
                  {actionLoading["create-user"] ? "Creating..." : "Create User"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {roleModalOpen && (
        <div className="admin-modal-overlay" onClick={() => setRoleModalOpen(false)}>
          <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
            <div className="admin-modal-header">
              <h3>Update Permissions / Role</h3>
              <button
                type="button"
                className="admin-modal-close"
                onClick={() => setRoleModalOpen(false)}
              >
                ×
              </button>
            </div>
            <form className="admin-form admin-form-single" onSubmit={submitRoleUpdate}>
              <label>
                User
                <input value={roleForm.username} readOnly />
              </label>
              <label>
                Role / Permission Group
                <select
                  value={roleForm.role}
                  onChange={(e) => setRoleForm((prev) => ({ ...prev, role: e.target.value }))}
                >
                  <option value="user">user</option>
                  <option value="admin">admin</option>
                  <option value="viewer">viewer</option>
                  <option value="manager">manager</option>
                </select>
              </label>
              {roleFormError && <div className="admin-form-error">{roleFormError}</div>}
              <div className="admin-form-actions">
                <button type="button" className="secondary-btn" onClick={() => setRoleModalOpen(false)}>
                  Cancel
                </button>
                <button type="submit" className="primary-btn" disabled={!!actionLoading[`role-${roleForm.userKey}`]}>
                  {actionLoading[`role-${roleForm.userKey}`] ? "Updating..." : "Update"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {resetModalOpen && (
        <div className="admin-modal-overlay" onClick={() => setResetModalOpen(false)}>
          <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
            <div className="admin-modal-header">
              <h3>Reset Password</h3>
              <button
                type="button"
                className="admin-modal-close"
                onClick={() => setResetModalOpen(false)}
              >
                ×
              </button>
            </div>
            {resetSuccessUsername ? (
              <div className="admin-form admin-form-single">
                <div className="admin-form-success">
                  Password reset for <strong>{resetSuccessUsername}</strong>.
                  <br />
                  They must sign in with this new password — the portal will
                  immediately require them to set a password of their own
                  choosing before they can reach their dashboard. Share the
                  new password with them through a secure channel; it isn't
                  saved anywhere for you to look up again.
                </div>
                <div className="admin-form-actions">
                  <button type="button" className="primary-btn" onClick={() => setResetModalOpen(false)}>
                    Done
                  </button>
                </div>
              </div>
            ) : (
            <form className="admin-form admin-form-single" onSubmit={submitResetPassword}>
              <label>
                User
                <input value={resetForm.username} readOnly />
              </label>
              <label>
                New Password
                <input
                  type="password"
                  minLength={6}
                  value={resetForm.password}
                  onChange={(e) => setResetForm((prev) => ({ ...prev, password: e.target.value }))}
                  placeholder="Enter new password"
                  required
                />
              </label>
              {resetFormError && <div className="admin-form-error">{resetFormError}</div>}
              <div className="admin-form-actions">
                <button type="button" className="secondary-btn" onClick={() => setResetModalOpen(false)}>
                  Cancel
                </button>
                <button type="submit" className="primary-btn" disabled={!!actionLoading[`pass-${resetForm.userKey}`]}>
                  {actionLoading[`pass-${resetForm.userKey}`] ? "Resetting..." : "Reset Password"}
                </button>
              </div>
            </form>
            )}
          </div>
        </div>
      )}
      {tempPasswordModalOpen && (
        <div className="admin-modal-overlay" onClick={() => setTempPasswordModalOpen(false)}>
          <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
            <div className="admin-modal-header">
              <h3>Temporary Password</h3>
              <button
                type="button"
                className="admin-modal-close"
                onClick={() => setTempPasswordModalOpen(false)}
              >
                ×
              </button>
            </div>
            <div className="admin-form admin-form-single">
              <label>
                User
                <input value={tempPasswordData.username} readOnly />
              </label>
              <label>
                One-Time Temporary Password
                {/* Auto-generated server-side, deliberately read-only — this
                    is a value to copy and hand to the user, not a password
                    you choose yourself. Use "Reset Password" instead if you
                    want to set a specific password. */}
                <input value={tempPasswordData.password || (tempPasswordError ? "" : "Generating...")} readOnly />
              </label>
              {tempPasswordError && <div className="admin-form-error">{tempPasswordError}</div>}
              {tempPasswordData.password && (
                <div className="admin-form-success">
                  Copy this password and share it with <strong>{tempPasswordData.username}</strong> through
                  a secure channel — it won't be shown again. They must sign in with it, and the portal will
                  immediately require them to set a password of their own choosing before they can reach
                  their dashboard.
                </div>
              )}
              <div className="admin-form-actions">
                <button type="button" className="secondary-btn" onClick={() => setTempPasswordModalOpen(false)}>
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      <Footer />
    </div>
  );
}
