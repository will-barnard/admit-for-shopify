# Shopify Integration API

This endpoint allows Shopify to automatically create attendee tickets when purchases are made.

## Endpoint

```
POST /api/shopify/create-ticket
```

## Authentication

Include the API key in the request headers:

```
x-api-key: REDACTED-ROTATED-KEY
```

## Request Body

```json
{
  "name": "John Doe",
  "email": "john@example.com",
  "ticket_subtype": "adult_2day",
  "quantity": 1
}
```

### Fields

- **name** (required): Full name of the ticket holder
- **email** (required): Email address for ticket delivery
- **ticket_subtype** (required): Type of attendee ticket. Valid values:
  - `vip` - VIP Pass (Friday, Saturday, Sunday)
  - `adult_2day` - Adult 2-Day Pass (Saturday, Sunday)
  - `adult_saturday` - Adult 1-Day Pass (Saturday)
  - `adult_sunday` - Adult 1-Day Pass (Sunday)
  - `child_2day` - Child 2-Day Pass (Saturday, Sunday)
  - `child_saturday` - Child 1-Day Pass (Saturday)
  - `child_sunday` - Child 1-Day Pass (Sunday)
- **quantity** (optional): Number of tickets to create (default: 1, max: 10)

## Response

### Success (201 Created)

```json
{
  "success": true,
  "message": "Successfully created 2 ticket(s)",
  "tickets": [
    {
      "id": 123,
      "uuid": "550e8400-e29b-41d4-a716-446655440000",
      "email_sent": true
    },
    {
      "id": 124,
      "uuid": "650e8400-e29b-41d4-a716-446655440001",
      "email_sent": true
    }
  ]
}
```

### Error (400 Bad Request)

```json
{
  "error": "Missing required fields: name, email, and ticket_subtype are required"
}
```

### Error (401 Unauthorized)

```json
{
  "error": "Unauthorized: Invalid API key"
}
```

## Example cURL Request

```bash
curl -X POST http://your-nas-ip:49191/api/shopify/create-ticket \
  -H "Content-Type: application/json" \
  -H "x-api-key: REDACTED-ROTATED-KEY" \
  -d '{
    "name": "John Doe",
    "email": "john@example.com",
    "ticket_subtype": "adult_2day",
    "quantity": 2
  }'
```

## Notes

- Tickets are automatically emailed if `auto_send_emails` is enabled in settings
- Each ticket gets a unique UUID for QR code verification
- The endpoint supports creating multiple tickets in a single request (up to 10)
- Only attendee tickets can be created via this API (student and exhibitor tickets must be created manually)
