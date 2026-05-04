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
      <div
        className="back-button"
        onClick={() => navigate("/home")}
        title="Back to Home"
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

      <div className="menu-toggle" onClick={toggleSidebar}>
        <div className={`bar ${isSidebarOpen ? "open" : ""}`}></div>
      </div>

      <div className="lucknow-header__center">
        <img src={logo} alt="City Logo" className="lucknow-header__logo" />
        <h2 className="lucknow-header__title">{cityTitle}</h2>
        <img
          src={rsacLogo}
          alt="City Logo Right"
          className="lucknow-header__logo"
        />
      </div>

      <div className="lucknow-header__actions" style={{ position: 'relative', display: 'flex', alignItems: 'center', marginRight: '20px', gap: '16px' }}>
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

        {isDownloadMenuOpen && (
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

        <div style={{ position: 'relative' }}>
          <i
            className="fa-solid fa-user-circle"
            title="Profile"
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
            zIndex: 3000,
            minWidth: '160px',
            boxShadow: '0 2px 10px rgba(0,0,0,0.2)',
            color: 'black',
            display: 'none'
          }}>
            <div
              onClick={() => {
                const token = localStorage.getItem("authToken");
                if (token) {
                  fetch("/api/auth/logout", { method: "POST", headers: { Authorization: `Bearer ${token}` } }).catch(() => { });
                }
                localStorage.removeItem("authToken");
                window.location.href = "/";
              }}
              style={{ padding: '10px 15px', cursor: 'pointer', fontSize: '14px' }}
            >
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
