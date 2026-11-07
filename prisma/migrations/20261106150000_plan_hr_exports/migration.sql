-- « Exports RH » becomes a plan service, off until an admin turns it on.
ALTER TABLE "business_plans" ADD COLUMN "hr_exports" BOOLEAN NOT NULL DEFAULT false;
