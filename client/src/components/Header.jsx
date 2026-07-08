/* Header bar with navigation, hamburger menu, download menu, and profile actions. */
import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import rsacLogo from "../assets/NN_Logo/images.jpg";
import hamburgerIcon from "../assets/Amenities_Icons/hamburger.icon.png";
import { cityConfig } from "../assets/configs/cityConfig";
import "../assets/styles/Dashboard.css";

// Import all city logos at once
import agraLogo from "../assets/NN_Logo/agra-logo.jpg";
import aligarhLogo from "../assets/NN_Logo/aligarh-logo.png";
import ayodhyaLogo from "../assets/NN_Logo/ayodhya.jpeg";
import bareillyLogo from "../assets/NN_Logo/bnn-logo.png";
import firozabadLogo from "../assets/NN_Logo/firozabad_logo.jpg";
import ghaziabadLogo from "../assets/NN_Logo/ghaziabad-logo.png";
import gorakhpurLogo from "../assets/NN_Logo/goakhnn.png";
import jhansiLogo from "../assets/NN_Logo/jhansi-logo.jpg";
import kanpurLogo from "../assets/NN_Logo/Kanpur_logo.jpg";
import lucknowLogo from "../assets/NN_Logo/lko.png";
import mathuraLogo from "../assets/NN_Logo/mathura_logo.jpg";
import meerutLogo from "../assets/NN_Logo/Meerut.jpg";
import moradabadLogo from "../assets/NN_Logo/moradabad.png";
import prayagLogo from "../assets/NN_Logo/Prayag_logo.jpg";
import saharanpurLogo from "../assets/NN_Logo/saharanpur-logo.png";
import shahjahapurLogo from "../assets/NN_Logo/shahjahanpur.png";
import varanasiLogo from "../assets/NN_Logo/varanasi1_logo.jpg";

const cityLogos = {
  agra: agraLogo,
  aligarh: aligarhLogo,
  ayodhya: ayodhyaLogo,
  bareilly: bareillyLogo,
  firozabad: firozabadLogo,
  ghaziabad: ghaziabadLogo,
  gorakhpur: gorakhpurLogo,
  jhansi: jhansiLogo,
  kanpur: kanpurLogo,
  lucknow: lucknowLogo,
  mathura: mathuraLogo,
  meerut: meerutLogo,
  moradabad: moradabadLogo,
  prayagraj: prayagLogo,
  saharanpur: saharanpurLogo,
  shahjahapur: shahjahapurLogo,
  varanasi: varanasiLogo,
};

const Header = ({
  city,
  onMenuClick,
  backTarget,
  hideBack = false,
  // Field-task deep links (KMC/iGile redirects) hide the app-navigation
  // chrome entirely — there's nowhere for "back"/the sidebar menu/exports
  // to meaningfully go for someone dropped straight onto one patch task.
  hideHamburger = false,
  hideDownload = false,
  // Explicit flag for "this session is a field-task redirect" — kept
  // separate from fieldTaskLabel because the title/description text can
  // legitimately be missing even in field-task mode, and null would
  // otherwise be indistinguishable from "not a field task at all."
  isFieldTaskMode = false,
  // Display-only label for who this task belongs to per the redirect URL
  // (never the authenticated session identity — see fieldTaskLabel usage
  // below for why those are kept separate).
  fieldTaskLabel = null,
  // Raw user_id from the redirect URL, shown verbatim so whoever's holding
  // the device can confirm this matches the task KMC assigned them.
  kmcUserId = null,

  // ⭐ NEW PROPS for dynamic road search
  showRoadSearch,       // boolean → Dashboard se aata hai
  roadOptions = [],     // dropdown values
  selectedRoad = "",    // currently selected
  onRoadSelect,         // callback to Dashboard
  onDownloadAction,     // callback for download options
  isDownloading = false, // ⭐ true when export is in progress
}) => {
  const navigate = useNavigate();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isDownloadMenuOpen, setIsDownloadMenuOpen] = useState(false);
  const [loggedInUser] = useState(() => localStorage.getItem("authUser") || "User");

  const toggleSidebar = () => {
    setIsSidebarOpen(!isSidebarOpen);
    if (onMenuClick) onMenuClick();
  };

  const cityKey = city?.toLowerCase().trim();
  const normalizedCity = cityKey?.replace(/[^a-z]/g, "");

  const logo = cityLogos[normalizedCity] || lucknowLogo;

  const formatCityName = (name) => {
    if (!name) return "Lucknow";
    return name
      .toLowerCase()
      .split(" ")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  };

  const cityTitle = `${formatCityName(city)} Nagar Nigam`;

  return (
    <header className="lucknow-header">
      {!hideBack && (
      <div
        className="back-button"
        onClick={() => navigate(backTarget || "/home")}
        title="Back"
        style={{
          cursor: "pointer",
          marginRight: "15px",
          color: "white",
          fontSize: "18px",
          display: "flex",
          alignItems: "center",
          zIndex: 2000
        }}
      >
        <i className="fa-solid fa-arrow-left"></i>
      </div>
      )}

      {!hideHamburger && (
      <div className="menu-toggle" onClick={toggleSidebar}>
        <div className={`bar ${isSidebarOpen ? "open" : ""}`}></div>
      </div>
      )}

      <div className="lucknow-header__center">
        <img src={logo} alt="City Logo" className="lucknow-header__logo" />
        <h2 className="lucknow-header__title">{cityTitle}</h2>
        <img
          src={rsacLogo}
          alt="City Logo Right"
          className="lucknow-header__logo"
        />
      </div>

      <div className="lucknow-header__actions" style={{ position: 'relative', display: 'flex', alignItems: 'center', marginRight: '20px', gap: '16px', zIndex: 10050 }}>
        {!hideDownload && (
        <i
          className="fa-solid fa-download"
          onClick={() => setIsDownloadMenuOpen(!isDownloadMenuOpen)}
          title="Download Options"
          style={{
            cursor: "pointer",
            color: "black",
            fontSize: "20px"
          }}
        ></i>
        )}

        {!hideDownload && isDownloadMenuOpen && (
          <div className="download-menu" style={{
            position: 'absolute',
            top: '130%',
            right: -10,
            backgroundColor: 'white',
            border: '1px solid #ccc',
            borderRadius: '4px',
            padding: '5px 0',
            zIndex: 3000,
            minWidth: '180px',
            boxShadow: '0 2px 10px rgba(0,0,0,0.2)',
            color: 'black'
          }}>
            <div onClick={() => { onDownloadAction('print'); setIsDownloadMenuOpen(false); }} style={{ padding: '10px 15px', cursor: 'pointer', borderBottom: '1px solid #eee', fontSize: '14px' }}>Print Map</div>
            <div onClick={() => { onDownloadAction('excel'); setIsDownloadMenuOpen(false); }} style={{ padding: '10px 15px', cursor: 'pointer', borderBottom: '1px solid #eee', fontSize: '14px' }}>Excel Format Table</div>
            <div onClick={() => { onDownloadAction('pdf'); setIsDownloadMenuOpen(false); }} style={{ padding: '10px 15px', cursor: 'pointer', borderBottom: '1px solid #eee', fontSize: '14px' }}>PDF Format Table</div>
            <div onClick={() => { onDownloadAction('kml'); setIsDownloadMenuOpen(false); }} style={{ padding: '10px 15px', cursor: 'pointer', fontSize: '14px' }}>KML Format Table</div>
          </div>
        )}

        <div style={{ position: 'relative', zIndex: 10050 }}>
          <i
            className="fa-solid fa-user-circle"
            title={loggedInUser}
            style={{ cursor: 'pointer', color: 'black', fontSize: '20px' }}
            onClick={() => {
              const menu = document.getElementById("profile-menu");
              if (menu) {
                const isOpen = menu.style.display === "block";
                menu.style.display = isOpen ? "none" : "block";
              }
            }}
          ></i>
          <div id="profile-menu" style={{
            position: 'absolute',
            top: '130%',
            right: -10,
            backgroundColor: 'white',
            border: '1px solid #ccc',
            borderRadius: '4px',
            padding: '5px 0',
            // Higher than .feature-progress-notice (z-index: 40050 in
            // Dashboard.css) — an interactive menu the user just opened
            // must never be blocked by a passive status notice appearing
            // on top of it.
            zIndex: 100000,
            minWidth: '160px',
            boxShadow: '0 2px 10px rgba(0,0,0,0.2)',
            color: 'black',
            display: 'none'
          }}>
            <div style={{
              padding: '10px 15px',
              borderBottom: '1px solid #eee',
              fontSize: '13px',
              fontWeight: 700,
              textTransform: 'capitalize',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}>
              <i className="fa-solid fa-user-circle" style={{ fontSize: 22, color: '#3b82f6' }}></i>
              {/* A task title/description is free text from KMC's own
                  system — it can be a full sentence, or missing entirely.
                  Neither belongs in the "identity" slot at the top: show a
                  short, always-available KMC user reference there instead,
                  and let the (possibly long, possibly absent) title live in
                  its own labeled "Task" row below. */}
              {isFieldTaskMode ? (kmcUserId ? `KMC User #${kmcUserId}` : "Field Task User") : loggedInUser}
            </div>
            {isFieldTaskMode && (
              // The account logged in here is a shared field-task login —
              // these lines show *who this specific task belongs to* and
              // *which shared account authorised the session*, straight
              // from the redirect link and the session respectively. Both
              // are read-only context for whoever's holding the device,
              // never an identity the app trusts for anything: access
              // control still runs entirely off the session, not these
              // labels.
              <div style={{ padding: '8px 15px', borderBottom: '1px solid #eee', fontSize: '12px', color: '#555' }}>
                <div style={{ fontWeight: 600, color: '#333' }}>Task</div>
                <div style={{ marginBottom: 6 }}>{fieldTaskLabel || "No task description provided"}</div>
                {kmcUserId && (
                  <div>KMC User Id: <span style={{ color: '#333', fontWeight: 600 }}>{kmcUserId}</span></div>
                )}
                <div>Authorised by: <span style={{ color: '#333', fontWeight: 600 }}>{loggedInUser}</span></div>
              </div>
            )}
            <div
              onClick={() => {
                fetch("/api/auth/logout", { method: "POST", credentials: "include" }).catch(() => { });
                localStorage.removeItem("authUser");
                localStorage.removeItem("authRole");
                localStorage.removeItem("authCity");
                window.location.href = "/";
              }}
              style={{ padding: '10px 15px', cursor: 'pointer', fontSize: '14px' }}
            >
              <i className="fa-solid fa-sign-out-alt" style={{ marginRight: 8 }}></i>
              Logout
            </div>
          </div>
        </div>
      </div>

      {/* SEARCH REMOVED AS REQUESTED */}
    </header>
  );
};

export default Header;
