-- Add missing indexes identified in backend audit

-- ad_delivery_logs: sent_at (used in analytics GROUP BY and ORDER BY)
CREATE INDEX IF NOT EXISTS "idx_ad_delivery_sent_at"
  ON "ad_delivery_logs"("sent_at");

-- ad_delivery_logs: (advertisement_id, sent_at) composite — used by per-batch analytics query
CREATE INDEX IF NOT EXISTS "idx_ad_delivery_advertisement_sent_at"
  ON "ad_delivery_logs"("advertisement_id", "sent_at");

-- applications: (job_offer_id, status) composite — used when counting accepted applications per job
CREATE INDEX IF NOT EXISTS "idx_application_job_offer_status"
  ON "applications"("job_offer_id", "status");
