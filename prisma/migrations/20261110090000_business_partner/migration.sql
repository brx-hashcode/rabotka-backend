-- AlterTable
ALTER TABLE "businesses" ADD COLUMN     "is_partner" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "partner_rank" INTEGER;
