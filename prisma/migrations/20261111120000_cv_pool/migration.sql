-- « Mes profils » beyond Rabotka workers: careers-page candidates who agreed
-- to be kept (opt-in, for a set time) and CVs the business analysed.

ALTER TABLE "external_applications"
  ADD COLUMN "pool_consent_at" TIMESTAMPTZ,
  ADD COLUMN "pool_expires_at" TIMESTAMPTZ,
  ADD COLUMN "pool_token_hash" TEXT;
CREATE UNIQUE INDEX "external_applications_pool_token_hash_key" ON "external_applications"("pool_token_hash");

ALTER TABLE "business_talents"
  ALTER COLUMN "worker_id" DROP NOT NULL,
  ADD COLUMN "external_application_id" UUID,
  ADD COLUMN "cv_resume_id" UUID;

CREATE UNIQUE INDEX "business_talents_employer_id_external_application_id_key" ON "business_talents"("employer_id", "external_application_id");
CREATE UNIQUE INDEX "business_talents_employer_id_cv_resume_id_key" ON "business_talents"("employer_id", "cv_resume_id");

ALTER TABLE "business_talents" ADD CONSTRAINT "business_talents_external_application_id_fkey" FOREIGN KEY ("external_application_id") REFERENCES "external_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "business_talents" ADD CONSTRAINT "business_talents_cv_resume_id_fkey" FOREIGN KEY ("cv_resume_id") REFERENCES "cv_screening_resumes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Exactly one kind per row: a worker, a candidature, or a CV.
ALTER TABLE "business_talents" ADD CONSTRAINT "business_talents_one_kind"
  CHECK (num_nonnulls("worker_id", "external_application_id", "cv_resume_id") = 1);
