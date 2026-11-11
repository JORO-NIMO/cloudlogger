// ============================================================================
// CloudLogger Edge Core: serverless activity logging on Cloudflare
// (Workers + D1 SQLite + Pages). Personal data is hashed before it is saved,
// and every site must be proven to belong to its owner before it can log.
// ============================================================================

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
        "SELECT id, user_id, project_id, domain, verified_at, ingest_key FROM sites WHERE ingest_key = ?"
      ).bind(token).all();
      const site = query?.results?.find((s) => s.ingest_key === token);
      if (site) {
        return {
          type: "site",
          user_id: site.user_id,
          site_id: site.id,
          project_id: site.project_id,
          domain: site.domain,
          verified: Boolean(site.verified_at)
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
    created_at: row.created_at
  };
}

const SITE_COLUMNS =
  "id, user_id, name, project_id, domain, verify_token, ingest_key, verified_at, created_at";

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

export default {
  async fetch(request, env) {
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
          { method: "POST", path: "/v1/logs", description: "Record an activity from a verified site" },
          { method: "GET", path: "/v1/logs?project_id=:id", description: "Read activity for one of your sites" }
        ]
      });
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
          "INSERT INTO users (id, email, password_hash, api_key) VALUES (?, ?, ?, ?)"
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

    // Payment provider notifications (server to server).
    if (request.method === "POST" && pathname === "/v1/webhooks/whop") {
      try {
        const payload = await request.json();
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

    if (request.method === "GET" && pathname === "/v1/billing/status") {
      return respond({
        success: true,
        plan: auth.plan,
        is_active_paid: auth.is_active_paid === 1
      });
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
        if (auth.type === "site") {
          if (body.project_id !== auth.project_id) {
            return respond({ error: "This key belongs to a different site." }, 403);
          }
          if (!auth.verified) return respond({ error: "This site has not been verified yet." }, 403);
          if (!originAllowed(request, auth.domain)) {
            return respond({ error: "This key can only be used from its own website." }, 403);
          }
        } else if (auth.type === "user") {
          const site = await findOwnedSite(body.project_id);
          if (!site) return respond({ error: "That site does not belong to your account." }, 403);
          if (!site.verified_at) return respond({ error: "This site has not been verified yet." }, 403);
        }

        let payloadObj = {};
        if (body.payload) {
          payloadObj = { ...body.payload };
          delete payloadObj.actor;
          delete payloadObj.ip_address;
        }
        const payloadData = JSON.stringify(payloadObj);
        if (payloadData.length > 8192) return respond({ error: "Details are too large." }, 413);

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
};
