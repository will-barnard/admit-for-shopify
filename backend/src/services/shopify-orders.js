/**
 * Shopify order processing.
 *
 * This module is the single implementation of "turn a Shopify order payload
 * into tickets" and "apply a status change to an order's tickets". Both the
 * live endpoints (routes/shopify.js) and the webhook retry path
 * (routes/webhooks.js) call in here.
 *
 * They used to be two separate copies that had drifted apart: the retry path
 * matched events with `sku IS NOT NULL` instead of `active = true` (so it could
 * create tickets against inactive and archived events), skipped the daily email
 * quota entirely, and swallowed email failures without notifying an admin.
 * Keep it that way - one path, no copies.
 */

const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const db = require('../config/database');
const { sendTicketEmail, sendAdminNotification } = require('./email');

const DAILY_EMAIL_LIMIT = 100;
const VOIDABLE_FROM_STATUSES = ['valid'];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function asId(value) {
  return value === undefined || value === null || value === '' ? null : String(value);
}

function customerNameOf(customer) {
  return `${customer.first_name} ${customer.last_name || ''}`.trim();
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

async function emailsSentToday(shopId) {
  const result = await db.query(
    'SELECT COUNT(*) as sent_today FROM email_send_log WHERE shop_id = $1 AND sent_at >= $2 AND success = true',
    [shopId, startOfToday()]
  );
  return parseInt(result.rows[0].sent_today, 10);
}

async function autoSendEmailsEnabled(shopId) {
  const result = await db.query('SELECT auto_send_emails FROM settings WHERE shop_id = $1', [shopId]);
  return result.rows[0]?.auto_send_emails ?? true;
}

/**
 * SKU -> event, for events that can actually accept new tickets.
 *
 * Deliberately excludes archived events: routes/verify.js rejects scans on
 * archived events, so issuing tickets against one produces a ticket that can
 * never be used.
 */
async function loadSellableEventsBySku(shopId) {
  const result = await db.query(
    `SELECT id, name, sku FROM events
      WHERE shop_id = $1
        AND active = true
        AND sku IS NOT NULL
        AND (archived IS NULL OR archived = false)`,
    [shopId]
  );
  const bySku = new Map();
  result.rows.forEach((event) => bySku.set(event.sku.toLowerCase(), event));
  return bySku;
}

async function withQrCode(ticket, eventName) {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost';
  const verifyUrl = `${frontendUrl}/verify/${ticket.uuid}`;
  return {
    ...ticket,
    event_name: eventName,
    verifyUrl,
    qrCodeDataUrl: await QRCode.toDataURL(verifyUrl),
  };
}

// ---------------------------------------------------------------------------
// webhook_logs
// ---------------------------------------------------------------------------

async function logWebhook({ shopId, orderId, payload, type, errorMessage = null, processed = false }) {
  try {
    const result = await db.query(
      `INSERT INTO webhook_logs (shop_id, shopify_order_id, webhook_data, processed, error_message, webhook_type, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING id`,
      [shopId, asId(orderId), JSON.stringify(payload), processed, errorMessage, type]
    );
    return result.rows[0].id;
  } catch (error) {
    console.error('Failed to log webhook:', error);
    return null;
  }
}

async function markWebhookProcessed(webhookLogId, { shopId, ticketsCreated = 0, errorMessage = null } = {}) {
  if (!webhookLogId) return;
  try {
    await db.query(
      `UPDATE webhook_logs
          SET processed = TRUE, processed_at = NOW(), tickets_created = $1, error_message = $2
        WHERE id = $3 AND shop_id = $4`,
      [ticketsCreated, errorMessage, webhookLogId, shopId]
    );
  } catch (error) {
    console.error('Failed to update webhook log:', error);
  }
}

async function markWebhookFailed(webhookLogId, message, shopId) {
  if (!webhookLogId) return;
  try {
    await db.query(
      'UPDATE webhook_logs SET error_message = $1 WHERE id = $2 AND shop_id = $3',
      [message, webhookLogId, shopId]
    );
  } catch (error) {
    console.error('Failed to record webhook error:', error);
  }
}

// ---------------------------------------------------------------------------
// order create
// ---------------------------------------------------------------------------

/**
 * @returns {{outcome: string, ...}} outcome is one of:
 *   'invalid' | 'duplicate' | 'no_ticket_items' | 'created'
 */
async function processOrderCreate(payload, { source = 'webhook', webhookLogId = null, shopId } = {}) {
  if (!shopId) throw new Error('processOrderCreate requires shopId');

  const { line_items: lineItems, customer, id: rawOrderId } = payload || {};
  const orderId = asId(rawOrderId);

  // --- validate -----------------------------------------------------------
  let validationError = null;
  if (!lineItems || !Array.isArray(lineItems)) {
    validationError = 'Missing or invalid line_items array';
  } else if (!customer || !customer.first_name) {
    validationError = 'Missing customer first_name';
  }

  if (validationError) {
    const logId = webhookLogId
      || (await logWebhook({ shopId, orderId, payload, type: 'order_create', errorMessage: validationError }));
    return { outcome: 'invalid', error: validationError, webhookLogId: logId };
  }

  const logId = webhookLogId
    || (await logWebhook({ shopId, orderId, payload, type: 'order_create' }));

  const customerName = customerNameOf(customer);
  const customerEmail = customer.email || null;

  console.log(`Processing order ${orderId} for ${customerName} (${customerEmail || 'no email'}) [${source}]`);

  let created;
  try {
    // Ticket rows are created inside one transaction, guarded by an advisory
    // lock on the order id. Without the lock, two concurrent deliveries of the
    // same order both pass the duplicate check and both insert.
    created = await db.withTransaction(async (client) => {
      if (orderId) {
        await db.advisoryXactLock(client, `shopify_order:${orderId}`);

        const existing = await client.query(
          'SELECT id, uuid, shopify_order_id, email_sent FROM tickets WHERE shopify_order_id = $1 AND shop_id = $2',
          [orderId, shopId]
        );
        if (existing.rows.length > 0) {
          return { duplicate: true, tickets: existing.rows };
        }
      }

      const eventsBySku = await loadSellableEventsBySku(shopId);
      const ticketLineItems = lineItems.filter((item) => {
        const sku = item.sku?.toLowerCase();
        return sku && eventsBySku.has(sku);
      });

      if (ticketLineItems.length === 0) {
        return { duplicate: false, tickets: [] };
      }

      const rows = [];
      for (const lineItem of ticketLineItems) {
        const event = eventsBySku.get(lineItem.sku.toLowerCase());
        const quantity = lineItem.quantity || 1;
        const lineItemId = asId(lineItem.id);

        for (let i = 0; i < quantity; i += 1) {
          const inserted = await client.query(
            `INSERT INTO tickets (shop_id, event_id, name, email, uuid, shopify_order_id, shopify_line_item_id, email_sent, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, false, NOW())
             RETURNING *`,
            [shopId, event.id, customerName, customerEmail, uuidv4(), orderId, lineItemId]
          );
          rows.push({ ticket: inserted.rows[0], eventName: event.name });
        }
      }
      return { duplicate: false, tickets: rows };
    });
  } catch (error) {
    console.error('Error creating tickets for order:', error);
    await markWebhookFailed(logId, error.message || 'Unknown error processing order', shopId);
    throw error;
  }

  if (created.duplicate) {
    console.log(`Duplicate Shopify order ${orderId} - returning existing tickets`);
    await markWebhookProcessed(logId, {
      shopId,
      ticketsCreated: created.tickets.length,
      errorMessage: 'Duplicate order - tickets already exist',
    });
    return { outcome: 'duplicate', tickets: created.tickets, webhookLogId: logId };
  }

  if (created.tickets.length === 0) {
    await markWebhookProcessed(logId, { shopId, errorMessage: 'No ticket items found in order' });
    return { outcome: 'no_ticket_items', tickets: [], webhookLogId: logId };
  }

  // QR generation and email happen outside the transaction - they are slow and
  // must not hold a database connection or a lock.
  const tickets = [];
  for (const { ticket, eventName } of created.tickets) {
    tickets.push(await withQrCode(ticket, eventName));
  }

  const email = await maybeSendOrderEmail({
    shopId,
    tickets,
    customerName,
    customerEmail,
    orderId,
    sendType: source === 'retry' ? 'shopify_order_retry' : 'shopify_order',
  });

  await markWebhookProcessed(logId, { shopId, ticketsCreated: tickets.length });
  console.log(`Created ${tickets.length} ticket(s) from order ${orderId}`);

  return { outcome: 'created', tickets, email, webhookLogId: logId };
}

/**
 * Send one consolidated email for an order, respecting the daily quota.
 *
 * One row per *message* is written to email_send_log, not one per ticket. The
 * quota models Resend messages, so counting per ticket made a 4-ticket order
 * consume 4 units of a 100-message budget. This matches what batch-send in
 * routes/tickets.js already did.
 */
async function maybeSendOrderEmail({ shopId, tickets, customerName, customerEmail, orderId, sendType }) {
  if (tickets.length === 0) return { sent: false, reason: 'no_tickets' };
  if (!(await autoSendEmailsEnabled(shopId))) return { sent: false, reason: 'auto_send_disabled' };
  if (!customerEmail) {
    console.log(`No email on order ${orderId} - tickets created without sending`);
    return { sent: false, reason: 'no_email' };
  }

  const sentToday = await emailsSentToday(shopId);
  if (sentToday >= DAILY_EMAIL_LIMIT) {
    console.log(`Daily email limit reached (${sentToday}/${DAILY_EMAIL_LIMIT}) - order ${orderId} left unsent`);
    await notifyAdmin({
      subject: 'Daily Email Limit Reached - Tickets Created Without Email',
      message: `A Shopify order was processed but the email was not sent because the daily limit of ${DAILY_EMAIL_LIMIT} emails has been reached.`,
      ticketDetails: `Order ID: ${orderId}\nCustomer: ${customerName} <${customerEmail}>\nTickets Created: ${tickets.length}\nEmails Sent Today: ${sentToday}/${DAILY_EMAIL_LIMIT}\n\nThe tickets are saved and marked as unsent. Use batch send tomorrow.`,
    });
    return { sent: false, reason: 'quota_exceeded', sentToday };
  }

  try {
    const sendResult = await sendTicketEmail({ to: customerEmail, name: customerName, tickets, shopId });

    // sendTicketEmail does not always throw on failure:
    //  - if RESEND_API_KEY is unset it returns { success: false } and sends nothing
    //  - Resend itself returns { data: null, error } rather than rejecting
    // Both used to be treated as success, so tickets were marked email_sent = true
    // and a success row was written to email_send_log when no email had been sent.
    if (sendResult?.success === false || sendResult?.error) {
      const reason = sendResult.error?.message || sendResult.message || 'Email provider reported a failure';
      throw new Error(reason);
    }

    await db.query(
      'UPDATE tickets SET email_sent = true, email_sent_at = NOW() WHERE id = ANY($1) AND shop_id = $2',
      [tickets.map((t) => t.id), shopId]
    );
    await db.query(
      'INSERT INTO email_send_log (shop_id, recipient_email, ticket_id, send_type, success) VALUES ($1, $2, $3, $4, $5)',
      [shopId, customerEmail, tickets[0].id, sendType, true]
    );

    console.log(`Sent consolidated email with ${tickets.length} ticket(s) to ${customerEmail}`);
    return { sent: true };
  } catch (error) {
    console.error('Failed to send ticket email:', error);
    try {
      await db.query(
        'INSERT INTO email_send_log (shop_id, recipient_email, ticket_id, send_type, success) VALUES ($1, $2, $3, $4, $5)',
        [shopId, customerEmail, tickets[0].id, sendType, false]
      );
    } catch (logError) {
      console.error('Failed to log email failure:', logError);
    }
    await notifyAdmin({
      subject: 'Shopify Order Email Delivery Failure',
      message: 'A ticket email from a Shopify order failed to send.',
      ticketDetails: `Recipient: ${customerName} <${customerEmail}>\nOrder ID: ${orderId}\nTicket Count: ${tickets.length}\nError: ${error.message}`,
    });
    return { sent: false, reason: 'send_failed', error: error.message };
  }
}

async function notifyAdmin(payload) {
  try {
    await sendAdminNotification(payload);
  } catch (error) {
    console.error('Failed to send admin notification:', error);
  }
}

// ---------------------------------------------------------------------------
// refund / cancel / chargeback
// ---------------------------------------------------------------------------

/**
 * Work out which of an order's tickets a refund actually covers.
 *
 * Shopify's refund payload carries refund_line_items[] with line_item_id and
 * quantity. Previously this was ignored and every ticket on the order was
 * voided, so refunding one of four tickets killed all four.
 *
 * Tickets created before shopify_line_item_id existed cannot be matched; in
 * that case we fall back to voiding the whole order and say so.
 */
function selectTicketsToVoid(tickets, refundLineItems) {
  const voidable = tickets.filter((t) => !t.status || VOIDABLE_FROM_STATUSES.includes(t.status));

  if (!Array.isArray(refundLineItems) || refundLineItems.length === 0) {
    return { tickets: voidable, partial: false, reason: 'no_line_items_in_payload' };
  }

  if (!voidable.some((t) => t.shopify_line_item_id)) {
    return { tickets: voidable, partial: false, reason: 'tickets_predate_line_item_tracking' };
  }

  const selected = [];
  const unmatched = [];

  for (const refundLine of refundLineItems) {
    const lineItemId = asId(refundLine.line_item_id);
    const quantity = refundLine.quantity ?? 1;
    if (!lineItemId) continue;

    // Prefer tickets that have not been scanned - if someone already walked in
    // on a ticket, void an unused one first.
    const candidates = voidable
      .filter((t) => t.shopify_line_item_id === lineItemId && !selected.includes(t))
      .sort((a, b) => Number(a.scanned) - Number(b.scanned) || a.id - b.id);

    if (candidates.length === 0) {
      unmatched.push(lineItemId);
      continue;
    }
    selected.push(...candidates.slice(0, quantity));
  }

  return { tickets: selected, partial: true, unmatchedLineItemIds: unmatched };
}

const STATUS_LABELS = {
  refunded: { verb: 'refunded', subject: 'Order Refunded' },
  cancelled: { verb: 'cancelled', subject: 'Order Cancelled' },
  chargeback: { verb: 'chargeback', subject: 'CHARGEBACK ALERT' },
};

/**
 * @returns {{outcome: 'no_tickets'|'updated', ...}}
 */
async function processOrderStatusChange({
  payload,
  status,
  webhookType,
  source = 'webhook',
  webhookLogId = null,
  extraDetails = '',
  shopId,
}) {
  if (!shopId) throw new Error('processOrderStatusChange requires shopId');

  const orderId = asId(payload?.order_id);
  const logId = webhookLogId || (await logWebhook({ shopId, orderId, payload, type: webhookType }));

  const ticketsResult = await db.query(
    `SELECT t.id, t.uuid, t.name, t.email, t.status, t.shopify_line_item_id,
            EXISTS (SELECT 1 FROM ticket_scans ts WHERE ts.ticket_id = t.id AND ts.shop_id = t.shop_id) AS scanned
       FROM tickets t
      WHERE t.shopify_order_id = $1 AND t.shop_id = $2
      ORDER BY t.id`,
    [orderId, shopId]
  );

  if (ticketsResult.rows.length === 0) {
    console.log(`No tickets found for order ${orderId}`);
    await markWebhookProcessed(logId, { shopId, errorMessage: 'No tickets found for this order' });
    return { outcome: 'no_tickets', orderId, webhookLogId: logId };
  }

  const selection = selectTicketsToVoid(ticketsResult.rows, payload?.refund_line_items);

  if (selection.tickets.length === 0) {
    await markWebhookProcessed(logId, {
      shopId,
      errorMessage: 'Refund did not match any voidable tickets',
    });
    return { outcome: 'updated', updated: [], orderId, selection, webhookLogId: logId };
  }

  const ids = selection.tickets.map((t) => t.id);
  const updateResult = await db.query(
    'UPDATE tickets SET status = $1 WHERE id = ANY($2) AND shop_id = $3 RETURNING id, uuid, status',
    [status, ids, shopId]
  );

  const label = STATUS_LABELS[status] || { verb: status, subject: `Order ${status}` };
  const scopeNote = selection.partial
    ? `Scoped to ${updateResult.rows.length} of ${ticketsResult.rows.length} ticket(s) on this order, based on refund_line_items.`
    : `Applied to all ${updateResult.rows.length} ticket(s) on this order (${selection.reason}).`;

  console.log(`Marked ${updateResult.rows.length} ticket(s) as ${label.verb} for order ${orderId} [${source}]`);

  const ticketList = selection.tickets
    .map((t) => `- ${t.name} (${t.email || 'no email'}) - UUID: ${t.uuid}${t.scanned ? ' [ALREADY SCANNED]' : ''}`)
    .join('\n');

  await notifyAdmin({
    subject: `${label.subject} - ${updateResult.rows.length} Ticket(s) Invalidated`,
    message: `Order #${orderId} has been ${label.verb}${source === 'retry' ? ' (retry processing)' : ''}.`,
    ticketDetails: `${scopeNote}\n\nThe following tickets have been marked as ${label.verb}:\n\n${ticketList}\n${extraDetails}`,
  });

  await markWebhookProcessed(logId, { shopId, ticketsCreated: updateResult.rows.length });

  return {
    outcome: 'updated',
    orderId,
    updated: updateResult.rows,
    totalOnOrder: ticketsResult.rows.length,
    selection,
    webhookLogId: logId,
  };
}

module.exports = {
  DAILY_EMAIL_LIMIT,
  processOrderCreate,
  processOrderStatusChange,
  logWebhook,
  markWebhookProcessed,
  markWebhookFailed,
  selectTicketsToVoid,
};
