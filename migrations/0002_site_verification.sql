-- One-time upgrade for databases created before site verification existed.
-- Run once:  npx wrangler d1 execute production-logger-db --remote --file=./migrations/0002_site_verification.sql
ALTER TABLE sites ADD COLUMN verify_token TEXT;
ALTER TABLE sites ADD COLUMN ingest_key TEXT;
ALTER TABLE sites ADD COLUMN verified_at DATETIME;

UPDATE sites SET verify_token = lower(hex(randomblob(16))) WHERE verify_token IS NULL;
UPDATE sites SET ingest_key = 'cl_site_' || lower(hex(randomblob(16))) WHERE ingest_key IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sites_ingest_key ON sites(ingest_key);
CREATE INDEX IF NOT EXISTS idx_sites_domain ON sites(domain);
