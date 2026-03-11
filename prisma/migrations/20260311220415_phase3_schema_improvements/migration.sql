-- CreateEnum
CREATE TYPE "BillingStatus" AS ENUM ('CLEAR', 'PENDING_PAYMENT', 'BLOCKED');

-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('CONFIRMED', 'COMPLETED', 'NO_SHOW', 'CANCELLED_BY_WORKER', 'CANCELLED_BY_EMPLOYER');

-- CreateEnum
CREATE TYPE "CancelledBy" AS ENUM ('WORKER', 'EMPLOYER');

-- AlterEnum
ALTER TYPE "ApplicationStatus" ADD VALUE 'VIEWED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "JobOfferStatus" ADD VALUE 'DRAFT';
ALTER TYPE "JobOfferStatus" ADD VALUE 'PARTIALLY_FILLED';
ALTER TYPE "JobOfferStatus" ADD VALUE 'IN_PROGRESS';
ALTER TYPE "JobOfferStatus" ADD VALUE 'EXPIRED';

-- AlterTable
ALTER TABLE "applications" ADD COLUMN     "viewed_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "profiles" ADD COLUMN     "billing_status" "BillingStatus" NOT NULL DEFAULT 'CLEAR';

-- CreateTable
CREATE TABLE "assignments" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "application_id" UUID NOT NULL,
    "job_offer_id" UUID NOT NULL,
    "worker_id" UUID NOT NULL,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'CONFIRMED',
    "cancelled_by" "CancelledBy",
    "cancelled_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "no_show_at" TIMESTAMP(3),
    "note" TEXT,

    CONSTRAINT "assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "assignments_application_id_key" ON "assignments"("application_id");

-- CreateIndex
CREATE INDEX "idx_assignment_job_offer" ON "assignments"("job_offer_id");

-- CreateIndex
CREATE INDEX "idx_assignment_worker" ON "assignments"("worker_id");

-- CreateIndex
CREATE INDEX "idx_assignment_status" ON "assignments"("status");

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_job_offer_id_fkey" FOREIGN KEY ("job_offer_id") REFERENCES "job_offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
