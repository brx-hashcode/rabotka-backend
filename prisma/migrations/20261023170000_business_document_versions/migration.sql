-- A refused business paper is replaced by a new row; the refused one stays,
-- superseded, so the reviewer sees what was sent before and why it was refused.
ALTER TABLE "business_documents" ADD COLUMN "replaces_id" UUID;
ALTER TABLE "business_documents" ADD COLUMN "superseded_at" TIMESTAMPTZ;
CREATE UNIQUE INDEX "business_documents_replaces_id_key" ON "business_documents"("replaces_id");
ALTER TABLE "business_documents" ADD CONSTRAINT "business_documents_replaces_id_fkey"
  FOREIGN KEY ("replaces_id") REFERENCES "business_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- One paper refused on its own, in the business's in-app feed.
ALTER TYPE "ProfileNotificationType" ADD VALUE IF NOT EXISTS 'BUSINESS_DOCUMENT_REJECTED';
