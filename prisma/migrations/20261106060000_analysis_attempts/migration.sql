-- CV analyses: how many were started for an application (a cap on retries),
-- and a claim so two paths never charge the same CV twice.
ALTER TABLE "applications" ADD COLUMN "analysis_attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "applications" ADD COLUMN "analysis_claimed_at" TIMESTAMPTZ;
ALTER TABLE "external_applications" ADD COLUMN "analysis_attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "external_applications" ADD COLUMN "analysis_claimed_at" TIMESTAMPTZ;

-- Each already has the one it had.
UPDATE "applications" SET "analysis_attempts" = 1 WHERE "cv_resume_id" IS NOT NULL;
UPDATE "external_applications" SET "analysis_attempts" = 1 WHERE "cv_resume_id" IS NOT NULL;
