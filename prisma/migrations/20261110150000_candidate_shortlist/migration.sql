-- « Présélectionnée »: a step only the business sees, while the candidature waits.
ALTER TABLE "applications" ADD COLUMN "shortlisted_at" TIMESTAMPTZ;
ALTER TABLE "external_applications" ADD COLUMN "shortlisted_at" TIMESTAMPTZ;
