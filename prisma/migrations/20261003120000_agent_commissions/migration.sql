-- Field agents, phase 3: commissions.
--
-- One new enum and one new table. Nothing existing is altered.

-- CreateEnum
CREATE TYPE "AgentCommissionStatus" AS ENUM ('PENDING', 'AVAILABLE', 'CANCELLED', 'INELIGIBLE');

-- CreateTable
CREATE TABLE "agent_commissions" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "agent_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "contact_unlock_attempt_id" UUID NOT NULL,
    "job_offer_id" UUID NOT NULL,
    "worker_id" UUID NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "status" "AgentCommissionStatus" NOT NULL DEFAULT 'PENDING',
    "available_at" TIMESTAMPTZ,
    "released_at" TIMESTAMPTZ,
    "cancelled_at" TIMESTAMPTZ,
    "reason" TEXT,
    "rules_snapshot" JSONB NOT NULL,

    CONSTRAINT "agent_commissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_commissions_application_id_key" ON "agent_commissions"("application_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_commissions_contact_unlock_attempt_id_key" ON "agent_commissions"("contact_unlock_attempt_id");

-- CreateIndex
CREATE INDEX "idx_agent_commission_status_available" ON "agent_commissions"("status", "available_at");

-- CreateIndex
CREATE INDEX "idx_agent_commission_agent_time" ON "agent_commissions"("agent_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "agent_commissions" ADD CONSTRAINT "agent_commissions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

