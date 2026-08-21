-- AlterEnum: add the back-of-document side to KycDocumentCategory.
--
-- AFTER 'DOCUMENT' is load-bearing. Postgres sorts an enum by declaration
-- order, and a bare ADD VALUE appends to the end -- which would sort SELFIE
-- before DOCUMENT_BACK. Placing it here keeps the DB order aligned with
-- schema.prisma so `orderBy: { document_category: 'asc' }` returns
-- front -> back -> selfie for the admin review grid.
ALTER TYPE "KycDocumentCategory" ADD VALUE 'DOCUMENT_BACK' AFTER 'DOCUMENT';
