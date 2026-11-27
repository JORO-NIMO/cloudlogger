# CloudLogger

A simple, private diary of what happens on your website. It runs entirely on Cloudflare (Workers, D1 and Pages) and is built by [Safe Spaces AI Innovation Hub](https://safespaceshub.com).

- **Website:** `public/index.html` (plain HTML, no build step)
- **Service:** `src/index.js` (Cloudflare Worker)
- **Database:** `schema.sql` (Cloudflare D1)
- **Tests:** `test/logger.test.js` (`npm test`)

Full documentation lives in [`docs/`](docs/):

| Document | What it covers |
| --- | --- |
| [Architecture](docs/ARCHITECTURE.md) | How the pieces fit together on Cloudflare |
| [API reference](docs/API.md) | Every endpoint with cURL, Node.js, Python and browser snippets |
| [MCP endpoint](docs/MCP.md) | Using CloudLogger from AI assistants |
| [Deployment](docs/DEPLOYMENT.md) | Setup, secrets, local development, operations |
| [Security & privacy](docs/SECURITY.md) | What is protected, and the honest limitations |

## How a website becomes trusted

Activity is only accepted for a website its owner has proven they control.

1. The owner adds a website. CloudLogger creates a secret **verification code** and a **site key** just for that site.
2. The owner shows the code on their website, either way:
   - add `<meta name="cloudlogger-verify" content="CODE">` to the home page, or
   - publish a text file at `/.well-known/cloudlogger-verify.txt` containing only the code.
3. The owner presses **Check now**. The Worker fetches the site over HTTPS (following redirects only within the same site) and looks for the code. If found, the site is marked verified.
4. Until then, every attempt to record activity for that site is refused.

After verification:

- A **site key** (`cl_site_…`) can only record activity for its own site, and browsers may only use it from that site's own address.
- An **account key** (`cl_live_…`) can read activity only for the account's own sites.
- The administrator key (`CLIENT_API_TOKEN`) can access everything and is meant for you alone.

## Privacy

Before anything is saved, the person (`actor`) and `metadata.ip_address` are converted to one-way HMAC-SHA256 hashes using `HASHING_SECRET`. The readable values are never stored.

## Plans

| | Free | Pro ($5/month) |
| --- | --- | --- |
| Websites | 1 | 10 |
| Activities per month | 1,000 | 50,000 |
| History kept | 30 days | 1 year |
| Failure alerts by email | ✓ | ✓ |

Limits are enforced server-side (`402` when exceeded). Payments run through
Whop: its webhook (signature-verified) flips an account to Pro, and
`GET /v1/billing/status` returns plan, limits, live usage and the checkout
link. Alert emails are sent through Resend when a failure-like activity is
recorded — at most one email per site per 30 minutes.

## Endpoints

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| POST | `/v1/auth/register` | anyone | Create an account |
| POST | `/v1/auth/login` | anyone | Log in |
| GET | `/v1/sites` | account | List your sites |
| POST | `/v1/sites` | account | Add a site (`name`, `domain`) |
| POST | `/v1/sites/:id/verify` | account | Check ownership |
| POST | `/v1/sites/:id/alerts` | account | Set or clear the failure-alert email |
| POST | `/v1/logs` | site key or account key | Record activity (`project_id`, `module_name`, `action`, `status`, optional `actor`, `metadata.ip_address`, `payload`) |
| GET | `/v1/logs?project_id=…` | account | Read activity for your own site |
| GET | `/v1/billing/status` | account | Plan, limits and current usage |
| POST | `/v1/webhooks/whop` | payment provider (signature-verified) | Plan changes |
| GET | `/v1/openapi.json` | anyone | Machine-readable API description (OpenAPI 3.0) |
| POST | `/mcp` | account | JSON-RPC 2.0 tools for AI assistants (see [docs/MCP.md](docs/MCP.md)) |

Live: the API is at `https://serverless-logger-api.joronimoamanya.workers.dev` and the dashboard at `https://cloudlogger.pages.dev`.

## Secrets

Set these with `npx wrangler secret put NAME` (never put them in `wrangler.toml`):

| Name | What it is |
| --- | --- |
| `HASHING_SECRET` | Long random value used for hashing. Do not change it once people have accounts, or they cannot log in and past hashes stop matching. |
| `CLIENT_API_TOKEN` | Administrator key. |
| `WHOP_WEBHOOK_SECRET` | Secret for payment notifications. |
| `RESEND_API_KEY` | Optional: sends failure-alert emails via Resend. Without it, alerting is skipped. |

## Deploy

```bash
npm install
npm test

# New database
npx wrangler d1 create production-logger-db        # copy the id into wrangler.toml
npx wrangler d1 execute production-logger-db --remote --file=./schema.sql

# Existing databases: run each one-time migration that predates your database
npx wrangler d1 execute production-logger-db --remote --file=./migrations/0002_site_verification.sql
npx wrangler d1 execute production-logger-db --remote --file=./migrations/0003_plan_gating.sql

npx wrangler deploy
npx wrangler pages deploy public --project-name=cloudlogger --branch=production
```

For local development, copy your test secrets into `.dev.vars` (git-ignored, never deployed) and run `npx wrangler dev` — full instructions in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

`schema.sql` only creates missing tables, so it is safe to run again. It never deletes data.

## Screenshots

`node scripts/capture.mjs` serves `public/` locally and saves screenshots to `screenshots/` (needs Google Chrome).

## Licence

See [LICENSE](LICENSE).
