-- AlterEnum
-- NOTE: Postgres cannot use a value added by ALTER TYPE in the same
-- transaction that adds it, and Prisma wraps each migration file in one. This
-- file only declares the value, it never inserts a row carrying it — do not add
-- a data statement here later.
ALTER TYPE "WalletTransactionType" ADD VALUE 'REFERRAL_CREDIT';

-- CreateEnum
CREATE TYPE "ReferralStatus" AS ENUM ('PENDING', 'QUALIFIED_ON_HOLD', 'REWARDED', 'CAPPED', 'FORFEITED');

-- CreateEnum
CREATE TYPE "ReferralSource" AS ENUM ('LINK', 'MANUAL_CODE', 'BOT', 'ADMIN');

-- AlterTable
ALTER TABLE "profiles" ADD COLUMN     "referral_code" TEXT;

-- CreateTable
CREATE TABLE "referrals" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "referrer_id" UUID NOT NULL,
    "referee_id" UUID NOT NULL,
    "code_used" TEXT NOT NULL,
    "source" "ReferralSource" NOT NULL DEFAULT 'LINK',
    "status" "ReferralStatus" NOT NULL DEFAULT 'PENDING',
    "qualifying_payment_request_id" UUID,
    "rewarded_at" TIMESTAMP(3),
    "referrer_amount" DECIMAL(10,2),
    "referee_amount" DECIMAL(10,2),
    "settlement_note" TEXT,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Lazily minted, so most rows are NULL; Postgres unique indexes ignore NULLs,
-- which is exactly the "unique when present" this wants.
CREATE UNIQUE INDEX "profiles_referral_code_key" ON "profiles"("referral_code");

-- CreateIndex
-- A profile is referred at most once, ever.
CREATE UNIQUE INDEX "referrals_referee_id_key" ON "referrals"("referee_id");

-- CreateIndex
-- One payment can never settle two referrals.
CREATE UNIQUE INDEX "referrals_qualifying_payment_request_id_key" ON "referrals"("qualifying_payment_request_id");

-- CreateIndex
CREATE INDEX "idx_referral_referrer_status" ON "referrals"("referrer_id", "status");

-- CreateIndex
CREATE INDEX "idx_referral_status" ON "referrals"("status");

-- CreateIndex
CREATE INDEX "idx_referral_created_at" ON "referrals"("created_at");

-- CreateIndex
CREATE INDEX "idx_referral_deleted_at" ON "referrals"("deleted_at");

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrer_id_fkey" FOREIGN KEY ("referrer_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referee_id_fkey" FOREIGN KEY ("referee_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_qualifying_payment_request_id_fkey" FOREIGN KEY ("qualifying_payment_request_id") REFERENCES "payment_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;
