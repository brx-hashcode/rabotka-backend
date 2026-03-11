-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "profile_id" UUID NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "platform" "BotPlatform" NOT NULL DEFAULT 'WHATSAPP',
    "body" TEXT NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_message_profile" ON "messages"("profile_id");

-- CreateIndex
CREATE INDEX "idx_message_created_at" ON "messages"("created_at");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
