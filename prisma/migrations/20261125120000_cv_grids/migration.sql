-- CVs marked on a grid per offer. Additive: no score changes; a null grid_id is
-- the previous formula.
CREATE TABLE "cv_grids" (
  "id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "business_id" UUID NOT NULL,
  "offer_id" UUID,
  "screening_id" UUID,
  "version" INTEGER NOT NULL,
  "items" JSONB NOT NULL,
  "job_hash" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "created_by" UUID,
  CONSTRAINT "cv_grids_pkey" PRIMARY KEY ("id"),
  -- An offer's, or a hand-made analysis's: never both, never neither.
  CONSTRAINT "cv_grids_owner_check" CHECK (("offer_id" IS NULL) <> ("screening_id" IS NULL))
);

CREATE UNIQUE INDEX "cv_grids_offer_id_version_key" ON "cv_grids"("offer_id", "version");
CREATE UNIQUE INDEX "cv_grids_screening_id_version_key" ON "cv_grids"("screening_id", "version");
CREATE INDEX "idx_cv_grid_business" ON "cv_grids"("business_id");

ALTER TABLE "cv_grids" ADD CONSTRAINT "cv_grids_business_id_fkey"
  FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cv_grids" ADD CONSTRAINT "cv_grids_offer_id_fkey"
  FOREIGN KEY ("offer_id") REFERENCES "job_offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cv_grids" ADD CONSTRAINT "cv_grids_screening_id_fkey"
  FOREIGN KEY ("screening_id") REFERENCES "cv_screenings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "cv_screenings" ADD COLUMN "rescores" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "cv_screening_resumes" ADD COLUMN "grid_id" UUID;
ALTER TABLE "cv_screening_resumes" ADD COLUMN "reading" JSONB;
ALTER TABLE "cv_screening_resumes" ADD COLUMN "musts_missing" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "idx_cv_screening_resume_grid" ON "cv_screening_resumes"("grid_id");
ALTER TABLE "cv_screening_resumes" ADD CONSTRAINT "cv_screening_resumes_grid_id_fkey"
  FOREIGN KEY ("grid_id") REFERENCES "cv_grids"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "application_assessments" ADD COLUMN "grid_id" UUID;
ALTER TABLE "application_assessments" ADD COLUMN "reading" JSONB;
ALTER TABLE "application_assessments" ADD COLUMN "musts_missing" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "application_assessments" ADD CONSTRAINT "application_assessments_grid_id_fkey"
  FOREIGN KEY ("grid_id") REFERENCES "cv_grids"("id") ON DELETE SET NULL ON UPDATE CASCADE;
