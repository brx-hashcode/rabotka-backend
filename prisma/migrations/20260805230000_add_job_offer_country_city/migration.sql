-- Structured location on the job offer.
--
-- The profile already carries country/city, and the ranker's proximity
-- fallback uses it whenever geocoding is missing. Job offers had none, so the
-- worker-facing feed had to borrow the EMPLOYER's city as a stand-in — which is
-- wrong for anyone recruiting for a site away from their own base.
--
-- Nullable: every existing row has none, and offer creation must keep working
-- while an older client build is still live.
ALTER TABLE "job_offers"
  ADD COLUMN "country_code" VARCHAR(2),
  ADD COLUMN "country_name" TEXT,
  ADD COLUMN "city" TEXT;

-- The composite the coming "jobs in my city" filters will scan.
CREATE INDEX "idx_job_offer_country_city" ON "job_offers"("country_code", "city");
