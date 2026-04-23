-- CreateEnum
CREATE TYPE "BundleTargetAudience" AS ENUM ('WORKER', 'EMPLOYER', 'BOTH');

-- AlterTable
ALTER TABLE "advertisement_bundles" ADD COLUMN     "target_audience" "BundleTargetAudience" NOT NULL DEFAULT 'BOTH';
