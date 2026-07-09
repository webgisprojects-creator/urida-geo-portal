/* Forced password-change screen shown after an admin-issued temporary
   password login (must_change_password=true — see authController.js's
   login()/changePassword()). Reuses LoginPage's own form styling so it
   doesn't need its own stylesheet. */
import React, { useState, useEffect } from "react";
import "./LoginPage.css";

const API_BASE_URL = "/api/auth";

export default function ForceChangePassword() {
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("error");
  const [loading, setLoading] = useState(false);
  // localStorage's authUser is set at login (see LoginPage.jsx), but this
  // route is also reachable via a direct redirect (App.js's Protected
  // guard) where that may be stale/absent — profile is the source of truth.
  const [username, setUsername] = useState(() => localStorage.getItem("authUser") || "");

  useEffect(() => {
    fetch(`${API_BASE_URL}/profile`, { credentials: "include" })
      .then((res) => res.json())
      .then((data) => {
        if (data?.success && data?.user?.username) {
          setUsername(String(data.user.username));
        }
      })
      .catch(() => {});
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setMessage("");

    if (!newPassword || !confirmPassword) {
      setMessage("Please enter and confirm your new password.");
      setMessageType("error");
      return;
    }
    if (newPassword !== confirmPassword) {
      setMessage("Passwords do not match.");
      setMessageType("error");
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/change-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ newPassword, confirmPassword }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success) {
        setMessage(String(data?.message || "Unable to update password. Please try again."));
        setMessageType("error");
        return;
      }

      setMessage(String(data?.message || "Password updated successfully."));
      setMessageType("success");

      // Hard navigation (not client-side routing) so the whole app
      // re-bootstraps its session via App.js's refresh(), picking up the
      // freshly-issued cookie (must_change_password now false) instead of
      // carrying over stale session state — same pattern LoginPage.jsx
      // already uses after a normal login.
      const role = String(localStorage.getItem("authRole") || "").toLowerCase();
      const target = role === "admin" ? "/admin" : "/home";
      setTimeout(() => {
        window.location.href = target;
      }, 600);
    } catch (error) {
      console.error(error);
      setMessage("Server not reachable. Please try again.");
      setMessageType("error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-overlay">
        <div className="login-modal">
          <h2 className="form__title">Set a New Password</h2>
          <p style={{ color: "#475569", fontSize: 13, marginTop: -10, marginBottom: 20 }}>
            Your password was reset by an administrator. Please create a new
            password to continue.
            {username && (
              <>
                <br />
                Signed in as <strong>{username}</strong>.
              </>
            )}
          </p>
          {message && (
            <div
              className={`form__message${messageType === "success" ? " form__message--success" : ""}`}
            >
              {message}
            </div>
          )}
          <form onSubmit={handleSubmit}>
            <div className="form__input-group">
              <input
                type="password"
                placeholder="New Password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="form__input"
                autoComplete="new-password"
              />
            </div>
            <div className="form__input-group">
              <input
                type="password"
                placeholder="Confirm New Password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="form__input"
                autoComplete="new-password"
              />
            </div>
            <button type="submit" className="form__button" disabled={loading}>
              {loading ? "Updating..." : "Update Password"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
