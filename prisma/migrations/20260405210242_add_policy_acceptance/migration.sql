-- AlterTable
ALTER TABLE "profiles" ADD COLUMN     "read_and_approved_policies" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "profile_platform_document_links" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "profile_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,

    CONSTRAINT "profile_platform_document_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "profile_platform_document_links_profile_id_document_id_key" ON "profile_platform_document_links"("profile_id", "document_id");

-- AddForeignKey
ALTER TABLE "profile_platform_document_links" ADD CONSTRAINT "profile_platform_document_links_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_platform_document_links" ADD CONSTRAINT "profile_platform_document_links_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
