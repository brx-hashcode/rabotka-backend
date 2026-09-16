-- AlterEnum
--
-- The feed started with profile views only. Every value below is an event the
-- API already reports on WhatsApp or by e-mail, now also shown in the bell —
-- for workers and employers alike.
--
-- Postgres 12+ allows several ADD VALUE statements in one migration as long as
-- nothing in the same transaction uses the new values, and nothing here does.
ALTER TYPE "ProfileNotificationType" ADD VALUE 'JOB_RECOMMENDATION';
ALTER TYPE "ProfileNotificationType" ADD VALUE 'APPLICATION_ACCEPTED';
ALTER TYPE "ProfileNotificationType" ADD VALUE 'APPLICATION_REJECTED';
ALTER TYPE "ProfileNotificationType" ADD VALUE 'HIRE_CANCELLED';
ALTER TYPE "ProfileNotificationType" ADD VALUE 'MISSION_RATED';
ALTER TYPE "ProfileNotificationType" ADD VALUE 'NEW_APPLICATION';
ALTER TYPE "ProfileNotificationType" ADD VALUE 'APPLICATION_CANCELLED';
ALTER TYPE "ProfileNotificationType" ADD VALUE 'MISSION_COMPLETED';
ALTER TYPE "ProfileNotificationType" ADD VALUE 'CONTACT_UNLOCKED';
ALTER TYPE "ProfileNotificationType" ADD VALUE 'PAYMENT_SUCCEEDED';
ALTER TYPE "ProfileNotificationType" ADD VALUE 'PAYMENT_FAILED';
ALTER TYPE "ProfileNotificationType" ADD VALUE 'CLAIM_COMMENTED';
ALTER TYPE "ProfileNotificationType" ADD VALUE 'CLAIM_STATUS_CHANGED';

-- AlterTable
--
-- « Tout effacer » and swipe-to-delete hide a row from its recipient without
-- deleting it, so the admin profile tab keeps the full history.
ALTER TABLE "profile_notifications" ADD COLUMN     "dismissed_at" TIMESTAMP(3);
