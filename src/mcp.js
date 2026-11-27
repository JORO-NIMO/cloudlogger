// Model Context Protocol (MCP) server for CloudLogger.
// Speaks JSON-RPC 2.0 over HTTP POST at /mcp. Every tool runs as the account
// whose key was sent, so it can only touch that account's own websites.

const PROTOCOL_VERSION = "2025-03-26";

export const TOOLS = [
  {
    name: "list_sites",
    description: "List the websites on the account, including whether each one is verified.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "add_site",
    description: "Add a website. It starts unverified and returns the code needed to prove ownership.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "A friendly name" },
        domain: { type: "string", description: "Website address, e.g. mysite.com" }
      },
      required: ["name", "domain"]
    }
  },
  {
    name: "verify_site",
    description:
      "Check that the verification code is on the website. Use after the owner has added the meta tag or text file.",
    inputSchema: {
      type: "object",
      properties: { site_id: { type: "string", description: "The id from list_sites" } },
      required: ["site_id"]
    }
  },
  {
    name: "get_activity",
    description: "Read the latest recorded activity for one of the account's websites, newest first.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "The project_id from list_sites" },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "How many to return (default 20)" }
      },
      required: ["project_id"]
    }
  },
  {
    name: "record_activity",
    description: "Record one activity for a verified website. People and IP addresses are stored only as hashes.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        area: { type: "string", description: "Part of the website, e.g. Checkout" },
        what_happened: { type: "string", description: "e.g. Order placed" },
        result: { type: "string", description: "e.g. SUCCESS or FAILED" },
        actor: { type: "string", description: "Optional person involved (hashed before saving)" }
      },
      required: ["project_id", "area", "what_happened", "result"]
    }
  }
];

const rpcResult = (id, result) => ({ status: 200, body: { jsonrpc: "2.0", id, result } });
const rpcError = (id, code, message) => ({ status: 200, body: { jsonrpc: "2.0", id, error: { code, message } } });

const textResult = (value, isError = false) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  isError
});

async function runTool(name, args, callApi) {
  const a = args && typeof args === "object" ? args : {};
  const done = ({ status, data }) =>
    status >= 400 ? textResult((data && data.error) || `Request failed (${status})`, true) : textResult(data);

  switch (name) {
    case "list_sites":
      return done(await callApi("/v1/sites"));
    case "add_site":
      return done(await callApi("/v1/sites", "POST", { name: a.name, domain: a.domain }));
    case "verify_site":
      if (!a.site_id) return textResult("site_id is required", true);
      return done(await callApi(`/v1/sites/${encodeURIComponent(a.site_id)}/verify`, "POST"));
    case "get_activity": {
      if (!a.project_id) return textResult("project_id is required", true);
      const res = await callApi(`/v1/logs?project_id=${encodeURIComponent(a.project_id)}`);
      if (res.status >= 400 || !Array.isArray(res.data)) return done(res);
      const limit = Math.min(Math.max(parseInt(a.limit, 10) || 20, 1), 200);
      return textResult(res.data.slice(0, limit));
    }
    case "record_activity":
      return done(
        await callApi("/v1/logs", "POST", {
          project_id: a.project_id,
          module_name: a.area,
          action: a.what_happened,
          status: a.result,
          ...(a.actor ? { actor: a.actor } : {})
        })
      );
    default:
      return null;
  }
}

/** Returns { status, body } where body is null for notifications. */
export async function handleMcp(request, callApi) {
  let msg;
  try {
    msg = await request.json();
  } catch {
    return rpcError(null, -32700, "Parse error");
  }
  if (!msg || Array.isArray(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(msg && msg.id !== undefined ? msg.id : null, -32600, "Invalid request");
  }
  const { id, method, params } = msg;
  if (id === undefined) return { status: 202, body: null }; // notification, e.g. notifications/initialized

  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "cloudlogger", version: "2.0.0" },
        instructions:
          "Manage CloudLogger websites and read their activity. A website must be verified before it can record activity."
      });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS });
    case "tools/call": {
      const result = await runTool(params && params.name, params && params.arguments, callApi);
      if (result === null) return rpcError(id, -32602, `Unknown tool: ${params && params.name}`);
      return rpcResult(id, result);
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

