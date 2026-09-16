-- CreateEnum
CREATE TYPE "ProfileNotificationType" AS ENUM ('PROFILE_VIEW');

-- CreateTable
--
-- The in-app notification feed behind the bell in rabotka-client, one row per
-- recipient.
--
-- AdminNotification could not be reused: it has no recipient column, because
-- every admin reads the same feed. Profiles each need their own, with their own
-- read state.
--
-- The copy is rendered when the row is written, not when it is read, so an old
-- notification still says what it said on the day it was sent.
CREATE TABLE "profile_notifications" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recipient_id" UUID NOT NULL,
    "type" "ProfileNotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    -- The employer behind a PROFILE_VIEW. Only admins ever see it; the worker
    -- is shown an anonymised sentence.
    "actor_id" UUID,
    "metadata" JSONB,
    "read_at" TIMESTAMP(3),

    CONSTRAINT "profile_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
--
-- Serves the feed itself: newest first, for one recipient.
CREATE INDEX "idx_profile_notif_recipient_time" ON "profile_notifications"("recipient_id", "created_at" DESC);

-- CreateIndex
--
-- Serves the unread badge and the WhatsApp-reminder threshold, which counts
-- unread rows of a single type.
CREATE INDEX "idx_profile_notif_recipient_unread" ON "profile_notifications"("recipient_id", "type", "read_at");

-- AddForeignKey
ALTER TABLE "profile_notifications" ADD CONSTRAINT "profile_notifications_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile_notifications" ADD CONSTRAINT "profile_notifications_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
