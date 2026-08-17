const express = require('express');
const db = require('../config/database');
const orders = require('../services/shopify-orders');
const { verifyWebhookHmac } = require('../shopify/hmac');
const { isConfigured, isValidShopDomain } = require('../shopify/config');
const { markUninstalled } = require('../shopify/shops');
const shopContext = require('../middleware/shop-context');

const router = express.Router();

/**
 * Native Shopify webhooks.
 *
 * Mounted with express.raw() BEFORE the global express.json() in server.js,
 * because HMAC verification needs the unparsed body.
 *
 * Shopify allows one second to connect and five seconds for the whole request,
 * and retries 8 times over 4 hours. Creating tickets means generating a QR per
 * ticket and sending an email, which will not reliably fit in five seconds. So
 * these handlers persist the payload, acknowledge, and then process in the
 * background - failures land in webhook_logs and can be replayed from the
 * Webhooks page, which runs the same code path.
 */

// Topic -> how to read the order id, and what to do with it.
const TOPIC_HANDLERS = {
  'orders/create': { kind: 'create' },
  'orders/cancelled': { kind: 'status', status: 'cancelled', type: 'cancel', orderIdFrom: (p) => p.id },
  'refunds/create': { kind: 'status', status: 'refunded', type: 'refund', orderIdFrom: (p) => p.order_id },
  'disputes/create': { kind: 'status', status: 'chargeback', type: 'chargeback', orderIdFrom: (p) => p.order_id },
  'app/uninstalled': { kind: 'uninstall' },
};

router.post('/', async (req, res) => {
  if (!isConfigured()) {
    console.error('Shopify webhook received but the app is not configured');
    return res.status(503).send('Shopify app not configured');
  }

  const topic = req.headers['x-shopify-topic'];
  const shopDomain = req.headers['x-shopify-shop-domain'];
  const deliveryId = req.headers['x-shopify-webhook-id'] || null;
  const rawBody = req.body; // Buffer, courtesy of express.raw()

  if (!verifyWebhookHmac(rawBody, req.headers['x-shopify-hmac-sha256'])) {
    // 401 on a bad HMAC is what Shopify's automated checks look for.
    console.warn(`Rejected webhook with bad HMAC (topic=${topic}, shop=${shopDomain})`);
    return res.status(401).send('Invalid HMAC');
  }

  if (!isValidShopDomain(shopDomain)) {
    return res.status(400).send('Invalid shop domain');
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (error) {
    console.error(`Webhook ${topic} had unparseable JSON`);
    return res.status(400).send('Invalid JSON');
  }

  const handler = TOPIC_HANDLERS[topic];
  if (!handler) {
    // Acknowledge unknown topics: a non-2xx counts as a failure and Shopify
    // deletes the subscription after 8 consecutive ones.
    console.log(`Ignoring unhandled webhook topic: ${topic}`);
    return res.status(200).send('ignored');
  }

  if (handler.kind === 'uninstall') {
    try {
      await markUninstalled(shopDomain);
      console.log(`App uninstalled from ${shopDomain}`);
    } catch (error) {
      console.error('Failed to record uninstall:', error);
    }
    return res.status(200).send('ok');
  }

  const shopId = await shopContext.resolveShopByDomain(shopDomain);
  if (shopId === null) {
    // Unknown shop: acknowledge so Shopify stops retrying, but say why.
    console.warn(`Webhook for unknown or uninstalled shop ${shopDomain}`);
    return res.status(200).send('unknown shop');
  }

  // Persist first, so nothing is lost if processing dies.
  let webhookLogId = null;
  const webhookType = handler.kind === 'create' ? 'order_create' : handler.type;
  const orderId = handler.kind === 'create' ? payload.id : handler.orderIdFrom(payload);

  try {
    const inserted = await db.query(
      `INSERT INTO webhook_logs (shop_id, shopify_order_id, webhook_data, webhook_type, delivery_id, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (delivery_id) WHERE delivery_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [shopId, orderId ? String(orderId) : null, JSON.stringify(payload), webhookType, deliveryId]
    );

    if (inserted.rows.length === 0) {
      // Same delivery id already stored - this is a Shopify retry of something
      // we already have. Acknowledge and do nothing.
      console.log(`Duplicate webhook delivery ${deliveryId} (${topic}) ignored`);
      return res.status(200).send('duplicate');
    }
    webhookLogId = inserted.rows[0].id;
  } catch (error) {
    console.error('Failed to persist webhook:', error);
    return res.status(500).send('Failed to persist webhook');
  }

  // Acknowledge inside Shopify's budget, then do the slow part.
  res.status(200).send('ok');

  setImmediate(async () => {
    try {
      if (handler.kind === 'create') {
        await orders.processOrderCreate(payload, { source: 'webhook', webhookLogId, shopId });
      } else {
        await orders.processOrderStatusChange({
          // processOrderStatusChange reads payload.order_id; orders/cancelled
          // carries the order itself, so normalise before handing it over.
          payload: { ...payload, order_id: orderId },
          status: handler.status,
          webhookType: handler.type,
          source: 'webhook',
          webhookLogId,
          shopId,
        });
      }
    } catch (error) {
      console.error(`Background processing failed for webhook ${webhookLogId} (${topic}):`, error);
      await orders.markWebhookFailed(webhookLogId, error.message || 'Background processing failed', shopId);
    }
  });
});

module.exports = router;
