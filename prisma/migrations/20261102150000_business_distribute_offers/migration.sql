-- Whether a business's open offers go to Google and the job sites. On by
-- default; the business can turn it off from Organisation.
ALTER TABLE "businesses" ADD COLUMN "distribute_offers" BOOLEAN NOT NULL DEFAULT true;
