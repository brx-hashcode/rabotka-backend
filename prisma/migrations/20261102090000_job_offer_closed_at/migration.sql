-- The employer closed this offer: it stays closed until they republish it.
ALTER TABLE "job_offers" ADD COLUMN "closed_at" TIMESTAMPTZ;
