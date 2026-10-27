-- Interviews a business proposes to a candidate (an analysed CV or an
-- applicant), answered through a private link.
ALTER TYPE "ProfileNotificationType" ADD VALUE 'INTERVIEW_INVITED';
ALTER TYPE "ProfileNotificationType" ADD VALUE 'INTERVIEW_CANCELLED';
ALTER TYPE "ProfileNotificationType" ADD VALUE 'INTERVIEW_ANSWERED';

CREATE TYPE "InterviewMode" AS ENUM ('IN_PERSON', 'PHONE', 'VIDEO');
CREATE TYPE "InterviewStatus" AS ENUM ('PENDING', 'CONFIRMED', 'DECLINED', 'RESCHEDULE_REQUESTED', 'CANCELLED');

CREATE TABLE "interviews" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "business_id" UUID NOT NULL,
    "cv_resume_id" UUID,
    "application_id" UUID,
    "offer_id" UUID,
    "job_title" TEXT NOT NULL,
    "candidate_name" TEXT NOT NULL,
    "candidate_email" TEXT,
    "starts_at" TIMESTAMPTZ NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "mode" "InterviewMode" NOT NULL,
    "location" TEXT,
    "message" TEXT,
    "status" "InterviewStatus" NOT NULL DEFAULT 'PENDING',
    "response_note" TEXT,
    "responded_at" TIMESTAMPTZ,
    "token_hash" TEXT NOT NULL,
    "reminded_at" TIMESTAMPTZ,

    CONSTRAINT "interviews_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "interviews_token_hash_key" ON "interviews"("token_hash");
CREATE INDEX "idx_interview_business_starts" ON "interviews"("business_id", "starts_at");
CREATE INDEX "idx_interview_status_starts" ON "interviews"("status", "starts_at");
CREATE INDEX "idx_interview_cv_resume" ON "interviews"("cv_resume_id");
CREATE INDEX "idx_interview_application" ON "interviews"("application_id");

ALTER TABLE "interviews" ADD CONSTRAINT "interviews_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_cv_resume_id_fkey" FOREIGN KEY ("cv_resume_id") REFERENCES "cv_screening_resumes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "job_offers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
