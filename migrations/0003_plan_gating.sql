-- One-time upgrade for databases created before plan gating existed.
-- Run once:  npx wrangler d1 execute production-logger-db --remote --file=./migrations/0003_plan_gating.sql

-- Failure alerts: where to email, and when the last one was sent (cooldown).
ALTER TABLE sites ADD COLUMN alert_email TEXT;
ALTER TABLE sites ADD COLUMN last_alert_at DATETIME;

-- Monthly activity counters used for quota enforcement.
CREATE TABLE IF NOT EXISTS usage (
    user_id TEXT NOT NULL,
    month TEXT NOT NULL,           -- UTC "YYYY-MM"
    log_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, month)
);
CREATE INDEX IF NOT EXISTS idx_usage_month ON usage(month);

-- Accounts created before gating existed got pro defaults without paying.
-- Anyone without a Whop membership moves to the free plan.
UPDATE users SET plan = 'free', is_active_paid = 0
 WHERE whop_membership_id IS NULL AND plan = 'pro_monthly_5';
