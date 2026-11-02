-- The field-agent option is gone: agents work on the offers of every business
-- with a running plan.
ALTER TABLE "business_plans" DROP COLUMN "includes_field_agents";
