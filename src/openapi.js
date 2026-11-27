// OpenAPI 3.0 description of the CloudLogger API, served at GET /v1/openapi.json.
export function openApiSpec(origin) {
  const bearer = [{ bearerAuth: [] }];
  const json = (schema) => ({ content: { "application/json": { schema } } });
  const err = { description: "Error", ...json({ $ref: "#/components/schemas/Error" }) };
  return {
    openapi: "3.0.3",
    info: {
      title: "CloudLogger API",
      version: "2.0.0",
      description:
        "Record and read activity for websites you own. A website must be verified before it can record activity."
    },
    servers: [{ url: origin }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "Account key (cl_live_...) for everything, or a site key (cl_site_...) which can only record activity for its own verified site."
        }
      },
      schemas: {
        Error: { type: "object", properties: { error: { type: "string" } } },
        Site: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            project_id: { type: "string" },
            domain: { type: "string" },
            verified: { type: "boolean" },
            verify_token: { type: "string" },
            ingest_key: { type: "string" },
            alert_email: { type: "string", nullable: true, description: "Where failure alerts are sent (null = off)" },
            created_at: { type: "string" }
          }
        },
        Credentials: {
          type: "object",
          required: ["email", "password"],
          properties: { email: { type: "string" }, password: { type: "string", minLength: 8 } }
        },
        LogEntry: {
          type: "object",
          required: ["project_id", "module_name", "action", "status"],
          properties: {
            project_id: { type: "string", maxLength: 120 },
            module_name: { type: "string", maxLength: 120, description: "Area of the website, e.g. Checkout" },
            action: { type: "string", maxLength: 120, description: "What happened" },
            status: { type: "string", maxLength: 120, description: "Result, e.g. SUCCESS or FAILED" },
            event_type: { type: "string" },
            actor: { type: "string", description: "Person involved. Stored only as a one-way hash." },
            metadata: {
              type: "object",
              properties: { ip_address: { type: "string", description: "Stored only as a one-way hash." } }
            },
            payload: { type: "object", description: "Extra details (up to 8 KB)." }
          }
        }
      }
    },
    paths: {
      "/v1/auth/register": {
        post: {
          summary: "Create an account",
          requestBody: { required: true, ...json({ $ref: "#/components/schemas/Credentials" }) },
          responses: { 200: { description: "Account created; returns the account key as token" }, 400: err, 409: err }
        }
      },
      "/v1/auth/login": {
        post: {
          summary: "Log in",
          requestBody: { required: true, ...json({ $ref: "#/components/schemas/Credentials" }) },
          responses: { 200: { description: "Returns the account key as token" }, 401: err }
        }
      },
      "/v1/sites": {
        get: {
          summary: "List your websites",
          security: bearer,
          responses: { 200: { description: "Sites" }, 401: err }
        },
        post: {
          summary: "Add a website",
          security: bearer,
          requestBody: {
            required: true,
            ...json({
              type: "object",
              required: ["name", "domain"],
              properties: { name: { type: "string" }, domain: { type: "string", example: "mysite.com" } }
            })
          },
          responses: { 200: { description: "Site created, not yet verified" }, 400: err, 401: err, 402: { description: "Plan site limit reached", ...json({ $ref: "#/components/schemas/Error" }) } }
        }
      },
      "/v1/sites/{id}/verify": {
        post: {
          summary: "Check that you own a website",
          description:
            'Looks for your verification code in <meta name="cloudlogger-verify" content="CODE"> on the home page, or in /.well-known/cloudlogger-verify.txt.',
          security: bearer,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "{ verified: true|false }" }, 404: err }
        }
      },
      "/v1/sites/{id}/alerts": {
        post: {
          summary: "Set or clear the failure-alert email for a website",
          description: 'Send { "email": "you@example.com" } to enable alerts, or { "email": "" } to turn them off. One email per website per 30 minutes at most.',
          security: bearer,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            ...json({ type: "object", properties: { email: { type: "string" } } })
          },
          responses: { 200: { description: "{ alert_email: string | null }" }, 400: err, 404: err }
        }
      },
      "/v1/billing/status": {
        get: {
          summary: "Plan, limits and current usage",
          description:
            "Free: 1 website, 1,000 activities/month, 30-day history. Pro ($5/month via Whop): 10 websites, 50,000 activities/month, 1-year history.",
          security: bearer,
          responses: { 200: { description: "Plan details with limits and usage" }, 401: err }
        }
      },
      "/v1/logs": {
        post: {
          summary: "Record an activity",
          security: bearer,
          requestBody: { required: true, ...json({ $ref: "#/components/schemas/LogEntry" }) },
          responses: { 200: { description: "Recorded" }, 400: err, 401: err, 403: err, 402: { description: "Monthly plan quota exceeded", ...json({ $ref: "#/components/schemas/Error" }) }, 413: err }
        },
        get: {
          summary: "Read the latest 200 activities for one of your websites",
          security: bearer,
          parameters: [{ name: "project_id", in: "query", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Activities, newest first" }, 403: err }
        }
      },
      "/mcp": {
        post: {
          summary: "Model Context Protocol endpoint (JSON-RPC 2.0 over HTTP) for AI assistants",
          security: bearer,
          responses: { 200: { description: "JSON-RPC response" }, 202: { description: "Notification accepted" } }
        }
      }
    }
  };
}

