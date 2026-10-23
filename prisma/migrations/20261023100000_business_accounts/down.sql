-- Rollback of 20261023100000_business_accounts. Run by hand, then revert the
-- schema change and delete this migration's row from _prisma_migrations.
-- Lossless until the first business exists; after that, export "businesses"
-- and "business_documents" first (their files stay in the bucket by key).
DROP TRIGGER IF EXISTS "businesses_profile_is_business" ON "businesses";
DROP FUNCTION IF EXISTS "business_requires_business_profile"();
DROP TABLE IF EXISTS "business_documents";
DROP TABLE IF EXISTS "businesses";
DROP TYPE IF EXISTS "BusinessDocumentType";
DROP TYPE IF EXISTS "BusinessLegalForm";
DROP TYPE IF EXISTS "BusinessCategory";
DROP INDEX IF EXISTS "idx_profile_is_business";
ALTER TABLE "profiles" DROP CONSTRAINT IF EXISTS "profiles_business_is_employer";
ALTER TABLE "profiles" DROP COLUMN IF EXISTS "is_business";
