-- AlterTable
ALTER TABLE "job_offers" ADD COLUMN "latitude" DOUBLE PRECISION,
                         ADD COLUMN "longitude" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "profiles" ADD COLUMN "latitude" DOUBLE PRECISION,
                       ADD COLUMN "longitude" DOUBLE PRECISION;
