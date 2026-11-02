-- Business subscriptions: plans edited in admin, periods bought / granted /
-- given as the trial, and the contact-unlock quota ledger.
ALTER TYPE "PaymentType" ADD VALUE IF NOT EXISTS 'BUSINESS_SUBSCRIPTION';
ALTER TYPE "PaymentRequestType" ADD VALUE IF NOT EXISTS 'BUSINESS_SUBSCRIPTION';
ALTER TYPE "InvoiceReason" ADD VALUE IF NOT EXISTS 'BUSINESS_SUBSCRIPTION';
ALTER TYPE "ProfileNotificationType" ADD VALUE IF NOT EXISTS 'BUSINESS_TRIAL_STARTED';
ALTER TYPE "ProfileNotificationType" ADD VALUE IF NOT EXISTS 'BUSINESS_SUBSCRIPTION_ACTIVE';
ALTER TYPE "ProfileNotificationType" ADD VALUE IF NOT EXISTS 'BUSINESS_SUBSCRIPTION_EXPIRING';
ALTER TYPE "ProfileNotificationType" ADD VALUE IF NOT EXISTS 'BUSINESS_SUBSCRIPTION_EXPIRED';

CREATE TYPE "BusinessSubscriptionStatus" AS ENUM ('TRIAL', 'ACTIVE', 'EXPIRED', 'CANCELLED');
CREATE TYPE "BusinessBillingPeriod" AS ENUM ('TRIAL', 'MONTHLY', 'ANNUAL');

ALTER TABLE "job_offers" ADD COLUMN "priority_until" TIMESTAMPTZ;

CREATE TABLE "business_plans" (
  "id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "monthly_price_fcfa" INTEGER NOT NULL,
  "annual_price_fcfa" INTEGER NOT NULL,
  "unlocks_per_period" INTEGER,
  "active_offers_limit" INTEGER,
  "includes_preselection" BOOLEAN NOT NULL DEFAULT false,
  "includes_field_agents" BOOLEAN NOT NULL DEFAULT false,
  "priority_visibility" BOOLEAN NOT NULL DEFAULT false,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "business_plans_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "business_plans_prices_check" CHECK ("monthly_price_fcfa" >= 0 AND "annual_price_fcfa" >= 0),
  CONSTRAINT "business_plans_quotas_check" CHECK (
    ("unlocks_per_period" IS NULL OR "unlocks_per_period" >= 0) AND
    ("active_offers_limit" IS NULL OR "active_offers_limit" >= 0))
);
CREATE UNIQUE INDEX "business_plans_code_key" ON "business_plans"("code");

CREATE TABLE "business_subscriptions" (
  "id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "business_id" UUID NOT NULL,
  "plan_id" UUID NOT NULL,
  "status" "BusinessSubscriptionStatus" NOT NULL,
  "billing_period" "BusinessBillingPeriod" NOT NULL,
  "starts_at" TIMESTAMPTZ NOT NULL,
  "ends_at" TIMESTAMPTZ NOT NULL,
  "unlocks_used" INTEGER NOT NULL DEFAULT 0,
  "payment_request_id" UUID,
  "granted_by" UUID,
  "reminded_at" TIMESTAMPTZ,
  "expired_notified_at" TIMESTAMPTZ,
  CONSTRAINT "business_subscriptions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "business_subscriptions_period_check" CHECK ("ends_at" > "starts_at"),
  CONSTRAINT "business_subscriptions_unlocks_check" CHECK ("unlocks_used" >= 0),
  CONSTRAINT "business_subscriptions_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "business_subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "business_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "business_subscriptions_payment_request_id_key" ON "business_subscriptions"("payment_request_id");
CREATE INDEX "idx_business_subscription_business_end" ON "business_subscriptions"("business_id", "ends_at");
CREATE INDEX "idx_business_subscription_status_end" ON "business_subscriptions"("status", "ends_at");
-- One trial per business, ever.
CREATE UNIQUE INDEX "business_subscriptions_one_trial" ON "business_subscriptions"("business_id") WHERE "billing_period" = 'TRIAL';

CREATE TABLE "business_quota_usages" (
  "id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "subscription_id" UUID NOT NULL,
  "contact_unlock_attempt_id" UUID NOT NULL,
  "released_at" TIMESTAMPTZ,
  CONSTRAINT "business_quota_usages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "business_quota_usages_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "business_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "business_quota_usages_contact_unlock_attempt_id_key" ON "business_quota_usages"("contact_unlock_attempt_id");
CREATE INDEX "idx_business_quota_usage_subscription" ON "business_quota_usages"("subscription_id");
