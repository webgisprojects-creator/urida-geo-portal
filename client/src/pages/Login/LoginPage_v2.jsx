import React, { useState, useEffect } from "react";
import "./LoginPage_v2.css";
import ResponsiveImage from "../../components/ResponsiveImage";

const API_BASE_URL = "/api/auth";

/**
 * LoginPage_v2 - High Fidelity Wireframe Implementation
 * Based on DESIGN_AUDIT.md specifications.
 * 
 * Key Features:
 * - 3-Column Layout (Desktop) / Stacked (Mobile)
 * - Semantic HTML5 Structure
 * - Accessible Forms
 * - Optimized Images via ResponsiveImage component
 */
export default function LoginPage_v2() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch(`${API_BASE_URL}/profile`, { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) return null;
        const data = await res.json().catch(() => null);
        return data?.success ? data : null;
      })
      .then((data) => {
        if (!data?.user) return;
        const role = String(data.user?.role || "").toLowerCase();
        window.location.href = role === "admin" ? "/admin" : "/home";
      })
      .catch(() => {});
  }, []);

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    setMessage("");

    try {
      const response = await fetch(`${API_BASE_URL}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ username, password }),
      });

      if (!response.ok) {
        setMessage("Invalid username or password");
        return;
      }

      const profileRes = await fetch(`${API_BASE_URL}/profile`, { credentials: "include" });
      const profile = await profileRes.json().catch(() => ({}));
      if (!profileRes.ok || !profile?.success || !profile?.user) {
        setMessage("Login failed");
        return;
      }

      localStorage.setItem("authUser", String(profile.user.username || username || ""));
      if (profile.user.role != null) localStorage.setItem("authRole", String(profile.user.role));
      if (profile.user.city != null) localStorage.setItem("authCity", String(profile.user.city));
      const role = String(profile.user?.role || "").toLowerCase();
      setMessage("Login successful! Redirecting...");
      setTimeout(() => {
        window.location.href = role === "admin" ? "/admin" : "/home";
      }, 300);
    } catch (error) {
      console.error(error);
      setMessage("Server not reachable.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page-v2">
      {/* 1. HEADER SECTION */}
      <header className="header-v2">
        <div className="header-container">
          {/* Left Logo */}
          <div className="header-logo-wrapper">
             <ResponsiveImage 
                imageKey="Login/URIDA.PNG" 
                alt="URIDA Logo" 
                className="header-logo" 
                sizes="200px" 
             />
          </div>
          
          {/* Center Text (If image text is insufficient, we use H1, but keeping visual style) */}
          {/* Right Logo */}
          <div className="header-emblem-wrapper">
             {/* Assuming emblem is part of header image or separate asset */}
          </div>
        </div>
      </header>

      {/* 2. MAIN CONTENT GRID */}
      <main className="main-content-v2">
        
        {/* LEFT COLUMN: Hon'ble CM */}
        <section className="column-left">
          <div className="cm-profile-card">
            <div className="cm-image-container">
              {/* Yellow Circle Background via CSS */}
              <div className="cm-circle-bg"></div>
              <ResponsiveImage 
                imageKey="Login/CM-Yogi-PNG.png" 
                alt="Shri Yogi Adityanath" 
                className="cm-cutout-image" 
                sizes="(max-width: 768px) 200px, 300px" 
              />
            </div>
            <div className="cm-details">
              <h2 className="official-name-primary">Shri Yogi Adityanath</h2>
              <p className="official-title-primary">Hon'ble Chief Minister</p>
              <p className="official-state">Uttar Pradesh</p>
            </div>
          </div>
        </section>

        {/* CENTER COLUMN: Login Interaction */}
        <section className="column-center">
          <div className="login-card-container">
            {/* Background Road Image */}
            <div className="road-bg-wrapper">
              <ResponsiveImage 
                imageKey="Login/maxresdefault.jpg" 
                alt="Urban Road Infrastructure" 
                className="road-bg-image" 
                sizes="(max-width: 768px) 100vw, 50vw" 
              />
            </div>
            
            {/* Login Form Overlay */}
            <div className="login-form-overlay">
              <h3 className="login-heading">LOGIN</h3>
              <form onSubmit={handleLogin} className="login-form">
                <div className="input-group">
                  <input
                    type="text"
                    className="form-control"
                    placeholder="Username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    required
                    aria-label="Username"
                  />
                </div>
                <div className="input-group">
                  <input
                    type="password"
                    className="form-control"
                    placeholder="Password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    aria-label="Password"
                  />
                </div>
                
                <button type="submit" className="btn-submit" disabled={loading}>
                  {loading ? "AUTHENTICATING..." : "SUBMIT"}
                </button>
                
                {message && <div className="alert-message">{message}</div>}
              </form>
            </div>
          </div>
        </section>

        {/* RIGHT COLUMN: Officials List */}
        <section className="column-right">
          <div className="officials-grid">
            
            {/* Official 1: Minister */}
            <article className="official-card-v2">
              <div className="official-avatar-wrapper">
                <ResponsiveImage 
                  imageKey="Login/urida minister.png" 
                  alt="Shri Arvind Kumar Sharma" 
                  className="official-avatar" 
                  sizes="80px" 
                />
              </div>
              <div className="official-info">
                <h4 className="official-name">Shri Arvind Kumar Sharma</h4>
                <p className="official-role">Hon'ble Minister</p>
                <p className="official-dept">Urban Development Department, Uttar Pradesh</p>
              </div>
            </article>

            {/* Official 2: Minister of State */}
            <article className="official-card-v2">
              <div className="official-avatar-wrapper">
                <ResponsiveImage 
                  imageKey="Login/state_urban.png" 
                  alt="Shri Rakesh Rathor" 
                  className="official-avatar" 
                  sizes="80px" 
                />
              </div>
              <div className="official-info">
                <h4 className="official-name">Shri Rakesh Rathor</h4>
                <p className="official-role">Hon'ble Minister of State</p>
                <p className="official-dept">Urban Development Department, Uttar Pradesh</p>
              </div>
            </article>

            {/* Official 3: Principal Secretary */}
            <article className="official-card-v2">
              <div className="official-avatar-wrapper">
                <ResponsiveImage 
                  imageKey="Login/P_Guruprasad 1.jpg" 
                  alt="Shri P. Guruprasad" 
                  className="official-avatar" 
                  sizes="80px" 
                />
              </div>
              <div className="official-info">
                <h4 className="official-name">Shri P. Guruprasad (I.A.S.)</h4>
                <p className="official-role">Principal Secretary</p>
                <p className="official-dept">Urban Development Department, Urban Employment & Poverty Alleviation, Uttar Pradesh</p>
              </div>
            </article>

            {/* Official 4: CEO */}
            <article className="official-card-v2">
              <div className="official-avatar-wrapper">
                <ResponsiveImage 
                  imageKey="Login/ceo.png" 
                  alt="Shri Mahendra Bahadur Singh" 
                  className="official-avatar" 
                  sizes="80px" 
                />
              </div>
              <div className="official-info">
                <h4 className="official-name">Shri Mahendra Bahadur Singh (I.A.S.)</h4>
                <p className="official-role">CEO URIDA, Special Secretary</p>
                <p className="official-dept">Urban Development Department, Director of Urban Transport, Uttar Pradesh</p>
              </div>
            </article>

          </div>
        </section>

      </main>

      {/* 3. FOOTER SECTION */}
      <footer className="footer-v2">
        <div className="footer-content">
           <ResponsiveImage 
             imageKey="Login/rsac_banner.png" 
             alt="Developed by Remote Sensing Applications Centre, Uttar Pradesh" 
             className="footer-banner-img" 
             sizes="100vw" 
           />
        </div>
      </footer>
    </div>
  );
}
