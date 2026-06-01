-- Add reference column (nullable for backfill), populate, then enforce NOT NULL + unique.
ALTER TABLE "job_offers" ADD COLUMN "reference" TEXT;

UPDATE "job_offers"
SET "reference" = 'RAB-' || UPPER(SUBSTRING(REPLACE(id::text, '-', '') FROM 1 FOR 5));

ALTER TABLE "job_offers" ALTER COLUMN "reference" SET NOT NULL;
CREATE UNIQUE INDEX "job_offers_reference_key" ON "job_offers"("reference");
