-- CreateEnum
CREATE TYPE "BroadcastStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'SENDING', 'SENT', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "BroadcastRecipientStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'READ');

-- AlterEnum
ALTER TYPE "ProfileNotificationType" ADD VALUE 'ANNOUNCEMENT';

-- AlterTable
ALTER TABLE "profiles" ADD COLUMN     "marketing_opt_out_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "broadcasts" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "channels" "DeliveryChannel"[],
    "audience" JSONB NOT NULL,
    "status" "BroadcastStatus" NOT NULL DEFAULT 'DRAFT',
    "scheduled_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "recipient_count" INTEGER NOT NULL DEFAULT 0,
    "sent_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "read_count" INTEGER NOT NULL DEFAULT 0,
    "estimated_cost" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" UUID,

    CONSTRAINT "broadcasts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broadcast_recipients" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "broadcast_id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "channel" "DeliveryChannel" NOT NULL,
    "status" "BroadcastRecipientStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "sent_at" TIMESTAMP(3),

    CONSTRAINT "broadcast_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_broadcast_status_created" ON "broadcasts"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_broadcast_scheduled" ON "broadcasts"("scheduled_at");

-- CreateIndex
-- The idempotency of the fan-out: a retried chunk cannot send twice, and does
-- not depend on a Redis key that may have expired.
CREATE UNIQUE INDEX "idx_broadcast_recipient_unique" ON "broadcast_recipients"("broadcast_id", "profile_id", "channel");

-- CreateIndex
CREATE INDEX "idx_broadcast_recipient_status" ON "broadcast_recipients"("broadcast_id", "status");

-- CreateIndex
CREATE INDEX "idx_broadcast_recipient_profile" ON "broadcast_recipients"("profile_id");

-- AddForeignKey
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_broadcast_id_fkey" FOREIGN KEY ("broadcast_id") REFERENCES "broadcasts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
