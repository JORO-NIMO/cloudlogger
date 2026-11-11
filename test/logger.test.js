import { describe, it, expect, beforeEach } from 'vitest';
import worker, { secureHMAC } from '../src/index.js';

let lastSql = null;
let lastBindings = [];

// In-memory mock storage for multi-tenant account, site & billing simulation
const mockUsers = [];
const mockSites = [];
const mockLogs = [
  { id: "1", project_id: "test-app", module_name: "auth", status: "SUCCESS", payload: "{}" }
];

// Setup Mock Environment variables matching Wrangler settings
const mockEnv = {
  CLIENT_API_TOKEN: "test-token-12345",
  HASHING_SECRET: "test-salt-abcde",
  WHOP_CHECKOUT_URL: "https://whop.com/safespaceshub/cloudlogger",
  WHOP_WEBHOOK_SECRET: "whop_webhook_secret_dev",
  DB: {
    prepare: (sql) => {
      lastSql = sql;
      return {
        bind: (...args) => {
          lastBindings = args;
          return {
            run: async () => {
              if (sql.includes("INSERT INTO users")) {
                mockUsers.push({
                  id: args[0],
                  email: args[1],
                  password_hash: args[2],
                  api_key: args[3],
                  plan: args[4] || "pro_monthly_5",
                  is_active_paid: args[5] !== undefined ? args[5] : 1
                });
              } else if (sql.includes("INSERT INTO sites")) {
                mockSites.push({
                  id: args[0],
                  user_id: args[1],
                  name: args[2],
                  project_id: args[3],
                  domain: args[4]
                });
              } else if (sql.includes("UPDATE users SET is_active_paid")) {
                const targetEmail = args[args.length - 1];
                const found = mockUsers.find((u) => u.email === targetEmail || u.id === targetEmail);
                if (found) {
                  found.is_active_paid = args[0] !== undefined ? args[0] : 1;
                }
              }
              return { success: true };
            },
            all: async () => {
              if (sql.includes("FROM users WHERE api_key = ?")) {
                const found = mockUsers.find((u) => u.api_key === args[0]);
                return { results: found ? [found] : [] };
              }
              if (sql.includes("FROM users WHERE email = ? AND password_hash = ?")) {
                const found = mockUsers.find((u) => u.email === args[0] && u.password_hash === args[1]);
                return { results: found ? [found] : [] };
              }
              if (sql.includes("FROM sites WHERE user_id = ?")) {
                const found = mockSites.filter((s) => s.user_id === args[0]);
                return { results: found };
              }
              if (sql.includes("FROM sites")) {
                return { results: mockSites };
              }
              return { results: mockLogs };
            }
          };
        }
      };
    }
  }
};

describe("Serverless Logging Engine Unit Testing Suite", () => {
  beforeEach(() => {
    lastSql = null;
    lastBindings = [];
  });

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

  it("Should return a 401 error code if the client provides an invalid Authorization token", async () => {
    const request = new Request("https://logger.local/v1/logs", {
      method: "POST",
      body: JSON.stringify({
        project_id: "saas-platform-one",
        module_name: "payments",
        action: "test",
        status: "SUCCESS"
      }),
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer wrong-token"
      }
    });

    const response = await worker.fetch(request, mockEnv);
    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe("Invalid API credentials");
  });

  it("Should successfully process valid entries, hash client IDs, and log transactions correctly", async () => {
    const validLogPayload = {
      project_id: "saas-platform-one",
      module_name: "payments_flutterwave",
      event_type: "USER_ACTIVITY",
      action: "checkout_success",
      actor: "user_uganda_99",
      status: "SUCCESS",
      payload: { amount: 25000, currency: "UGX" },
      metadata: { ip_address: "197.239.4.1" }
    };

    const request = new Request("https://logger.local", {
      method: "POST",
      body: JSON.stringify(validLogPayload),
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer test-token-12345"
      }
    });

    const expectedActorHash = await secureHMAC(validLogPayload.actor, mockEnv.HASHING_SECRET);
    const expectedIpHash = await secureHMAC(validLogPayload.metadata.ip_address, mockEnv.HASHING_SECRET);

    const response = await worker.fetch(request, mockEnv);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.log_id).toBeDefined();

    expect(lastSql).toContain("INSERT INTO system_logs");
    expect(lastBindings[1]).toBe("saas-platform-one");
    expect(lastBindings[2]).toBe("payments_flutterwave");
    expect(lastBindings[3]).toBe("USER_ACTIVITY");
    expect(lastBindings[4]).toBe("checkout_success");
    expect(lastBindings[5]).toBe(expectedActorHash);
    expect(lastBindings[6]).toBe("SUCCESS");
    expect(lastBindings[7]).toBe(JSON.stringify({ amount: 25000, currency: "UGX" }));
    expect(lastBindings[8]).toBe(expectedIpHash);

    expect(lastBindings).not.toContain("user_uganda_99");
    expect(lastBindings).not.toContain("197.239.4.1");
  });

  it("Should reject payloads missing structural keys like project_id or module_name", async () => {
    const brokenPayload = {
      project_id: "saas-platform-one",
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
    const data = await response.json();
    expect(data.error).toContain("Missing required core schema strings");
  });

  it("Should reject malformed or invalid JSON payloads with a 400 status", async () => {
    const request = new Request("https://logger.local/v1/logs", {
      method: "POST",
      body: "invalid-non-json-string",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer test-token-12345"
      }
    });

    const response = await worker.fetch(request, mockEnv);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain("Invalid JSON format");
  });

  it("Should support CORS preflight OPTIONS requests without requiring Authorization", async () => {
    const request = new Request("https://logger.local/v1/logs", {
      method: "OPTIONS",
      headers: {
        "Origin": "https://dashboard.example.com",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Authorization, Content-Type"
      }
    });

    const response = await worker.fetch(request, mockEnv);
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  it("Should successfully retrieve logs for a given project_id via GET /v1/logs", async () => {
    const request = new Request("https://logger.local/v1/logs?project_id=test-app", {
      method: "GET",
      headers: {
        "Authorization": "Bearer test-token-12345"
      }
    });

    const response = await worker.fetch(request, mockEnv);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(1);
    expect(data[0].project_id).toBe("test-app");
  });

  it("Should return 400 when GET /v1/logs is missing project_id query parameter", async () => {
    const request = new Request("https://logger.local/v1/logs", {
      method: "GET",
      headers: {
        "Authorization": "Bearer test-token-12345"
      }
    });

    const response = await worker.fetch(request, mockEnv);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain("Missing project_id");
  });

  it("Should return 404 for unknown endpoint routes", async () => {
    const request = new Request("https://logger.local/unknown/path", {
      method: "GET",
      headers: {
        "Authorization": "Bearer test-token-12345"
      }
    });

    const response = await worker.fetch(request, mockEnv);
    expect(response.status).toBe(404);
  });

  it("Should register a new user account, return API key, and provision initial connected site", async () => {
    const registerReq = new Request("https://logger.local/v1/auth/register", {
      method: "POST",
      body: JSON.stringify({
        email: "whop_subscriber@startup.io",
        password: "securePassword123!",
        site_name: "E-Commerce Web",
        domain: "store.startup.io"
      }),
      headers: { "Content-Type": "application/json" }
    });

    const response = await worker.fetch(registerReq, mockEnv);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.user.email).toBe("whop_subscriber@startup.io");
    expect(data.user.api_key).toMatch(/^cl_live_[a-f0-9]+$/);
    expect(data.whop.price).toBeUndefined(); // inside whop.plan
    expect(data.whop.provider).toBe("whop.com");
  });

  it("Should authenticate an existing user via POST /v1/auth/login and return Whop pricing metadata", async () => {
    const loginReq = new Request("https://logger.local/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: "whop_subscriber@startup.io",
        password: "securePassword123!"
      }),
      headers: { "Content-Type": "application/json" }
    });

    const response = await worker.fetch(loginReq, mockEnv);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.whop.provider).toBe("whop.com");
    expect(data.whop.price).toBe("$5/month");
  });

  it("Should allow authenticated customers to create additional connected sites via POST /v1/sites", async () => {
    const customer = mockUsers.find((u) => u.email === "whop_subscriber@startup.io");
    expect(customer).toBeDefined();

    const addSiteReq = new Request("https://logger.local/v1/sites", {
      method: "POST",
      body: JSON.stringify({
        name: "Mobile App Backend",
        domain: "api.startup.io"
      }),
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${customer.api_key}`
      }
    });

    const response = await worker.fetch(addSiteReq, mockEnv);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.site.name).toBe("Mobile App Backend");
  });

  it("Should process Whop.com payment webhooks at POST /v1/webhooks/whop", async () => {
    const webhookReq = new Request("https://logger.local/v1/webhooks/whop", {
      method: "POST",
      body: JSON.stringify({
        action: "payment.succeeded",
        data: {
          membership_id: "mem_whop_12345",
          user_id: "usr_whop_67890",
          user: { email: "whop_subscriber@startup.io" }
        }
      }),
      headers: { "Content-Type": "application/json" }
    });

    const response = await worker.fetch(webhookReq, mockEnv);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.provider).toBe("whop.com");
  });

  it("Should expose platform documentation manifest via GET /v1/docs", async () => {
    const docsReq = new Request("https://logger.local/v1/docs", {
      method: "GET"
    });

    const response = await worker.fetch(docsReq, mockEnv);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.name).toContain("CloudLogger");
    expect(data.payment_provider).toBe("whop.com");
    expect(data.price_usd).toBe("$5 / month");
    expect(data.endpoints.length).toBeGreaterThanOrEqual(8);
  });
});
