-- Administrators a business may add besides its account holder, set per plan
-- like recruiters and evaluators. 0 until set in rabotka-admin: no plan gives
-- administrators by surprise.
ALTER TABLE "business_plans" ADD COLUMN "admins_limit" INTEGER DEFAULT 0;
