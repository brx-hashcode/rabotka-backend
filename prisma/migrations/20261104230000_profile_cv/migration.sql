-- « Mon CV »: a worker's own CV on their profile, and which CV each application carries.

-- CreateEnum
CREATE TYPE "CvChoice" AS ENUM ('RABOTKA', 'UPLOADED');

-- AlterTable
ALTER TABLE "profiles" ADD COLUMN     "preferred_cv" "CvChoice" NOT NULL DEFAULT 'RABOTKA';

-- AlterTable
ALTER TABLE "applications" ADD COLUMN     "profile_cv_id" UUID;

-- CreateTable
CREATE TABLE "profile_cvs" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "profile_id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "storage_bucket" TEXT,
    "cv_text" TEXT NOT NULL DEFAULT '',
    "deleted_at" TIMESTAMPTZ,
    "purged_at" TIMESTAMPTZ,

    CONSTRAINT "profile_cvs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_profile_cv_live" ON "profile_cvs"("profile_id", "deleted_at");

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_profile_cv_id_fkey" FOREIGN KEY ("profile_cv_id") REFERENCES "profile_cvs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_cvs" ADD CONSTRAINT "profile_cvs_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

