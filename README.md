# CloudLogger — Edge Log-As-A-Service (Micro-SaaS)

A production-ready, serverless, general-purpose logging engine running entirely on Cloudflare's Edge network (**Workers**, **D1 SQLite Database**, and **Pages**).

---

## Live Production Deployments

- **Analytics & Account Dashboard (Cloudflare Pages)**:  
  **[`https://cloudlogger.pages.dev`](https://cloudlogger.pages.dev)**  
  *(Palette: Navy Blue `#050b1a`, Crisp White `#ffffff`, Vibrant Orange `#f97316`)*
- **Edge Ingestion & Retrieval API (Cloudflare Worker)**:  
  **[`https://serverless-logger-api.joronimoamanya.workers.dev`](https://serverless-logger-api.joronimoamanya.workers.dev)**
- **Cloudflare D1 SQLite Database**:  
  Name: `production-logger-db` | Database UUID: `869421f7-6db0-408c-a0d6-9cc3ecd778be` (Region: WEUR)
- **Whop.com $5 SaaS Subscription**:  
  All-inclusive $5/month plan unlocking unlimited account creation, connected site provisioning, and high-throughput edge telemetry ingestion.

---

## Architecture Overview

```
[ Client Applications / Embedded Frame ] (Node.js / Python / cURL / Web)
          |
          |  Bearer Auth (CLIENT_API_TOKEN or User cl_live_... API Key)
          v
[ Cloudflare Worker Edge Ingestion API ]
   ├── CORS Preflight Handler (OPTIONS 204)
   ├── Multi-Tenant Auth (System Token or User API Key from D1)
   ├── Whop.com $5/mo Billing Lifecycle Webhooks (/v1/webhooks/whop)
   ├── Interactive Platform Documentation Endpoint (/v1/docs)
   ├── Account & Site Management (Register, Login, Create Sites)
   ├── Schema Validation (400 on incomplete payload)
   └── Privacy Engine (Native Web Crypto HMAC-SHA256)
          ├── Hash 'actor' -> actor_hash
          ├── Hash 'ip_address' -> ip_hash
          └── Strip all raw PII before persistence
          |
          v
[ Cloudflare D1 SQLite Database ] (users, sites, system_logs)
          ^
          |  Authenticated GET /v1/logs?project_id=...
          |
[ Cloudflare Pages Dashboard & Embeddable Frame ]
```

---

## Built-In Platform Documentation & Whop Billing

1. **Interactive Platform Docs**: Accessible directly via the **Platform Docs** navigation button on the dashboard or `GET /v1/docs`, covering:
   - Cloudflare Serverless Edge Topology (Workers + D1 + Pages)
   - Cryptographic Edge Privacy & Web Crypto HMAC-SHA256 Redaction
   - Multi-Language SDKs (cURL, Node.js Fetch, Python Requests, Go)
   - Iframe Embed Frame Widget (`/?embed=true&project_id=...&token=...`)
   - Whop.com $5 SaaS Billing & Automated Webhook Handling
   - Full REST API Specification
2. **Whop.com Payment Integration**:
   - $5 / month subscription tier (`WHOP_PLAN_PRICE = "5"`)
   - Direct checkout link: [https://whop.com/safespaceshub/cloudlogger](https://whop.com/safespaceshub/cloudlogger)
   - Whop webhook endpoint: `POST /v1/webhooks/whop`
   - In-app license key / payment redemption modal (`POST /v1/billing/activate`)

```
[ Client Applications / Embedded Frame ] (Node.js / Python / cURL / Web)
          |
          |  Bearer Auth (CLIENT_API_TOKEN or User cl_live_... API Key)
          v
[ Cloudflare Worker Edge Ingestion API ]
   ├── CORS Preflight Handler (OPTIONS 204)
   ├── Multi-Tenant Auth (System Token or User API Key from D1)
   ├── Account & Site Management (Register, Login, Create Sites)
   ├── Schema Validation (400 on incomplete payload)
   └── Privacy Engine (Native Web Crypto HMAC-SHA256)
          ├── Hash 'actor' -> actor_hash
          ├── Hash 'ip_address' -> ip_hash
          └── Strip all raw PII before persistence
          |
          v
[ Cloudflare D1 SQLite Database ] (users, sites, system_logs)
          ^
          |  Authenticated GET /v1/logs?project_id=...
          |
[ Cloudflare Pages Dashboard & Embeddable Frame ] (Gated via Cloudflare Zero Trust)
```

---

## 1. Local Development & Setup

### Prerequisites
- Node.js `>= 18`
- npm `>= 9`

### Installation & Automated Testing
```bash
# Install dependencies
npm install

# Run automated Vitest integration test suite (13/13 passing)
npm run test
```

### Local Edge Worker Execution
```bash
# Start local Cloudflare Worker on http://127.0.0.1:8787
npm run dev
```

---

## 2. Multi-Tenant Accounts & Connected Sites API

### A. Register Account & Provision First Site
```bash
POST /v1/auth/register
Content-Type: application/json

{
  "email": "founder@startup.io",
  "password": "SuperSecretPassword123!",
  "site_name": "E-Commerce Web",
  "domain": "store.startup.io"
}
```
**Response (200 OK):**
```json
{
  "success": true,
  "user": {
    "id": "e0b04c86-8149-43c1-b0db-5da6bfa33f20",
    "email": "founder@startup.io",
    "api_key": "cl_live_9d2f8319e72847a9b0c2"
  },
  "site": {
    "id": "c1a93820-e129-4d2a-87b1-21789c02d1a3",
    "user_id": "e0b04c86-8149-43c1-b0db-5da6bfa33f20",
    "name": "E-Commerce Web",
    "project_id": "e-commerce-web-49a01f",
    "domain": "store.startup.io"
  },
  "token": "cl_live_9d2f8319e72847a9b0c2"
}
```

### B. Authenticate / Login
```bash
POST /v1/auth/login
Content-Type: application/json

{
  "email": "founder@startup.io",
  "password": "SuperSecretPassword123!"
}
```

### C. Connect Additional Sites
```bash
POST /v1/sites
Authorization: Bearer cl_live_9d2f8319e72847a9b0c2
Content-Type: application/json

{
  "name": "Mobile Backend Service",
  "domain": "api.startup.io"
}
```

---

## 3. Embeddable Frame / Iframe Widget

Connected sites can embed the real-time telemetry dashboard directly into their custom admin portals:

```html
<iframe 
  src="https://your-pages-app.pages.dev/?embed=true&project_id=e-commerce-web-49a01f&token=cl_live_9d2f8319e72847a9b0c2" 
  width="100%" 
  height="600" 
  frameborder="0"
  style="border-radius: 12px; border: 1px solid #1e293b;">
</iframe>
```

---

## 4. Cloudflare Production Deployment Runbook

### Step 1: Provision the Cloudflare D1 Database
```bash
npx wrangler d1 create production-logger-db
```
Update `database_id` in [`wrangler.toml`](file:///d:/cloudlogger/wrangler.toml).

### Step 2: Apply the Database Schema & Indices
```bash
# Local development
npx wrangler d1 execute production-logger-db --local --file=./schema.sql

# Production remote D1 database
npx wrangler d1 execute production-logger-db --remote --file=./schema.sql
```

### Step 3: Configure Production Secrets & Environment Variables

Set your production secrets using the Wrangler CLI:
```bash
# 1. Edge Cryptography Salt (Used to HMAC-SHA256 hash actor & IP addresses)
npx wrangler secret put HASHING_SECRET

# 2. System Root API Token (Admin / System-wide ingest token)
npx wrangler secret put CLIENT_API_TOKEN

# 3. Whop Payment Webhook Secret (From Whop Dashboard -> Developer -> Webhooks)
npx wrangler secret put WHOP_WEBHOOK_SECRET

# 4. Whop Public Checkout URL (Defined in wrangler.toml or as an override secret)
# Default: https://whop.com/safespaceshub/cloudlogger
npx wrangler secret put WHOP_CHECKOUT_URL

# 5. Whop API Key (Optional: for server-to-server Whop API calls)
npx wrangler secret put WHOP_API_KEY
```

### Step 4: Deploy Worker & Pages
```bash
npx wrangler deploy
npx wrangler pages deploy public --project-name=cloudlogger-dashboard
```
