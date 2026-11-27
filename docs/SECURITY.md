# CloudLogger — Security & Privacy

This page describes what the service actively protects, and — honestly — what
it does not, so you can decide what to send to it.

## What is protected, and how

### Ownership before ingestion

- A website can only record activity after its owner proved control of it
  (`sites.verified_at`). Proof = publishing a per-site secret token on the
  site itself.
- The verification fetch follows redirects but only accepts answers from the
  site's own host, so a token served from another domain (or an attacker's
  redirect target) is refused.
- Domain input is normalised and validated: IP addresses, `localhost`, ports,
  credentials and malformed hosts are rejected outright.

### Least-privilege keys

Three key types with shrinking power (system → account → site). A site key
can do exactly one thing — `POST /v1/logs` for its own verified `project_id` —
and only when the browser `Origin` matches the site's domain. It cannot list
sites, read logs, or call MCP. An account key is confined to its own rows
everywhere, enforced per query with `user_id` filters.

### Private data is hashed before storage

`actor` and `metadata.ip_address` are HMAC-SHA256'd with `HASHING_SECRET`
using the Workers-native Web Crypto API; the readable values never reach D1.
The same two keys are stripped from `payload`. Stored rows contain only
`actor_hash` / `ip_hash`.

### Webhook signatures

`POST /v1/webhooks/whop` verifies every request the way Whop documents:
HMAC-SHA256 over `{webhook-id}.{webhook-timestamp}.{raw body}` with
`WHOP_WEBHOOK_SECRET`, compared in constant time, with a 5-minute replay
window. Unsigned, stale or wrongly signed requests are rejected with `401`
before any data is touched.

### Plan quotas

Free and Pro limits (sites, monthly activities, retention) are enforced
server-side before any write, returning `402`. Quota accounting lives in the
`usage` table keyed by account and month; a daily cron deletes activity older
than each plan's retention window.

### XSS-safe dashboard

`public/index.html` renders all dynamic text via `textContent` and DOM
builders — never `innerHTML` — so log content, site names and domains are
displayed inertly.

## Honest limitations (read before sending sensitive data)

- **Password hashing is HMAC-SHA256**, the same fast hash used for log fields.
  It is keyed (`HASHING_SECRET`), which protects against plain rainbow tables,
  but it is not a slow password KDF (bcrypt/scrypt/Argon2). Choose long
  passwords; treat the Workers + D1 perimeter as the main defence.
- **Passwords are bearer tokens.** The account key (`cl_live_…`) returned by
  login never expires. Store it like a password.
- **CORS is `*` on API responses.** This is safe for keyed endpoints (the key
  is the authorisation), and the site key is additionally pinned to its own
  website via the `Origin` check. There is no cookie/session anywhere.
- **The payload you send is stored as-is** (minus `actor`/`ip_address`). If a
  payload contains personal data, hash or drop it sender-side.
- **No per-minute rate limiting is implemented.** Plan quotas (monthly
  activity allowance, site count) are enforced, and Cloudflare
  platform-level protections apply, but a free account can still burst up to
  its monthly allowance within seconds.
- **Alert emails carry no sensitive content** — only the site domain, area,
  action and status — and go to the address the site owner entered. Delivery
  depends on the operator configuring `RESEND_API_KEY`; without it, alerting
  is skipped.
- **Logs are readable by the account key and the system key** (and nobody
  else), but they are not encrypted at rest beyond D1's own storage.
- **The system key (`CLIENT_API_TOKEN`) is all-powerful** and compared with a
  plain `===`; keep it long and secret. Rotate with
  `npx wrangler secret put CLIENT_API_TOKEN`.

## Secrets inventory

| Secret | Used for | If it leaks |
| --- | --- | --- |
| `HASHING_SECRET` | Password + privacy hashing | Attacker can forge logins and brute-force hashed values offline. Rotate and reset passwords (stored hashes become invalid). |
| `CLIENT_API_TOKEN` | Administrator access | Full read/write of everything. Rotate immediately. |
| `WHOP_WEBHOOK_SECRET` | Webhook verification | Attacker can forge payment events. Rotate in the Whop dashboard and in Worker secrets. |

Secrets live only in Cloudflare's encrypted secret store — never in
`wrangler.toml`, git, or `.dev.vars` (which is local-only and git-ignored).

## Reporting

Security issues: `info@safespaceshub.com` (Safe Spaces AI Innovation Hub).
