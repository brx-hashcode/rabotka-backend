-- « Compte rendu » of an interview: the team's notes and the report written from them.
CREATE TABLE "interview_reports" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "interview_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "report" JSONB,
    "generated_at" TIMESTAMPTZ,
    "sent_at" TIMESTAMPTZ,
    "updated_by_member_id" UUID,

    CONSTRAINT "interview_reports_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "interview_reports_interview_id_key" ON "interview_reports"("interview_id");
CREATE INDEX "idx_interview_report_business" ON "interview_reports"("business_id");

ALTER TABLE "interview_reports" ADD CONSTRAINT "interview_reports_interview_id_fkey" FOREIGN KEY ("interview_id") REFERENCES "interviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "interview_reports" ADD CONSTRAINT "interview_reports_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
