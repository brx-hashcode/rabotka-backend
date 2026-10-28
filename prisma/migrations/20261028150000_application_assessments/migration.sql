-- How well each applicant to a business's offer fits it, scored by the AI from their profile.
CREATE TABLE "application_assessments" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "application_id" UUID NOT NULL,
    "score" INTEGER,
    "criteria" JSONB,
    "summary" TEXT,
    "strengths" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "gaps" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "failed" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "application_assessments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "application_assessments_application_id_key" ON "application_assessments"("application_id");
ALTER TABLE "application_assessments" ADD CONSTRAINT "application_assessments_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
