/* App routing and auth gating for login, home, and dashboard flows. */
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { Suspense, lazy, useCallback, useEffect, useMemo, useState, createContext, useContext } from "react";
import LoginPage from "./pages/Login/LoginPage.jsx";
import HomePage from "./pages/HomePage/HomePage";
import Dashboard from "./pages/Dashboard";
import AdminPanel from "./pages/AdminPanel/AdminPanel.jsx";
import ChainagePage from "./pages/ChainagePage";//chainage
import ForceChangePassword from "./pages/Login/ForceChangePassword.jsx";

const DSS = lazy(() => import("./components/DSS"));

const SessionContext = createContext({
  loading: true,
  user: null,
  refresh: async () => {},
});

const useSession = () => useContext(SessionContext);

function App() {
  useEffect(() => {
    localStorage.removeItem("authToken");
  }, []);

  const [session, setSession] = useState({ loading: true, user: null });

  useEffect(() => {
    if (session.loading || !session.user) return;
    const configuredIdleMs = Number(process.env.REACT_APP_SESSION_IDLE_TIMEOUT_MS);
    const defaultIdleMs = Number.isFinite(configuredIdleMs) && configuredIdleMs > 0
      ? configuredIdleMs
      : 15 * 60 * 1000;
    // The shared field-task "chainage" account is used across many short
    // KMC visits spread through a shift — the app's normal idle default
    // would log someone out mid-task far too aggressively for how this
    // account is actually used in the field.
    const isChainageAccount = String(session.user?.username || "").toLowerCase() === "chainage";
    const idleMs = isChainageAccount ? 30 * 60 * 1000 : defaultIdleMs;
    let idleTimer = null;
    let lastPingAt = 0;
    let lastActivityAt = Date.now();
    let logoutStarted = false;

    const doLogout = async () => {
      if (logoutStarted) return;
      logoutStarted = true;
      try {
        await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
      } catch {
      } finally {
        setSession({ loading: false, user: null });
        window.location.replace("/");
      }
    };

    const schedule = () => {
      if (idleTimer) clearTimeout(idleTimer);
      const elapsed = Date.now() - lastActivityAt;
      const remaining = Math.max(0, idleMs - elapsed);
      idleTimer = setTimeout(doLogout, remaining);
    };

    const maybePing = () => {
      const now = Date.now();
      if (now - lastPingAt < 60 * 1000) return;
      lastPingAt = now;
      fetch("/api/auth/profile", { credentials: "include" })
        .then((res) => {
          if (res.status === 401 || res.status === 403) doLogout();
        })
        .catch(() => {});
    };

    const onActivity = () => {
      lastActivityAt = Date.now();
      schedule();
      maybePing();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastActivityAt >= idleMs) {
        doLogout();
        return;
      }
      schedule();
      maybePing();
    };

    schedule();
    const events = ["mousemove", "mousedown", "keydown", "touchstart", "scroll"];
    events.forEach((evt) => window.addEventListener(evt, onActivity, { passive: true }));
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      if (idleTimer) clearTimeout(idleTimer);
      events.forEach((evt) => window.removeEventListener(evt, onActivity));
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [session.loading, session.user]);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/profile", { credentials: "include" });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          setSession({ loading: false, user: null });
        } else {
          setSession((prev) => ({ loading: false, user: prev.user }));
        }
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (data?.success && data?.user) {
        setSession({ loading: false, user: data.user });
      } else {
        setSession({ loading: false, user: null });
      }
    } catch {
      setSession((prev) => ({ loading: false, user: prev.user }));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const sessionValue = useMemo(
    () => ({ ...session, refresh }),
    [session.loading, session.user, refresh]
  );
//new
  // const Protected = ({ children }) => {
  //   const { loading, user } = useSession();
  //   if (loading) return null;
  //   if (!user) return <Navigate to="/" replace />;
  //   return children;
  // };
  const Protected = ({ children }) => {
  const { loading, user } = useSession();
  const location = useLocation();

  if (loading) return null;

  if (!user) {
    const redirectPath = location.pathname + location.search;

    // Field-task deep links (KMC/iGile redirects) can point either at the
    // legacy /chainage shim or directly at /dashboard?...&mode=CHAINAGE —
    // both carry the same kind of one-shot context (project_id, zone, ward,
    // latitude, longitude, user_id, title) that must survive the login
    // round trip, or the task is silently lost the moment someone hits the
    // link while logged out. Only these field-task links preserve their
    // full query string on redirect; other routes keep the old behavior.
    const isFieldTaskLink =
      location.pathname === "/chainage" ||
      new URLSearchParams(location.search).get("mode") === "CHAINAGE";
    if (isFieldTaskLink) {
      return (
        <Navigate
          to={`/?redirect=${encodeURIComponent(redirectPath)}`}
          replace
        />
      );
    }

    // Old behavior for home/dashboard/dss
    return <Navigate to="/" replace />;
  }

  // A temporary-password login (admin reset/generate-temp-password) sets
  // must_change_password server-side; login()/profile() surface it on the
  // session user. Block every protected route except the change-password
  // screen itself until it's cleared, so typing /home or /dashboard
  // directly can't skip the forced change the same way a normal redirect
  // already can't.
  if (user.must_change_password && location.pathname !== "/change-password") {
    return <Navigate to="/change-password" replace />;
  }

  return children;
};

  const AdminProtected = ({ children }) => {
    const { loading, user } = useSession();
    if (loading) return null;
    if (!user) return <Navigate to="/" replace />;
    const role = String(user?.role || "").toLowerCase();
    if (role !== "admin") return <Navigate to="/home" replace />;

    return children;
  };

  return (
    <SessionContext.Provider value={sessionValue}>
      <Router future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Suspense fallback={null}>
          <Routes>
            <Route
              path="/"
              element={
                session.loading ? null : session.user ? (
                  String(session.user?.role || "").toLowerCase() === "admin" ? (
                    <Navigate to="/admin" replace />
                  ) : (
                    <Navigate to="/home" replace />
                  )
                ) : (
                  <LoginPage />
                )
              }
            />
            <Route
              path="/home"
              element={
                <Protected>
                  <HomePage />
                </Protected>
              }
            />
            <Route
              path="/dashboard"
              element={
                <Protected>
                  <Dashboard />
                </Protected>
              }
            />
            <Route
              path="/dss"
              element={
                <Protected>
                  <DSS />
                </Protected>
              }
            />
            <Route
              path="/admin"
              element={
                <AdminProtected>
                  <AdminPanel />
                </AdminProtected>
              }
            />
            <Route
              path="/change-password"
              element={
                <Protected>
                  <ForceChangePassword />
                </Protected>
              }
            />
            {/* chainage */}
            <Route path="/chainage" element={<Protected><ChainagePage /></Protected>} />
          </Routes>
        </Suspense>
      </Router>
    </SessionContext.Provider>
  );
}

export default App;
