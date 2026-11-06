-- Each CV's own retention: an offer's screening lasts across periods, and a
-- CV that came on its last day was purged the next.
ALTER TABLE "cv_screening_resumes" ADD COLUMN "expires_at" TIMESTAMPTZ;

-- Until now a CV went with its screening.
UPDATE "cv_screening_resumes" r
SET "expires_at" = s."expires_at"
FROM "cv_screenings" s
WHERE s."id" = r."screening_id";
