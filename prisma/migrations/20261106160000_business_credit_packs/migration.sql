-- Packs: units a business buys on top of its plan (CVs, offers, contacts,
-- AI-written offers), spent after the plan's own quota, kept 12 months.
ALTER TYPE "PaymentRequestType" ADD VALUE 'BUSINESS_CREDIT_PACK';
ALTER TYPE "InvoiceReason" ADD VALUE 'BUSINESS_CREDIT_PACK';
ALTER TYPE "ProfileNotificationType" ADD VALUE 'BUSINESS_CREDITS_ADDED';

CREATE TYPE "BusinessCreditKind" AS ENUM ('CV', 'OFFER', 'CONTACT', 'OFFER_DRAFT');

CREATE TABLE "business_credits" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "business_id" UUID NOT NULL,
    "kind" "BusinessCreditKind" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "used" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "payment_request_id" UUID,
    "granted_by_admin_id" UUID,

    CONSTRAINT "business_credits_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "business_credits_payment_request_id_key" ON "business_credits"("payment_request_id");
CREATE INDEX "business_credits_business_id_kind_expires_at_idx" ON "business_credits"("business_id", "kind", "expires_at");
ALTER TABLE "business_credits" ADD CONSTRAINT "business_credits_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "payment_requests" ADD COLUMN "business_credit_kind" "BusinessCreditKind",
ADD COLUMN "business_credit_quantity" INTEGER;

ALTER TABLE "business_subscriptions" ADD COLUMN "cv_from_credits" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "offers_from_credits" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "offer_drafts_from_credits" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "business_quota_usages" ADD COLUMN "credit_id" UUID;
