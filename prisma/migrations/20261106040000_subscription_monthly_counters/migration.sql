-- The month a period's counters belong to: an annual period starts them
-- again every month. Null: the period's first month.
ALTER TABLE "business_subscriptions" ADD COLUMN "counters_from" TIMESTAMPTZ;
