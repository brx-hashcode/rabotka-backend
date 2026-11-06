-- A careers-page candidate can be invited without a CV analysis.
ALTER TABLE "interviews" ADD COLUMN     "external_application_id" UUID;

CREATE INDEX "idx_interview_external_application" ON "interviews"("external_application_id");

ALTER TABLE "interviews" ADD CONSTRAINT "interviews_external_application_id_fkey" FOREIGN KEY ("external_application_id") REFERENCES "external_applications"("id") ON DELETE SET NULL ON UPDATE CASCADE;
