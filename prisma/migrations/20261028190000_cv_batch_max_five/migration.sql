-- At most 5 CVs in one screening.
ALTER TABLE "business_plans" ALTER COLUMN "cv_batch_max" SET DEFAULT 5;
UPDATE "business_plans" SET "cv_batch_max" = LEAST("cv_batch_max", 5);
