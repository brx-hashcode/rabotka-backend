-- Applications from the public careers page, by people with no Rabotka account.
CREATE TYPE "ExternalApplicationStatus" AS ENUM ('PENDING', 'REFUSED');

CREATE TABLE "external_applications" (
  "id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "job_offer_id" UUID NOT NULL,
  "first_name" TEXT NOT NULL,
  "last_name" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "status" "ExternalApplicationStatus" NOT NULL DEFAULT 'PENDING',
  "answers" JSONB NOT NULL DEFAULT '[]',
  "knocked_out" BOOLEAN NOT NULL DEFAULT false,
  "consented_at" TIMESTAMPTZ NOT NULL,
  "viewed_at" TIMESTAMPTZ,
  "refused_at" TIMESTAMPTZ,
  "refusal_message" TEXT,
  "cv_file_name" TEXT NOT NULL,
  "cv_mime_type" TEXT NOT NULL,
  "cv_size_bytes" INTEGER NOT NULL,
  "cv_storage_key" TEXT,
  "cv_storage_bucket" TEXT,
  CONSTRAINT "external_applications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "external_applications_job_offer_id_email_key" ON "external_applications"("job_offer_id", "email");
CREATE INDEX "idx_external_application_created" ON "external_applications"("created_at");

ALTER TABLE "external_applications"
  ADD CONSTRAINT "external_applications_job_offer_id_fkey"
  FOREIGN KEY ("job_offer_id") REFERENCES "job_offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
