// src/components/Footer.jsx
import React from "react";
import "../assets/styles/Dashboard.css"; // reuse same gradient theme
import rightLogo from "../assets/NN_Logo/images.jpg";

const Footer = () => {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="dashboard-footer">

      <div className="footer-left">
        <span>All rights reserved</span>
      </div>
      <div className="footer-middle">
        <span>
          © {currentYear} Remote Sensing and Applications Centre. RSAC-UP{" "}
        </span>
        <img src={rightLogo} alt="RSAC Logo" className="footer-logo" />
      </div>
      <div className="footer-right">
        <span>
          Data displayed is for departmental reference only and has no legal validity.
        </span>
      </div>
    </footer>
  );
};

export default Footer;
