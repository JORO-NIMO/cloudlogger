-- D1 Migration Schema for General Logging Engine & Multi-Tenant SaaS with Whop Billing
DROP TABLE IF EXISTS system_logs;
DROP TABLE IF EXISTS sites;
DROP TABLE IF EXISTS users;

CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    api_key TEXT UNIQUE NOT NULL,
    plan TEXT DEFAULT 'pro_monthly_5', -- 'free', 'pro_monthly_5'
    is_active_paid INTEGER DEFAULT 1,  -- 1 for active $5/mo Whop subscriber
    whop_membership_id TEXT,
    whop_user_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sites (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    project_id TEXT UNIQUE NOT NULL,
    domain TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE system_logs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    module_name TEXT NOT NULL,
    event_type TEXT NOT NULL,
    action TEXT NOT NULL,
    actor_hash TEXT,
    status TEXT NOT NULL,
    payload TEXT NOT NULL, -- JSON string
    ip_hash TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Optimize query speeds for high-scale querying
CREATE INDEX idx_logs_project_module ON system_logs(project_id, module_name);
CREATE INDEX idx_logs_created_at ON system_logs(created_at);
CREATE INDEX idx_sites_user_id ON sites(user_id);
CREATE INDEX idx_sites_project_id ON sites(project_id);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_api_key ON users(api_key);
