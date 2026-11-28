// A user who has a city may read only that city. Users without one (admins and
// state-level roles) are not limited. This is the rule the client already
// applies to what it shows (HomePage "isCityScopedUser"), enforced here.
// Use with router.param(), after verifyToken.
const normalize = (value) => String(value || '').toLowerCase().trim();

export const canReadCity = (user, requested) => {
  if (!user) return false;
  if (normalize(user.role) === 'admin') return true;
  const own = normalize(user.city);
  return !own || own === normalize(requested);
};

export const requireOwnCity = (req, res, next, city) => {
  if (canReadCity(req.user, city)) return next();
  return res.status(403).json({ error: 'Forbidden for this city' });
};
