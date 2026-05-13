-- Add PROCESSING to PaymentRequestStatus enum
ALTER TYPE "PaymentRequestStatus" ADD VALUE 'PROCESSING';

-- Add MONETBIL to ConfigCategory enum
ALTER TYPE "ConfigCategory" ADD VALUE 'MONETBIL';

-- Add Monetbil fields to payment_requests
ALTER TABLE "payment_requests"
  ADD COLUMN "amount"               DECIMAL(10,2),
  ADD COLUMN "description"          TEXT,
  ADD COLUMN "phone"                TEXT,
  ADD COLUMN "operator"             TEXT,
  ADD COLUMN "monetbil_payment_ref" TEXT,
  ADD COLUMN "monetbil_tx_id"       TEXT;

-- Unique constraint on monetbil_payment_ref
CREATE UNIQUE INDEX "payment_requests_monetbil_payment_ref_key" ON "payment_requests"("monetbil_payment_ref");

-- Index for fast lookup by monetbil_payment_ref
CREATE INDEX "idx_payment_request_monetbil_ref" ON "payment_requests"("monetbil_payment_ref");
