-- Agent earnings ledger: append-only, no stored balance.
--
-- Every balance is SUM(amount) GROUP BY bucket. There is no UPDATE or DELETE
-- path in the code; corrections are ADJUSTMENT rows. ON DELETE RESTRICT, so an
-- agent with money history cannot be removed out from under it.

-- CreateEnum
CREATE TYPE "AgentLedgerBucket" AS ENUM ('PENDING', 'AVAILABLE', 'LOCKED', 'PAID_OUT');

-- CreateEnum
CREATE TYPE "AgentLedgerKind" AS ENUM ('COMMISSION_EARNED', 'COMMISSION_RELEASED', 'COMMISSION_CANCELLED', 'WITHDRAWAL_REQUESTED', 'WITHDRAWAL_PAID', 'WITHDRAWAL_REJECTED', 'ADJUSTMENT');

-- CreateTable
CREATE TABLE "agent_ledger_entries" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "agent_id" UUID NOT NULL,
    "kind" "AgentLedgerKind" NOT NULL,
    "bucket" "AgentLedgerBucket" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reference_type" TEXT NOT NULL,
    "reference_id" UUID,
    "description" TEXT,
    "idempotency_key" TEXT NOT NULL,

    CONSTRAINT "agent_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_ledger_entries_idempotency_key_key" ON "agent_ledger_entries"("idempotency_key");

-- CreateIndex
CREATE INDEX "idx_agent_ledger_agent_bucket" ON "agent_ledger_entries"("agent_id", "bucket");

-- CreateIndex
CREATE INDEX "idx_agent_ledger_agent_time" ON "agent_ledger_entries"("agent_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "agent_ledger_entries" ADD CONSTRAINT "agent_ledger_entries_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

