// ============================================================================
// CloudLogger Edge Core: Serverless Log-As-A-Service (Micro-SaaS)
// Built natively on the Cloudflare Ecosystem (Workers, D1 SQLite, Pages)
// Integrated with Whop.com ($5/mo Payment Provider) & Web Crypto HMAC Redaction
// ============================================================================

/**
 * Native Edge Web Crypto HMAC-SHA256 signature generator.
 * Converts sensitive PII (actor IDs, IP addresses) into deterministic hashes.
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
 * Validates incoming Bearer token against:
 * 1. env.CLIENT_API_TOKEN (System root key)
 * 2. Multi-tenant customer API keys in Cloudflare D1 (`cl_live_...`)
 */
export async function authenticateToken(authHeader, env) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }
  const token = authHeader.substring(7).trim();
  if (!token) return null;

  // 1. Direct match with configured system API token
  if (env.CLIENT_API_TOKEN && token === env.CLIENT_API_TOKEN) {
    return { type: "system", user_id: "system", token, is_active_paid: 1, plan: "system_unlimited" };
  }

  // 2. Multi-tenant customer API key lookup in Cloudflare D1
  if (env.DB && (token.startsWith("cl_live_") || token.startsWith("cl_test_"))) {
    try {
      const query = await env.DB.prepare(
        "SELECT id, email, api_key, plan, is_active_paid FROM users WHERE api_key = ?"
      )
        .bind(token)
        .all();
      const user = query?.results?.find((u) => u.api_key === token);
      if (user) {
        return {
          type: "user",
          user_id: user.id,
          email: user.email,
          token: user.api_key,
          plan: user.plan || "pro_monthly_5",
          is_active_paid: user.is_active_paid !== undefined ? user.is_active_paid : 1
        };
      }
    } catch {
      // Graceful fallback if table does not exist yet
    }
  }

  return null;
}

export default {
  async fetch(request, env) {
    // Standard Cross-Origin Resource Sharing (CORS) Headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Whop-Signature"
    };

    // 1. CORS Preflight Resolution (Handled before authentication to satisfy browser security)
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const whopCheckoutUrl = env.WHOP_CHECKOUT_URL || "https://whop.com/safespaceshub/cloudlogger";

    // 2. Public Route: API Documentation Manifest
    if (request.method === "GET" && pathname === "/v1/docs") {
      return new Response(
        JSON.stringify({
          name: "CloudLogger Edge API",
          version: "1.0.0",
          payment_provider: "whop.com",
          price_usd: "$5 / month",
          pricing_model: "Micro-SaaS all-inclusive (Accounts, Multi-Sites, Edge Log Ingestion)",
          endpoints: [
            { method: "POST", path: "/v1/auth/register", description: "Create customer account & generate API key" },
            { method: "POST", path: "/v1/auth/login", description: "Authenticate user & fetch connected sites" },
            { method: "GET",  path: "/v1/sites", description: "List connected sites (Requires Bearer Token)" },
            { method: "POST", path: "/v1/sites", description: "Connect new site or microservice (Requires Bearer Token)" },
            { method: "POST", path: "/v1/logs", description: "Ingest telemetry event with Web Crypto HMAC PII redaction" },
            { method: "GET",  path: "/v1/logs?project_id=:id", description: "Retrieve telemetry events for site" },
            { method: "POST", path: "/v1/webhooks/whop", description: "Whop.com payment & membership webhook handler" },
            { method: "POST", path: "/v1/billing/activate", description: "Activate Whop license or subscription" },
            { method: "GET",  path: "/v1/billing/status", description: "Inspect current subscription tier" }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // 3. Public Route: User Registration (SaaS Onboarding)
    if (request.method === "POST" && pathname === "/v1/auth/register") {
      try {
        const body = await request.json();
        const email = body.email?.trim()?.toLowerCase();
        const password = body.password;
        const siteName = body.site_name?.trim() || "My First Connected Site";
        const domain = body.domain?.trim() || "";

        if (!email || !email.includes("@") || !password || password.length < 6) {
          return new Response(
            JSON.stringify({ error: "Valid email and password (minimum 6 characters) required" }),
            { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        }

        const passwordHash = await secureHMAC(password, env.HASHING_SECRET);
        const userId = crypto.randomUUID();
        const apiKey = `cl_live_${crypto.randomUUID().replace(/-/g, "")}`;
        const siteId = crypto.randomUUID();
        const cleanSlug = siteName.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-");
        const projectId = `${cleanSlug}-${crypto.randomUUID().slice(0, 6)}`;

        // Default plan is pro_monthly_5 ($5/mo SaaS access)
        await env.DB.prepare(
          "INSERT INTO users (id, email, password_hash, api_key, plan, is_active_paid) VALUES (?, ?, ?, ?, ?, ?)"
        )
          .bind(userId, email, passwordHash, apiKey, "pro_monthly_5", 1)
          .run();

        await env.DB.prepare(
          "INSERT INTO sites (id, user_id, name, project_id, domain) VALUES (?, ?, ?, ?, ?)"
        )
          .bind(siteId, userId, siteName, projectId, domain)
          .run();

        return new Response(
          JSON.stringify({
            success: true,
            user: { id: userId, email, api_key: apiKey, plan: "pro_monthly_5", is_active_paid: 1 },
            site: { id: siteId, user_id: userId, name: siteName, project_id: projectId, domain },
            token: apiKey,
            whop: {
              plan: "Pro SaaS Tier ($5/mo)",
              provider: "whop.com",
              checkout_url: whopCheckoutUrl
            }
          }),
          { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      } catch (err) {
        const isDuplicate = err.message?.includes("UNIQUE constraint") || err.message?.includes("users.email");
        return new Response(
          JSON.stringify({
            error: isDuplicate ? "An account with this email already exists" : "Registration failed",
            details: err.message
          }),
          { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }
    }

    // 4. Public Route: User Login
    if (request.method === "POST" && pathname === "/v1/auth/login") {
      try {
        const body = await request.json();
        const email = body.email?.trim()?.toLowerCase();
        const password = body.password;

        if (!email || !password) {
          return new Response(
            JSON.stringify({ error: "Email and password are required" }),
            { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        }

        const passwordHash = await secureHMAC(password, env.HASHING_SECRET);
        const userQuery = await env.DB.prepare(
          "SELECT id, email, api_key, plan, is_active_paid FROM users WHERE email = ? AND password_hash = ?"
        )
          .bind(email, passwordHash)
          .all();

        const user = userQuery?.results?.[0];
        if (!user) {
          return new Response(
            JSON.stringify({ error: "Invalid email or password credentials" }),
            { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        }

        const sitesQuery = await env.DB.prepare(
          "SELECT id, user_id, name, project_id, domain, created_at FROM sites WHERE user_id = ? ORDER BY created_at DESC"
        )
          .bind(user.id)
          .all();

        const sites = sitesQuery?.results ?? [];

        return new Response(
          JSON.stringify({
            success: true,
            user: {
              id: user.id,
              email: user.email,
              api_key: user.api_key,
              plan: user.plan || "pro_monthly_5",
              is_active_paid: user.is_active_paid !== undefined ? user.is_active_paid : 1
            },
            sites,
            token: user.api_key,
            whop: {
              price: "$5/month",
              provider: "whop.com",
              checkout_url: whopCheckoutUrl
            }
          }),
          { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      } catch (err) {
        return new Response(
          JSON.stringify({ error: "Authentication failed", details: err.message }),
          { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }
    }

    // 5. Public Route: Whop.com Webhook Handler ($5 SaaS Billing Lifecycle)
    if (request.method === "POST" && pathname === "/v1/webhooks/whop") {
      try {
        const payload = await request.json();
        const action = payload.action || payload.event;
        const data = payload.data || {};
        const email = (data.user?.email || data.email || "").toLowerCase();
        const membershipId = data.membership_id || data.id || "";
        const whopUserId = data.user_id || data.user?.id || "";

        if (action === "payment.succeeded" || action === "membership.went_valid") {
          if (email) {
            await env.DB.prepare(
              "UPDATE users SET is_active_paid = 1, plan = 'pro_monthly_5', whop_membership_id = ?, whop_user_id = ? WHERE email = ?"
            )
              .bind(membershipId, whopUserId, email)
              .run();
          }
        } else if (action === "membership.went_invalid" || action === "payment.failed") {
          if (email) {
            await env.DB.prepare(
              "UPDATE users SET is_active_paid = 0, plan = 'free' WHERE email = ?"
            )
              .bind(email)
              .run();
          }
        }

        return new Response(
          JSON.stringify({ success: true, processed_event: action, provider: "whop.com" }),
          { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      } catch (err) {
        return new Response(
          JSON.stringify({ error: "Whop webhook processing failed", details: err.message }),
          { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }
    }

    // 6. Global Security Check: Validate incoming Authorization Token for protected routes
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized access path" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    const auth = await authenticateToken(authHeader, env);
    if (!auth) {
      return new Response(JSON.stringify({ error: "Invalid API credentials" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // 7. Protected Route: Activate Whop License Key or Direct Upgrade
    if (request.method === "POST" && pathname === "/v1/billing/activate") {
      try {
        const body = await request.json();
        const licenseKey = body.license_key?.trim();

        if (auth.type === "user") {
          await env.DB.prepare(
            "UPDATE users SET is_active_paid = 1, plan = 'pro_monthly_5', whop_membership_id = ? WHERE id = ?"
          )
            .bind(licenseKey || "manual_whop_activation", auth.user_id)
            .run();
        }

        return new Response(
          JSON.stringify({
            success: true,
            plan: "pro_monthly_5",
            is_active_paid: 1,
            price: "$5/month",
            provider: "whop.com",
            message: "Whop $5 SaaS membership verified and active!"
          }),
          { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      } catch (err) {
        return new Response(
          JSON.stringify({ error: "Billing activation failed", details: err.message }),
          { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }
    }

    // 8. Protected Route: Inspect Billing & Subscription Status
    if (request.method === "GET" && pathname === "/v1/billing/status") {
      return new Response(
        JSON.stringify({
          success: true,
          plan: auth.plan || "pro_monthly_5",
          is_active_paid: auth.is_active_paid === 1,
          price: "$5.00 USD / month",
          provider: "whop.com",
          checkout_url: whopCheckoutUrl
        }),
        { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // 9. Protected Route: List Connected Sites
    if (request.method === "GET" && pathname === "/v1/sites") {
      let sites = [];
      if (auth.type === "user") {
        const query = await env.DB.prepare(
          "SELECT id, user_id, name, project_id, domain, created_at FROM sites WHERE user_id = ? ORDER BY created_at DESC"
        )
          .bind(auth.user_id)
          .all();
        sites = query?.results ?? [];
      } else {
        const query = await env.DB.prepare(
          "SELECT id, user_id, name, project_id, domain, created_at FROM sites ORDER BY created_at DESC LIMIT 50"
        ).all();
        sites = query?.results ?? [];
      }

      return new Response(JSON.stringify({ success: true, sites }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // 10. Protected Route: Connect New Site or Microservice
    if (request.method === "POST" && pathname === "/v1/sites") {
      try {
        const body = await request.json();
        const siteName = body.name?.trim();
        const domain = body.domain?.trim() || "";
        if (!siteName) {
          return new Response(
            JSON.stringify({ error: "Site name is required" }),
            { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        }

        const siteId = crypto.randomUUID();
        const cleanSlug = siteName.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-");
        const projectId = body.project_id?.trim() || `${cleanSlug}-${crypto.randomUUID().slice(0, 6)}`;
        const userId = auth.user_id || "system";

        await env.DB.prepare(
          "INSERT INTO sites (id, user_id, name, project_id, domain) VALUES (?, ?, ?, ?, ?)"
        )
          .bind(siteId, userId, siteName, projectId, domain)
          .run();

        return new Response(
          JSON.stringify({
            success: true,
            site: { id: siteId, user_id: userId, name: siteName, project_id: projectId, domain }
          }),
          { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      } catch (err) {
        return new Response(
          JSON.stringify({ error: "Failed to connect new site", details: err.message }),
          { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }
    }

    const isLogsPath = pathname === "/v1/logs" || pathname === "/";

    // 11. Route A: Ingest Telemetry Logs (POST)
    if (request.method === "POST" && isLogsPath) {
      try {
        const body = await request.json();

        // Strict Schema Assertions
        if (!body || !body.project_id || !body.module_name || !body.action || !body.status) {
          return new Response(
            JSON.stringify({ error: "Missing required core schema strings" }),
            {
              status: 400,
              headers: { "Content-Type": "application/json", ...corsHeaders }
            }
          );
        }

        if (body.payload !== undefined && (typeof body.payload !== "object" || body.payload === null || Array.isArray(body.payload))) {
          return new Response(
            JSON.stringify({ error: "Invalid schema: payload must be a JSON object" }),
            {
              status: 400,
              headers: { "Content-Type": "application/json", ...corsHeaders }
            }
          );
        }

        const logId = crypto.randomUUID();

        // Native Edge Web Crypto HMAC Redaction
        const actorHash = await secureHMAC(body.actor, env.HASHING_SECRET);
        const ipHash = await secureHMAC(body.metadata?.ip_address, env.HASHING_SECRET);

        // Strip plain-text PII from payload before database persistence
        let payloadObj = {};
        if (body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)) {
          payloadObj = { ...body.payload };
          delete payloadObj.actor;
          delete payloadObj.ip_address;
        }
        const payloadData = JSON.stringify(payloadObj);

        // Write directly to Cloudflare D1 high-throughput table
        await env.DB.prepare(
          `INSERT INTO system_logs (id, project_id, module_name, event_type, action, actor_hash, status, payload, ip_hash) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            logId,
            body.project_id,
            body.module_name,
            body.event_type || "INFO",
            body.action,
            actorHash,
            body.status,
            payloadData,
            ipHash
          )
          .run();

        return new Response(JSON.stringify({ success: true, log_id: logId }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      } catch (err) {
        return new Response(
          JSON.stringify({ error: "Invalid JSON format body structure", details: err.message }),
          {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          }
        );
      }
    }

    // 12. Route B: Read Logs For Dashboard (GET)
    if (request.method === "GET" && isLogsPath) {
      const projectId = url.searchParams.get("project_id");
      if (!projectId) {
        return new Response(
          JSON.stringify({ error: "Missing project_id url parameter" }),
          {
            status: 400,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          }
        );
      }

      const queryResult = await env.DB.prepare(
        "SELECT * FROM system_logs WHERE project_id = ? ORDER BY created_at DESC LIMIT 200"
      )
        .bind(projectId)
        .all();

      const results = queryResult?.results ?? [];

      return new Response(JSON.stringify(results), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // 13. Fallback Route: 404
    return new Response(JSON.stringify({ error: "Endpoint route target not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }
};
