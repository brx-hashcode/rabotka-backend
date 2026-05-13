-- Make penalty creation idempotent: one penalty per application
-- This prevents double-charging if the cancellation BullMQ job retries

CREATE UNIQUE INDEX IF NOT EXISTS "idx_penalty_application_unique"
  ON "penalties"("application_id");
