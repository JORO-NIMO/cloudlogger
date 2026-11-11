import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

// In-Memory Cloudflare D1 Emulation Engine
const memoryDb = {
  users: [],
  sites: [
    {
      id: "site_default_1",
      user_id: "system",
      name: "saas-platform-one",
      project_id: "saas-platform-one",
      domain: "saas.example.com",
      created_at: new Date().toISOString()
    }
  ],
  logs: [
    {
      id: "log_init_1",
      project_id: "saas-platform-one",
      module_name: "billing_stripe",
      event_type: "USER_ACTIVITY",
      action: "subscription_created",
      actor_hash: "a8f9c1e2b3d4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0",
      status: "SUCCESS",
      payload: JSON.stringify({ plan: "growth_monthly", amount: 4900, currency: "USD" }),
      ip_hash: "b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2",
      created_at: new Date(Date.now() - 3600000).toISOString().replace("T", " ").slice(0, 19)
    },
    {
      id: "log_init_2",
      project_id: "saas-platform-one",
      module_name: "auth_service",
      event_type: "SECURITY",
      action: "password_reset_requested",
      actor_hash: "c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4",
      status: "SUCCESS",
      payload: JSON.stringify({ reset_channel: "email_magic_link" }),
      ip_hash: "d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6",
      created_at: new Date(Date.now() - 1800000).toISOString().replace("T", " ").slice(0, 19)
    },
    {
      id: "log_init_3",
      project_id: "saas-platform-one",
      module_name: "payments_flutterwave",
      event_type: "ERROR",
      action: "card_charge_declined",
      actor_hash: "e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8",
      status: "ERROR",
      payload: JSON.stringify({ error_code: "insufficient_funds", attempt: 2 }),
      ip_hash: "f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0",
      created_at: new Date(Date.now() - 300000).toISOString().replace("T", " ").slice(0, 19)
    }
  ]
};

const localEnv = {
  CLIENT_API_TOKEN: "dev-token-secret-12345",
  HASHING_SECRET: "dev-hashing-salt-secure-98765",
  DB: {
    prepare: (sql) => ({
      bind: (...args) => ({
        run: async () => {
          if (sql.includes("INSERT INTO users")) {
            memoryDb.users.push({
              id: args[0],
              email: args[1],
              password_hash: args[2],
              api_key: args[3],
              created_at: new Date().toISOString()
            });
          } else if (sql.includes("INSERT INTO sites")) {
            memoryDb.sites.push({
              id: args[0],
              user_id: args[1],
              name: args[2],
              project_id: args[3],
              domain: args[4],
              created_at: new Date().toISOString()
            });
          } else if (sql.includes("INSERT INTO system_logs")) {
            memoryDb.logs.unshift({
              id: args[0],
              project_id: args[1],
              module_name: args[2],
              event_type: args[3],
              action: args[4],
              actor_hash: args[5],
              status: args[6],
              payload: args[7],
              ip_hash: args[8],
              created_at: new Date().toISOString().replace("T", " ").slice(0, 19)
            });
          }
          return { success: true };
        },
        all: async () => {
          if (sql.includes("FROM users WHERE api_key = ?")) {
            const found = memoryDb.users.find((u) => u.api_key === args[0]);
            return { results: found ? [found] : [] };
          }
          if (sql.includes("FROM users WHERE email = ? AND password_hash = ?")) {
            const found = memoryDb.users.find((u) => u.email === args[0] && u.password_hash === args[1]);
            return { results: found ? [found] : [] };
          }
          if (sql.includes("FROM sites WHERE user_id = ?")) {
            const found = memoryDb.sites.filter((s) => s.user_id === args[0]);
            return { results: found };
          }
          if (sql.includes("FROM sites")) {
            return { results: memoryDb.sites };
          }
          if (sql.includes("FROM system_logs WHERE project_id = ?")) {
            const found = memoryDb.logs.filter((l) => l.project_id === args[0]);
            return { results: found };
          }
          return { results: memoryDb.logs };
        }
      })
    })
  }
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1:8787'}`);

  // Serve Logo
  if (url.pathname === '/SafeSpacesLogo.png') {
    const imgPath = path.join(projectRoot, 'public', 'SafeSpacesLogo.png');
    if (fs.existsSync(imgPath)) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(fs.readFileSync(imgPath));
      return;
    }
  }

  // Serve Static Frontend
  if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/frame') {
    const filePath = path.join(projectRoot, 'public', 'index.html');
    try {
      const html = fs.readFileSync(filePath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    } catch (e) {
      res.writeHead(500);
      res.end('Error loading index.html: ' + e.message);
      return;
    }
  }

  // Delegate API routes to Worker Core
  try {
    const buffers = [];
    for await (const chunk of req) {
      buffers.push(chunk);
    }
    const body = Buffer.concat(buffers);

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) {
        v.forEach(val => headers.append(k, val));
      } else if (v) {
        headers.set(k, v);
      }
    }

    const workerRequest = new Request(url.toString(), {
      method: req.method,
      headers,
      body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : body
    });

    const workerResponse = await worker.fetch(workerRequest, localEnv);

    res.writeHead(workerResponse.status, Object.fromEntries(workerResponse.headers.entries()));
    const responseArrayBuffer = await workerResponse.arrayBuffer();
    res.end(Buffer.from(responseArrayBuffer));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Local server execution error', details: err.message }));
  }
});

const PORT = 8787;
server.listen(PORT, '127.0.0.1', () => {
  console.log(`CloudLogger Edge Simulator active at http://127.0.0.1:${PORT}`);
});

