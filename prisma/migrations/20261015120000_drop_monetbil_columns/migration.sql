-- Monetbil is no longer a payment gateway. Its references were copied into
-- gateway_payment_ref / gateway_tx_id by 20260824220000_backfill_gateway_ref_from_monetbil,
-- and nothing reads these columns any more.

-- Safety net: copy any reference the backfill could not have seen.
UPDATE "payment_requests"
SET "gateway_payment_ref" = "monetbil_payment_ref",
    "gateway_tx_id"       = COALESCE("gateway_tx_id", "monetbil_tx_id"),
    "gateway"             = COALESCE("gateway", 'MONETBIL')
WHERE "monetbil_payment_ref" IS NOT NULL
  AND "gateway_payment_ref" IS NULL;

DROP INDEX IF EXISTS "idx_payment_request_monetbil_ref";
DROP INDEX IF EXISTS "payment_requests_monetbil_payment_ref_key";

ALTER TABLE "payment_requests"
  DROP COLUMN IF EXISTS "monetbil_payment_ref",
  DROP COLUMN IF EXISTS "monetbil_tx_id";
