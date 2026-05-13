-- CreateEnum
CREATE TYPE "ContactUnlockStatus" AS ENUM ('PENDING_BOTH', 'PENDING_EMPLOYER', 'PENDING_WORKER', 'UNLOCKED', 'EXPIRED', 'CONVERTED_TO_CREDIT');

-- AlterEnum
ALTER TYPE "PaymentType" ADD VALUE 'CONTACT_UNLOCK';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "WalletTransactionType" ADD VALUE 'WELCOME_CREDIT';
ALTER TYPE "WalletTransactionType" ADD VALUE 'CONTACT_UNLOCK_DEBIT';
ALTER TYPE "WalletTransactionType" ADD VALUE 'CONTACT_UNLOCK_CREDIT_CONVERSION';
ALTER TYPE "WalletTransactionType" ADD VALUE 'PENALTY_DEBIT';

-- AlterTable
ALTER TABLE "profiles" ADD COLUMN     "whatsapp_activation_bonus_granted" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "contact_unlock_attempts" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "application_id" UUID NOT NULL,
    "job_offer_id" UUID NOT NULL,
    "worker_id" UUID NOT NULL,
    "employer_id" UUID NOT NULL,
    "status" "ContactUnlockStatus" NOT NULL DEFAULT 'PENDING_BOTH',
    "employer_paid" BOOLEAN NOT NULL DEFAULT false,
    "worker_paid" BOOLEAN NOT NULL DEFAULT false,
    "employer_paid_at" TIMESTAMP(3),
    "worker_paid_at" TIMESTAMP(3),
    "employer_amount" DECIMAL(10,2) NOT NULL,
    "worker_amount" DECIMAL(10,2) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "unlocked_at" TIMESTAMP(3),
    "converted_at" TIMESTAMP(3),

    CONSTRAINT "contact_unlock_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "contact_unlock_attempts_application_id_key" ON "contact_unlock_attempts"("application_id");

-- CreateIndex
CREATE INDEX "idx_unlock_application" ON "contact_unlock_attempts"("application_id");

-- CreateIndex
CREATE INDEX "idx_unlock_status" ON "contact_unlock_attempts"("status");

-- CreateIndex
CREATE INDEX "idx_unlock_expires_at" ON "contact_unlock_attempts"("expires_at");

-- AddForeignKey
ALTER TABLE "contact_unlock_attempts" ADD CONSTRAINT "contact_unlock_attempts_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_unlock_attempts" ADD CONSTRAINT "contact_unlock_attempts_job_offer_id_fkey" FOREIGN KEY ("job_offer_id") REFERENCES "job_offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_unlock_attempts" ADD CONSTRAINT "contact_unlock_attempts_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_unlock_attempts" ADD CONSTRAINT "contact_unlock_attempts_employer_id_fkey" FOREIGN KEY ("employer_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
