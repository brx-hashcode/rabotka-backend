-- AlterTable
ALTER TABLE "penalties" ADD COLUMN     "last_notified_at" TIMESTAMP(3),
ADD COLUMN     "notification_count" INTEGER NOT NULL DEFAULT 0;
