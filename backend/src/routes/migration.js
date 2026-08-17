const express = require('express');

const router = express.Router();

/**
 * RETIRED 2026-08.
 *
 * These endpoints existed to copy tickets and scans between two instances of
 * this app. They are retired rather than fixed because:
 *
 *   - POST /receive was unauthenticated. It validated only settings.receive_mode_secret,
 *     which GET /api/settings leaked publicly until it was column-whitelisted.
 *   - The scan import never worked: it inserted into ticket_scans (ticket_id,
 *     scanned_by, scanned_at), but the column is scanned_by_user_id, so any
 *     payload containing scans threw.
 *   - The BEGIN/COMMIT/ROLLBACK were issued as separate pool.query() calls, so
 *     they could land on different pooled connections. The rollback was not
 *     guaranteed to undo the ticket upserts that had already succeeded.
 *   - Nothing in either frontend ever called them.
 *
 * Use pg_dump / pg_restore to move data between instances. Once the app is a
 * Shopify app, Shopify is the source of truth and this has no reason to exist.
 *
 * The router still responds so that anything still pointed here gets a clear
 * answer instead of a 404 that looks like a routing bug.
 */
router.all('*', (req, res) => {
  res.status(410).json({
    error: 'Gone',
    message:
      'The cross-instance migration endpoints have been retired. Use pg_dump/pg_restore to move data between instances.',
  });
});

module.exports = router;
