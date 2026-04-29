-- CreateEnum
CREATE TYPE "PaymentRequestType" AS ENUM ('PENALTY_BATCH', 'PENALTY_RESOLUTION', 'CONTACT_UNLOCK', 'RECOMMENDATION_CONTACT');

-- AlterTable
ALTER TABLE "payment_requests"
  ADD COLUMN "request_type" "PaymentRequestType",
  ADD COLUMN "recommendation_worker_id" UUID;

-- CreateIndex
CREATE INDEX "idx_payment_request_type" ON "payment_requests"("request_type");
