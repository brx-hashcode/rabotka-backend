-- Add TOTP fields to users table
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totp_secret" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totp_enabled" BOOLEAN NOT NULL DEFAULT false;

-- Add MANUAL_CREDIT to WalletTransactionType enum
ALTER TYPE "WalletTransactionType" ADD VALUE IF NOT EXISTS 'MANUAL_CREDIT';

-- Add payment_id to invoices table and make payment_request_id nullable
ALTER TABLE "invoices" ALTER COLUMN "payment_request_id" DROP NOT NULL;
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "payment_id" UUID;

-- Add unique index on invoices.payment_id
CREATE UNIQUE INDEX IF NOT EXISTS "invoices_payment_id_key" ON "invoices"("payment_id");

-- Add foreign key from invoices.payment_id to payments.id
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_payment_id_fkey"
  FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
