-- CreateEnum
CREATE TYPE "WhatsappDeliveryStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED');

-- AlterTable
ALTER TABLE "event_series" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "feedback" ALTER COLUMN "id" DROP DEFAULT;

-- CreateTable
CREATE TABLE "whatsapp_messages" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_message_id" TEXT,
    "direction" "MessageDirection" NOT NULL DEFAULT 'OUTBOUND',
    "to_phone" TEXT NOT NULL,
    "profile_id" UUID,
    "kind" TEXT NOT NULL,
    "template_key" TEXT,
    "template_category" TEXT,
    "body_preview" TEXT NOT NULL,
    "variables" JSONB,
    "status" "WhatsappDeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "sent_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "read_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "error_code" TEXT,
    "error_provider_code" INTEGER,
    "error_message" TEXT,
    "pricing_category" TEXT,
    "billable" BOOLEAN,
    "sent_by_id" UUID,

    CONSTRAINT "whatsapp_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_messages_provider_message_id_key" ON "whatsapp_messages"("provider_message_id");

-- CreateIndex
CREATE INDEX "idx_wa_msg_created" ON "whatsapp_messages"("created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_wa_msg_status_created" ON "whatsapp_messages"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_wa_msg_template_created" ON "whatsapp_messages"("template_key", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_wa_msg_phone" ON "whatsapp_messages"("to_phone");

-- CreateIndex
CREATE INDEX "idx_wa_msg_profile" ON "whatsapp_messages"("profile_id");

-- AddForeignKey
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_sent_by_id_fkey" FOREIGN KEY ("sent_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
