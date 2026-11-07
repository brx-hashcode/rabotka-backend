-- The period each CV was charged to, so a CV not read is given back there:
-- an offer's screening lasts across periods, and was refunding its later
-- CVs to the period it was opened under.
ALTER TABLE "cv_screening_resumes" ADD COLUMN     "subscription_id" UUID;

-- Until now a CV was charged to its screening's period, as far as anyone can
-- tell from the rows: start from there.
UPDATE "cv_screening_resumes" r
SET "subscription_id" = s."subscription_id"
FROM "cv_screenings" s
WHERE s."id" = r."screening_id";

ALTER TABLE "cv_screening_resumes" ADD CONSTRAINT "cv_screening_resumes_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "business_subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
