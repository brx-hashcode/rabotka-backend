-- Sign-up attempts, from the first WhatsApp code to the account, so the team
-- can reach the people who stopped halfway.
CREATE TYPE "OnboardingStage" AS ENUM ('CODE_SENT', 'PHONE_VERIFIED', 'DOCUMENTS', 'CONFIRMATION', 'COMPLETED');

CREATE TABLE "onboarding_attempts" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "phone" TEXT NOT NULL,
    "first_name" TEXT,
    "last_name" TEXT,
    "profile_type" "ProfileType",
    "stage" "OnboardingStage" NOT NULL DEFAULT 'CODE_SENT',
    "code_sends" INTEGER NOT NULL DEFAULT 1,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_activity_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "phone_verified_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "profile_id" UUID,
    "contacted_at" TIMESTAMP(3),
    "contacted_by_id" UUID,
    "contact_note" TEXT,

    CONSTRAINT "onboarding_attempts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "onboarding_attempts_phone_key" ON "onboarding_attempts"("phone");
CREATE INDEX "idx_onboarding_attempt_stage_activity" ON "onboarding_attempts"("stage", "last_activity_at");
CREATE INDEX "idx_onboarding_attempt_started" ON "onboarding_attempts"("started_at");
