-- AI CV screening for businesses: what each plan includes, the period's
-- usage, and the screenings with their CVs.
ALTER TYPE "ProfileNotificationType" ADD VALUE 'CV_SCREENING_DONE';

ALTER TABLE "business_plans"
  ADD COLUMN "cv_screenings_per_period" INTEGER DEFAULT 0,
  ADD COLUMN "cv_batch_max" INTEGER NOT NULL DEFAULT 20,
  ADD COLUMN "cv_file_max_mb" INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN "cv_retention_days" INTEGER NOT NULL DEFAULT 30;

ALTER TABLE "business_subscriptions" ADD COLUMN "cv_screened" INTEGER NOT NULL DEFAULT 0;

CREATE TYPE "CvScreeningStatus" AS ENUM ('PROCESSING', 'DONE');
CREATE TYPE "CvScreeningResumeStatus" AS ENUM ('QUEUED', 'SCORED', 'UNREADABLE', 'FAILED');

CREATE TABLE "cv_screenings" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "business_id" UUID NOT NULL,
    "subscription_id" UUID,
    "offer_id" UUID,
    "job_title" TEXT NOT NULL,
    "job_text" TEXT NOT NULL,
    "status" "CvScreeningStatus" NOT NULL DEFAULT 'PROCESSING',
    "expires_at" TIMESTAMPTZ NOT NULL,
    "purged_at" TIMESTAMPTZ,

    CONSTRAINT "cv_screenings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "cv_screening_resumes" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "screening_id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "storage_key" TEXT,
    "storage_bucket" TEXT,
    "status" "CvScreeningResumeStatus" NOT NULL DEFAULT 'QUEUED',
    "score" INTEGER,
    "criteria" JSONB,
    "summary" TEXT,
    "strengths" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "gaps" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "candidate" JSONB,
    "error" TEXT,

    CONSTRAINT "cv_screening_resumes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_cv_screening_business_created" ON "cv_screenings"("business_id", "created_at");
CREATE INDEX "idx_cv_screening_expires" ON "cv_screenings"("expires_at");
CREATE INDEX "idx_cv_screening_resume_screening" ON "cv_screening_resumes"("screening_id");

ALTER TABLE "cv_screenings" ADD CONSTRAINT "cv_screenings_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cv_screenings" ADD CONSTRAINT "cv_screenings_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "business_subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "cv_screenings" ADD CONSTRAINT "cv_screenings_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "job_offers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "cv_screening_resumes" ADD CONSTRAINT "cv_screening_resumes_screening_id_fkey" FOREIGN KEY ("screening_id") REFERENCES "cv_screenings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
