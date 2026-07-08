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

export default function LoginPage() {
  const [showLogin, setShowLogin] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [captcha, setCaptcha] = useState("");
  const [captchaImage, setCaptchaImage] = useState("");
  const [captchaLoading, setCaptchaLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  const handleCaptchaAudio = () => {
    setMessage("Please enter the characters shown in the CAPTCHA image.");
    if (!("speechSynthesis" in window) || !captchaImage) return;
    const utterance = new SpeechSynthesisUtterance(
      "Please enter the characters shown in the captcha image."
    );
    utterance.rate = 0.9;
    utterance.pitch = 1;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  };

  const loadCaptcha = async () => {
    setCaptchaLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/captcha`, { credentials: "include" });
      const data = await response.json().catch(() => ({}));
      setCaptchaImage(String(data?.captcha?.image || ""));
      setCaptcha("");
    } catch {
      setCaptchaImage("");
    } finally {
      setCaptchaLoading(false);
    }
  };

  useEffect(() => {
    const push = () => {
      window.history.pushState({ portal_lock: true }, "", window.location.href);
    };

    push();
    const onPopState = () => {
      push();
    };

    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
    };
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
    if (showLogin) {
      loadCaptcha();
    }
  }, [showLogin]);

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    setMessage("");

    // Passed straight through to the backend, which uses it to confirm a
    // shared field-task account (e.g. "chainage") is actually being used as
    // part of a KMC/iGile redirect and not typed into this form directly —
    // see authController.js's login() for the actual gate.
    const redirectContext = new URLSearchParams(window.location.search).get("redirect");

    try {
      const response = await fetch(`${API_BASE_URL}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ username, password, captcha, redirect: redirectContext }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setMessage(String(data?.message || "Invalid login details."));
        await loadCaptcha();
        return;
      }

      const profileRes = await fetch(`${API_BASE_URL}/profile`, { credentials: "include" });
      const profile = await profileRes.json().catch(() => ({}));
      if (!profileRes.ok || !profile?.success || !profile?.user) {
        setMessage("Login failed.");
        await loadCaptcha();
        return;
      }

      localStorage.setItem("authUser", String(profile.user.username || username || ""));
      if (profile.user.role != null) localStorage.setItem("authRole", String(profile.user.role));
      if (profile.user.city != null) localStorage.setItem("authCity", String(profile.user.city));
//new
      // const role = String(profile.user.role || "").toLowerCase();
      // const target = role === "admin" ? "/admin" : "/home";

      // setMessage("Login successful. Redirecting...");
      // setTimeout(() => {
      //   window.location.href = target;
      // }, 300);
      const role = String(profile.user.role || "").toLowerCase();

const params = new URLSearchParams(window.location.search);
const redirect = params.get("redirect");

const safeRedirect =
  redirect &&
  redirect.startsWith("/") &&
  !redirect.startsWith("//")
    ? redirect
    : null;

const target = safeRedirect || (role === "admin" ? "/admin" : "/home");

setMessage("Login successful. Redirecting...");
setTimeout(() => {
  window.location.href = target;
}, 300);
    } catch (error) {
      console.error(error);
      setMessage("Server not reachable. Please try again.");
      await loadCaptcha();
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
        {/* LEFT â€“ CM */}
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

        {/* CENTER â€“ Road Image and Login */}
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

        {/* RIGHT â€“ Minister Cards */}
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
              <div className="form__input-group">
                <div className="captcha-panel">
                  <div className="captcha-visual">
                    {captchaImage ? (
                      <img
                        src={captchaImage}
                        alt="CAPTCHA challenge"
                        className="captcha-image"
                      />
                    ) : (
                      <div className="captcha-placeholder">
                        {captchaLoading ? "Loading CAPTCHA..." : "CAPTCHA unavailable"}
                      </div>
                    )}
                  </div>
                  <div className="captcha-actions">
                    <button
                      type="button"
                      className="captcha-action-btn"
                      onClick={handleCaptchaAudio}
                      disabled={captchaLoading || loading}
                      aria-label="CAPTCHA instructions"
                      title="CAPTCHA instructions"
                    >
                      <i className="fa-solid fa-volume-high" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="captcha-action-btn"
                      onClick={loadCaptcha}
                      disabled={captchaLoading || loading}
                      aria-label="Refresh CAPTCHA"
                      title="Refresh CAPTCHA"
                    >
                      <i className="fa-solid fa-rotate-right" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              </div>
              <div className="form__input-group">
                <input
                  type="text"
                  placeholder="Enter CAPTCHA"
                  value={captcha}
                  onChange={(e) => setCaptcha(e.target.value)}
                  className="form__input"
                  autoComplete="off"
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
