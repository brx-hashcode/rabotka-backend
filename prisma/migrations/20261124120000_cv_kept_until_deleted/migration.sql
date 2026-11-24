-- CVs stay while the offer recruits, then until the business deletes them, with
-- a far limit (business.cv_limit_months) instead of the plan's days.

-- Deleted by the business: never rebuilt.
ALTER TABLE "cv_screening_resumes" ADD COLUMN "removed_at" TIMESTAMPTZ;
ALTER TABLE "applications" ADD COLUMN "cv_removed_at" TIMESTAMPTZ;
ALTER TABLE "external_applications" ADD COLUMN "cv_removed_at" TIMESTAMPTZ;

ALTER TABLE "external_applications" ADD COLUMN "cv_expires_at" TIMESTAMPTZ;
-- The candidate took « Garder ma candidature » back: the CV goes as the offer closes.
ALTER TABLE "external_applications" ADD COLUMN "pool_withdrawn_at" TIMESTAMPTZ;
ALTER TABLE "answer_files" ADD COLUMN "expires_at" TIMESTAMPTZ;
ALTER TABLE "answer_files" ADD COLUMN "removed_at" TIMESTAMPTZ;

-- The business was told these CVs are about to go.
ALTER TABLE "job_offers" ADD COLUMN "cv_notice_at" TIMESTAMPTZ;
ALTER TABLE "cv_screenings" ADD COLUMN "cv_notice_at" TIMESTAMPTZ;

-- « Des CV vont être supprimés », in the business's feed.
ALTER TYPE "ProfileNotificationType" ADD VALUE 'CV_EXPIRING';

-- What is still there lasts as long as the new rule gives, at least: the sweep
-- extends the offers still recruiting from there.
UPDATE "cv_screening_resumes"
SET "expires_at" = GREATEST("expires_at", "created_at" + INTERVAL '24 months')
WHERE "storage_key" IS NOT NULL OR "cv_text" IS NOT NULL;

UPDATE "cv_screenings" s
SET "expires_at" = GREATEST(
  s."expires_at",
  (SELECT MAX(r."expires_at") FROM "cv_screening_resumes" r WHERE r."screening_id" = s."id"
     AND (r."storage_key" IS NOT NULL OR r."cv_text" IS NOT NULL))
)
WHERE s."purged_at" IS NULL;

UPDATE "external_applications"
SET "cv_expires_at" = GREATEST("created_at" + INTERVAL '24 months', "pool_expires_at")
WHERE "cv_storage_key" IS NOT NULL;

UPDATE "answer_files"
SET "expires_at" = "created_at" + INTERVAL '24 months'
WHERE "storage_key" IS NOT NULL AND "attached_at" IS NOT NULL;
