import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import worker, { secureHMAC, normalizeDomain, extractMetaToken } from "../src/index.js";

// ---------------------------------------------------------------------------
// In-memory stand-in for Cloudflare D1. It understands exactly the statements
// the worker issues, so a changed query in src/index.js fails these tests.
// ---------------------------------------------------------------------------
let users, sites, logs, userUpdates, usage, deletes;

const mockEnv = {
  CLIENT_API_TOKEN: "test-admin-token",
  HASHING_SECRET: "test-salt-abcde",
  WHOP_WEBHOOK_SECRET: "test-whop-webhook-secret",
  DB: {
    prepare: (sql) => ({
      bind: (...a) => ({
        run: async () => {
          if (sql.includes("INSERT INTO users")) {
            if (users.some((u) => u.email === a[1])) throw new Error("UNIQUE constraint failed: users.email");
            // Mirrors a legacy database whose users table still defaults to pro:
            // only an explicit 'free' in the INSERT yields the free plan.
            users.push({
              id: a[0], email: a[1], password_hash: a[2], api_key: a[3],
              plan: sql.includes("'free'") ? "free" : "pro_monthly_5",
              is_active_paid: sql.includes("'free'") ? 0 : 1
            });
          } else if (sql.includes("INSERT INTO sites")) {
            sites.push({
              id: a[0], user_id: a[1], name: a[2], project_id: a[3], domain: a[4],
              verify_token: a[5], ingest_key: a[6], verified_at: null, created_at: "2026-01-01 00:00:00"
            });
          } else if (sql.includes("UPDATE sites SET verified_at")) {
            const site = sites.find((s) => s.id === a[0]);
            if (site) site.verified_at = "2026-01-01 00:00:00";
          } else if (sql.includes("INSERT INTO system_logs")) {
            logs.push({
              id: a[0], project_id: a[1], module_name: a[2], event_type: a[3], action: a[4],
              actor_hash: a[5], status: a[6], payload: a[7], ip_hash: a[8]
            });
          } else if (sql.includes("UPDATE users SET is_active_paid")) {
            const user = users.find((u) => a.includes(u.email));
            if (user) {
              user.is_active_paid = sql.includes("is_active_paid = 1") ? 1 : 0;
              user.plan = sql.includes("pro_monthly_5") ? "pro_monthly_5" : "free";
            }
            userUpdates.push(sql);
          } else if (sql.includes("INSERT INTO usage")) {
            const key = `${a[0]}|${a[1]}`;
            usage[key] = (usage[key] || 0) + (a[2] ?? 1);
          } else if (sql.includes("UPDATE sites SET alert_email")) {
            const site = sites.find((s) => s.id === a[1]);
            if (site) site.alert_email = a[0];
          } else if (sql.includes("UPDATE sites SET last_alert_at")) {
            const site = sites.find((s) => s.id === a[0]);
            if (site) site.last_alert_at = new Date().toISOString().slice(0, 19).replace("T", " ");
          } else if (sql.includes("DELETE FROM system_logs") || sql.includes("DELETE FROM usage")) {
            deletes.push(sql);
          }
          return { success: true };
        },
        all: async () => {
          if (sql.includes("FROM users u WHERE u.id")) {
            const user = users.find((u) => u.id === a[1]);
            return { results: [{ plan: user?.plan ?? "free", used: usage[`${a[1]}|${a[0]}`] ?? 0 }] };
          }
          if (sql.includes("FROM usage WHERE user_id")) return { results: [{ n: usage[`${a[0]}|${a[1]}`] ?? 0 }] };
          if (sql.includes("COUNT(*) AS n FROM sites")) return { results: [{ n: sites.filter((s) => s.user_id === a[0]).length }] };
          if (sql.includes("FROM users WHERE api_key")) return { results: users.filter((u) => u.api_key === a[0]) };
          if (sql.includes("FROM users WHERE email = ? AND password_hash")) {
            return { results: users.filter((u) => u.email === a[0] && u.password_hash === a[1]) };
          }
          if (sql.includes("FROM sites WHERE ingest_key")) return { results: sites.filter((s) => s.ingest_key === a[0]) };
          if (sql.includes("FROM sites WHERE id = ? AND user_id")) {
            return { results: sites.filter((s) => s.id === a[0] && s.user_id === a[1]) };
          }
          if (sql.includes("FROM sites WHERE id = ?")) return { results: sites.filter((s) => s.id === a[0]) };
          if (sql.includes("FROM sites WHERE project_id = ? AND user_id")) {
            return { results: sites.filter((s) => s.project_id === a[0] && s.user_id === a[1]) };
          }
          if (sql.includes("FROM sites WHERE user_id")) return { results: sites.filter((s) => s.user_id === a[0]) };
          if (sql.includes("FROM sites")) return { results: sites };
          if (sql.includes("FROM system_logs WHERE project_id")) return { results: logs.filter((l) => l.project_id === a[0]) };
          return { results: [] };
        }
      })
    })
  }
};

const call = (path, { method = "POST", body, token, headers = {}, env = mockEnv } = {}) =>
  worker.fetch(
    new Request(`https://logger.local${path}`, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers
      }
    }),
    env
  );

const register = async (email = "owner@example.com") => {
  const res = await call("/v1/auth/register", { body: { email, password: "a-good-password" } });
  return (await res.json()).token;
};

const addSite = async (token, domain = "mysite.com") => {
  const res = await call("/v1/sites", { token, body: { name: "My Shop", domain } });
  return (await res.json()).site;
};

const pageWithCode = (code) =>
  new Response(`<html><head><meta name="cloudlogger-verify" content="${code}"></head></html>`, { status: 200 });

const verifiedSite = async (token, domain = "mysite.com") => {
  const site = await addSite(token, domain);
  vi.stubGlobal("fetch", vi.fn(async () => pageWithCode(site.verify_token)));
  await call(`/v1/sites/${site.id}/verify`, { token });
  return site;
};

const logBody = (projectId, extra = {}) => ({
  project_id: projectId,
  module_name: "checkout",
  action: "order_placed",
  status: "SUCCESS",
  ...extra
});

beforeEach(() => {
  users = [];
  sites = [];
  logs = [];
  userUpdates = [];
  usage = {};
  deletes = [];
});
afterEach(() => vi.unstubAllGlobals());

describe("Access control", () => {
  it("returns 401 when no Authorization header is sent", async () => {
    const res = await call("/v1/logs", { body: {} });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toContain("Unauthorized");
  });

  it("returns 401 for an invalid token", async () => {
    const res = await call("/v1/logs", { token: "wrong-token", body: logBody("x") });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Invalid API credentials");
  });

  it("answers CORS preflight with 204 before any authentication", async () => {
    const res = await call("/v1/logs", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  it("no longer offers a self-service upgrade route", async () => {
    const token = await register();
    const res = await call("/v1/billing/activate", { token, body: { license_key: "anything" } });
    expect(res.status).toBe(404);
  });
});

describe("Logging and privacy (administrator key)", () => {
  it("stores only hashes of the person and IP address (200)", async () => {
    const res = await call("/v1/logs", {
      token: "test-admin-token",
      body: logBody("any-project", {
        actor: "jane@shop.com",
        metadata: { ip_address: "197.239.4.1" },
        payload: { amount: 25000, actor: "jane@shop.com", ip_address: "197.239.4.1" }
      })
    });
    expect(res.status).toBe(200);
    expect(logs).toHaveLength(1);
    expect(logs[0].actor_hash).toBe(await secureHMAC("jane@shop.com", mockEnv.HASHING_SECRET));
    expect(logs[0].ip_hash).toBe(await secureHMAC("197.239.4.1", mockEnv.HASHING_SECRET));
    const stored = JSON.stringify(logs[0]);
    expect(stored).not.toContain("jane@shop.com");
    expect(stored).not.toContain("197.239.4.1");
  });

  it("returns 400 when required fields are missing", async () => {
    const res = await call("/v1/logs", { token: "test-admin-token", body: { project_id: "p", module_name: "m" } });
    expect(res.status).toBe(400);
  });

  it("returns 400 when payload is not an object", async () => {
    const res = await call("/v1/logs", { token: "test-admin-token", body: logBody("p", { payload: "text" }) });
    expect(res.status).toBe(400);
  });
});

describe("Accounts", () => {
  it("creates an account without any pre-made site or sample data", async () => {
    const res = await call("/v1/auth/register", { body: { email: "New@Example.com", password: "a-good-password" } });
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.token).toMatch(/^cl_live_/);
    expect(data.user.email).toBe("new@example.com");
    expect(sites).toHaveLength(0);
    expect(users[0].password_hash).not.toContain("a-good-password");
    expect(JSON.stringify(data)).not.toMatch(/whop/i);
  });

  it("rejects weak passwords and duplicate emails", async () => {
    expect((await call("/v1/auth/register", { body: { email: "a@b.co", password: "short" } })).status).toBe(400);
    await register("dup@example.com");
    expect((await call("/v1/auth/register", { body: { email: "dup@example.com", password: "a-good-password" } })).status).toBe(409);
  });

  it("logs in with the right password only", async () => {
    await register("login@example.com");
    const ok = await call("/v1/auth/login", { body: { email: "login@example.com", password: "a-good-password" } });
    expect(ok.status).toBe(200);
    const bad = await call("/v1/auth/login", { body: { email: "login@example.com", password: "nope-nope-nope" } });
    expect(bad.status).toBe(401);
  });
});

describe("Site ownership and verification", () => {
  it("adds a site as not verified, with its own codes", async () => {
    const token = await register();
    const site = await addSite(token, "https://www.MySite.com/shop");
    expect(site.domain).toBe("mysite.com");
    expect(site.verified).toBe(false);
    expect(site.verify_token).toHaveLength(32);
    expect(site.ingest_key).toMatch(/^cl_site_/);
  });

  it("rejects an invalid website address", async () => {
    const token = await register();
    for (const domain of ["", "localhost", "192.168.0.1", "not a site", "user@evil.com"]) {
      const res = await call("/v1/sites", { token, body: { name: "x", domain } });
      expect(res.status).toBe(400);
    }
  });

  it("refuses activity from a site that is not verified", async () => {
    const token = await register();
    const site = await addSite(token);
    const res = await call("/v1/logs", { token, body: logBody(site.project_id) });
    expect(res.status).toBe(403);
    expect(logs).toHaveLength(0);
  });

  it("stays unverified when the code is not on the website", async () => {
    const token = await register();
    const site = await addSite(token);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html></html>", { status: 200 })));
    const res = await call(`/v1/sites/${site.id}/verify`, { token });
    expect((await res.json()).verified).toBe(false);
    expect(sites[0].verified_at).toBeNull();
  });

  it("verifies when the code is on the home page", async () => {
    const token = await register();
    const site = await addSite(token);
    vi.stubGlobal("fetch", vi.fn(async () => pageWithCode(site.verify_token)));
    const res = await call(`/v1/sites/${site.id}/verify`, { token });
    expect((await res.json()).verified).toBe(true);
    expect(sites[0].verified_at).not.toBeNull();
  });

  it("verifies when the code is in the verification file", async () => {
    const token = await register();
    const site = await addSite(token);
    vi.stubGlobal("fetch", vi.fn(async (url) =>
      url.endsWith("cloudlogger-verify.txt") ? new Response(`${site.verify_token}\n`, { status: 200 }) : new Response("", { status: 404 })
    ));
    const res = await call(`/v1/sites/${site.id}/verify`, { token });
    expect((await res.json()).verified).toBe(true);
  });

  it("does not accept a code served from a different website after a redirect", async () => {
    const token = await register();
    const site = await addSite(token);
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      url: "https://evil.example/",
      text: async () => `<meta name="cloudlogger-verify" content="${site.verify_token}">`
    })));
    const res = await call(`/v1/sites/${site.id}/verify`, { token });
    expect((await res.json()).verified).toBe(false);
  });

  it("accepts activity from a verified site with the account key", async () => {
    const token = await register();
    const site = await verifiedSite(token);
    const res = await call("/v1/logs", { token, body: logBody(site.project_id) });
    expect(res.status).toBe(200);
    expect(logs).toHaveLength(1);
  });

  it("accepts activity with the site key only for its own site and website", async () => {
    const token = await register();
    const site = await verifiedSite(token);
    const own = await call("/v1/logs", {
      token: site.ingest_key, body: logBody(site.project_id), headers: { Origin: "https://www.mysite.com" }
    });
    expect(own.status).toBe(200);

    const otherWebsite = await call("/v1/logs", {
      token: site.ingest_key, body: logBody(site.project_id), headers: { Origin: "https://evil.example" }
    });
    expect(otherWebsite.status).toBe(403);

    const otherSite = await call("/v1/logs", { token: site.ingest_key, body: logBody("someone-elses-site") });
    expect(otherSite.status).toBe(403);
    expect(logs).toHaveLength(1);
  });

  it("keeps a site key from reading logs or listing sites", async () => {
    const token = await register();
    const site = await verifiedSite(token);
    expect((await call("/v1/sites", { method: "GET", token: site.ingest_key })).status).toBe(403);
    expect((await call(`/v1/logs?project_id=${site.project_id}`, { method: "GET", token: site.ingest_key })).status).toBe(403);
  });

  it("stops one account from writing to or reading another account's site", async () => {
    const ownerToken = await register("owner@example.com");
    const site = await verifiedSite(ownerToken);
    await call("/v1/logs", { token: ownerToken, body: logBody(site.project_id) });

    const intruderToken = await register("intruder@example.com");
    const write = await call("/v1/logs", { token: intruderToken, body: logBody(site.project_id) });
    const read = await call(`/v1/logs?project_id=${site.project_id}`, { method: "GET", token: intruderToken });
    const verify = await call(`/v1/sites/${site.id}/verify`, { token: intruderToken });
    expect(write.status).toBe(403);
    expect(read.status).toBe(403);
    expect(verify.status).toBe(404);

    const mine = await call(`/v1/logs?project_id=${site.project_id}`, { method: "GET", token: ownerToken });
    expect(await mine.json()).toHaveLength(1);
  });

  it("only lists the signed-in account's own sites", async () => {
    const a = await register("a@example.com");
    const b = await register("b@example.com");
    await addSite(a, "a-site.com");
    await addSite(b, "b-site.com");
    const res = await call("/v1/sites", { method: "GET", token: a });
    const data = await res.json();
    expect(data.sites).toHaveLength(1);
    expect(data.sites[0].domain).toBe("a-site.com");
  });
});

describe("Payment webhooks", () => {
  const secret = mockEnv.WHOP_WEBHOOK_SECRET;

  // Signs a raw body exactly the way Whop documents it.
  const whopHeaders = (rawBody, { id = "msg_123", ts = Math.floor(Date.now() / 1000), key = secret } = {}) => ({
    "webhook-id": id,
    "webhook-timestamp": String(ts),
    "webhook-signature":
      "v1," + createHmac("sha256", key).update(`${id}.${ts}.${rawBody}`).digest("base64")
  });

  const webhookPost = (rawBody, headers, env = mockEnv) =>
    worker.fetch(
      new Request("https://logger.local/v1/webhooks/whop", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: rawBody
      }),
      env
    );

  it("accepts a correctly signed payment notification and marks the account paid", async () => {
    await register("paid@example.com");
    const rawBody = JSON.stringify({
      event: "payment.succeeded",
      data: { user: { email: "paid@example.com" }, membership_id: "m_1", user_id: "u_1" }
    });
    const res = await webhookPost(rawBody, whopHeaders(rawBody));
    expect(res.status).toBe(200);
    expect((await res.json()).processed_event).toBe("payment.succeeded");
    expect(users[0].is_active_paid).toBe(1);
    expect(users[0].plan).toBe("pro_monthly_5");
  });

  it("accepts a signed cancellation and downgrades the account", async () => {
    await register("gone@example.com");
    const rawBody = JSON.stringify({
      event: "membership.went_invalid",
      data: { user: { email: "gone@example.com" } }
    });
    const res = await webhookPost(rawBody, whopHeaders(rawBody));
    expect(res.status).toBe(200);
    expect(users[0].is_active_paid).toBe(0);
    expect(users[0].plan).toBe("free");
  });

  it("rejects a notification with no signature headers", async () => {
    const res = await webhookPost(JSON.stringify({ event: "payment.succeeded", data: {} }), {});
    expect(res.status).toBe(401);
    expect(userUpdates).toHaveLength(0);
  });

  it("rejects a signature made with the wrong secret", async () => {
    const rawBody = JSON.stringify({ event: "payment.succeeded", data: { user: { email: "x@y.co" } } });
    const res = await webhookPost(rawBody, whopHeaders(rawBody, { key: "attacker-secret" }));
    expect(res.status).toBe(401);
  });

  it("rejects a replayed notification older than five minutes", async () => {
    const rawBody = JSON.stringify({ event: "payment.succeeded", data: { user: { email: "x@y.co" } } });
    const res = await webhookPost(rawBody, whopHeaders(rawBody, { ts: Math.floor(Date.now() / 1000) - 400 }));
    expect(res.status).toBe(401);
  });

  it("rejects everything when no webhook secret is configured", async () => {
    const rawBody = JSON.stringify({ event: "payment.succeeded", data: { user: { email: "x@y.co" } } });
    const envWithoutSecret = { ...mockEnv, WHOP_WEBHOOK_SECRET: undefined };
    const res = await webhookPost(rawBody, whopHeaders(rawBody), envWithoutSecret);
    expect(res.status).toBe(401);
  });
});

describe("API description and MCP endpoint", () => {
  it("serves the OpenAPI description without a key", async () => {
    const res = await call("/v1/openapi.json", { method: "GET" });
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.openapi).toBe("3.0.3");
    expect(data.servers[0].url).toBe("https://logger.local");
    expect(Object.keys(data.paths)).toContain("/v1/logs");
    expect(Object.keys(data.paths)).toContain("/mcp");
  });

  it("lists every endpoint in /v1/docs", async () => {
    const res = await call("/v1/docs", { method: "GET" });
    const paths = (await res.json()).endpoints.map((e) => e.path);
    expect(paths).toContain("/v1/auth/register");
    expect(paths).toContain("/v1/billing/status");
    expect(paths).toContain("/v1/openapi.json");
    expect(paths).toContain("/mcp");
  });

  it("requires a key for /mcp", async () => {
    const res = await call("/mcp", { body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} } });
    expect(res.status).toBe(401);
  });

  it("keeps a site key away from /mcp", async () => {
    const token = await register();
    const site = await verifiedSite(token);
    const res = await call("/mcp", {
      token: site.ingest_key,
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" }
    });
    expect(res.status).toBe(403);
  });

  it("answers initialize and tools/list", async () => {
    const token = await register();
    const init = await call("/mcp", { token, body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} } });
    expect((await init.json()).result.serverInfo.name).toBe("cloudlogger");

    const tools = await call("/mcp", { token, body: { jsonrpc: "2.0", id: 2, method: "tools/list" } });
    const names = (await tools.json()).result.tools.map((t) => t.name);
    expect(names).toEqual(["list_sites", "add_site", "verify_site", "get_activity", "record_activity"]);
  });

  it("runs list_sites as the account that sent the key", async () => {
    const a = await register("a@example.com");
    const b = await register("b@example.com");
    await addSite(a, "a-site.com");
    await addSite(b, "b-site.com");
    const res = await call("/mcp", {
      token: a,
      body: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_sites", arguments: {} } }
    });
    const text = (await res.json()).result.content[0].text;
    expect(text).toContain("a-site.com");
    expect(text).not.toContain("b-site.com");
  });

  it("records and reads activity through the MCP tools", async () => {
    const token = await register();
    const site = await verifiedSite(token);
    const write = await call("/mcp", {
      token,
      body: {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "record_activity",
          arguments: { project_id: site.project_id, area: "Checkout", what_happened: "Order placed", result: "SUCCESS" }
        }
      }
    });
    expect((await write.json()).result.isError).toBeFalsy();
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("Order placed");

    const read = await call("/mcp", {
      token,
      body: {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "get_activity", arguments: { project_id: site.project_id } }
      }
    });
    expect((await read.json()).result.content[0].text).toContain("Order placed");
  });

  it("accepts notifications with 202 and rejects unknown methods", async () => {
    const token = await register();
    const note = await call("/mcp", { token, body: { jsonrpc: "2.0", method: "notifications/initialized" } });
    expect(note.status).toBe(202);

    const bad = await call("/mcp", { token, body: { jsonrpc: "2.0", id: 9, method: "nope/nothing" } });
    expect((await bad.json()).error.code).toBe(-32601);
  });
});

describe("Plans and limits", () => {
  const month = () => new Date().toISOString().slice(0, 7);

  it("creates new accounts on the free plan", async () => {
    await register();
    expect(users[0].plan).toBe("free");
    expect(users[0].is_active_paid).toBe(0);
  });

  it("limits free accounts to one website", async () => {
    const token = await register();
    await addSite(token, "first.com");
    const res = await call("/v1/sites", { token, body: { name: "Second", domain: "second.com" } });
    expect(res.status).toBe(402);
    expect(sites).toHaveLength(1);
  });

  it("allows pro accounts more websites", async () => {
    const token = await register();
    users[0].plan = "pro_monthly_5";
    await addSite(token, "first.com");
    const res = await call("/v1/sites", { token, body: { name: "Second", domain: "second.com" } });
    expect(res.status).toBe(200);
    expect(sites).toHaveLength(2);
  });

  it("stops recording when the free monthly quota is used up", async () => {
    const token = await register();
    const site = await verifiedSite(token);
    usage[`${users[0].id}|${month()}`] = 1000;
    const res = await call("/v1/logs", { token, body: logBody(site.project_id) });
    expect(res.status).toBe(402);
    expect(logs).toHaveLength(0);
  });

  it("keeps recording for pro accounts past the free allowance", async () => {
    const token = await register();
    const site = await verifiedSite(token);
    users[0].plan = "pro_monthly_5";
    usage[`${users[0].id}|${month()}`] = 1200;
    const res = await call("/v1/logs", { token, body: logBody(site.project_id) });
    expect(res.status).toBe(200);
    expect(logs).toHaveLength(1);
  });

  it("counts activities and reports them with the plan limits", async () => {
    const token = await register();
    const site = await verifiedSite(token);
    await call("/v1/logs", { token, body: logBody(site.project_id) });
    const res = await call("/v1/billing/status", { method: "GET", token });
    const data = await res.json();
    expect(data.plan).toBe("free");
    expect(data.limits).toEqual({ sites: 1, logs_per_month: 1000, retention_days: 30 });
    expect(data.usage.sites).toBe(1);
    expect(data.usage.logs_this_month).toBe(1);
  });

  it("includes the checkout link only when one is configured", async () => {
    const token = await register();
    const withUrl = await call("/v1/billing/status", {
      method: "GET", token, env: { ...mockEnv, WHOP_CHECKOUT_URL: "https://whop.com/checkout/test" }
    });
    expect((await withUrl.json()).checkout_url).toBe("https://whop.com/checkout/test");
    const withoutUrl = await call("/v1/billing/status", { method: "GET", token });
    expect((await withoutUrl.json()).checkout_url).toBeUndefined();
  });
});

describe("Failure alerts", () => {
  it("saves and clears the alert email for a verified site", async () => {
    const token = await register();
    const site = await verifiedSite(token);
    const set = await call(`/v1/sites/${site.id}/alerts`, { token, body: { email: "Owner@Example.com" } });
    expect(set.status).toBe(200);
    expect((await set.json()).alert_email).toBe("owner@example.com");
    expect(sites[0].alert_email).toBe("owner@example.com");
    const listed = await call("/v1/sites", { method: "GET", token });
    expect((await listed.json()).sites[0].alert_email).toBe("owner@example.com");

    const bad = await call(`/v1/sites/${site.id}/alerts`, { token, body: { email: "not-an-email" } });
    expect(bad.status).toBe(400);

    const off = await call(`/v1/sites/${site.id}/alerts`, { token, body: { email: "" } });
    expect((await off.json()).alert_email).toBeNull();
    expect(sites[0].alert_email).toBeNull();
  });

  it("refuses alerts on an unverified site", async () => {
    const token = await register();
    const site = await addSite(token);
    const res = await call(`/v1/sites/${site.id}/alerts`, { token, body: { email: "a@b.co" } });
    expect(res.status).toBe(400);
  });

  it("emails a failure alert once per cooldown window", async () => {
    const token = await register();
    const site = await verifiedSite(token);
    await call(`/v1/sites/${site.id}/alerts`, { token, body: { email: "owner@example.com" } });

    const sends = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (String(url).includes("api.resend.com")) {
        sends.push(init);
        return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
      }
      return pageWithCode(site.verify_token);
    }));

    const first = await call("/v1/logs", {
      token,
      env: { ...mockEnv, RESEND_API_KEY: "re_test_key" },
      body: logBody(site.project_id, { action: "Payment declined", status: "FAILED" })
    });
    expect(first.status).toBe(200);
    expect(sends).toHaveLength(1);
    const sent = JSON.parse(sends[0].body);
    expect(sent.to).toEqual(["owner@example.com"]);
    expect(sent.subject).toContain("mysite.com");
    expect(sent.subject).toContain("Payment declined");

    // Within the 30-minute cooldown there is no second email…
    await call("/v1/logs", {
      token,
      env: { ...mockEnv, RESEND_API_KEY: "re_test_key" },
      body: logBody(site.project_id, { action: "Another failure", status: "ERROR" })
    });
    expect(sends).toHaveLength(1);

    // …but after it passes, the next failure emails again.
    sites[0].last_alert_at = "2026-01-01 00:00:00";
    await call("/v1/logs", {
      token,
      env: { ...mockEnv, RESEND_API_KEY: "re_test_key" },
      body: logBody(site.project_id, { action: "Third failure", status: "FAILED" })
    });
    expect(sends).toHaveLength(2);
  });

  it("does not email for successful activity", async () => {
    const token = await register();
    const site = await verifiedSite(token);
    await call(`/v1/sites/${site.id}/alerts`, { token, body: { email: "owner@example.com" } });

    const sends = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (String(url).includes("api.resend.com")) { sends.push(init); return new Response("{}", { status: 200 }); }
      return pageWithCode(site.verify_token);
    }));

    await call("/v1/logs", {
      token,
      env: { ...mockEnv, RESEND_API_KEY: "re_test_key" },
      body: logBody(site.project_id) // SUCCESS
    });
    expect(sends).toHaveLength(0);
  });

  it("skips alerting when no email provider key is configured", async () => {
    const token = await register();
    const site = await verifiedSite(token);
    await call(`/v1/sites/${site.id}/alerts`, { token, body: { email: "owner@example.com" } });

    const sends = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (String(url).includes("api.resend.com")) { sends.push(init); return new Response("{}", { status: 200 }); }
      return pageWithCode(site.verify_token);
    }));

    const res = await call("/v1/logs", {
      token,
      body: logBody(site.project_id, { status: "FAILED" }) // mockEnv has no RESEND_API_KEY
    });
    expect(res.status).toBe(200);
    expect(sends).toHaveLength(0);
  });
});

describe("Retention sweep", () => {
  it("deletes activity older than each plan allows", async () => {
    await worker.scheduled({}, mockEnv, {});
    const logDeletes = deletes.filter((d) => d.includes("DELETE FROM system_logs"));
    expect(logDeletes).toHaveLength(2);
    expect(deletes.some((d) => d.includes("DELETE FROM usage"))).toBe(true);
  });
});

describe("Helpers", () => {
  it("normalizes website addresses", () => {
    expect(normalizeDomain("https://www.Example.com/path?x=1")).toBe("example.com");
    expect(normalizeDomain("shop.example.co.uk")).toBe("shop.example.co.uk");
    expect(normalizeDomain("localhost")).toBeNull();
    expect(normalizeDomain("10.0.0.1")).toBeNull();
    expect(normalizeDomain("example.com:8080")).toBeNull();
    expect(normalizeDomain(42)).toBeNull();
  });

  it("reads the verification meta tag with attributes in either order", () => {
    expect(extractMetaToken('<meta name="cloudlogger-verify" content="abc">')).toBe("abc");
    expect(extractMetaToken("<meta content='xyz' name='cloudlogger-verify'/>")).toBe("xyz");
    expect(extractMetaToken('<meta name="description" content="abc">')).toBeNull();
  });
});
