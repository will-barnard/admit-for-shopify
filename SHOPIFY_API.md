# Shopify Integration API

Endpoints Shopify calls to keep tickets in sync with orders. Currently driven by
Shopify Flow "Send HTTP request" actions.

> **Auth:** every endpoint except `/health` requires an `x-api-key` header whose
> value matches the `SHOPIFY_API_KEY` environment variable. The key is a shared
> secret — it lives in `.env` and the Beachhead dashboard, and must never be
> committed to this repo or pasted into documentation.

> **Planned change:** this static-key scheme is a stopgap. A real Shopify app
> verifies the `X-Shopify-Hmac-Sha256` signature over the raw request body
> instead, which removes the shared secret entirely. See `SHOPIFY_APP_SCOPE.md`.

## `POST /api/shopify/create-ticket`

Creates one ticket per unit of every line item whose SKU matches an event.
Events are matched on `events.sku` (case-insensitive) and must be `active` and
not `archived`. Line items with unknown SKUs are ignored.

```json
{
  "id": 5123456789012,
  "customer": {
    "first_name": "John",
    "last_name": "Doe",
    "email": "john@example.com"
  },
  "line_items": [
    { "id": 14567890123456, "sku": "CDS-2DAY", "quantity": 2, "name": "2-Day Pass" },
    { "id": 14567890123457, "sku": "CDS-SAT",  "quantity": 1, "name": "Saturday Pass" }
  ]
}
```

| Field | Required | Notes |
|---|---|---|
| `id` | recommended | Shopify order id. Used for duplicate detection and for refund/cancel matching. Without it, retries will create duplicate tickets. |
| `customer.first_name` | **yes** | Request is rejected without it. |
| `customer.last_name` | no | |
| `customer.email` | no | Tickets can exist without an email; they just aren't sent. |
| `line_items[].id` | recommended | Shopify line item id. Required for partial refunds to void only the refunded tickets. |
| `line_items[].sku` | **yes** | Matched against `events.sku`. |
| `line_items[].quantity` | no | Defaults to 1. One ticket is created per unit. |

**Responses**

- `201` — tickets created. Body includes `tickets[]` and `email_sent`.
- `200` `{ "duplicate": true }` — an order with this id already has tickets. Safe to retry.
- `200` `{ "tickets": [] }` — no line item matched a sellable event.
- `400` — missing `line_items` array or `customer.first_name`.
- `401` — bad or missing `x-api-key`.
- `423` — lockdown mode is on.

Emails are sent as one consolidated message per order when `auto_send_emails` is
enabled, subject to a 100-message daily cap.

## `POST /api/shopify/refund`

```json
{
  "order_id": 5123456789012,
  "refund_line_items": [
    { "line_item_id": 14567890123456, "quantity": 1 }
  ],
  "transactions": []
}
```

Marks tickets `refunded`. **Partial refunds are respected**: only `quantity`
tickets are voided per refunded line item, preferring tickets that have not been
scanned. Tickets created before `shopify_line_item_id` was recorded cannot be
matched — for those orders the whole order is voided and the admin notification
says so.

## `POST /api/shopify/cancel`

Same payload shape; marks tickets `cancelled`. No line item scoping — an order
cancellation voids every ticket on the order.

## `POST /api/shopify/chargeback`

```json
{ "id": "dispute-id", "order_id": 5123456789012 }
```

Marks tickets `chargeback` and sends an admin alert.

## `GET /api/shopify/health`

No auth. Returns `{ "status": "ok", "service": "shopify-integration" }`.

## Notes

- Refund, cancel and chargeback deliberately **ignore lockdown mode**. Voiding a
  refunded ticket is a safety operation; blocking it during an event would leave
  a refunded ticket scannable at the door.
- Every request is recorded in `webhook_logs` and can be replayed from the
  Webhooks page in the admin, which runs the same code path as the live endpoint.
