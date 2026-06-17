/*
  Warnings:

  - The values [DRAFT] on the enum `JobOfferStatus` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "JobOfferStatus_new" AS ENUM ('ACTIVE', 'PARTIALLY_FILLED', 'FILLED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'EXPIRED');
ALTER TABLE "public"."job_offers" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "job_offers" ALTER COLUMN "status" TYPE "JobOfferStatus_new" USING ("status"::text::"JobOfferStatus_new");
ALTER TYPE "JobOfferStatus" RENAME TO "JobOfferStatus_old";
ALTER TYPE "JobOfferStatus_new" RENAME TO "JobOfferStatus";
DROP TYPE "public"."JobOfferStatus_old";
ALTER TABLE "job_offers" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';
COMMIT;

-- DropForeignKey
ALTER TABLE "verification_tokens" DROP CONSTRAINT "verification_tokens_profile_id_fkey";

-- CreateIndex
CREATE INDEX "idx_unlock_worker" ON "contact_unlock_attempts"("worker_id");

-- CreateIndex
CREATE INDEX "idx_unlock_employer" ON "contact_unlock_attempts"("employer_id");

-- AddForeignKey
ALTER TABLE "verification_tokens" ADD CONSTRAINT "verification_tokens_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
