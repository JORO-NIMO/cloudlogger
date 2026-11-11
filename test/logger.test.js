import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker, { secureHMAC, normalizeDomain, extractMetaToken } from "../src/index.js";

// ---------------------------------------------------------------------------
// In-memory stand-in for Cloudflare D1. It understands exactly the statements
// the worker issues, so a changed query in src/index.js fails these tests.
// ---------------------------------------------------------------------------
let users, sites, logs;

const mockEnv = {
  CLIENT_API_TOKEN: "test-admin-token",
  HASHING_SECRET: "test-salt-abcde",
  DB: {
    prepare: (sql) => ({
      bind: (...a) => ({
        run: async () => {
          if (sql.includes("INSERT INTO users")) {
            if (users.some((u) => u.email === a[1])) throw new Error("UNIQUE constraint failed: users.email");
            users.push({ id: a[0], email: a[1], password_hash: a[2], api_key: a[3], plan: "pro_monthly_5", is_active_paid: 1 });
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
          }
          return { success: true };
        },
        all: async () => {
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

const call = (path, { method = "POST", body, token, headers = {} } = {}) =>
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
    mockEnv
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
