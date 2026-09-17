-- AlterEnum
ALTER TYPE "WhatsappDeliveryStatus" ADD VALUE 'RECEIVED';

-- AlterTable
ALTER TABLE "whatsapp_messages" ADD COLUMN     "received_at" TIMESTAMP(3),
ADD COLUMN     "wa_profile_name" TEXT;

-- CreateTable
CREATE TABLE "whatsapp_contacts" (
    "id" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "wa_profile_name" TEXT,
    "profile_id" UUID,
    "first_seen_at" TIMESTAMP(3) NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL,
    "inbound_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_contacts_phone_key" ON "whatsapp_contacts"("phone");

-- CreateIndex
CREATE INDEX "idx_wa_contact_last_seen" ON "whatsapp_contacts"("last_seen_at" DESC);

-- CreateIndex
CREATE INDEX "idx_wa_contact_profile" ON "whatsapp_contacts"("profile_id");

-- CreateIndex
CREATE INDEX "idx_wa_msg_direction_created" ON "whatsapp_messages"("direction", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "whatsapp_contacts" ADD CONSTRAINT "whatsapp_contacts_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
