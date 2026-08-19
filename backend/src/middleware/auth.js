const jwt = require('jsonwebtoken');

/**
 * Establish req.user.
 *
 * Two identity sources reach this point:
 *
 *   1. An App Bridge session token, already verified by middleware/shopify-auth
 *      (signed with the app's CLIENT SECRET) and mapped to a users row. Both
 *      conditions are required - isShopifyRequest alone is not a licence to
 *      skip verification, and req.user alone could be set by anything.
 *   2. The app's own login JWT, signed with JWT_SECRET.
 *
 * Re-verifying case 1 here against JWT_SECRET is what used to make the embedded
 * admin unusable: shopify-auth accepted the request, then this rejected it.
 */
const authMiddleware = (req, res, next) => {
  if (req.isShopifyRequest && req.user) return next();

  try {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

module.exports = authMiddleware;
