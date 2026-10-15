-- Payouts from the gateway account to a mobile-money number, sent by an
-- admin. The ledger is debited when the gateway confirms them.
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

CREATE TABLE "mobile_money_payouts" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "client_request_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'XAF',
    "phone" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "note" TEXT,
    "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
    "gateway" TEXT NOT NULL,
    "gateway_ref" TEXT,
    "gateway_tx_id" TEXT,
    "failure_reason" TEXT,
    "completed_at" TIMESTAMP(3),
    "requested_by_id" UUID,

    CONSTRAINT "mobile_money_payouts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mobile_money_payouts_client_request_id_key" ON "mobile_money_payouts"("client_request_id");
CREATE UNIQUE INDEX "mobile_money_payouts_gateway_ref_key" ON "mobile_money_payouts"("gateway_ref");
CREATE INDEX "idx_mm_payout_status" ON "mobile_money_payouts"("status");
CREATE INDEX "idx_mm_payout_created" ON "mobile_money_payouts"("created_at");

ALTER TABLE "mobile_money_payouts"
  ADD CONSTRAINT "mobile_money_payouts_requested_by_id_fkey"
  FOREIGN KEY ("requested_by_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
