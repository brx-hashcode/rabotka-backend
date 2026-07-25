-- AlterTable
ALTER TABLE "applications" ADD COLUMN     "deleted_at" TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "job_offers" ADD COLUMN     "deleted_at" TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "payment_requests" ADD COLUMN     "deleted_at" TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "penalties" ADD COLUMN     "deleted_at" TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "profiles" ADD COLUMN     "deleted_at" TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "deleted_at" TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "wallet_transactions" ADD COLUMN     "deleted_at" TIMESTAMPTZ;

-- CreateIndex
CREATE INDEX "idx_application_deleted_at" ON "applications"("deleted_at");

-- CreateIndex
CREATE INDEX "idx_job_offer_deleted_at" ON "job_offers"("deleted_at");

-- CreateIndex
CREATE INDEX "idx_payment_request_deleted_at" ON "payment_requests"("deleted_at");

-- CreateIndex
CREATE INDEX "idx_penalty_deleted_at" ON "penalties"("deleted_at");

-- CreateIndex
CREATE INDEX "idx_profile_deleted_at" ON "profiles"("deleted_at");

-- CreateIndex
CREATE INDEX "idx_user_deleted_at" ON "users"("deleted_at");

-- CreateIndex
CREATE INDEX "idx_wallet_transaction_deleted_at" ON "wallet_transactions"("deleted_at");
