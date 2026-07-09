const normalize = (value) => String(value || "").toLowerCase().trim();

export const fieldTaskUsernames = () =>
  new Set(
    String(process.env.FIELD_TASK_ONLY_USERNAMES || "chainage")
      .split(",")
      .map(normalize)
      .filter(Boolean)
  );

export function authorizeCityAccess(req, res, cityRaw) {
  const city = normalize(cityRaw);
  if (!city) {
    res.status(400).json({ error: "City is required" });
    return null;
  }

  const role = normalize(req.user?.role);
  if (role === "admin") return city;

  const userCity = normalize(req.user?.city);
  if (userCity) {
    if (userCity === city) return city;
    res.status(403).json({ error: "Forbidden for this city" });
    return null;
  }

  const username = normalize(req.user?.username);
  if (fieldTaskUsernames().has(username)) return city;

  res.status(403).json({ error: "Forbidden for this city" });
  return null;
}
