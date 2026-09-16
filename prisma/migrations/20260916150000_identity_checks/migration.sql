-- CreateEnum
CREATE TYPE "IdentityCheckStatus" AS ENUM ('PENDING_CONSENT', 'COMPLETED', 'NOT_COMPLETED');

-- AlterTable
ALTER TABLE "oauth_apps" ADD COLUMN     "webhook_url" TEXT;

-- CreateTable
CREATE TABLE "identity_checks" (
    "id" UUID NOT NULL,
    "app_id" UUID NOT NULL,
    "profile_id" UUID,
    "sandbox_subject" TEXT,
    "phone_e164" TEXT NOT NULL,
    "claimed" JSONB,
    "reference" TEXT,
    "idempotency_key" TEXT,
    "status" "IdentityCheckStatus" NOT NULL DEFAULT 'PENDING_CONSENT',
    "expires_at" TIMESTAMPTZ NOT NULL,
    "consent_sent_at" TIMESTAMPTZ,
    "decided_at" TIMESTAMPTZ,
    "declined" BOOLEAN,
    "result" JSONB,
    "score" INTEGER,
    "webhook_attempts" INTEGER NOT NULL DEFAULT 0,
    "webhook_delivered_at" TIMESTAMPTZ,
    "webhook_last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "identity_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_identity_check_app_phone_time" ON "identity_checks"("app_id", "phone_e164", "created_at");

-- CreateIndex
CREATE INDEX "idx_identity_check_status_expiry" ON "identity_checks"("status", "expires_at");

-- CreateIndex
CREATE INDEX "idx_identity_check_profile_status" ON "identity_checks"("profile_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "identity_checks_app_id_idempotency_key_key" ON "identity_checks"("app_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "identity_checks" ADD CONSTRAINT "identity_checks_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "oauth_apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity_checks" ADD CONSTRAINT "identity_checks_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

