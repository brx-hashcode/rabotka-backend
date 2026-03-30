-- Safe: update any rows using PENDING_PAYMENT before removing the enum value
UPDATE job_offers SET status = 'DRAFT' WHERE status = 'PENDING_PAYMENT';

-- AlterEnum: remove PENDING_PAYMENT from JobOfferStatus
ALTER TYPE "JobOfferStatus" RENAME TO "JobOfferStatus_old";
CREATE TYPE "JobOfferStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PARTIALLY_FILLED', 'FILLED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'EXPIRED');
ALTER TABLE "job_offers" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "job_offers" ALTER COLUMN "status" TYPE "JobOfferStatus" USING ("status"::text::"JobOfferStatus");
ALTER TABLE "job_offers" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';
DROP TYPE "JobOfferStatus_old";
