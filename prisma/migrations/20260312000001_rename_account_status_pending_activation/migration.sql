-- Rename AccountStatus enum value PENDING_PAYMENT → PENDING_ACTIVATION
-- This clarifies that the status refers to account activation, not financial payment,
-- which is now handled by the separate BillingStatus enum.

ALTER TYPE "AccountStatus" RENAME VALUE 'PENDING_PAYMENT' TO 'PENDING_ACTIVATION';
