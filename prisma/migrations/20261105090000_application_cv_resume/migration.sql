-- A Rabotka applicant's CV analysis, in the offer's screening beside the careers-page CVs.

-- AlterTable
ALTER TABLE "applications" ADD COLUMN     "cv_resume_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "applications_cv_resume_id_key" ON "applications"("cv_resume_id");

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_cv_resume_id_fkey" FOREIGN KEY ("cv_resume_id") REFERENCES "cv_screening_resumes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

