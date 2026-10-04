-- Field agents, phase 4: withdrawals.
--
-- Two new enums and one new table. Nothing existing is altered.

-- CreateEnum
CREATE TYPE "AgentWithdrawalStatus" AS ENUM ('REQUESTED', 'PAID', 'REJECTED');

-- CreateEnum
CREATE TYPE "AgentMomoOperator" AS ENUM ('MTN', 'AIRTEL');

-- CreateTable
CREATE TABLE "agent_withdrawals" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "agent_id" UUID NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "momo_phone" TEXT NOT NULL,
    "momo_operator" "AgentMomoOperator" NOT NULL,
    "status" "AgentWithdrawalStatus" NOT NULL DEFAULT 'REQUESTED',
    "processed_by_user_id" UUID,
    "processed_at" TIMESTAMPTZ,
    "provider_reference" TEXT,
    "rejection_reason" TEXT,

    CONSTRAINT "agent_withdrawals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_withdrawals_provider_reference_key" ON "agent_withdrawals"("provider_reference");

-- CreateIndex
CREATE INDEX "idx_agent_withdrawal_status_time" ON "agent_withdrawals"("status", "created_at");

-- CreateIndex
CREATE INDEX "idx_agent_withdrawal_agent_time" ON "agent_withdrawals"("agent_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "agent_withdrawals" ADD CONSTRAINT "agent_withdrawals_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- At most one open (REQUESTED) withdrawal per agent. Hand-written: Prisma
-- cannot express a partial index, so — like applications_live_unique — it
-- lives only here and a future `migrate diff` must not drop it.
CREATE UNIQUE INDEX "agent_withdrawals_one_open" ON "agent_withdrawals"("agent_id") WHERE "status" = 'REQUESTED';
