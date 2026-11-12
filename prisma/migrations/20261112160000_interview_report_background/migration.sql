-- « Rédiger le compte rendu » in the background, with a notification when it is ready.
ALTER TYPE "ProfileNotificationType" ADD VALUE 'INTERVIEW_REPORT_READY';
ALTER TABLE "interview_reports" ADD COLUMN "writing_started_at" TIMESTAMPTZ;
ALTER TABLE "interview_reports" ADD COLUMN "writing_error" TEXT;
