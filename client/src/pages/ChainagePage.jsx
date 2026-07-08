import { useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";

// Chainage is now an in-place mode on the main Dashboard rather than a
// separate page (it used to render its own MapContainer instance, with its
// own Header/Footer, and would load every chainage segment in the city
// unfiltered). This route is kept only so existing deep links (e.g. from the
// mobile field-task app: /chainage?city=...&zone=...&ward=...&project_id=...)
// keep working — it forwards straight to the Dashboard with mode=CHAINAGE.
const ChainagePage = () => {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    params.set("mode", "CHAINAGE");
    navigate(`/dashboard?${params.toString()}`, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
};

export default ChainagePage;
