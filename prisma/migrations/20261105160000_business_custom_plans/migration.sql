-- A custom plan (« sur mesure »): made for one business alone. Null: the
-- public catalog, as every plan so far.
ALTER TABLE "business_plans" ADD COLUMN     "business_id" UUID;

CREATE INDEX "idx_business_plan_business" ON "business_plans"("business_id");

ALTER TABLE "business_plans" ADD CONSTRAINT "business_plans_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
