-- AlterEnum: Add WALLET_TOP_UP to InvoiceReason (was added via raw SQL, now tracked in migration history)
ALTER TYPE "InvoiceReason" ADD VALUE IF NOT EXISTS 'WALLET_TOP_UP';

-- AlterEnum: Remove MONETBIL and PAYMENT from ConfigCategory
-- PostgreSQL does not support DROP VALUE on enums directly; recreate the type without those values.
DELETE FROM "system_configs" WHERE category::text IN ('MONETBIL', 'PAYMENT');

ALTER TYPE "ConfigCategory" RENAME TO "ConfigCategory_old";
CREATE TYPE "ConfigCategory" AS ENUM ('TWILIO', 'FEES', 'MATCHING', 'CONTACT', 'STORAGE', 'GENERAL');
ALTER TABLE "system_configs" ALTER COLUMN "category" TYPE "ConfigCategory" USING "category"::text::"ConfigCategory";
DROP TYPE "ConfigCategory_old";
