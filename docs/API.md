# CloudLogger — API Reference

Base URL (production): `https://serverless-logger-api.joronimoamanya.workers.dev`

All request and response bodies are JSON. Authentication is a single header:

```
Authorization: Bearer <key>
```

A machine-readable OpenAPI 3.0 description is served at
[`GET /v1/openapi.json`](https://serverless-logger-api.joronimoamanya.workers.dev/v1/openapi.json),
and a short endpoint index at `GET /v1/docs`.

## Keys

| Key | Format | Can do |
| --- | --- | --- |
| System (administrator) | value of the `CLIENT_API_TOKEN` secret | everything |
| Account key | `cl_live_…` / `cl_test_…` | manage your sites, read/write their activity |
| Site key | `cl_site_…` | only `POST /v1/logs`, only for its own verified site, only from its own website |

Account keys are returned by register/login. Site keys are returned when a site
is added.

## Plans and limits

| | Free | Pro ($5/month) |
| --- | --- | --- |
| Websites | 1 | 10 |
| Activities per month | 1,000 | 50,000 |
| History kept | 30 days | 1 year |

Enforced with `402 Payment Required`: adding a website past the limit, or
recording activity past the monthly allowance. Over-limit responses include a
`checkout_url` when one is configured. Upgrade via the Whop checkout link
returned by `GET /v1/billing/status`.

## Endpoints

### `POST /v1/auth/register` — public

```json
{ "email": "owner@example.com", "password": "at-least-8-chars" }
```

`200` → `{ "success": true, "user": { "id": "…", "email": "…" }, "token": "cl_live_…" }`
`400` invalid input · `409` email already registered

### `POST /v1/auth/login` — public

`200` → same shape as register · `401` wrong credentials

### `GET /v1/sites` — account

`200` → `{ "success": true, "sites": [ { "id", "name", "project_id", "domain", "verified", "verify_token", "ingest_key", "created_at" } ] }`

Lists only the caller's sites (the system key sees the 50 most recent sites).

### `POST /v1/sites` — account

```json
{ "name": "My Shop", "domain": "https://www.mysite.com/" }
```

The domain is normalised (`mysite.com`). `200` → `{ "success": true, "site": { … } }`
with `verified: false`, a `verify_token` and an `ingest_key`. `400` for an
invalid address or missing name.

### `POST /v1/sites/:id/verify` — account

Triggers an ownership check (see [Architecture](ARCHITECTURE.md)). `200` →

- `{ "success": true, "verified": true }` — done, the site may now record activity
- `{ "success": true, "verified": false, "message": "We could not find your code…" }` — try again after publishing the code

`404` if the site is not yours / does not exist.

### `POST /v1/logs` — site key or account key

Record one activity. Required fields (strings, 1–120 chars each):
`project_id`, `module_name`, `action`, `status`.

```json
{
  "project_id": "my-shop-1a2b3c4d",
  "module_name": "Checkout",
  "action": "Order placed",
  "status": "SUCCESS",
  "event_type": "USER_ACTIVITY",
  "actor": "jane@shop.com",
  "metadata": { "ip_address": "197.239.4.1" },
  "payload": { "amount": 25000, "currency": "UGX" }
}
```

- `actor` and `metadata.ip_address` are stored only as HMAC-SHA256 hashes; the
  readable values are discarded. `actor`/`ip_address` keys are also removed
  from `payload`.
- `payload` is optional, must be a JSON object, max 8 KB after serialisation.
- `event_type` defaults to `"INFO"`.
- `200` → `{ "success": true, "log_id": "…" }`
- `400` schema problems · `401` bad key · `402` monthly plan quota used up ·
  `403` site not verified / not yours / wrong site for this key / wrong website
  origin · `413` payload too large

### `GET /v1/logs?project_id=…` — account

Newest-first array of the latest 200 stored rows for one of your sites:

```json
[{
  "id": "…", "project_id": "…", "module_name": "Checkout",
  "event_type": "USER_ACTIVITY", "action": "Order placed",
  "actor_hash": "9f86d0…", "status": "SUCCESS",
  "payload": "{\"amount\":25000}", "ip_hash": "5f1a…",
  "created_at": "2026-11-12 09:47:32"
}]
```

`403` if the site belongs to another account.

### `GET /v1/billing/status` — account

Plan, limits and current usage:

```json
{
  "success": true,
  "plan": "free",
  "is_active_paid": false,
  "limits": { "sites": 1, "logs_per_month": 1000, "retention_days": 30 },
  "usage": { "sites": 1, "logs_this_month": 42, "month": "2026-11" },
  "checkout_url": "https://whop.com/checkout/…"
}
```

`checkout_url` appears only when the operator has configured a Whop checkout
link. The system key sees `plan: "system_unlimited"` with `limits: null`.

### `POST /v1/sites/:id/alerts` — account

Set or clear the failure-alert email for one of your verified sites. When an
activity with a failure-like status (`FAILED`, `ERROR`, …) is later recorded
for that site, CloudLogger emails this address — at most one email per site
per 30 minutes.

```json
{ "email": "owner@example.com" }
```

`200` → `{ "success": true, "alert_email": "owner@example.com" }`. Send
`""` to turn alerts off. `400` for an invalid address or an unverified site,
`404` if the site is not yours. Alert delivery requires the operator to
configure `RESEND_API_KEY`.

### `POST /v1/webhooks/whop` — Whop only

Payment notifications. Signature-verified (`webhook-id`, `webhook-timestamp`,
`webhook-signature` headers, HMAC-SHA256 with `WHOP_WEBHOOK_SECRET`); anything
unsigned, stale (>5 min) or wrongly signed gets `401`. See
[Security](SECURITY.md).

### `GET /v1/openapi.json` / `GET /v1/docs` — public

Machine-readable and human-readable API descriptions.

### `POST /mcp` — account

JSON-RPC 2.0 endpoint for AI assistants. See [MCP](MCP.md).

## Integration snippets

### cURL

```bash
curl -X POST "https://serverless-logger-api.joronimoamanya.workers.dev/v1/logs" \
  -H "Authorization: Bearer cl_site_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "my-shop-1a2b3c4d",
    "module_name": "Checkout",
    "action": "Order placed",
    "status": "SUCCESS",
    "payload": { "amount": 25000, "currency": "UGX" }
  }'
```

### Node.js

```js
async function recordActivity(entry) {
  try {
    const res = await fetch("https://serverless-logger-api.joronimoamanya.workers.dev/v1/logs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.CLOUDLOGGER_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(entry)
    });
    if (!res.ok) throw new Error(`CloudLogger rejected the entry (${res.status})`);
    return await res.json(); // { success: true, log_id: "…" }
  } catch (err) {
    console.error("Activity not recorded:", err.message);
    return null; // never let logging break the product
  }
}
```

### Python

```python
import os
import requests

API = "https://serverless-logger-api.joronimoamanya.workers.dev/v1/logs"

def record_activity(entry: dict) -> dict | None:
    try:
        res = requests.post(
            API,
            headers={
                "Authorization": f"Bearer {os.environ['CLOUDLOGGER_KEY']}",
                "Content-Type": "application/json",
            },
            json=entry,
            timeout=10,
        )
        res.raise_for_status()
        return res.json()
    except requests.RequestException as err:
        print(f"Activity not recorded: {err}")
        return None  # never let logging break the product
```

### Browser (site key)

```html
<script>
  fetch("https://serverless-logger-api.joronimoamanya.workers.dev/v1/logs", {
    method: "POST",
    headers: {
      Authorization: "Bearer cl_site_YOUR_KEY",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      project_id: "my-shop-1a2b3c4d",
      module_name: "Sign up",
      action: "Account created",
      status: "SUCCESS"
    })
  }).catch(() => {}); // fire and forget; never break the page
</script>
```

The site key only works when the page is served from the site's own domain —
the Worker checks the `Origin` header.

## Errors

Errors are always `{ "error": "human-readable message" }` with a fitting HTTP
status (`400`, `401`, `402`, `403`, `404`, `409`, `413`); quota errors also
carry a `code` (`quota_exceeded` / `site_limit_reached`). CORS headers are sent
on every response, and `OPTIONS` preflights are answered with `204` before any
authentication.
