-- CreateEnum
CREATE TYPE "PaymentType" AS ENUM ('REGISTRATION', 'JOB_POSTING', 'PENALTY');

-- AlterTable: add columns as nullable first
ALTER TABLE "payments" ADD COLUMN "type" "PaymentType";
ALTER TABLE "payments" ADD COLUMN "paid_at" TIMESTAMP(3);
ALTER TABLE "payments" ADD COLUMN "description" TEXT;

-- Backfill existing rows: set type based on context and migrate completed_at to paid_at
UPDATE "payments" SET "paid_at" = "completed_at" WHERE "completed_at" IS NOT NULL;
UPDATE "payments" SET "type" = 'PENALTY' WHERE "id" IN (
  SELECT p."id" FROM "payments" p
  INNER JOIN "wallet_transactions" wt ON wt."reference_id"::uuid = p."profile_id"::uuid
  WHERE wt."type" = 'CREDIT_PENALTY'
);
UPDATE "payments" SET "type" = 'JOB_POSTING' WHERE "type" IS NULL;

-- Make type column required
ALTER TABLE "payments" ALTER COLUMN "type" SET NOT NULL;

-- Drop old column
ALTER TABLE "payments" DROP COLUMN "completed_at";

-- CreateIndex
CREATE INDEX "idx_payment_type" ON "payments"("type");
