-- Business accounts (PME/TPE, ONG, écoles…): an employer profile flagged
-- is_business, linked one-to-one to the organisation it represents and its
-- documents. Existing profiles all stay is_business = false (column default).
-- Rollback: down.sql next to this file.

-- CreateEnum
CREATE TYPE "BusinessCategory" AS ENUM ('INDIVIDUAL_BUSINESS', 'TPE', 'PME', 'LARGE_COMPANY', 'STARTUP', 'COOPERATIVE', 'GIE', 'ASSOCIATION', 'NGO', 'INTERNATIONAL_NGO', 'FOUNDATION', 'RELIGIOUS', 'SCHOOL', 'HIGHER_EDUCATION', 'TRAINING_CENTER', 'HEALTH', 'PUBLIC_ADMINISTRATION', 'PUBLIC_ENTERPRISE', 'INTERNATIONAL_ORG', 'OTHER');

-- CreateEnum
CREATE TYPE "BusinessLegalForm" AS ENUM ('EI', 'SARL', 'SARLU', 'SA', 'SAS', 'SASU', 'SNC', 'SCS', 'GIE', 'SCOOPS', 'COOP_CA', 'BRANCH', 'ASSOCIATION', 'FOUNDATION', 'PUBLIC_ENTITY', 'OTHER');

-- CreateEnum
CREATE TYPE "BusinessDocumentType" AS ENUM ('RCCM', 'NIU', 'STATUTS', 'PATENTE', 'CNSS', 'SCIEN_SCIET', 'RECEPISSE', 'AGREMENT', 'AUTORISATION_OUVERTURE', 'ARRETE', 'MANDATE', 'OTHER');

-- AlterTable
ALTER TABLE "profiles" ADD COLUMN     "is_business" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "businesses" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "profile_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "category" "BusinessCategory" NOT NULL,
    "legal_form" "BusinessLegalForm",
    "size" TEXT,
    "registration_number" TEXT,
    "tax_id" TEXT,
    "statistical_id" TEXT,
    "address" TEXT NOT NULL,
    "country_code" VARCHAR(2),
    "city" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "website" TEXT,
    "description" TEXT,
    "verification_status" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "verified_at" TIMESTAMP(3),
    "verified_by" UUID,
    "rejection_reason" TEXT,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "businesses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_documents" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "business_id" UUID NOT NULL,
    "document_type" "BusinessDocumentType" NOT NULL,
    "storage_key" TEXT NOT NULL,
    "file_name" TEXT,
    "mime_type" TEXT,
    "verification_status" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "verified_at" TIMESTAMP(3),
    "verified_by" UUID,
    "rejection_reason" TEXT,

    CONSTRAINT "business_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "businesses_profile_id_key" ON "businesses"("profile_id");

-- CreateIndex
CREATE INDEX "idx_business_verification_status" ON "businesses"("verification_status");

-- CreateIndex
CREATE INDEX "idx_business_category" ON "businesses"("category");

-- CreateIndex
CREATE INDEX "idx_business_deleted_at" ON "businesses"("deleted_at");

-- CreateIndex
CREATE INDEX "idx_business_document_business" ON "business_documents"("business_id");

-- CreateIndex
CREATE INDEX "idx_profile_is_business" ON "profiles"("is_business");

-- AddForeignKey
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_documents" ADD CONSTRAINT "business_documents_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Only an employer can be a business. Prisma cannot model CHECK constraints;
-- the schema's comment on Profile.is_business points here.
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_business_is_employer"
  CHECK (NOT "is_business" OR "profile_type" = 'EMPLOYER');

-- A business row only for a business employer. A CHECK cannot look at another
-- table, so a trigger keeps the two from drifting apart.
CREATE FUNCTION "business_requires_business_profile"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "profiles"
    WHERE "id" = NEW."profile_id"
      AND "is_business"
      AND "profile_type" = 'EMPLOYER'
  ) THEN
    RAISE EXCEPTION 'businesses.profile_id % is not a business employer profile', NEW."profile_id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "businesses_profile_is_business"
  BEFORE INSERT OR UPDATE OF "profile_id" ON "businesses"
  FOR EACH ROW EXECUTE FUNCTION "business_requires_business_profile"();
