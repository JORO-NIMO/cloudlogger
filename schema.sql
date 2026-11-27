-- CloudLogger database schema (Cloudflare D1 / SQLite)
-- Safe to run more than once: it only creates what is missing and never drops data.
-- Existing databases: also run the matching file in migrations/ once.

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    api_key TEXT UNIQUE NOT NULL,
    plan TEXT DEFAULT 'free',
    is_active_paid INTEGER DEFAULT 0,
    whop_membership_id TEXT,
    whop_user_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sites (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    project_id TEXT UNIQUE NOT NULL,
    domain TEXT NOT NULL,
    verify_token TEXT NOT NULL,      -- secret the owner places on their site to prove ownership
    ingest_key TEXT UNIQUE NOT NULL, -- key that can only send activity for this one site
    verified_at DATETIME,            -- NULL until ownership is proven
    alert_email TEXT,                -- where failure alerts are sent (NULL = off)
    last_alert_at DATETIME,          -- cooldown marker: when the last failure alert went out
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS system_logs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    module_name TEXT NOT NULL,
    event_type TEXT NOT NULL,
    action TEXT NOT NULL,
    actor_hash TEXT,
    status TEXT NOT NULL,
    payload TEXT NOT NULL,
    ip_hash TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS usage (
    user_id TEXT NOT NULL,
    month TEXT NOT NULL,             -- UTC "YYYY-MM"
    log_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, month)
);

CREATE INDEX IF NOT EXISTS idx_logs_project_module ON system_logs(project_id, module_name);
CREATE INDEX IF NOT EXISTS idx_logs_created_at ON system_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_sites_user_id ON sites(user_id);
CREATE INDEX IF NOT EXISTS idx_sites_project_id ON sites(project_id);
CREATE INDEX IF NOT EXISTS idx_sites_domain ON sites(domain);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sites_ingest_key ON sites(ingest_key);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_api_key ON users(api_key);
CREATE INDEX IF NOT EXISTS idx_usage_month ON usage(month);
