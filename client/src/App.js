/* App routing and auth gating for login, home, and dashboard flows. */
import { BrowserRouter as Router, Routes, Route, Navigate } from "react-router-dom";
import LoginPage from "./pages/Login/LoginPage.jsx";
import HomePage from "./pages/HomePage/HomePage";
import Dashboard from "./pages/Dashboard";

function App() {
  const Protected = ({ children }) => {
    const token = localStorage.getItem("authToken");
    if (!token) return <Navigate to="/" replace />;
    return children;
  };
  return (
    <Router future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path="/" element={<LoginPage />} />
        <Route path="/home" element={<Protected><HomePage /></Protected>} />
        <Route path="/dashboard" element={<Protected><Dashboard /></Protected>} />
      </Routes>
    </Router>
  );
}

export default App;
