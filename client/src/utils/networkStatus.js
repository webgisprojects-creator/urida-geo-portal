// Shared low-bandwidth detection — single source of truth so map layers,
// table fetches, and anything added later all agree on what "slow
// connection" means instead of each reimplementing their own check.
export const getIsLowBandwidth = () => {
  if (typeof navigator === "undefined") return false;
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!conn) return false;
  const effectiveType = String(conn.effectiveType || "").toLowerCase();
  return !!conn.saveData || ["slow-2g", "2g", "3g"].includes(effectiveType);
};
