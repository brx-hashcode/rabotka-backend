-- Add PAYMENT to ConfigCategory enum
ALTER TYPE "ConfigCategory" ADD VALUE IF NOT EXISTS 'PAYMENT';

-- Add gateway-agnostic fields to payment_requests
ALTER TABLE "payment_requests"
  ADD COLUMN IF NOT EXISTS "gateway"             TEXT,
  ADD COLUMN IF NOT EXISTS "gateway_payment_ref" TEXT,
  ADD COLUMN IF NOT EXISTS "gateway_tx_id"       TEXT;

-- Unique index on gateway_payment_ref (mirrors monetbil_payment_ref constraint)
CREATE UNIQUE INDEX IF NOT EXISTS "idx_payment_request_gateway_ref"
  ON "payment_requests"("gateway_payment_ref");

-- Backfill existing Monetbil rows
UPDATE "payment_requests"
SET
  "gateway"             = 'MONETBIL',
  "gateway_payment_ref" = "monetbil_payment_ref",
  "gateway_tx_id"       = "monetbil_tx_id"
WHERE "gateway" IS NULL
  AND "monetbil_payment_ref" IS NOT NULL;
