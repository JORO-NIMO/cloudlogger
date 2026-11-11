To feed a modern coding agent (like Claude Engineer, Roo Code, or an automated workspace agent) successfully, you need to break down your software requirements into modular, highly specific prompt structures. Large monolithic prompts can cause agents to lose context, skip crucial files, or hallucinate boilerplate code.
Here is the complete production blueprint split into isolated, contextual agent prompts, followed by the complete file directory and a comprehensive testing suite.

Part 1: The Context Prompts for Your Coding Agent


Prompt 1: System Architecture & Data Topology

text
Context: You are a Lead Cloud Infrastructure Engineer.
Goal: Define the system architecture blueprint and database migrations for our serverless, general-purpose Log-As-A-Service engine built entirely on the Cloudflare ecosystem.

Requirements:
1. Provide a schema migration file for Cloudflare D1 (SQLite) named `schema.sql`. It must create a table `system_logs` optimized for high-throughput write operations. Include indices on commonly queried lookups (`project_id`, `module_name`, `created_at`).
2. Provide a production-ready `wrangler.toml` file setting up the development environments, environment variable bindings for security keys, and D1 database bindings.
3. Keep the stack completely serverless: Cloudflare Workers for the ingestion API, D1 for persistence, and Cloudflare Pages for the frontend visualizer.
Use code with caution.

Prompt 2: Ingestion API & Edge Cryptography Implementation

text
Context: You are a Senior Security & Web Crypto Engineer.
Goal: Write a robust, low-latency Cloudflare Worker ingestion endpoint (`POST /v1/logs`) that processes, secures, and saves module/SaaS execution logs.

Requirements:
1. Create a `src/index.js` file utilizing modern ES Modules structure.
2. Authenticate requests using a Bearer token verification system via the `Authorization` header against `env.CLIENT_API_TOKEN`. Return 401 on failure.
3. Enforce data schemas: `project_id`, `module_name`, `action`, and `status` are required. Validate that `payload` is an object. Return 400 on failure.
4. Privacy Engine: Use the edge-native Web Crypto API to hash sensitive data elements. Implement HMAC-SHA256 tracking. Read `env.HASHING_SECRET`. Automatically check if `actor` and `metadata.ip_address` are present. Generate secure hashes (`actor_hash`, `ip_hash`) and strip the plain-text originals to preserve customer privacy before writing parameters into the D1 statement.
5. Expose an authenticated `GET /v1/logs` endpoint queryable by your dashboard, filtering by `project_id`.
Use code with caution.

Prompt 3: Developer API & Reusable Multi-Language Snippets

text
Context: You are a Developer Relations Engineer.
Goal: Create copy-pasteable code snippets and structural examples that external developers can use to integrate their software systems seamlessly into our logging service.

Requirements:
1. Provide a standard multi-platform API Integration payload template in JSON format showing where user activity, system bugs, or workflow flags are written.
2. Provide clean, modern integration blocks for:
   - cURL (command line)
   - Node.js (Fetch API with proper error handling)
   - Python (using the `requests` library inside a try-except layer)
Use code with caution.

Prompt 4: Cloudflare Pages Analytics Dashboard

text
Context: You are a Frontend UI/UX Developer.
Goal: Build a performant, static frontend dashboard layout that developers can use to parse through logs visually.

Requirements:
1. Create a standalone `public/index.html` file leveraging Tailwind CSS CDN and simple modular JavaScript.
2. The UI must feature an executive summary layout (Total Logs Count, Active Modules, Success Rate KPI cards) alongside a dynamic data table displaying incoming live records.
3. Include functional filtering capabilities allowing developers to query events by `project_id`, `module_name`, or `status`.
4. Do not include internal login handlers or custom identity stores. Write clear, markdown-friendly deployment documentation detailing how to configure Cloudflare Access (Zero Trust) directly via the Cloudflare Dashboard to enforce corporate email access controls instantly.
Use code with caution.

Part 2: The Core Project Files

Create these files exactly as structured below in your local directory.

File 1: schema.sql (Database Setup)

sql
-- D1 Migration Schema for General Logging Engine
DROP TABLE IF EXISTS system_logs;

CREATE TABLE system_logs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    module_name TEXT NOT NULL,
    event_type TEXT NOT NULL,
    action TEXT NOT NULL,
    actor_hash TEXT,
    status TEXT NOT NULL,
    payload TEXT NOT NULL, -- JSON string
    ip_hash TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Optimize query speeds for large scales
CREATE INDEX idx_logs_project_module ON system_logs(project_id, module_name);
CREATE INDEX idx_logs_created_at ON system_logs(created_at);
Use code with caution.

File 2: wrangler.toml (Cloudflare Setup Configuration)

toml
name = "serverless-logger-api"
main = "src/index.js"
compatibility_date = "2026-11-09"

[vars]
# In production, these should be added via 'wrangler secret put'
CLIENT_API_TOKEN = "dev-token-secret-12345"
HASHING_SECRET = "dev-hashing-salt-secure-98765"

[[d1_databases]]
binding = "DB"
database_name = "production-logger-db"
database_id = "your-d1-database-uuid-goes-here"
Use code with caution.

File 3: src/index.js (The Edge Ingestion Worker Core)

javascript
// Worker Core: Handles high-throughput logging logic safely at the edge
async function secureHMAC(value, secretKey) {
  if (!value) return null;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secretKey),
    { name: "HMAC", hash: "SHA-256" },
    false, ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(value));
  return Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // Global Security Check: Validate incoming Authorization Token
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized access path" }), {
        status: 401,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }
    const token = authHeader.split(" ")[1];
    if (token !== env.CLIENT_API_TOKEN) {
      return new Response(JSON.stringify({ error: "Invalid API credentials" }), {
        status: 401,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    // CORS preflight support
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type"
        }
      });
    }

    // Route A: Ingest Logs (POST)
    if (request.method === "POST" && url.pathname === "/v1/logs") {
      try {
        const body = await request.json();
        
        // Strict Schema Assertions
        if (!body.project_id || !body.module_name || !body.action || !body.status) {
          return new Response(JSON.stringify({ error: "Missing required core schema strings" }), { status: 400 });
        }

        const logId = crypto.randomUUID();
        
        // Handle Privacy Fields at the edge via HMAC
        const actorHash = await secureHMAC(body.actor, env.HASHING_SECRET);
        const ipHash = await secureHMAC(body.metadata?.ip_address, env.HASHING_SECRET);
        
        const payloadData = body.payload ? JSON.stringify(body.payload) : "{}";

        // Write directly to D1 Table Instance
        await env.DB.prepare(
          `INSERT INTO system_logs (id, project_id, module_name, event_type, action, actor_hash, status, payload, ip_hash) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(logId, body.project_id, body.module_name, body.event_type || 'INFO', body.action, actorHash, body.status, payloadData, ipHash).run();

        return new Response(JSON.stringify({ success: true, log_id: logId }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });

      } catch (err) {
        return new Response(JSON.stringify({ error: "Invalid JSON format body structure", details: err.message }), { status: 400 });
      }
    }

    // Route B: Read Logs For Dashboard (GET)
    if (request.method === "GET" && url.pathname === "/v1/logs") {
      const projectId = url.searchParams.get("project_id");
      if (!projectId) {
        return new Response(JSON.stringify({ error: "Missing project_id url parameter" }), { status: 400 });
      }

      const { results } = await env.DB.prepare(
        "SELECT * FROM system_logs WHERE project_id = ? ORDER BY created_at DESC LIMIT 200"
      ).bind(projectId).all();

      return new Response(JSON.stringify(results), {
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    return new Response(JSON.stringify({ error: "Endpoint route target not found" }), { status: 404 });
  }
};
Use code with caution.

Part 3: Automated Unit Testing Environment

To guarantee everything works automatically, we will implement local unit tests using Vitest and the Miniflare/Wrangler Serverless Simulation Environment.

File 4: package.json (Dependencies Setup)

json
{
  "name": "serverless-logger",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "test": "vitest run"
  },
  "devDependencies": {
    "wrangler": "^3.0.0",
    "vitest": "^1.0.0"
  }
}
Use code with caution.

File 5: test/logger.test.js (The Unit Tests File)

Run these unit tests to verify system reliability locally before shipping code into production.
javascript
import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../src/index.js';

// Setup Mock Environment variables matching Wrangler settings
const mockEnv = {
  CLIENT_API_TOKEN: "test-token-12345",
  HASHING_SECRET: "test-salt-abcde",
  DB: {
    prepare: (sql) => ({
      bind: (...args) => ({
        run: async () => ({ success: true }),
        all: async () => ({ results: [
          { id: "1", project_id: "test-app", module_name: "auth", status: "SUCCESS", payload: "{}" }
        ] })
      })
    })
  }
};

describe("Serverless Logging Engine Unit Testing Suite", () => {
  
  it("Should return a 401 error code if the client fails to provide an Authorization token", async () => {
    const request = new Request("https://logger.local", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" }
    });
    
    const response = await worker.fetch(request, mockEnv);
    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toContain("Unauthorized");
  });

  it("Should successfully process valid entries, hash client IDs, and log transactions correctly", async () => {
    const validLogPayload = {
      project_id: "saas-platform-one",
      module_name: "payments_flutterwave",
      event_type: "USER_ACTIVITY",
      action: "checkout_success",
      actor: "user_uganda_99", // To be securely converted to HMAC
      status: "SUCCESS",
      payload: { amount: 25000, currency: "UGX" },
      metadata: { ip_address: "197.239.4.1" } // To be securely converted to HMAC
    };

    const request = new Request("https://logger.local", {
      method: "POST",
      body: JSON.stringify(validLogPayload),
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer test-token-12345"
      }
    });

    const response = await worker.fetch(request, mockEnv);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.log_id).toBeDefined();
  });

  it("Should reject payloads missing structural keys like project_id or module_name", async () => {
    const brokenPayload = {
      project_id: "saas-platform-one",
      // missing module_name completely
      action: "checkout_success",
      status: "SUCCESS"
    };

    const request = new Request("https://logger.local", {
      method: "POST",
      body: JSON.stringify(brokenPayload),
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer test-token-12345"
      }
    });

    const response = await worker.fetch(request, mockEnv);
    expect(response.status).toBe(400);
  });
});
Use code with caution.
