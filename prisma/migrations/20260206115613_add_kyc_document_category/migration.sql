/*
  Warnings:

  - You are about to drop the column `selfie_url` on the `kyc_documents` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[profile_id,document_category]` on the table `kyc_documents` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `document_category` to the `kyc_documents` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "KycDocumentCategory" AS ENUM ('DOCUMENT', 'SELFIE');

-- DropIndex
DROP INDEX "kyc_documents_profile_id_key";

-- AlterTable
ALTER TABLE "kyc_documents" DROP COLUMN "selfie_url",
ADD COLUMN     "document_category" "KycDocumentCategory" NOT NULL,
ALTER COLUMN "document_type" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "kyc_documents_profile_id_document_category_key" ON "kyc_documents"("profile_id", "document_category");
