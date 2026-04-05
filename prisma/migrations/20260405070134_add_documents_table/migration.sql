-- CreateEnum
CREATE TYPE "DocumentCategory" AS ENUM ('AGREEMENT', 'CONTRACT', 'POLICY', 'INVOICE', 'REPORT', 'OTHER');

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "title" TEXT NOT NULL,
    "category" "DocumentCategory" NOT NULL,
    "file_url" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "created_by" UUID,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_document_category" ON "documents"("category");

-- CreateIndex
CREATE INDEX "idx_document_created_at" ON "documents"("created_at");
