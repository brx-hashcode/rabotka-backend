-- CreateEnum
CREATE TYPE "DeliveryChannel" AS ENUM ('EMAIL', 'WHATSAPP', 'ALL');

-- AlterTable
ALTER TABLE "events" ADD COLUMN     "channel" "DeliveryChannel" NOT NULL DEFAULT 'EMAIL';

-- CreateTable
CREATE TABLE "admin_notifications" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "event" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "metadata" JSONB,
    "read" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "admin_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_admin_notification_created_at" ON "admin_notifications"("created_at");

-- CreateIndex
CREATE INDEX "idx_admin_notification_read" ON "admin_notifications"("read");
