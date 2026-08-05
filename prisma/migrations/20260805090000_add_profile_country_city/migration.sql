-- Structured location on the profile.
--
-- `address` alone is free text, so nothing could be filtered or grouped by
-- place, and the recommendation engine's proximity term fell back to a flat
-- 0.5 whenever geocoding had failed — a constant carrying a third of the
-- cold-start weight. country_code/city give that term something coarse but
-- real to work with.
--
-- All three are nullable: every existing row has none, and signup must keep
-- working while old and new client builds are live at the same time.
ALTER TABLE "profiles"
  ADD COLUMN "country_code" VARCHAR(2),
  ADD COLUMN "country_name" TEXT,
  ADD COLUMN "city" TEXT;

-- The composite the coming "workers in my city" filters will scan.
CREATE INDEX "idx_profile_country_city" ON "profiles"("country_code", "city");
