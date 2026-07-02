/* App routing and auth gating for login, home, and dashboard flows. */
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { Suspense, lazy, useCallback, useEffect, useMemo, useState, createContext, useContext } from "react";
import LoginPage from "./pages/Login/LoginPage.jsx";
import HomePage from "./pages/HomePage/HomePage";
import Dashboard from "./pages/Dashboard";
import AdminPanel from "./pages/AdminPanel/AdminPanel.jsx";
import ChainagePage from "./pages/ChainagePage";//chainage

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
    const idleMs = 15 * 60 * 1000;
    let idleTimer = null;
    let lastPingAt = 0;

    const doLogout = async () => {
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
      idleTimer = setTimeout(doLogout, idleMs);
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
      schedule();
      maybePing();
    };

    schedule();
    const events = ["mousemove", "mousedown", "keydown", "touchstart", "scroll"];
    events.forEach((evt) => window.addEventListener(evt, onActivity, { passive: true }));
    return () => {
      if (idleTimer) clearTimeout(idleTimer);
      events.forEach((evt) => window.removeEventListener(evt, onActivity));
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

    // Only chainage should preserve redirect params
    if (location.pathname === "/chainage") {
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
            {/* chainage */}
            <Route path="/chainage" element={<Protected><ChainagePage /></Protected>} />
          </Routes>
        </Suspense>
      </Router>
    </SessionContext.Provider>
  );
}

export default App;
