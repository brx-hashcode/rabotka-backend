-- Field agents, phase 2: leads, calls, phone reveals, and the agent behind an
-- application.
--
-- New tables, a new nullable column on applications (no rewrite, no default),
-- and a new ConfigCategory value. The partial unique index
-- applications_live_unique is untouched: this diff never mentions it.

-- CreateEnum
CREATE TYPE "AgentLeadStatus" AS ENUM ('SUGGESTED', 'CLAIMED', 'INVITED', 'CONFIRMED', 'DECLINED', 'UNREACHABLE');

-- CreateEnum
CREATE TYPE "AgentCallOutcome" AS ENUM ('INTERESTED', 'NOT_AVAILABLE', 'NOT_INTERESTED', 'UNREACHABLE', 'WRONG_NUMBER', 'CALL_BACK');

-- AlterEnum
ALTER TYPE "ConfigCategory" ADD VALUE 'AGENT';

-- AlterTable
ALTER TABLE "applications" ADD COLUMN     "agent_id" UUID;

-- CreateTable
CREATE TABLE "agent_leads" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "job_offer_id" UUID NOT NULL,
    "worker_id" UUID NOT NULL,
    "status" "AgentLeadStatus" NOT NULL DEFAULT 'SUGGESTED',
    "claimed_by_agent_id" UUID,
    "claimed_at" TIMESTAMP(3),
    "claim_expires_at" TIMESTAMP(3),
    "invite_token" TEXT,
    "invited_at" TIMESTAMP(3),
    "invite_expires_at" TIMESTAMP(3),
    "application_id" UUID,
    "decided_at" TIMESTAMP(3),

    CONSTRAINT "agent_leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_call_logs" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lead_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "outcome" "AgentCallOutcome" NOT NULL,
    "note" TEXT,

    CONSTRAINT "agent_call_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_phone_reveals" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "agent_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "worker_id" UUID NOT NULL,
    "ip_address" TEXT,

    CONSTRAINT "agent_phone_reveals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_leads_invite_token_key" ON "agent_leads"("invite_token");

-- CreateIndex
CREATE UNIQUE INDEX "agent_leads_application_id_key" ON "agent_leads"("application_id");

-- CreateIndex
CREATE INDEX "idx_agent_lead_agent_status" ON "agent_leads"("claimed_by_agent_id", "status");

-- CreateIndex
CREATE INDEX "idx_agent_lead_job_status" ON "agent_leads"("job_offer_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "agent_leads_job_offer_id_worker_id_key" ON "agent_leads"("job_offer_id", "worker_id");

-- CreateIndex
CREATE INDEX "idx_agent_call_lead_time" ON "agent_call_logs"("lead_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_agent_call_agent_time" ON "agent_call_logs"("agent_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_agent_reveal_agent_time" ON "agent_phone_reveals"("agent_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_agent_reveal_worker_time" ON "agent_phone_reveals"("worker_id", "created_at");

-- AddForeignKey
ALTER TABLE "agent_leads" ADD CONSTRAINT "agent_leads_job_offer_id_fkey" FOREIGN KEY ("job_offer_id") REFERENCES "job_offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_leads" ADD CONSTRAINT "agent_leads_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_leads" ADD CONSTRAINT "agent_leads_claimed_by_agent_id_fkey" FOREIGN KEY ("claimed_by_agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_leads" ADD CONSTRAINT "agent_leads_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_call_logs" ADD CONSTRAINT "agent_call_logs_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "agent_leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_call_logs" ADD CONSTRAINT "agent_call_logs_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_phone_reveals" ADD CONSTRAINT "agent_phone_reveals_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_phone_reveals" ADD CONSTRAINT "agent_phone_reveals_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "agent_leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_phone_reveals" ADD CONSTRAINT "agent_phone_reveals_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

