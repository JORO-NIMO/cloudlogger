# CloudLogger — MCP Endpoint

CloudLogger speaks the **Model Context Protocol (MCP)** over HTTP, so an AI
assistant that can call tools can manage your websites and read their activity
using your account key. The endpoint is JSON-RPC 2.0 over `POST`:

```
POST https://serverless-logger-api.joronimoamanya.workers.dev/mcp
Authorization: Bearer cl_live_YOUR_ACCOUNT_KEY
Content-Type: application/json
```

Every tool call runs **as the account whose key was sent**, so an assistant can
only ever touch that account's own websites. Site keys (`cl_site_…`) are
refused (`403`) — MCP needs the account key.

Protocol version: `2025-03-26`.

## Quick test

```bash
# Initialize
curl -s -X POST "https://serverless-logger-api.joronimoamanya.workers.dev/mcp" \
  -H "Authorization: Bearer cl_live_YOUR_KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'

# List tools
curl -s -X POST "https://serverless-logger-api.joronimoamanya.workers.dev/mcp" \
  -H "Authorization: Bearer cl_live_YOUR_KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

## Methods

| Method | Behaviour |
| --- | --- |
| `initialize` | Returns protocol version, capabilities and server info |
| `ping` | Returns `{}` |
| `tools/list` | Returns the five tools below |
| `tools/call` | Runs a tool; result arrives as a `text` content block |
| `notifications/*` (no `id`) | Accepted with `202`, body ignored |

Unknown methods → JSON-RPC error `-32601`; unknown tools → `-32602`; malformed
JSON → `-32700`; non-JSON-RPC body → `-32600`.

## Tools

### `list_sites`
List the websites on the account, including whether each one is verified.
No arguments.

### `add_site`
Add a website. It starts unverified; the response contains the `verify_token`
the owner must publish.

```json
{ "name": "My Shop", "domain": "mysite.com" }
```

### `verify_site`
Check that the verification code is now on the website. Use after the owner
has added the meta tag or text file.

```json
{ "site_id": "the id from list_sites" }
```

### `get_activity`
Read the latest recorded activity for one of the account's websites, newest
first.

```json
{ "project_id": "the project_id from list_sites", "limit": 20 }
```

`limit` is optional (1–200, default 20).

### `record_activity`
Record one activity for a **verified** website. People and IP addresses are
stored only as hashes.

```json
{
  "project_id": "my-shop-1a2b3c4d",
  "area": "Checkout",
  "what_happened": "Order placed",
  "result": "SUCCESS",
  "actor": "optional person, hashed before saving"
}
```

Tool results mirror the REST API exactly: a successful call returns the API's
JSON as text; a failed call returns the API's error message with `isError: true`.

## Example session

```jsonc
// 1. initialize
{ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} }

// 2. add a website
{ "jsonrpc": "2.0", "id": 2, "method": "tools/call",
  "params": { "name": "add_site", "arguments": { "name": "My Shop", "domain": "mysite.com" } } }
// → contains verify_token + ingest_key

// 3. after the owner publishes the token:
{ "jsonrpc": "2.0", "id": 3, "method": "tools/call",
  "params": { "name": "verify_site", "arguments": { "site_id": "…" } } }
// → { "verified": true }

// 4. record and read activity
{ "jsonrpc": "2.0", "id": 4, "method": "tools/call",
  "params": { "name": "record_activity", "arguments": {
      "project_id": "my-shop-…", "area": "Checkout", "what_happened": "Order placed", "result": "SUCCESS" } } }

{ "jsonrpc": "2.0", "id": 5, "method": "tools/call",
  "params": { "name": "get_activity", "arguments": { "project_id": "my-shop-…" } } }
```

## Implementation note

The MCP layer is a thin JSON-RPC shell (`src/mcp.js`) over the same REST API:
each `tools/call` is re-dispatched through the Worker's own router with the
caller's key, so every permission rule of the REST API applies unchanged. The
full behaviour is covered by the test suite in `test/logger.test.js`.
