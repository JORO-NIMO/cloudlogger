# CloudLogger

A simple, private diary of what happens on your website. It runs entirely on Cloudflare (Workers, D1 and Pages) and is built by [Safe Spaces AI Innovation Hub](https://safespaceshub.com).

- **Website:** `public/index.html` (plain HTML, no build step)
- **Service:** `src/index.js` (Cloudflare Worker)
- **Database:** `schema.sql` (Cloudflare D1)
- **Tests:** `test/logger.test.js` (`npm test`)

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

## Endpoints

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| POST | `/v1/auth/register` | anyone | Create an account |
| POST | `/v1/auth/login` | anyone | Log in |
| GET | `/v1/sites` | account | List your sites |
| POST | `/v1/sites` | account | Add a site (`name`, `domain`) |
| POST | `/v1/sites/:id/verify` | account | Check ownership |
| POST | `/v1/logs` | site key or account key | Record activity (`project_id`, `module_name`, `action`, `status`, optional `actor`, `metadata.ip_address`, `payload`) |
| GET | `/v1/logs?project_id=…` | account | Read activity for your own site |
| GET | `/v1/billing/status` | account | Plan status |
| POST | `/v1/webhooks/whop` | payment provider | Plan changes |

## Secrets

Set these with `npx wrangler secret put NAME` (never put them in `wrangler.toml`):

| Name | What it is |
| --- | --- |
| `HASHING_SECRET` | Long random value used for hashing. Do not change it once people have accounts, or they cannot log in and past hashes stop matching. |
| `CLIENT_API_TOKEN` | Administrator key. |
| `WHOP_WEBHOOK_SECRET` | Secret for payment notifications. |

## Deploy

```bash
npm install
npm test

# New database
npx wrangler d1 create production-logger-db        # copy the id into wrangler.toml
npx wrangler d1 execute production-logger-db --remote --file=./schema.sql

# Existing database created before site verification
npx wrangler d1 execute production-logger-db --remote --file=./migrations/0002_site_verification.sql

npx wrangler deploy
npx wrangler pages deploy public --project-name=cloudlogger --branch=production
```

`schema.sql` only creates missing tables, so it is safe to run again. It never deletes data.

## Screenshots

`node scripts/capture.mjs` serves `public/` locally and saves screenshots to `screenshots/` (needs Google Chrome).

## Licence

See [LICENSE](LICENSE).
