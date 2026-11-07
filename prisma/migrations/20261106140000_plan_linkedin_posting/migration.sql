-- « Publier sur LinkedIn » becomes a plan service. The plans that exist keep
-- it (businesses already post); a plan created from now on starts without it.
ALTER TABLE "business_plans" ADD COLUMN "linkedin_posting" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "business_plans" ALTER COLUMN "linkedin_posting" SET DEFAULT false;
