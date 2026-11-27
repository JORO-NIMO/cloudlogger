# CloudLogger — Deployment & Operations

Everything runs on Cloudflare. You need the `wrangler` CLI (included in
`devDependencies`) logged into the owning account:

```bash
npm install
npx wrangler login      # once; already done on this machine
```

## One-time setup

### 1. Create the D1 database

```bash
npx wrangler d1 create production-logger-db
```

Copy the returned `database_id` into `wrangler.toml` under `[[d1_databases]]`.
(This project's database already exists: id `869421f7-6db0-408c-a0d6-9cc3ecd778be`.)

### 2. Create the schema

```bash
npx wrangler d1 execute production-logger-db --remote --file=./schema.sql
```

`schema.sql` is idempotent — it only creates missing tables and indexes and
never deletes data. Databases created before a feature existed also need the
matching one-time upgrade:

```bash
# site verification (columns on sites)
npx wrangler d1 execute production-logger-db --remote --file=./migrations/0002_site_verification.sql

# plan gating + failure alerts (columns on sites, usage table, free-plan reset)
npx wrangler d1 execute production-logger-db --remote --file=./migrations/0003_plan_gating.sql
```

`0003` also moves any account that never paid (no Whop membership) to the free
plan. To keep a specific account on Pro, set it back afterwards:

```bash
npx wrangler d1 execute production-logger-db --remote --command "UPDATE users SET plan='pro_monthly_5', is_active_paid=1 WHERE email='you@example.com'"
```

### 3. Set the secrets

Never put secrets in `wrangler.toml` or in git. Set them once per environment:

```bash
npx wrangler secret put HASHING_SECRET        # long random value
npx wrangler secret put CLIENT_API_TOKEN      # administrator key
npx wrangler secret put WHOP_WEBHOOK_SECRET   # from the Whop dashboard webhook page
npx wrangler secret put RESEND_API_KEY        # optional: enables failure-alert emails
```

| Secret | Notes |
| --- | --- |
| `HASHING_SECRET` | Hashes passwords and private log fields. **Do not change it** once accounts exist: logins break and stored hashes stop matching. |
| `CLIENT_API_TOKEN` | The administrator key. Treat like a root password. |
| `WHOP_WEBHOOK_SECRET` | Verifies payment notifications. If missing, the webhook rejects everything. |
| `RESEND_API_KEY` | Optional. Sends failure-alert emails via [Resend](https://resend.com) (free tier: 100/day). Without it, alerting is skipped and everything else works. |

Verify what is configured: `npx wrangler secret list`.

Two non-secret vars live in `wrangler.toml`:

| Var | Purpose |
| --- | --- |
| `WHOP_CHECKOUT_URL` | The Whop checkout link shown on the dashboard's Upgrade button. Empty until you create a product in Whop. |
| `ALERT_FROM_EMAIL` | Sender shown on alert emails. Default is Resend's test sender; switch to an address on a domain you verified in Resend. |

### 4. Create the Pages project

```bash
npx wrangler pages project create cloudlogger
```

## Routine deploy

```bash
npm test                                   # 38 tests must pass
npx wrangler deploy                        # the Worker (API)
npx wrangler pages deploy public --project-name=cloudlogger --branch=production
```

The frontend is plain HTML/JS with no build step — `public/` is deployed
as-is. `public/index.html` contains the production API URL; if the Worker name
or account changes, update the `API` constant in that file.

Rollback if needed:

```bash
npx wrangler deployments list              # find the previous version id
npx wrangler rollback                      # rolls back to the previous deployment
```

## Local development

Create a `.dev.vars` file (git-ignored, never deployed) with local-only
secrets for `wrangler dev` — anything you like for testing, for example:

```
HASHING_SECRET=local-development-secret
CLIENT_API_TOKEN=local-admin-token
WHOP_WEBHOOK_SECRET=local-whop-secret
```

```bash
npx wrangler d1 execute production-logger-db --local --file=./schema.sql   # once, seeds the local D1
npx wrangler dev                                                           # http://127.0.0.8787
```

`--local` (the default) runs everything on your machine via Miniflare with a
SQLite file under `.wrangler/state` — production data is never touched.

Useful commands:

```bash
npx wrangler d1 execute production-logger-db --local --command "SELECT email, plan FROM users"
npx wrangler tail serverless-logger-api        # live production logs (Ctrl-C to stop)
npx wrangler secret list                       # which secrets exist in production
```

## Testing

```bash
npm test        # vitest run — 38 tests
```

The suite uses an in-memory D1 stand-in that understands exactly the SQL the
Worker issues, so a changed query breaks the tests. It covers authentication,
site verification (including redirect and cross-site refusals), the privacy
hashing, the Whop signature verification, the MCP endpoint, plan quotas
(free vs pro), failure-alert emails with cooldown, and the retention sweep.

## Whop setup (payments)

1. In the Whop dashboard, create a product for the Pro plan ($5/month).
2. Copy its checkout link into `WHOP_CHECKOUT_URL` in `wrangler.toml`, then
   `npx wrangler deploy`.
3. Under Developer → Webhooks, point a webhook at
   `https://serverless-logger-api.joronimoamanya.workers.dev/v1/webhooks/whop`,
   subscribe to `payment.succeeded`, `membership.went_valid`,
   `membership.went_invalid` and `payment.failed`, and copy the signing secret
   into the `WHOP_WEBHOOK_SECRET` Worker secret.
4. Send a test event from the Whop dashboard — it must return a 2xx.

Until step 2 is done, free users who hit a limit simply see the limit message
without an upgrade link.

## Resend setup (failure-alert emails)

1. Create a free [Resend](https://resend.com) account (100 emails/day free —
   far beyond what the 30-minute per-site cooldown can produce).
2. `npx wrangler secret put RESEND_API_KEY` with the API key.
3. Optional: verify your domain in Resend and set `ALERT_FROM_EMAIL` in
   `wrangler.toml` to an address on it, then redeploy. Without a verified
   domain, Resend's `onboarding@resend.dev` test sender only delivers to your
   own Resend account email — fine for testing.

## Scheduled jobs

`wrangler.toml` registers a daily cron trigger (`17 3 * * *`) that runs the
retention sweep (deletes activity older than each plan allows). It deploys
with `npx wrangler deploy` automatically. Inspect runs with
`npx wrangler tail serverless-logger-api` around 03:17 UTC, or trigger it
locally:

```bash
npx wrangler dev --test-scheduled
curl "http://127.0.0.1:8787/__scheduled?cron=17+3+*+*+*"
```

## Screenshots

```bash
node scripts/capture.mjs
```

Serves `public/` locally and saves desktop/phone screenshots to `screenshots/`.
Needs Google Chrome (override with the `CHROME_PATH` environment variable).

## Costs

There are no servers; you pay only for Cloudflare Workers requests, D1 rows
read/written, and Pages bandwidth, each within Cloudflare's free tiers for
small volumes. No other infrastructure exists to manage.
