-- Finish the monetbil_* -> gateway_* migration on the data side.
--
-- The original backfill (20260427120000) only touched rows where
-- monetbil_payment_ref IS NOT NULL, so a request that recorded a transaction id
-- without a payment ref kept its data solely in the legacy columns. Application
-- code no longer writes those columns, so anything still missing here would be
-- stranded when they are dropped.
--
-- Both statements are safe to re-run.

UPDATE "payment_requests"
SET
  "gateway"             = COALESCE("gateway", 'MONETBIL'),
  "gateway_payment_ref" = COALESCE("gateway_payment_ref", "monetbil_payment_ref"),
  "gateway_tx_id"       = COALESCE("gateway_tx_id", "monetbil_tx_id")
WHERE
  ("monetbil_payment_ref" IS NOT NULL OR "monetbil_tx_id" IS NOT NULL)
  AND (
    "gateway" IS NULL
    OR ("gateway_payment_ref" IS NULL AND "monetbil_payment_ref" IS NOT NULL)
    OR ("gateway_tx_id"       IS NULL AND "monetbil_tx_id"       IS NOT NULL)
  );

-- A row that reached a gateway at all has a driver name. Rows that never left
-- PENDING legitimately have neither and are left alone.
UPDATE "payment_requests"
SET "gateway" = 'MONETBIL'
WHERE "gateway" IS NULL
  AND "gateway_payment_ref" IS NOT NULL;
