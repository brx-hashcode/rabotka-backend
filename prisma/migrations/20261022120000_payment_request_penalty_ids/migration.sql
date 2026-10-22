-- The penalties a penalty payment request was priced for (pentest A2-F04, #861
-- follow-up #860). Settling the request marks exactly these paid — not every
-- penalty the profile has at settlement time, which let a link priced for one
-- small penalty clear any issued afterwards. Empty for every other request type
-- and for requests created before this column.
ALTER TABLE "payment_requests" ADD COLUMN "penalty_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[];
