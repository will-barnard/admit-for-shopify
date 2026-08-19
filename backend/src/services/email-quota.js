/**
 * The daily email allowance, counted once, in one place.
 *
 * "Today" is decided by the DATABASE, not by the Node process. Every caller
 * used to build a JS Date at local midnight and compare it against
 * email_send_log.sent_at, which Postgres fills from its own clock. When the two
 * disagreed about the zone - an app container on America/Chicago against a
 * database on UTC, say - the boundary moved by hours, so the quota either reset
 * early or counted a day that had not started. Running the test suite under
 * Asia/Tokyo made it obvious: the quota read 100 remaining when 88 had been
 * sent.
 *
 * date_trunc('day', LOCALTIMESTAMP) puts both halves of the comparison on the
 * same clock, whatever either machine is set to.
 *
 * The limit lived as a bare `100` in four places and as EMAIL_DAILY_LIMIT in a
 * fifth. It is one value now.
 */

const db = require('../config/database');

const DAILY_LIMIT = Number(process.env.EMAIL_DAILY_LIMIT ?? 100);

async function emailsSentToday(shopId) {
  const result = await db.query(
    `SELECT COUNT(*)::int AS c
       FROM email_send_log
      WHERE shop_id = $1
        AND success = true
        AND sent_at >= date_trunc('day', LOCALTIMESTAMP)`,
    [shopId]
  );
  return result.rows[0].c;
}

async function remainingQuota(shopId) {
  return Math.max(0, DAILY_LIMIT - (await emailsSentToday(shopId)));
}

module.exports = { DAILY_LIMIT, emailsSentToday, remainingQuota };
