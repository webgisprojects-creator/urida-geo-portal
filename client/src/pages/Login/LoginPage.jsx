/* Login and session bootstrap for URIDA portal users. */
import React, { useState, useEffect } from "react";
import "./LoginPage.css";

const cmYogi = require("../../assets/Login/CM-Yogi-PNG.png");
const roadImage = require("../../assets/Login/maxresdefault.jpg");
const minister1 = require("../../assets/Login/urida minister.png");
const minister2 = require("../../assets/Login/state_urban.png");
const secretary = require("../../assets/Login/P_Guruprasad_1.jpg");
const secretarySmall = require("../../assets/Login/P_Guruprasad2.png");
const ceo = require("../../assets/Login/ceo1.png");
const ceoSmall = require("../../assets/Login/ceo.png");

// Original Monolithic Banners
const uridaLogo = require("../../assets/Login/URIDA.PNG");
const rsacBanner = require("../../assets/Login/rsac_banner.png");

const API_BASE_URL = "/api/auth";
const IP_HOSTNAME_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$/;

export default function LoginPage() {
  const [showLogin, setShowLogin] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const currentHostname = window.location.hostname;
  const isDirectIpHttps =
    window.location.protocol === "https:" &&
    IP_HOSTNAME_PATTERN.test(currentHostname);
  const directHttpUrl = `http://${currentHostname}:8060`;

  useEffect(() => {
    const token = localStorage.getItem("authToken");
    if (token) {
      window.location.href = "/home";
    }
  }, []);

  useEffect(() => {
    const rootEl = document.getElementById("root");
    document.body.classList.add("login-page");
    document.documentElement.classList.add("login-page");
    if (rootEl) {
      rootEl.classList.add("login-page");
    }
    return () => {
      document.body.classList.remove("login-page");
      document.documentElement.classList.remove("login-page");
      if (rootEl) {
        rootEl.classList.remove("login-page");
      }
    };
  }, []);

  useEffect(() => {
    if (isDirectIpHttps) {
      setMessage(`⚠️ Open ${directHttpUrl} for login. HTTPS on the raw IP is not trusted by the browser.`);
    }
  }, [directHttpUrl, isDirectIpHttps]);

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    setMessage("");

    try {
      const response = await fetch(`${API_BASE_URL}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      const data = await response.json();
      if (data.success) {
        localStorage.setItem("authToken", data.token);
        localStorage.setItem("authUser", username);
        setMessage("✅ Login successful! Redirecting...");
        setTimeout(() => {
          window.location.href = "/home"; // Redirect if needed
        }, 1000);
      } else {
        setMessage("❌ Invalid username or password");
      }
    } catch (error) {
      console.error(error);
      if (isDirectIpHttps) {
        setMessage(`⚠️ Login requests are blocked on ${window.location.origin}. Open ${directHttpUrl} and try again.`);
      } else {
        setMessage("⚠️ Server not reachable.");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-container">
      {/* HEADER MONOLITHIC */}
      <header className="header-native">
        <picture>
          <img src={uridaLogo} alt="URIDA Logo" />
        </picture>
      </header>

      {/* TITLE */}
      <div className="page-title-container">
        <h1 className="page-title">URBAN ROAD DIRECTORY PORTAL</h1>
      </div>

      {/* MAIN CONTENT */}
      <div className="main-content">
        {/* LEFT – CM */}
        <div className="left-side">
          <div className="img-wrap large-circle">
            <img src={cmYogi} alt="CM Yogi Adityanath" />
            <div className="img-caption">
              <span className="minister-name-large">Shri Yogi Adityanath</span>
              <p className="minister-title-large">
                Hon'ble Chief Minister
                <br />
                Uttar Pradesh
              </p>
            </div>
          </div>
        </div>

        {/* CENTER – Road Image and Login */}
        <div className="center-form">
          <div className="road-image-wrapper">
            <img src={roadImage} alt="Road" className="road-image" />
            <button
              className="login-button"
              onClick={() => setShowLogin(true)}
            >
              Nagar Nigam Login
            </button>
          </div>
        </div>

        {/* RIGHT – Minister Cards */}
        <div className="right-side">
          <div className="grid-images top-ministers">
            <div className="img-wrap small-circle">
              <img src={minister1} alt="Minister 1" />
              <div className="img-caption">
                <span className="minister-name">Shri Arvind Kumar Sharma</span>
                <p className="minister-title">
                  Hon'ble Minister
                  <br />
                  Urban Development Department, Uttar Pradesh
                </p>
              </div>
            </div>

            <div className="img-wrap small-circle">
              <img src={minister2} alt="Minister 2" />
              <div className="img-caption">
                <span className="minister-name">Shri Rakesh Rathor</span>
                <p className="minister-title">
                  Hon'ble Minister of State
                  <br />
                  Urban Development Department, Uttar Pradesh
                </p>
              </div>
            </div>
          </div>

          <div className="grid-images bottom-ias">
            <div className="img-wrap small-circle">
              <img
                src={secretary}
                srcSet={`${secretarySmall} 1x, ${secretary} 2x`}
                alt="Secretary"
              />
              <div className="img-caption">
                <span className="minister-name">Shri P Guruprasad (I.A.S.)</span>
                <p className="minister-title">
                  Principal Secretary, Urban Development Department,
                  <br />
                  Urban Employment & Poverty Alleviation, Uttar Pradesh
                </p>
              </div>
            </div>

            <div className="img-wrap small-circle">
              <img src={ceo} srcSet={`${ceoSmall} 1x, ${ceo} 2x`} alt="CEO" />
              <div className="img-caption">
                <span className="minister-name">Shri Mahendra Bahadur Singh (I.A.S.)</span>
                <p className="minister-title">
                  CEO URIDA, Special Secretary, Urban Development
                  <br />
                  Department, Director of Urban Transport, Uttar Pradesh
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* FOOTER MONOLITHIC */}
      <footer className="footer-native">
        <div className="footer-content">
          <img src={rsacBanner} alt="RSAC Banner" className="footer-banner" />
        </div>
      </footer>

      {/* LOGIN POPUP OVERLAY */}
      {showLogin && (
        <div className="login-overlay">
          <div className="login-modal">
            <button
              className="close-btn"
              onClick={() => setShowLogin(false)}
            >
              ✕
            </button>
            <h2 className="form__title">Login</h2>
            {message && <div className="form__message">{message}</div>}
            <form onSubmit={handleLogin}>
              <div className="form__input-group">
                <input
                  type="text"
                  placeholder="Username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="form__input"
                />
              </div>
              <div className="form__input-group">
                <input
                  type="password"
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="form__input"
                />
              </div>
              <button type="submit" className="form__button" disabled={loading}>
                {loading ? "Logging in..." : "Login"}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
