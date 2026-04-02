-- AlterTable
ALTER TABLE "payment_requests" ADD COLUMN IF NOT EXISTS "contact_unlock_attempt_id" UUID;
