-- HR events with a visio, and video calls in the admins' team chat.

ALTER TABLE "events" ADD COLUMN "visio_room" TEXT;
CREATE INDEX "idx_event_visio_room" ON "events"("visio_room");

CREATE TYPE "ChatMessageKind" AS ENUM ('TEXT', 'CALL');
ALTER TABLE "chat_messages" ADD COLUMN "kind" "ChatMessageKind" NOT NULL DEFAULT 'TEXT';
ALTER TABLE "chat_messages" ADD COLUMN "metadata" JSONB;

ALTER TABLE "chat_conversations" ADD COLUMN "active_call_room" TEXT;
ALTER TABLE "chat_conversations" ADD COLUMN "active_call_started_at" TIMESTAMP(3);
