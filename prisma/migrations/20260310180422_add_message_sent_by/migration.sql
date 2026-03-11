-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "sent_by_id" UUID;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_sent_by_id_fkey" FOREIGN KEY ("sent_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
