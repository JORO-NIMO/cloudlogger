# CloudLogger — Architecture

CloudLogger is a privacy-first activity logging service for websites. It runs
entirely on the Cloudflare ecosystem: no servers to manage, no containers, no
build step for the frontend.

| Piece | Cloudflare product | This project |
| --- | --- | --- |
| HTTP API + business logic | **Workers** | `src/index.js` (deployed as `serverless-logger-api`) |
| Database | **D1** (SQLite at the edge) | `production-logger-db`, defined in `schema.sql` |
| Dashboard website | **Pages** | `public/index.html` (deployed as `cloudlogger`) |

Live URLs:

- API: `https://serverless-logger-api.joronimoamanya.workers.dev`
- Dashboard: `https://cloudlogger.pages.dev`

## Request lifecycle

```
Browser / Server / AI assistant
        │  HTTPS + Bearer key
        ▼
┌──────────────────────────────────────────┐
│ Cloudflare Worker (src/index.js)         │
│                                          │
│  1. CORS preflight answered (204)        │
│  2. Route matched (public or keyed)      │
│  3. Bearer key authenticated:            │
│     • CLIENT_API_TOKEN  → system key     │
│     • cl_live_/cl_test_ → account key    │
│     • cl_site_…         → site key       │
│  4. Ownership + verification enforced    │
│  5. Private fields HMAC-hashed           │
│  6. Rows written / read via D1 binding   │
└──────────────────────────────────────────┘
        │  SQL over the D1 binding (env.DB)
        ▼
┌──────────────────────────────────────────┐
│ D1: users · sites · system_logs          │
└──────────────────────────────────────────┘
```

Source layout:

| Path | What it is |
| --- | --- |
| `src/index.js` | Router, authentication, site verification, privacy hashing, Whop webhook handling |
| `src/plans.js` | Plan catalogue (limits) and failure-status detection |
| `src/openapi.js` | Machine-readable API description served at `GET /v1/openapi.json` |
| `src/mcp.js` | Model Context Protocol endpoint at `POST /mcp` for AI assistants |
| `public/index.html` | The whole dashboard: landing page, sign-in, site management, activity table (no build step) |
| `schema.sql` | Idempotent D1 schema (safe to re-run; never drops data) |
| `migrations/` | One-time upgrades for databases created before a feature existed |
| `test/logger.test.js` | Vitest suite (51 tests) with an in-memory D1 stand-in |
| `scripts/capture.mjs` | Screenshot generator for `screenshots/` (needs local Chrome) |
| `.dev.vars` | Local-only secrets for `wrangler dev` (git-ignored, never deployed) |

## The three key types

Authentication is a single `Authorization: Bearer <key>` header, resolved to one
of three identities:

1. **System key** — the `CLIENT_API_TOKEN` secret. Full access to everything.
   Meant for the operator only.
2. **Account key** — `cl_live_…` / `cl_test_…`, stored in `users.api_key`.
   Issued at registration. Can manage sites and read/write activity, but only
   for sites that belong to that account.
3. **Site key** — `cl_site_…`, stored in `sites.ingest_key`. The most limited
   key: it can only `POST /v1/logs`, only for its own `project_id`, only if the
   site is verified, and only from its own website (checked against the
   browser `Origin` header). It cannot read anything.

## How a website becomes trusted

Activity is only accepted for a website its owner has proven they control:

1. Owner adds a site (`POST /v1/sites`). The Worker generates a secret
   `verify_token` (32 hex chars) and an `ingest_key` (`cl_site_…`) for it.
2. The owner publishes the token on the site, either as
   `<meta name="cloudlogger-verify" content="TOKEN">` on the home page or as a
   plain text file at `/.well-known/cloudlogger-verify.txt`.
3. Owner presses **Check now** (`POST /v1/sites/:id/verify`). The Worker fetches
   the site over HTTPS (6-second timeout per URL) and looks for the token.
   Redirects are followed, but only if the final host is the same site — a
   token served from another domain is refused.
4. Until `sites.verified_at` is set, every attempt to record activity for that
   site is refused with `403`.

Domain input is normalised (`https://www.Example.com/shop` → `example.com`)
and rejected if it is not a plain public hostname (no IPs, localhost, ports,
credentials).

## Privacy engine

Before anything is written to D1:

- `actor` and `metadata.ip_address` are converted to HMAC-SHA256 hashes using
  the `HASHING_SECRET` secret. The plain values are never stored.
- `actor` and `ip_address` keys are also stripped from the `payload` object.

Hashing uses the Web Crypto API built into the Workers runtime — no external
dependencies.

## Payments, plans and quotas (Whop)

New accounts start on the **free** plan (1 website, 1,000 activities per
month, 30-day history). The **Pro** plan (`pro_monthly_5`, $5/month via Whop)
allows 10 websites, 50,000 activities per month and a 1-year history. Limits
live in `src/plans.js` and are enforced before any write:

- `POST /v1/sites` → `402` when the account already has its plan's number of sites
- `POST /v1/logs` → `402` when the month's activity allowance (`usage` table) is used up

`POST /v1/webhooks/whop` receives server-to-server notifications from Whop.
Every request is signature-verified against the `WHOP_WEBHOOK_SECRET` secret
(HMAC-SHA256 over `{webhook-id}.{webhook-timestamp}.{raw body}`, sent as
`v1,<base64>` in the `webhook-signature` header; requests older than five
minutes are rejected). Verified events flip `users.is_active_paid` / `plan`:

- `payment.succeeded`, `membership.went_valid` → paid, `pro_monthly_5`
- `membership.went_invalid`, `payment.failed` → unpaid, `free`

The upgrade path is a Whop checkout link configured in the `WHOP_CHECKOUT_URL`
var; `GET /v1/billing/status` returns it (plus live usage) so the dashboard can
show an Upgrade button.

## Failure alerts

Each verified site can have an `alert_email`. When an activity is recorded with
a failure-like status (`fail|error|denied|invalid|declin|crash|timeout`), the
Worker sends one email through the Resend API — at most one per site per 30
minutes (cooldown tracked in `sites.last_alert_at`). Sends happen after the
response via `ctx.waitUntil`, so a slow mail provider never delays logging.
If `RESEND_API_KEY` is not set, alerting is silently skipped and everything else
works.

## Retention

A daily Cloudflare Cron Trigger (`17 3 * * *`, see `wrangler.toml`) runs the
`scheduled` handler: it deletes stored activity older than each plan allows
(30 days free, 365 days pro) and usage counters older than two months.

## Verification status (last checked)

- 51/51 unit tests passing (`npm test`)
- Local end-to-end via `wrangler dev` + local D1: register (free plan) → billing
  limits → site limit 402 → alerts refused on unverified site
- Production: fresh registrations get the free plan with limits, the second
  website is refused with 402, OpenAPI/docs list the new endpoints
- D1 `production-logger-db` live with 4 tables; secrets configured; cron
  trigger registered
- Pages project `cloudlogger` serving the dashboard with the pricing pane,
  plan card and alerts UI
