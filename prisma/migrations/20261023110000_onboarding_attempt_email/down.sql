-- Run by hand. Business attempts (no phone) must go first.
DELETE FROM "onboarding_attempts" WHERE "phone" IS NULL;
ALTER TABLE "onboarding_attempts" DROP CONSTRAINT "onboarding_attempts_contact";
DROP INDEX "onboarding_attempts_email_key";
ALTER TABLE "onboarding_attempts" DROP COLUMN "entry";
ALTER TABLE "onboarding_attempts" DROP COLUMN "email";
ALTER TABLE "onboarding_attempts" ALTER COLUMN "phone" SET NOT NULL;
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261023110000_onboarding_attempt_email';
