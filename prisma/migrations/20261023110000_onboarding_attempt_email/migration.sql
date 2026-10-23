-- Business sign-ups prove an email, not a phone: an attempt is keyed by one
-- or the other.
ALTER TABLE "onboarding_attempts" ALTER COLUMN "phone" DROP NOT NULL;
ALTER TABLE "onboarding_attempts" ADD COLUMN "email" TEXT;
ALTER TABLE "onboarding_attempts" ADD COLUMN "entry" TEXT NOT NULL DEFAULT 'whatsapp';
CREATE UNIQUE INDEX "onboarding_attempts_email_key" ON "onboarding_attempts"("email");
ALTER TABLE "onboarding_attempts" ADD CONSTRAINT "onboarding_attempts_contact"
  CHECK ("phone" IS NOT NULL OR "email" IS NOT NULL);
