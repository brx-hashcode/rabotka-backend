-- AlterTable
ALTER TABLE "job_offers" ADD COLUMN     "employer_unlock_paid" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "employer_unlock_paid_at" TIMESTAMP(3);
