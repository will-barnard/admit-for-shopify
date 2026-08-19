/**
 * Role gate. Runs AFTER middleware/auth.js, which is what establishes req.user
 * for both identity sources (login JWT and Shopify session token).
 *
 *   router.post('/', authMiddleware, requireRole('admin', 'superadmin'), handler)
 *
 * The roles are: verifier (door staff - scan only), admin, superadmin.
 * A route with only authMiddleware is readable as "any signed-in user,
 * including door staff", so every write path needs to say what it wants.
 */
function requireRole(...allowed) {
  const permitted = new Set(allowed);
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'No token provided' });
    }
    if (!permitted.has(req.user.role)) {
      return res.status(403).json({
        error: `Access denied. This action requires: ${allowed.join(' or ')}.`,
      });
    }
    next();
  };
}

module.exports = requireRole;
