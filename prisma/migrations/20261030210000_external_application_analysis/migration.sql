-- An outside candidate's CV can be analysed: one shared screening per offer,
-- so its candidates can be compared.
ALTER TABLE "cv_screenings" ADD COLUMN "external" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "idx_cv_screening_offer_external" ON "cv_screenings"("offer_id", "external");

ALTER TABLE "external_applications" ADD COLUMN "cv_resume_id" UUID;
CREATE UNIQUE INDEX "external_applications_cv_resume_id_key" ON "external_applications"("cv_resume_id");
ALTER TABLE "external_applications"
  ADD CONSTRAINT "external_applications_cv_resume_id_fkey"
  FOREIGN KEY ("cv_resume_id") REFERENCES "cv_screening_resumes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
