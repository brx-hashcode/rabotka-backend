-- A business can retain a candidate from its public careers page.
ALTER TYPE "ExternalApplicationStatus" ADD VALUE 'RETAINED';
ALTER TABLE "external_applications" ADD COLUMN "retained_at" TIMESTAMPTZ;
