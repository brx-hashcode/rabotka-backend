-- AlterEnum: reduce DocumentType to the four types Rabotka can actually verify.
--
-- BIRTH_CERTIFICATE, STUDENT_CARD and OTHER are dropped: none is acceptable
-- identity proof, and OTHER is an open bucket no reviewer can judge consistently.
--
-- Postgres cannot DROP VALUE from an enum, so this follows the rename-swap-drop
-- pattern already used by 20260330090000_remove_job_offer_pending_payment_status.
-- Unlike that one, kyc_documents.document_type has no default, so no
-- ALTER COLUMN ... DROP/SET DEFAULT is needed.

-- Null out rows on a type being removed. The column is nullable and every read
-- path already tolerates NULL; remapping to IDENTITY_CARD was rejected because
-- it would assert something false about a person's identity document.
UPDATE "kyc_documents" SET "document_type" = NULL
WHERE "document_type" IN ('BIRTH_CERTIFICATE', 'STUDENT_CARD', 'OTHER');

ALTER TYPE "DocumentType" RENAME TO "DocumentType_old";
CREATE TYPE "DocumentType" AS ENUM ('IDENTITY_CARD', 'PASSPORT', 'DRIVER_LICENSE', 'NIU_CARD');
ALTER TABLE "kyc_documents" ALTER COLUMN "document_type"
  TYPE "DocumentType" USING ("document_type"::text::"DocumentType");
DROP TYPE "DocumentType_old";
