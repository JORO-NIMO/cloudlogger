// ============================================================================
// CloudLogger Edge Core: serverless activity logging on Cloudflare
// (Workers + D1 SQLite + Pages). Personal data is hashed before it is saved,
// and every site must be proven to belong to its owner before it can log.
// ============================================================================

import { openApiSpec } from "./openapi.js";
import { handleMcp } from "./mcp.js";
import { planLimits, isFailure, currentMonth } from "./plans.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

/**
 * Native Web Crypto HMAC-SHA256 signature generator.
 * Converts sensitive values (people, IP addresses) into irreversible hashes.
 */
export async function secureHMAC(value, secretKey) {
  if (!value || !secretKey) return null;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secretKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(String(value)));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Turns "https://www.Example.com/shop" into "example.com".
 * Returns null for anything that is not a plain public website name
 * (IP addresses, localhost, ports, credentials, odd characters).
 */
export function normalizeDomain(input) {
  if (typeof input !== "string") return null;
  let value = input.trim().toLowerCase();
  if (!value || value.length > 253) return null;
  value = value.replace(/^https?:\/\//, "");
  value = value.split(/[/?#]/)[0];
  if (value.includes("@") || value.includes(":")) return null;
  value = value.replace(/^www\./, "").replace(/\.$/, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return null;
  const label = "[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?";
  if (!new RegExp(`^(${label}\\.)+[a-z]{2,63}$`).test(value)) return null;
  return value;
}

/** Reads the ownership code from a page's <meta name="cloudlogger-verify" content="..."> tag. */
export function extractMetaToken(html) {
  const tags = String(html).match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    if (/name\s*=\s*["']cloudlogger-verify["']/i.test(tag)) {
      const match = tag.match(/content\s*=\s*["']([^"']*)["']/i);
      if (match) return match[1].trim();
    }
  }
  return null;
}

/** Constant-time string comparison, so timing never reveals how many bytes matched. */
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verifies a payment-provider notification the way Whop documents it:
 * HMAC-SHA256 over "{webhook-id}.{webhook-timestamp}.{raw body}" with the
 * webhook secret, sent base64-encoded as "v1,<signature>". Requests older
 * than 5 minutes are rejected to stop replays.
 */
export async function verifyWhopSignature(request, rawBody, secret) {
  if (!secret) return false;
  const id = request.headers.get("webhook-id");
  const timestamp = request.headers.get("webhook-timestamp");
  const signature = request.headers.get("webhook-signature");
  if (!id || !timestamp || !signature) return false;
  const tsSeconds = Number(timestamp);
  if (!Number.isFinite(tsSeconds) || Math.abs(Date.now() / 1000 - tsSeconds) > 300) return false;
  const match = signature.match(/^v1,([A-Za-z0-9+/=]+)$/);
  if (!match) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${id}.${timestamp}.${rawBody}`));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return timingSafeEqual(expected, match[1]);
}

/**
 * Proves a person controls a website. The owner puts their secret code either in
 * /.well-known/cloudlogger-verify.txt or in a meta tag on the home page; we fetch
 * the site over HTTPS and look for it. Only the site's own host is accepted.
 */
export async function checkSiteOwnership(domain, token, doFetch = fetch) {
  const urls = [
    `https://${domain}/.well-known/cloudlogger-verify.txt`,
    `https://${domain}/`,
    `https://www.${domain}/`
  ];
  for (const url of urls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const res = await doFetch(url, {
        signal: controller.signal,
        redirect: "follow",
        headers: { "User-Agent": "CloudLoggerVerifier/1.0" }
      });
      if (!res.ok) continue;
      const finalHost = new URL(res.url || url).hostname.toLowerCase().replace(/^www\./, "");
      if (finalHost !== domain) continue;
      const body = (await res.text()).slice(0, 200000);
      if (url.endsWith(".txt")) {
        if (body.split(/\s+/).includes(token)) return true;
      } else if (extractMetaToken(body) === token) {
        return true;
      }
    } catch {
      // Unreachable or slow site: try the next location.
    } finally {
      clearTimeout(timer);
    }
  }
  return false;
}

/**
 * Validates the Bearer token against:
 * 1. env.CLIENT_API_TOKEN (administrator key)
 * 2. Account keys in D1 (cl_live_...)
 * 3. Per-site keys in D1 (cl_site_...), which can only send activity for one site
 */
export async function authenticateToken(authHeader, env) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.substring(7).trim();
  if (!token) return null;

  if (env.CLIENT_API_TOKEN && token === env.CLIENT_API_TOKEN) {
    return { type: "system", user_id: "system", token, is_active_paid: 1, plan: "system_unlimited" };
  }

  if (env.DB && (token.startsWith("cl_live_") || token.startsWith("cl_test_"))) {
    try {
      const query = await env.DB.prepare(
        "SELECT id, email, api_key, plan, is_active_paid FROM users WHERE api_key = ?"
      ).bind(token).all();
      const user = query?.results?.find((u) => u.api_key === token);
      if (user) {
        return {
          type: "user",
          user_id: user.id,
          email: user.email,
          token: user.api_key,
          plan: user.plan,
          is_active_paid: user.is_active_paid
        };
      }
    } catch {
      // Database not ready: treat as unauthenticated.
    }
  }

  if (env.DB && token.startsWith("cl_site_")) {
    try {
      const query = await env.DB.prepare(
        "SELECT id, user_id, project_id, domain, verified_at, ingest_key, alert_email, last_alert_at FROM sites WHERE ingest_key = ?"
      ).bind(token).all();
      const site = query?.results?.find((s) => s.ingest_key === token);
      if (site) {
        return {
          type: "site",
          user_id: site.user_id,
          site_id: site.id,
          project_id: site.project_id,
          domain: site.domain,
          verified: Boolean(site.verified_at),
          alert_email: site.alert_email,
          last_alert_at: site.last_alert_at
        };
      }
    } catch {
      // Database not ready: treat as unauthenticated.
    }
  }

  return null;
}

function serializeSite(row) {
  return {
    id: row.id,
    name: row.name,
    project_id: row.project_id,
    domain: row.domain,
    verified: Boolean(row.verified_at),
    verify_token: row.verify_token,
    ingest_key: row.ingest_key,
    alert_email: row.alert_email ?? null,
    created_at: row.created_at
  };
}

const SITE_COLUMNS =
  "id, user_id, name, project_id, domain, verify_token, ingest_key, verified_at, alert_email, last_alert_at, created_at";

/** Browsers send an Origin header; a site key may only be used from its own website. */
function originAllowed(request, domain) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

/** 1000 → "1,000" — for readable quota messages. */
function fmtInt(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Minimum time between failure-alert emails for the same website. */
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Sends one failure-alert email through the Resend API.
 * Returns true when the provider accepted it. Errors are caught by the caller.
 */
async function sendAlertEmail(env, site, entry) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: env.ALERT_FROM_EMAIL || "CloudLogger <onboarding@resend.dev>",
      to: [site.alert_email],
      subject: `CloudLogger alert: "${entry.action}" failed on ${site.domain}`,
      text: [
        `Something failed on ${site.domain}.`,
        "",
        `When: ${new Date().toISOString()}`,
        `Area: ${entry.module_name}`,
        `What happened: ${entry.action}`,
        `Result: ${entry.status}`,
        "",
        "Open CloudLogger to see everything:",
        "https://cloudlogger.pages.dev"
      ].join("\n")
    })
  });
  return res.ok;
}

async function handleRequest(request, env, ctx = null) {
  const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type"
    };
    const respond = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...corsHeaders } });

    // CORS preflight is answered before any authentication.
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";

    // ---- Public routes ----------------------------------------------------
    if (request.method === "GET" && pathname === "/v1/docs") {
      return respond({
        name: "CloudLogger",
        version: "2.0.0",
        endpoints: [
          { method: "POST", path: "/v1/auth/register", description: "Create an account" },
          { method: "POST", path: "/v1/auth/login", description: "Log in" },
          { method: "GET", path: "/v1/sites", description: "List your sites" },
          { method: "POST", path: "/v1/sites", description: "Add a site" },
          { method: "POST", path: "/v1/sites/:id/verify", description: "Prove you own a site" },
          { method: "POST", path: "/v1/sites/:id/alerts", description: "Set or clear the failure-alert email for a site" },
          { method: "POST", path: "/v1/logs", description: "Record an activity from a verified site" },
          { method: "GET", path: "/v1/logs?project_id=:id", description: "Read activity for one of your sites" },
          { method: "GET", path: "/v1/billing/status", description: "Plan status" },
          { method: "GET", path: "/v1/openapi.json", description: "Machine-readable API description (OpenAPI 3.0)" },
          { method: "POST", path: "/mcp", description: "JSON-RPC 2.0 endpoint for AI assistants (MCP)" }
        ]
      });
    }

    if (request.method === "GET" && pathname === "/v1/openapi.json") {
      return respond(openApiSpec(url.origin));
    }

    if (request.method === "POST" && pathname === "/v1/auth/register") {
      try {
        const body = await request.json();
        const email = String(body.email || "").trim().toLowerCase();
        const password = String(body.password || "");
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8) {
          return respond({ error: "Please enter a valid email and a password of at least 8 characters." }, 400);
        }
        const userId = crypto.randomUUID();
        const apiKey = `cl_live_${crypto.randomUUID().replace(/-/g, "")}`;
        const passwordHash = await secureHMAC(password, env.HASHING_SECRET);
        await env.DB.prepare(
          "INSERT INTO users (id, email, password_hash, api_key, plan, is_active_paid) VALUES (?, ?, ?, ?, 'free', 0)"
        ).bind(userId, email, passwordHash, apiKey).run();
        return respond({ success: true, user: { id: userId, email }, token: apiKey });
      } catch (err) {
        const duplicate = String(err?.message || "").includes("UNIQUE");
        return respond(
          { error: duplicate ? "An account with this email already exists." : "We could not create your account." },
          duplicate ? 409 : 400
        );
      }
    }

    if (request.method === "POST" && pathname === "/v1/auth/login") {
      try {
        const body = await request.json();
        const email = String(body.email || "").trim().toLowerCase();
        const password = String(body.password || "");
        if (!email || !password) {
          return respond({ error: "Please enter your email and password." }, 400);
        }
        const passwordHash = await secureHMAC(password, env.HASHING_SECRET);
        const query = await env.DB.prepare(
          "SELECT id, email, api_key FROM users WHERE email = ? AND password_hash = ?"
        ).bind(email, passwordHash).all();
        const user = query?.results?.[0];
        if (!user) return respond({ error: "That email and password do not match." }, 401);
        return respond({ success: true, user: { id: user.id, email: user.email }, token: user.api_key });
      } catch {
        return respond({ error: "We could not log you in." }, 400);
      }
    }

    // Payment provider notifications (server to server). The signature is
    // verified against WHOP_WEBHOOK_SECRET before anything is trusted.
    if (request.method === "POST" && pathname === "/v1/webhooks/whop") {
      let payload;
      try {
        const rawBody = await request.text();
        if (!(await verifyWhopSignature(request, rawBody, env.WHOP_WEBHOOK_SECRET))) {
          return respond({ error: "Invalid webhook signature." }, 401);
        }
        payload = JSON.parse(rawBody);
        const action = payload.action || payload.event;
        const data = payload.data || {};
        const email = String(data.user?.email || data.email || "").toLowerCase();
        const membershipId = data.membership_id || data.id || "";
        const providerUserId = data.user_id || data.user?.id || "";
        if (email && (action === "payment.succeeded" || action === "membership.went_valid")) {
          await env.DB.prepare(
            "UPDATE users SET is_active_paid = 1, plan = 'pro_monthly_5', whop_membership_id = ?, whop_user_id = ? WHERE email = ?"
          ).bind(membershipId, providerUserId, email).run();
        } else if (email && (action === "membership.went_invalid" || action === "payment.failed")) {
          await env.DB.prepare(
            "UPDATE users SET is_active_paid = 0, plan = 'free' WHERE email = ?"
          ).bind(email).run();
        }
        return respond({ success: true, processed_event: action });
      } catch {
        return respond({ error: "Notification could not be processed." }, 400);
      }
    }

    // ---- Everything below needs a valid key -------------------------------
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return respond({ error: "Unauthorized access path" }, 401);
    }
    const auth = await authenticateToken(authHeader, env);
    if (!auth) return respond({ error: "Invalid API credentials" }, 401);

    const isLogsPath = pathname === "/v1/logs" || pathname === "/";

    // A site key can only record activity, nothing else.
    if (auth.type === "site" && !(request.method === "POST" && isLogsPath)) {
      return respond({ error: "This key can only be used to send activity from its own site." }, 403);
    }

    // JSON-RPC endpoint for AI assistants. Tool calls run as the account whose
    // key was sent, by re-entering this same Worker with that key.
    if (request.method === "POST" && pathname === "/mcp") {
      const callApi = async (path, method = "GET", body) => {
        const init = {
          method,
          headers: { "Content-Type": "application/json", Authorization: authHeader }
        };
        if (body !== undefined) init.body = JSON.stringify(body);
        const res = await handleRequest(new Request(new URL(path, url).toString(), init), env);
        let data = null;
        try {
          data = await res.json();
        } catch {
          // Empty or non-JSON body.
        }
        return { status: res.status, data };
      };
      const result = await handleMcp(request, callApi);
      if (result.body === null) return new Response(null, { status: result.status });
      return respond(result.body, result.status);
    }

    if (request.method === "GET" && pathname === "/v1/billing/status") {
      if (auth.type === "system") {
        return respond({ success: true, plan: "system_unlimited", is_active_paid: true, limits: null, usage: null });
      }
      const limits = planLimits(auth.plan);
      const month = currentMonth();
      const [logsQuery, sitesQuery] = await Promise.all([
        env.DB.prepare("SELECT COALESCE(log_count, 0) AS n FROM usage WHERE user_id = ? AND month = ?")
          .bind(auth.user_id, month).all(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM sites WHERE user_id = ?").bind(auth.user_id).all()
      ]);
      const body = {
        success: true,
        plan: auth.plan,
        is_active_paid: auth.is_active_paid === 1,
        limits: { sites: limits.sites, logs_per_month: limits.logsPerMonth, retention_days: limits.retentionDays },
        usage: {
          sites: sitesQuery?.results?.[0]?.n ?? 0,
          logs_this_month: logsQuery?.results?.[0]?.n ?? 0,
          month
        }
      };
      if (env.WHOP_CHECKOUT_URL) body.checkout_url = env.WHOP_CHECKOUT_URL;
      return respond(body);
    }

    if (request.method === "GET" && pathname === "/v1/sites") {
      const query =
        auth.type === "system"
          ? await env.DB.prepare(`SELECT ${SITE_COLUMNS} FROM sites ORDER BY created_at DESC LIMIT 50`).all()
          : await env.DB.prepare(
              `SELECT ${SITE_COLUMNS} FROM sites WHERE user_id = ? ORDER BY created_at DESC`
            ).bind(auth.user_id).all();
      return respond({ success: true, sites: (query?.results ?? []).map(serializeSite) });
    }

    if (request.method === "POST" && pathname === "/v1/sites") {
      try {
        const body = await request.json();
        const name = String(body.name || "").trim().slice(0, 80);
        const domain = normalizeDomain(body.domain);
        if (!name) return respond({ error: "Please give your site a name." }, 400);
        if (!domain) {
          return respond({ error: "Please enter your website address, for example mysite.com." }, 400);
        }
        // Plan limit: how many websites the account may have.
        if (auth.type !== "system") {
          const limits = planLimits(auth.plan);
          const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM sites WHERE user_id = ?")
            .bind(auth.user_id).all();
          if ((count?.results?.[0]?.n ?? 0) >= limits.sites) {
            return respond(
              {
                error: `Your ${limits.name} plan includes ${limits.sites} ${limits.sites === 1 ? "website" : "websites"}. Upgrade to add more.`,
                code: "site_limit_reached",
                ...(env.WHOP_CHECKOUT_URL ? { checkout_url: env.WHOP_CHECKOUT_URL } : {})
              },
              402
            );
          }
        }
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "site";
        const site = {
          id: crypto.randomUUID(),
          user_id: auth.user_id,
          name,
          project_id: `${slug.slice(0, 40)}-${crypto.randomUUID().slice(0, 8)}`,
          domain,
          verify_token: crypto.randomUUID().replace(/-/g, ""),
          ingest_key: `cl_site_${crypto.randomUUID().replace(/-/g, "")}`,
          verified_at: null
        };
        await env.DB.prepare(
          "INSERT INTO sites (id, user_id, name, project_id, domain, verify_token, ingest_key) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).bind(site.id, site.user_id, site.name, site.project_id, site.domain, site.verify_token, site.ingest_key).run();
        return respond({ success: true, site: serializeSite(site) });
      } catch {
        return respond({ error: "We could not add your site." }, 400);
      }
    }

    const verifyMatch = pathname.match(/^\/v1\/sites\/([^/]+)\/verify$/);
    if (request.method === "POST" && verifyMatch) {
      const query =
        auth.type === "system"
          ? await env.DB.prepare(`SELECT ${SITE_COLUMNS} FROM sites WHERE id = ?`).bind(verifyMatch[1]).all()
          : await env.DB.prepare(`SELECT ${SITE_COLUMNS} FROM sites WHERE id = ? AND user_id = ?`)
              .bind(verifyMatch[1], auth.user_id).all();
      const site = query?.results?.[0];
      if (!site) return respond({ error: "Site not found." }, 404);
      if (site.verified_at) return respond({ success: true, verified: true });
      const owned = await checkSiteOwnership(site.domain, site.verify_token);
      if (!owned) {
        return respond({
          success: true,
          verified: false,
          message: "We could not find your code on that website yet. Add it, wait a minute, then try again."
        });
      }
      await env.DB.prepare("UPDATE sites SET verified_at = CURRENT_TIMESTAMP WHERE id = ?").bind(site.id).run();
      return respond({ success: true, verified: true });
    }

    // Set or clear the failure-alert email for one of the caller's sites.
    const alertsMatch = pathname.match(/^\/v1\/sites\/([^/]+)\/alerts$/);
    if (request.method === "POST" && alertsMatch) {
      try {
        const body = await request.json();
        const email = String(body.email ?? "").trim().toLowerCase();
        if (email !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return respond({ error: "Please enter a valid email address, or leave it empty to turn alerts off." }, 400);
        }
        const query =
          auth.type === "system"
            ? await env.DB.prepare(`SELECT ${SITE_COLUMNS} FROM sites WHERE id = ?`).bind(alertsMatch[1]).all()
            : await env.DB.prepare(`SELECT ${SITE_COLUMNS} FROM sites WHERE id = ? AND user_id = ?`)
                .bind(alertsMatch[1], auth.user_id).all();
        const site = query?.results?.[0];
        if (!site) return respond({ error: "Site not found." }, 404);
        if (!site.verified_at) return respond({ error: "Verify this website before setting up alerts." }, 400);
        await env.DB.prepare("UPDATE sites SET alert_email = ? WHERE id = ?").bind(email || null, site.id).run();
        return respond({ success: true, alert_email: email || null });
      } catch {
        return respond({ error: "We could not save that." }, 400);
      }
    }

    // Looks up a site by its project id and checks it belongs to the signed-in account.
    const findOwnedSite = async (projectId) => {
      const query = await env.DB.prepare(`SELECT ${SITE_COLUMNS} FROM sites WHERE project_id = ? AND user_id = ?`)
        .bind(projectId, auth.user_id).all();
      return query?.results?.[0] ?? null;
    };

    if (request.method === "POST" && isLogsPath) {
      try {
        const body = await request.json();
        const text = (v) => typeof v === "string" && v.trim().length > 0 && v.length <= 120;
        if (!body || !text(body.project_id) || !text(body.module_name) || !text(body.action) || !text(body.status)) {
          return respond({ error: "Missing required core schema strings" }, 400);
        }
        if (
          body.payload !== undefined &&
          (typeof body.payload !== "object" || body.payload === null || Array.isArray(body.payload))
        ) {
          return respond({ error: "Invalid schema: payload must be a JSON object" }, 400);
        }

        // Ownership: logs are only accepted for a verified site that belongs to the caller.
        let siteRow = null;
        if (auth.type === "site") {
          if (body.project_id !== auth.project_id) {
            return respond({ error: "This key belongs to a different site." }, 403);
          }
          if (!auth.verified) return respond({ error: "This site has not been verified yet." }, 403);
          if (!originAllowed(request, auth.domain)) {
            return respond({ error: "This key can only be used from its own website." }, 403);
          }
          siteRow = auth;
        } else if (auth.type === "user") {
          const site = await findOwnedSite(body.project_id);
          if (!site) return respond({ error: "That site does not belong to your account." }, 403);
          if (!site.verified_at) return respond({ error: "This site has not been verified yet." }, 403);
          siteRow = site;
        }

        let payloadObj = {};
        if (body.payload) {
          payloadObj = { ...body.payload };
          delete payloadObj.actor;
          delete payloadObj.ip_address;
        }
        const payloadData = JSON.stringify(payloadObj);
        if (payloadData.length > 8192) return respond({ error: "Details are too large." }, 413);

        // Plan quota: each plan has a monthly activity allowance.
        if (auth.type !== "system") {
          const quota = await env.DB.prepare(
            `SELECT u.plan AS plan,
                    (SELECT COALESCE(log_count, 0) FROM usage WHERE user_id = u.id AND month = ?) AS used
               FROM users u WHERE u.id = ?`
          ).bind(currentMonth(), auth.user_id).all();
          const row = quota?.results?.[0];
          const limits = planLimits(row?.plan);
          if ((row?.used ?? 0) >= limits.logsPerMonth) {
            return respond(
              {
                error: `Your ${limits.name} plan includes ${fmtInt(limits.logsPerMonth)} activities per month. Upgrade to keep recording this month.`,
                code: "quota_exceeded",
                ...(env.WHOP_CHECKOUT_URL ? { checkout_url: env.WHOP_CHECKOUT_URL } : {})
              },
              402
            );
          }
        }

        const logId = crypto.randomUUID();
        const actorHash = await secureHMAC(body.actor, env.HASHING_SECRET);
        const ipHash = await secureHMAC(body.metadata?.ip_address, env.HASHING_SECRET);

        await env.DB.prepare(
          `INSERT INTO system_logs (id, project_id, module_name, event_type, action, actor_hash, status, payload, ip_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          logId,
          body.project_id,
          body.module_name,
          body.event_type || "INFO",
          body.action,
          actorHash,
          body.status,
          payloadData,
          ipHash
        ).run();

        // Count the activity against the account's monthly allowance.
        if (auth.type !== "system") {
          await env.DB.prepare(
            `INSERT INTO usage (user_id, month, log_count) VALUES (?, ?, 1)
             ON CONFLICT(user_id, month) DO UPDATE SET log_count = log_count + 1`
          ).bind(auth.user_id, currentMonth()).run();
        }

        // Failure alert: one email per site per 30 minutes, without slowing the response.
        if (isFailure(body.status) && siteRow && siteRow.alert_email) {
          const notify = (async () => {
            if (!env.RESEND_API_KEY) return;
            const last = siteRow.last_alert_at
              ? new Date(String(siteRow.last_alert_at).replace(" ", "T") + "Z")
              : null;
            if (last && Date.now() - last.getTime() < ALERT_COOLDOWN_MS) return;
            const sent = await sendAlertEmail(env, siteRow, body).catch(() => false);
            if (sent) {
              await env.DB.prepare("UPDATE sites SET last_alert_at = CURRENT_TIMESTAMP WHERE id = ?")
                .bind(siteRow.id).run();
            }
          })();
          if (ctx && ctx.waitUntil) ctx.waitUntil(notify);
          else await notify;
        }

        return respond({ success: true, log_id: logId });
      } catch {
        return respond({ error: "Invalid JSON format body structure" }, 400);
      }
    }

    if (request.method === "GET" && isLogsPath) {
      const projectId = url.searchParams.get("project_id");
      if (!projectId) return respond({ error: "Missing project_id url parameter" }, 400);
      if (auth.type === "user" && !(await findOwnedSite(projectId))) {
        return respond({ error: "That site does not belong to your account." }, 403);
      }
      const queryResult = await env.DB.prepare(
        "SELECT * FROM system_logs WHERE project_id = ? ORDER BY created_at DESC LIMIT 200"
      ).bind(projectId).all();
      return respond(queryResult?.results ?? []);
    }

    return respond({ error: "Endpoint route target not found" }, 404);
}

/**
 * Daily retention sweep (Cloudflare Cron Trigger). Deletes stored activity
 * older than each plan allows, plus usage counters older than two months.
 */
export async function runRetention(env) {
  const summary = [];
  for (const plan of ["free", "pro_monthly_5"]) {
    const limits = planLimits(plan);
    const res = await env.DB.prepare(
      `DELETE FROM system_logs WHERE created_at < datetime('now', ?)
       AND project_id IN (SELECT project_id FROM sites WHERE user_id IN (SELECT id FROM users WHERE plan = ?))`
    ).bind(`-${limits.retentionDays} days`, plan).run();
    summary.push({ plan, deleted: res?.meta?.changes ?? 0 });
  }
  const oldUsage = await env.DB.prepare(
    "DELETE FROM usage WHERE month < strftime('%Y-%m', 'now', '-2 months')"
  ).bind().run();
  summary.push({ usage_rows_deleted: oldUsage?.meta?.changes ?? 0 });
  return summary;
}

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
  async scheduled(controller, env) {
    const summary = await runRetention(env);
    console.log("CloudLogger retention sweep:", JSON.stringify(summary));
  }
};
