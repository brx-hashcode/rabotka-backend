-- CreateEnum
CREATE TYPE "PaymentRequestStatus" AS ENUM ('PENDING', 'SUBMITTED', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "payment_requests" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "profile_id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "status" "PaymentRequestStatus" NOT NULL DEFAULT 'PENDING',
    "payment_reference" TEXT,
    "proof_images" TEXT[],
    "rejection_note" TEXT,

    CONSTRAINT "payment_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_requests_token_key" ON "payment_requests"("token");

-- CreateIndex
CREATE INDEX "idx_payment_request_profile" ON "payment_requests"("profile_id");

-- CreateIndex
CREATE INDEX "idx_payment_request_token" ON "payment_requests"("token");

-- CreateIndex
CREATE INDEX "idx_payment_request_status" ON "payment_requests"("status");

-- AddForeignKey
ALTER TABLE "payment_requests" ADD CONSTRAINT "payment_requests_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
