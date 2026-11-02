-- What a BUSINESS_SUBSCRIPTION payment request buys: the plan and the period.
ALTER TABLE "payment_requests" ADD COLUMN "business_plan_id" UUID;
ALTER TABLE "payment_requests" ADD COLUMN "business_billing_period" "BusinessBillingPeriod";
