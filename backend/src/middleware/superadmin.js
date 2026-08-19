const authMiddleware = require('./auth');
const requireRole = require('./require-role');

/**
 * Superadmin-only. Exported as a middleware ARRAY so existing call sites keep
 * working unchanged, whether they use it alone or after authMiddleware:
 *
 *   router.get('/x', superAdminMiddleware, handler)
 *   router.get('/y', authMiddleware, superAdminMiddleware, handler)
 *
 * It used to verify the bearer token against JWT_SECRET itself, which meant an
 * embedded Shopify request - authenticated, but signed with the app's client
 * secret - was rejected here too. Delegating to authMiddleware fixes both paths
 * at once.
 */
module.exports = [authMiddleware, requireRole('superadmin')];
