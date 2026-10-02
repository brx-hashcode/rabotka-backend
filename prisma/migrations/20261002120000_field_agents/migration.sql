-- Field agents: a third identity beside profiles (end users) and users (staff).
--
-- An agent is created by an admin, logs in to the separate agent app with
-- email + OTP, and covers a set of cities (agent_zones). Their identity
-- documents live in the private KYC bucket; agent_kyc_documents holds only the
-- object keys. New tables only — nothing existing is altered.

-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'REVOKED');

-- CreateTable
CREATE TABLE "agents" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "id_document_type" "DocumentType" NOT NULL,
    "id_document_number" TEXT NOT NULL,
    "avatar_url" TEXT,
    "avatar_storage_key" TEXT,
    "status" "AgentStatus" NOT NULL DEFAULT 'ACTIVE',
    "status_reason" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "last_login_at" TIMESTAMP(3),

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_zones" (
    "agent_id" UUID NOT NULL,
    "country_code" VARCHAR(2) NOT NULL,
    "city" TEXT NOT NULL,

    CONSTRAINT "agent_zones_pkey" PRIMARY KEY ("agent_id","country_code","city")
);

-- CreateTable
CREATE TABLE "agent_kyc_documents" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "agent_id" UUID NOT NULL,
    "document_category" "KycDocumentCategory" NOT NULL,
    "storage_key" TEXT NOT NULL,
    "uploaded_by_user_id" UUID NOT NULL,

    CONSTRAINT "agent_kyc_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agents_email_key" ON "agents"("email");

-- CreateIndex
CREATE UNIQUE INDEX "agents_phone_key" ON "agents"("phone");

-- CreateIndex
CREATE INDEX "idx_agent_status" ON "agents"("status");

-- CreateIndex
CREATE UNIQUE INDEX "agents_id_document_type_id_document_number_key" ON "agents"("id_document_type", "id_document_number");

-- CreateIndex
CREATE INDEX "idx_agent_zone_city" ON "agent_zones"("country_code", "city");

-- CreateIndex
CREATE UNIQUE INDEX "agent_kyc_documents_agent_id_document_category_key" ON "agent_kyc_documents"("agent_id", "document_category");

-- AddForeignKey
ALTER TABLE "agent_zones" ADD CONSTRAINT "agent_zones_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_kyc_documents" ADD CONSTRAINT "agent_kyc_documents_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

