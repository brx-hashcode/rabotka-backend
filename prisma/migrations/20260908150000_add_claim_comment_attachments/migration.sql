-- AlterTable
--
-- Same shape as `claims.attachment_urls` (see 20260324223952_add_claims_module),
-- so the two sides of a claim thread store attachments identically.
--
-- No backfill needed: `DEFAULT ARRAY[]::TEXT[]` fills existing rows, and every
-- comment written before now had no way to carry an attachment.
ALTER TABLE "claim_comments" ADD COLUMN "attachment_urls" TEXT[] DEFAULT ARRAY[]::TEXT[];
