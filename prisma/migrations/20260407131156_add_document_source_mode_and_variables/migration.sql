-- CreateEnum
CREATE TYPE "DocumentSourceMode" AS ENUM ('UPLOAD', 'GOOGLE_DOCS');

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "google_docs_id" TEXT,
ADD COLUMN     "google_docs_url" TEXT,
ADD COLUMN     "preview_url" TEXT,
ADD COLUMN     "source_mode" "DocumentSourceMode" NOT NULL DEFAULT 'UPLOAD',
ADD COLUMN     "variables" TEXT[] DEFAULT ARRAY[]::TEXT[];
