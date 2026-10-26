-- A business's plan quota also covers a direct unlock from its worker search:
-- the usage row then points at the contact record instead of an attempt.
ALTER TABLE "business_quota_usages" ALTER COLUMN "contact_unlock_attempt_id" DROP NOT NULL;
ALTER TABLE "business_quota_usages" ADD COLUMN "contact_record_id" UUID;
CREATE UNIQUE INDEX "business_quota_usages_contact_record_id_key" ON "business_quota_usages"("contact_record_id");
ALTER TABLE "business_quota_usages" ADD CONSTRAINT "business_quota_usages_one_target"
  CHECK (("contact_unlock_attempt_id" IS NULL) <> ("contact_record_id" IS NULL));
